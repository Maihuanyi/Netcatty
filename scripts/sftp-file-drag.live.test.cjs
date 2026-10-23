"use strict";

// Opt-in: opens two fixture windows and drives real Windows mouse input and SFTP downloads.
// No user hosts, desktop files or installed Netcatty profiles are accessed.
if (!process.versions.electron || process.platform !== 'win32') {
  require('node:test')('SFTP native drag on Windows', { skip: 'run npm run test:sftp-file-drag:electron on Windows' }, () => {});
} else {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { spawn } = require('node:child_process');
  const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
  const { build } = require('esbuild');
  const { Server } = require('ssh2');
  const SftpClient = require('ssh2-sftp-client');
  const temp = require('../electron/bridges/tempDirBridge.cjs');
  temp.ensureTempDir();
  const fixture = fs.mkdtempSync(temp.getTempFilePath('sftp-native-live-'));
  console.log('SFTP_NATIVE_FIXTURE', fixture);
  app.setPath('userData', path.join(fixture, 'profile'));
  app.on('window-all-closed', () => {});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await fn(); if (result) return result; await wait(50); }
    throw new Error('SFTP live fixture timed out');
  }
  function powershell(script) {
    return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue'\n" + script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const destination = path.join(fixture, 'destination');
  fs.mkdirSync(destination);
  const landingFile = path.join(destination, 'landing-marker.txt');
  const landingFolder = path.join(destination, 'landing-folder');
  fs.writeFileSync(landingFile, 'Existing landing file\n');
  fs.mkdirSync(landingFolder);
  const inputType = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DragMouse {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; public POINT(int x, int y) { X=x; Y=y; } }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int Size; public int Flags; public IntPtr Cursor; public POINT Position; }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr window);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
 [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
 public static int CursorFlags() { var info=new CURSORINFO(); info.Size=Marshal.SizeOf(typeof(CURSORINFO)); if(!GetCursorInfo(ref info)) throw new System.ComponentModel.Win32Exception(); return info.Flags; }
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@`;
  let win, server, client;
  const connections = new Set();
  const reports = [];
  const files = new Map([
    ['/remote/file.txt', Buffer.from('Native SFTP drag contents\n')],
    ['/remote/folder/nested.txt', Buffer.from('Nested SFTP contents\n')],
    ['/remote/slow.bin', Buffer.alloc(256 * 1024, 73)],
    ['/remote/报告 & notes 2026.txt', Buffer.from('Unicode preview and download\n')],
  ]);
  const attrs = file => ({ size: files.get(file)?.length || 0, mode: files.has(file) ? 0o100644 : 0o40755,
    uid: 1, gid: 1, atime: 1700000000, mtime: 1700000000 });

  let reads = 0;
  const watchdog = setTimeout(() => { console.error('SFTP_DESTINATION_FAIL timeout'); app.exit(1); }, 90000);
  async function ps(script) {
    const child = powershell(script);
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => code ? reject(new Error(error || 'PowerShell failed')) : resolve());
    });
    return output.trim();
  }
  async function closeExplorer() {
    await ps(`$shell=New-Object -ComObject Shell.Application
      foreach($w in $shell.Windows()){try{if($w.Document.Folder.Self.Path -eq ${quote(destination)}){$w.Quit()}}catch{}}`);
  }
  app.whenReady().then(async () => {
    const bounds = screen.getPrimaryDisplay().workArea;
    await ps(`${inputType}
      $shell=New-Object -ComObject Shell.Application
      $shell.Explore(${quote(destination)})
      for($i=0;$i -lt 80;$i++){
        Start-Sleep -Milliseconds 100
        foreach($w in $shell.Windows()) {try { if($w.Document.Folder.Self.Path -eq ${quote(destination)}) {
          [DragMouse]::ShowWindow([IntPtr]([int64]$w.HWND),5) | Out-Null
          [DragMouse]::SetWindowPos([IntPtr]([int64]$w.HWND),[IntPtr](-1),760,80,700,600,0x0040) | Out-Null
          exit 0
        }}catch{}}
      }
      throw 'Fixture Explorer unavailable'`);
    const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    server = new Server({ hostKeys: [privateKey] }, connection => {
      connections.add(connection);
      connection.on('error', () => {});
      connection.on('close', () => connections.delete(connection));
      connection.on('authentication', context => context.username === 'fixture' ? context.accept() : context.reject());
      connection.on('ready', () => connection.on('session', accept => accept().on('sftp', acceptSftp => {
        const sftp = acceptSftp();
        const handles = new Map();
        const listed = new Set();
        let next = 0;
        sftp.on('error', () => {});
        const pathname = value => Buffer.isBuffer(value) ? value.toString() : value;
        sftp.on('REALPATH', (id, file) => sftp.name(id, [{ filename: pathname(file), longname: pathname(file), attrs: attrs(pathname(file)) }]));
        for (const operation of ['STAT', 'LSTAT']) sftp.on(operation, (id, file) => sftp.attrs(id, attrs(pathname(file))));
        sftp.on('FSTAT', (id, handle) => sftp.attrs(id, attrs(handles.get(handle.toString()))));
        for (const operation of ['OPEN', 'OPENDIR']) sftp.on(operation, (id, file) => {
          const handle = String(++next); handles.set(handle, pathname(file)); sftp.handle(id, Buffer.from(handle));
        });
        sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); listed.delete(handle.toString()); sftp.status(id, 0); });
        sftp.on('READDIR', (id, handle) => {
          if (listed.has(handle.toString())) return sftp.status(id, 1);
          listed.add(handle.toString());
          const parent = handles.get(handle.toString());
          sftp.name(id, [...files.keys()].filter(file => path.posix.dirname(file) === parent)
            .map(file => ({ filename: path.posix.basename(file), longname: file, attrs: attrs(file) })));
        });
        sftp.on('READ', (id, handle, position, length) => {
          const file = handles.get(handle.toString());
          const bytes = files.get(file); reads++;
          setTimeout(() => {
            if (sftp.destroyed) return;
            if (!bytes || position >= bytes.length) sftp.status(id, 1);
            else sftp.data(id, bytes.subarray(position, position + length));
          }, file?.endsWith('slow.bin') ? 600 : 0);
        });
      })));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture' });
    const sftpBridge = require('../electron/bridges/sftpBridge.cjs');
    const transferBridge = require('../electron/bridges/transferBridge.cjs');
    const sftpClients = new Map([['fixture', client]]);
    sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: require('electron') });
    transferBridge.init({ sftpClients });

    const preload = path.join(fixture, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer,webUtils}=require('electron');
      const {createPreloadApi}=require(${JSON.stringify(path.resolve(__dirname, '../electron/preload/api.cjs'))});
      contextBridge.exposeInMainWorld('netcatty',createPreloadApi({ipcRenderer,webUtils}));
      contextBridge.exposeInMainWorld('report',value=>ipcRenderer.send('fixture:report',value));`);
    const renderer = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {startSftpFileDrag} from './application/state/sftp/localFileDrag';
      import {useSftpFileDrag} from './application/state/sftp/useSftpFileDrag';
      import {useSftpTransfers} from './application/state/sftp/useSftpTransfers';
      import {useSftpPaneDragAndSelect} from './components/sftp/hooks/useSftpPaneDragAndSelect';
      window.selection=['file.txt','folder'];
      function Probe(){
        const [draggedFiles,setDraggedFiles]=React.useState(null);
        const receiver=useSftpPaneDragAndSelect({side:'right',
          pane:{id:'receiver',selectedFiles:new Set(),connection:{id:'receiver-ssh',currentPath:'/target',isLocal:false}},
          sortedDisplayFiles:[],draggedFiles,onDragStart:()=>{},
          onReceiveFromOtherPane:files=>window.report({internal:files}),
          onMoveEntriesToPath:async()=>{},onOpenEntry:()=>{},onRangeSelect:()=>{},onToggleSelection:()=>{}});
        const ops=useSftpTransfers({ownerId:'fixture',getActivePane:()=>null,
          getPaneByConnectionId:()=>null,getTabByConnectionId:()=>null,updateTab:()=>{},
          refresh:async()=>{},clearCacheForConnection:()=>{},handleSessionError:()=>{},
          sftpSessionsRef:{current:new Map()},connectionCacheKeyMapRef:{current:new Map()},
          listLocalFiles:async()=>[],listRemoteFiles:async(id,path,encoding)=>{
            const rows=await window.netcatty.listSftp(id,path,encoding);
            return rows.map(row=>({...row,sizeFormatted:'',lastModifiedFormatted:''}));
          }});
        const ref=React.useRef(null);
        ref.current={getActivePane:()=>({id:'pane',connection:{id:'remote',isLocal:false},filenameEncoding:'utf-8'}),
          getSftpIdForConnection:()=> 'fixture',downloadToLocal:async plan=>{
            window.report({download:plan}); const status=await ops.downloadToLocal(plan);window.report({completed:plan.fileName,status});return status;
          }};
        const start=useSftpFileDrag(ref,{t:key=>key,onQueued:directory=>window.report({queued:directory}),onError:error=>window.report({error})});
        return React.createElement(React.Fragment,null,React.createElement('div',{id:'source',draggable:true,
          onMouseDown:()=>window.report({mousedown:true}),
          onDragEnd:()=>setDraggedFiles(null),onDragStart:event=>startSftpFileDrag({
          event,paneId:'pane',connection:{id:'remote',isLocal:false},side:'left',
          sources:window.selection.map(name=>({name,sourcePath:'/remote',sourceConnectionId:'remote',isDirectory:name==='folder'})),
          onRemoteDrag:(files,side)=>setDraggedFiles(files.map(file=>({...file,side}))),
          onStartRemoteDrag:start,onError:error=>window.report({error})
        })},'Remote selection'),React.createElement('div',{id:'receiver',
          style:{height:50,background:'#a9d5aa'},onDragOver:receiver.handlePaneDragOver,
          onDrop:receiver.handlePaneDrop},'Official internal SFTP target'));
      }
      createRoot(document.querySelector('#root')).render(React.createElement(Probe));`;
    await build({stdin:{contents:renderer,loader:'ts',resolveDir:path.resolve(__dirname,'..')},
      bundle:true,platform:'browser',format:'iife',outfile:path.join(fixture,'renderer.js'),define:{'import.meta.env.DEV':'false'}});
    const html=path.join(fixture,'index.html');
    fs.writeFileSync(html,'<!doctype html><meta charset="utf-8"><style>body{background:#ddd;font:20px system-ui}#source{margin:40px;padding:40px;background:#89b9ff;cursor:grab}</style><p>SFTP destination fixture</p><div id="root"></div><script src="renderer.js"></script>');
    win=new BrowserWindow({x:bounds.x+20,y:bounds.y+80,width:600,height:400,alwaysOnTop:true,webPreferences:{preload,sandbox:false}});
    const windows=()=>[win];
    const tracker=require('../electron/bridges/localFileDragBridge.cjs').registerHandlers(ipcMain,{getWindows:windows,nativeImage,app});
    require('../electron/bridges/sftpFileDragBridge.cjs').registerHandlers(ipcMain,{getWindows:windows,getGesture:tracker.getGesture,app,
      run:(file,args,options)=>{const child=spawn(file,args,{...options,stdio:['pipe','pipe','pipe']});
        child.stdout.on('data',data=>console.log('SFTP_NATIVE_REPLY',data.toString().trim()));
        child.stderr.on('data',data=>console.log('SFTP_NATIVE_DEBUG',data.toString().trim()));return child;}});
    require('../electron/bridges/localFsBridge.cjs').registerHandlers(ipcMain);
    ipcMain.handle('netcatty:sftp:stat',sftpBridge.statSftp);
    ipcMain.handle('netcatty:sftp:realpath',sftpBridge.realpathSftp);
    ipcMain.handle('netcatty:sftp:list',sftpBridge.listSftp);
    transferBridge.registerHandlers(ipcMain);
    ipcMain.on('fixture:report',(_event,value)=>{reports.push(value);console.log('SFTP_DESTINATION_REPORT',JSON.stringify(value));});
    await win.loadFile(html);
    await until(()=>win.webContents.executeJavaScript('!!document.querySelector("#source")'));
    // Creating the source window can restack topmost windows. Pin only our
    // isolated destination again before probing the physical desktop.
    await ps(`${inputType}
      $shell=New-Object -ComObject Shell.Application
      foreach($w in $shell.Windows()){try{if($w.Document.Folder.Self.Path -eq ${quote(destination)}){
        [DragMouse]::SetWindowPos([IntPtr]([int64]$w.HWND),[IntPtr](-1),760,80,700,600,0x0040) | Out-Null
      }}catch{}}`);
    await wait(250);
    const helper=require('../electron/bridges/sftpFileDragBridge.cjs').helperPath(app);
    let loggedProbe = false;
    const probe=await until(async()=>{const result=await new Promise((resolve,reject)=>{
      const child=spawn(helper,['--probe','1000','380'],{windowsHide:true});let output='',error='';
      child.stderr.on('data', data=>{error+=data;});
      child.stdout.on('data',data=>{output+=data});child.on('error',reject);
      child.on('close',()=>{try{if(!loggedProbe){console.log('SFTP_INITIAL_PROBE',output,error);loggedProbe=true;}resolve(JSON.parse(output));}catch(error){reject(error);}});
    });return result.directory===destination?result:null;});
    assert.equal(probe.directory,destination,'must verify target before mouse input');
    async function itemPoint(name) {
      const output = await ps(`Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $shell=New-Object -ComObject Shell.Application
        foreach($w in $shell.Windows()){try{if($w.Document.Folder.Self.Path -eq ${quote(destination)}){
          $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$w.HWND))
          $condition=New-Object System.Windows.Automation.OrCondition(
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::ListItem)),
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::DataItem)))
          foreach($item in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)){
            if($item.Current.Name -eq ${quote(name)} -or $item.Current.Name -eq ${quote(path.parse(name).name)}){
              $rect=$item.Current.BoundingRectangle
              @{x=[int]($rect.Left+[Math]::Min(40,$rect.Width/2));y=[int]($rect.Top+$rect.Height/2)} | ConvertTo-Json -Compress
              exit 0
            }
          }
        }}catch{}}
        throw 'Fixture shell item unavailable'`);
      return JSON.parse(output);
    }
    const filePoint = await itemPoint('landing-marker.txt');
    const folderPoint = await itemPoint('landing-folder');
    async function probePoint(point, expected) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(helper, ['--probe', String(point.x), String(point.y)], {windowsHide:true});
        let output = '';
        child.stdout.on('data', data => {output += data;});
        child.on('error', reject);
        child.on('close', () => {try {resolve(JSON.parse(output));} catch(error) {reject(error);}});
      });
      assert.equal(result.directory, expected);
    }
    await probePoint(filePoint, destination);
    await probePoint(folderPoint, landingFolder);
    console.log('SFTP_SHELL_FILE_PARENT_AND_FOLDER_PROBE_PASS');
    let previewCapture = 0;
    async function drag(cancel=false,internal=false,landing=null,returning=false){
      win.show();win.focus();
      const rect=await win.webContents.executeJavaScript('document.querySelector("#source").getBoundingClientRect().toJSON()');
      const content=win.getContentBounds(), x=Math.round(content.x+rect.x+40),y=Math.round(content.y+rect.y+40);
      const target=internal?await win.webContents.executeJavaScript('document.querySelector("#receiver").getBoundingClientRect().toJSON()'):null;
      const dropX=internal?Math.round(content.x+target.x+80):(landing?.x ?? 1000);
      const dropY=internal?Math.round(content.y+target.y+20):(landing?.y ?? 380);
      const before=reads, count=reports.filter(row=>row.download).length;
      const sourceHandle=win.getNativeWindowHandle().readBigUInt64LE().toString();
      const driver=ps(`${inputType}
        [DragMouse]::SetProcessDPIAware() | Out-Null
        [DragMouse]::SetWindowPos([IntPtr](${sourceHandle}),[IntPtr](-1),0,0,0,0,0x0043) | Out-Null
        [DragMouse]::SetCursorPos(${x},${y}) | Out-Null
        Start-Sleep -Milliseconds 150
        $sourceAt=[DragMouse]::GetAncestor([DragMouse]::WindowFromPoint((New-Object DragMouse+POINT(${x},${y}))),2)
        if($sourceAt -ne [IntPtr](${sourceHandle})){throw "Source covered: $sourceAt expected ${sourceHandle}"}
        [DragMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        try {
        Start-Sleep -Milliseconds 150
        [DragMouse]::SetCursorPos(${x+45},${y}) | Out-Null
        Start-Sleep -Milliseconds 350
        ${returning ? `[DragMouse]::SetCursorPos(1000,380) | Out-Null
        Start-Sleep -Milliseconds 500
        if([DragMouse]::CursorFlags() -band 1){throw 'External cursor must hide before returning'}` : ''}
        [DragMouse]::SetCursorPos(${dropX},${dropY}) | Out-Null
        Start-Sleep -Milliseconds 1600
        ${cancel ? "(New-Object -ComObject WScript.Shell).SendKeys('{ESC}')" : ''}
        $cursorFlags=[DragMouse]::CursorFlags()
        ${!cancel && !internal ? "if($cursorFlags -band 1){throw 'External system cursor must be hidden'}" : ''}
        ${!cancel && !internal ? `Add-Type -AssemblyName System.Drawing
        $preview=[DragMouse]::FindWindow('NetcattySftpDropFeedback','Netcatty SFTP destination')
        $previewRect=New-Object DragMouse+RECT
        if($preview -eq [IntPtr]::Zero -or ![DragMouse]::GetWindowRect($preview,[ref]$previewRect)){throw 'Preview missing'}
        $bitmap=New-Object Drawing.Bitmap(($previewRect.Right-$previewRect.Left),($previewRect.Bottom-$previewRect.Top))
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($previewRect.Left,$previewRect.Top,0,0,$bitmap.Size)
        $bitmap.Save(${quote(path.join(fixture,`preview-${++previewCapture}.png`))})
        $graphics.Dispose();$bitmap.Dispose()` : ''}
        Start-Sleep -Milliseconds 100
        } finally { [DragMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
        [DragMouse]::SetCursorPos(${dropX+1},${dropY+1}) | Out-Null
        Start-Sleep -Milliseconds 800
        [DragMouse]::SetCursorPos(${dropX+2},${dropY+2}) | Out-Null
        Start-Sleep -Milliseconds 100
        $cursorFlags=[DragMouse]::CursorFlags()
        if(!($cursorFlags -band 1)){throw "System cursor must recover after the gesture: flags=$cursorFlags"}`);
      await wait(1500);
      assert.equal(reads,before,'no SFTP content read while mouse held');
      assert.equal(reports.filter(row=>row.download).length,count,'no queue entry before release');
      await driver;
    }
    await drag(false,true);
    await until(()=>reports.some(row=>row.internal));
    assert.equal(reports.find(row=>row.internal).internal[0].sourceConnectionId,'remote');
    assert.equal(reads,0);assert.equal(reports.filter(row=>row.download).length,0);
    console.log('SFTP_OFFICIAL_INTERNAL_HTML_DRAG_PASS');
    const internalBefore = reports.filter(row=>row.internal).length;
    await drag(false,true,null,true);
    await until(()=>reports.filter(row=>row.internal).length===internalBefore+1);
    assert.equal(reads,0);assert.equal(reports.filter(row=>row.download).length,0);
    console.log('SFTP_EXTERNAL_RETURN_TO_OFFICIAL_INTERNAL_DRAG_PASS');
    await drag(true);await wait(300);
    assert.equal(reads,0);assert.equal(reports.filter(row=>row.download).length,0);
    await drag();
    await until(()=>reports.filter(row=>row.completed).length===2);
    assert.equal(fs.readFileSync(path.join(destination,'file.txt'),'utf8'),files.get('/remote/file.txt').toString());
    assert.equal(fs.readFileSync(path.join(destination,'folder','nested.txt'),'utf8'),files.get('/remote/folder/nested.txt').toString());
    await win.webContents.executeJavaScript("window.selection=['slow.bin']");
    await drag(false,false,await itemPoint('landing-marker.txt'));await until(()=>reports.some(row=>row.completed==='slow.bin'));
    assert.deepEqual(fs.readFileSync(path.join(destination,'slow.bin')),files.get('/remote/slow.bin'));
    assert.equal(fs.readFileSync(landingFile,'utf8'),'Existing landing file\n','landing file stays unchanged');
    console.log('SFTP_DROP_ON_FILE_DOWNLOADS_TO_PARENT_PASS');
    await win.webContents.executeJavaScript("window.selection=['报告 & notes 2026.txt']");
    const completedBefore = reports.filter(row=>row.completed).length;
    await drag(false,false,await itemPoint('landing-folder'));
    await until(()=>reports.filter(row=>row.completed).length===completedBefore+1);
    assert.deepEqual(fs.readFileSync(path.join(landingFolder,'报告 & notes 2026.txt')),files.get('/remote/报告 & notes 2026.txt'));
    console.log('SFTP_DROP_ON_FOLDER_DOWNLOADS_INSIDE_PASS');
    assert.equal(reports.filter(row=>row.error).length,0,JSON.stringify(reports));
    assert.ok(reports.filter(row=>row.download).every(row=>[destination,landingFolder].includes(path.dirname(row.download.targetPath))));
    console.log('SFTP_DESTINATION_REAL_QUEUE_PASS',fixture);
  }).then(async()=>{
    clearTimeout(watchdog);await closeExplorer();win?.destroy();
    await client?.end();for(const connection of connections)connection.end();
    await new Promise(resolve=>server.close(resolve));app.exit(0);
  }).catch(async error=>{
    fs.writeFileSync(path.join(fixture,'failure.txt'),error.stack);console.error('SFTP_DESTINATION_FAIL',error,fixture);
    clearTimeout(watchdog);await closeExplorer().catch(()=>{});win?.destroy();
    await client?.end().catch(()=>{});for(const connection of connections)connection.end();server?.close();setTimeout(()=>app.exit(1),100);
  });
}
