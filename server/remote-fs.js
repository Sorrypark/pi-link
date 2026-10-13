import path from 'node:path';
import { assertName, assertRemote, remoteParent } from './paths.js';
import { call, isDir, isLink, lstat, mkdirp, mtimeMs, readdir } from './sftp-util.js';

export function listRemote(session, rawPath) {
  const dir = assertRemote(rawPath || session.home || '/');
  return session.browse(async () => {
    const list = await readdir(session.sftp, dir);
    const entries = list.map((entry) => {
      const type = isLink(entry.attrs) ? 'link' : isDir(entry.attrs) ? 'dir' : 'file';
      return {
        name: entry.filename,
        path: path.posix.join(dir, entry.filename),
        type,
        size: type === 'file' ? Number(entry.attrs?.size || 0) : null,
        mtime: mtimeMs(entry.attrs),
      };
    });
    entries.sort(byName);
    return { path: dir, parent: remoteParent(dir), entries };
  });
}

export function mkdirRemote(session, rawDir, name) {
  const dir = assertRemote(rawDir);
  const full = path.posix.join(dir, assertName(name));
  return session.browse(async () => {
    await call(session.sftp.mkdir.bind(session.sftp), full);
    return full;
  });
}

export function renameRemote(session, rawPath, name) {
  const from = assertRemote(rawPath);
  const to = path.posix.join(path.posix.dirname(from), assertName(name));
  return session.browse(async () => {
    await call(session.sftp.rename.bind(session.sftp), from, to);
    return to;
  });
}

export function removeRemote(session, rawPath) {
  const target = assertRemote(rawPath);
  return session.browse(async () => {
    await removeTree(session.sftp, target);
  });
}

async function removeTree(sftp, target) {
  const info = await lstat(sftp, target);
  if (isLink(info) || !isDir(info)) {
    await call(sftp.unlink.bind(sftp), target);
    return;
  }
  const list = await readdir(sftp, target);
  for (const entry of list) {
    await removeTree(sftp, path.posix.join(target, entry.filename));
  }
  await call(sftp.rmdir.bind(sftp), target);
}

function byName(a, b) {
  if (a.type === 'dir' && b.type !== 'dir') return -1;
  if (b.type === 'dir' && a.type !== 'dir') return 1;
  return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
}

export { mkdirp };
