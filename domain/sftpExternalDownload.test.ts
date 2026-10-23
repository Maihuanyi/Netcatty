import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWindowsDownloadName } from './sftpExternalDownload';

test('Windows download names preserve valid names and reject traversal/device names', () => {
  for (const name of ['file.txt', '文件夹', 'a b', '.env']) assert.doesNotThrow(() => assertWindowsDownloadName(name));
  for (const name of ['', '..', '.', 'x/y', 'x\\y', 'NUL', 'CON.txt', 'file:ads', 'x*', 'trailing.', 'trailing ', 'x\0y']) {
    assert.throws(() => assertWindowsDownloadName(name));
  }
});
