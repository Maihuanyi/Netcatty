const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeWindowsHelperArch, readPeMachine, getExpectedPeMachine, hasInitializedMsvcEnvironment,
  findVisualStudioDevCmd } = require('./build-windows-hello-helper.cjs');

function buildSftpDropTarget({ projectDir = process.cwd(), platform = process.platform,
  arch = process.env.npm_config_arch || process.arch, env = process.env, run = execFileSync } = {}) {
  if (platform !== 'win32') return { skipped: true, reason: 'non-windows' };
  const target = normalizeWindowsHelperArch(arch);
  if (!target) throw new Error('Unsupported SFTP drop helper architecture');
  const directory = path.join(projectDir, 'electron/bridges/sftpDropTarget');
  const outputDir = path.join(directory, 'build', target);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'NetcattySftpDropTarget.exe');
  const args = ['/nologo', '/EHsc', '/std:c++17', '/utf-8', '/MT', path.join(directory, 'NetcattySftpDropTarget.cpp'),
    '/Fo:' + path.join(outputDir, 'NetcattySftpDropTarget.obj'), '/Fe:' + outputPath,
    '/link', '/MACHINE:' + (target === 'arm64' ? 'ARM64' : 'X64'),
    'ole32.lib', 'oleaut32.lib', 'shell32.lib', 'uuid.lib', 'user32.lib', 'gdi32.lib', 'gdiplus.lib', 'uiautomationcore.lib'];
  const compiler = env.CXX || 'cl.exe';
  if (compiler === 'cl.exe' && !hasInitializedMsvcEnvironment(env, target)) {
    const setup = findVisualStudioDevCmd(env);
    if (!setup) throw new Error('Initialize an MSVC developer environment before building the SFTP drop helper');
    const script = path.join(outputDir, 'build.cmd');
    const quote = value => '"' + value.replace(/"/g, '""') + '"';
    fs.writeFileSync(script, '@echo off\r\ncall ' + quote(setup) + ' -arch=' + target + ' -host_arch=x64\r\nif errorlevel 1 exit /b %errorlevel%\r\n' + [compiler, ...args].map(quote).join(' ') + '\r\n');
    run('cmd.exe', ['/d', '/c', script], { cwd: projectDir, env, stdio: 'inherit' });
  } else run(compiler, args, { cwd: projectDir, env, stdio: 'inherit' });
  if (readPeMachine(outputPath) !== getExpectedPeMachine(target)) throw new Error('SFTP drop helper architecture mismatch');
  return { skipped: false, outputPath };
}
if (require.main === module) console.log(buildSftpDropTarget());
module.exports = { buildSftpDropTarget };
