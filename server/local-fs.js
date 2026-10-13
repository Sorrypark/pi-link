import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertLocal, assertName, localParent } from './paths.js';

let drivesCache = { at: 0, drives: null };

export async function listLocal(rawPath) {
  const resolved = assertLocal(rawPath);
  if (!resolved) {
    const drives = await listDrives();
    return {
      path: '',
      parent: null,
      entries: drives.map((drive) => ({
        name: drive,
        path: `${drive}\\`,
        type: 'dir',
        size: null,
        mtime: null,
      })),
    };
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw Object.assign(new Error('폴더가 아닙니다.'), { status: 400 });
  const dirents = await readdir(resolved, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    const full = path.join(resolved, dirent.name);
    let type = 'file';
    if (dirent.isDirectory()) type = 'dir';
    else if (dirent.isSymbolicLink()) type = 'link';
    let size = null;
    let mtime = null;
    try {
      const item = await lstat(full);
      size = type === 'file' ? item.size : null;
      mtime = item.mtimeMs;
    } catch {
      size = null;
    }
    entries.push({ name: dirent.name, path: full, type, size, mtime });
  }
  entries.sort(byName);
  return { path: resolved, parent: localParent(resolved), entries };
}

export async function mkdirLocal(rawDir, name) {
  const dir = assertLocal(rawDir);
  if (!dir) throw Object.assign(new Error('드라이브를 고른 뒤에는 그 안의 폴더를 여세요.'), { status: 400 });
  const full = path.join(dir, assertName(name));
  await mkdir(full);
  return full;
}

export async function renameLocal(rawPath, name) {
  const from = assertLocal(rawPath);
  if (!from) throw Object.assign(new Error('드라이브 이름은 바꿀 수 없습니다.'), { status: 400 });
  const to = path.join(path.dirname(from), assertName(name));
  await rename(from, to);
  return to;
}

export async function removeLocal(rawPath) {
  const target = assertLocal(rawPath);
  if (!target) throw Object.assign(new Error('드라이브는 지울 수 없습니다.'), { status: 400 });
  const info = await lstat(target);
  if (info.isSymbolicLink()) await rm(target);
  else await rm(target, { recursive: true });
}

async function listDrives() {
  if (drivesCache.drives && Date.now() - drivesCache.at < 30_000) return drivesCache.drives;
  const drives = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID }'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(['C:']);
        const list = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Z]:$/.test(line));
        resolve(list.length ? list : ['C:']);
      },
    );
  });
  drivesCache = { at: Date.now(), drives };
  return drives;
}

function byName(a, b) {
  if (a.type === 'dir' && b.type !== 'dir') return -1;
  if (b.type === 'dir' && a.type !== 'dir') return 1;
  return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
}
