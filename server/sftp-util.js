import path from 'node:path';

export function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

export function fileError(err) {
  const msg = String(err?.message || err || '');
  if (/[가-힣]/.test(msg)) return msg;
  if (/no such file/i.test(msg) || err?.code === 'ENOENT') return '그 파일이나 폴더가 없습니다.';
  if (/permission denied/i.test(msg) || err?.code === 'EPERM' || err?.code === 'EACCES') return '권한이 없습니다.';
  if (/already exists/i.test(msg) || err?.code === 'EEXIST') return '같은 이름이 이미 있습니다.';
  if (/not a directory/i.test(msg) || err?.code === 'ENOTDIR') return '폴더가 아닙니다.';
  if (/directory not empty/i.test(msg) || err?.code === 'ENOTEMPTY') return '폴더가 비어 있지 않습니다.';
  if (/is a directory/i.test(msg) || err?.code === 'EISDIR') return '파일이 아니라 폴더입니다.';
  return '그 작업을 하지 못했습니다.';
}

export function isDir(stats) {
  if (!stats) return false;
  if (typeof stats.isDirectory === 'function') return stats.isDirectory();
  return (Number(stats.mode) & 0o170000) === 0o040000;
}

export function isLink(stats) {
  if (!stats) return false;
  if (typeof stats.isSymbolicLink === 'function') return stats.isSymbolicLink();
  return (Number(stats.mode) & 0o170000) === 0o120000;
}

export function mtimeMs(attrs) {
  const value = attrs?.mtime;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return null;
}

export async function lstat(sftp, target) {
  return call(sftp.lstat.bind(sftp), target);
}

export async function readdir(sftp, target) {
  const list = await call(sftp.readdir.bind(sftp), target);
  return (list || []).filter((entry) => entry.filename !== '.' && entry.filename !== '..');
}

export async function statOrNull(sftp, target) {
  try {
    return await lstat(sftp, target);
  } catch (err) {
    if (/no such file/i.test(String(err?.message || '')) || err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function mkdirp(sftp, dir) {
  const norm = path.posix.normalize(dir);
  if (!norm || norm === '/' || norm === '.') return;
  const parts = norm.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    const existing = await statOrNull(sftp, cur);
    if (!existing) {
      await call(sftp.mkdir.bind(sftp), cur);
      continue;
    }
    if (!isDir(existing)) throw Object.assign(new Error('폴더를 만들 위치에 파일이 있습니다.'), { status: 400 });
  }
}

export function fastPut(sftp, local, remote, onStep) {
  return call(sftp.fastPut.bind(sftp), local, remote, {
    step(transferred) {
      onStep?.(transferred);
    },
  });
}

export function fastGet(sftp, remote, local, onStep) {
  return call(sftp.fastGet.bind(sftp), remote, local, {
    step(transferred) {
      onStep?.(transferred);
    },
  });
}
