import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertLocal, assertRemote } from './paths.js';
import { fastGet, fastPut, fileError, isDir, isLink, lstat as sftpLstat, mkdirp, readdir as sftpReaddir } from './sftp-util.js';

export function startTransfer(session, { direction, paths, destDir }) {
  const sources = Array.isArray(paths) ? paths : [];
  if (!sources.length) throw Object.assign(new Error('옮길 파일을 먼저 선택해 주세요.'), { status: 400 });
  const title = jobTitle(sources);
  const job = session.addJob({ title, direction, total: 0 });
  const run = direction === 'put'
    ? () => putMany(session, sources, destDir, job)
    : () => getMany(session, sources, destDir, job);
  session.copy(() => run())
    .then(() => finish(job, null))
    .catch((err) => finish(job, fileError(err)));
  return publicJob(job);
}

export function startUpload(session, remoteDir, files, cleanup = async () => {}) {
  const dir = assertRemote(remoteDir);
  if (!files.length) throw Object.assign(new Error('올릴 파일이 없습니다.'), { status: 400 });
  const job = session.addJob({
    title: jobTitle(files.map((file) => file.rel)),
    direction: 'upload',
    total: 0,
  });
  session.copy(async () => {
    let before = 0;
    for (const file of files) {
      const info = await stat(file.tmp);
      job.total += info.size;
      const dest = path.posix.join(dir, file.rel);
      await mkdirp(session.copier, path.posix.dirname(dest));
      await fastPut(session.copier, file.tmp, dest, (transferred) => {
        job.transferred = before + transferred;
      });
      before += info.size;
      job.transferred = before;
    }
  }).then(() => finish(job, null)).catch((err) => finish(job, fileError(err))).finally(() => {
    cleanup().catch(() => {});
  });
  return publicJob(job);
}

function finish(job, error) {
  job.error = error;
  job.done = true;
  job.finishedAt = Date.now();
  if (!error) job.transferred = Math.max(job.transferred, job.total);
}

async function putMany(session, sources, rawDest, job) {
  const destDir = assertRemote(rawDest);
  const locals = sources.map((item) => assertLocal(item)).filter(Boolean);
  if (!locals.length) throw Object.assign(new Error('노트북 파일을 선택해 주세요.'), { status: 400 });
  const planned = [];
  for (const local of locals) planned.push(...await planLocal(local, destDir));
  if (!planned.length) throw Object.assign(new Error('링크는 건너뜁니다. 파일이나 폴더를 선택해 주세요.'), { status: 400 });
  job.total = planned.reduce((sum, item) => sum + item.size, 0);
  let before = 0;
  for (const item of planned) {
    if (item.kind === 'dir') {
      await mkdirp(session.copier, item.remote);
      continue;
    }
    await mkdirp(session.copier, path.posix.dirname(item.remote));
    await fastPut(session.copier, item.local, item.remote, (transferred) => {
      job.transferred = before + transferred;
    });
    before += item.size;
    job.transferred = before;
  }
}

async function getMany(session, sources, rawDest, job) {
  const destDir = assertLocal(rawDest);
  if (!destDir) throw Object.assign(new Error('노트북에서 폴더를 먼저 여세요.'), { status: 400 });
  const remotes = sources.map((item) => assertRemote(item));
  const planned = [];
  for (const remote of remotes) planned.push(...await planRemote(session.copier, remote, destDir));
  if (!planned.length) throw Object.assign(new Error('링크는 건너뜁니다. 파일이나 폴더를 선택해 주세요.'), { status: 400 });
  job.total = planned.reduce((sum, item) => sum + item.size, 0);
  let before = 0;
  for (const item of planned) {
    if (item.kind === 'dir') {
      await mkdir(item.local, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(item.local), { recursive: true });
    await fastGet(session.copier, item.remote, item.local, (transferred) => {
      job.transferred = before + transferred;
    });
    before += item.size;
    job.transferred = before;
  }
}

async function planLocal(local, destDir) {
  const info = await lstat(local);
  const name = path.basename(local);
  if (info.isSymbolicLink()) return [];
  if (info.isDirectory()) {
    const root = path.posix.join(destDir, name);
    const planned = [{ kind: 'dir', remote: root, size: 0 }];
    const names = await readdir(local);
    for (const child of names) {
      planned.push(...await planLocal(path.join(local, child), root));
    }
    return planned;
  }
  return [{ kind: 'file', local, remote: path.posix.join(destDir, name), size: info.size }];
}

async function planRemote(sftp, remote, destDir) {
  const info = await sftpLstat(sftp, remote);
  const name = path.posix.basename(remote);
  if (isLink(info)) return [];
  if (isDir(info)) {
    const root = path.join(destDir, name);
    const planned = [{ kind: 'dir', local: root, size: 0 }];
    const list = await sftpReaddir(sftp, remote);
    for (const entry of list) {
      planned.push(...await planRemote(sftp, path.posix.join(remote, entry.filename), root));
    }
    return planned;
  }
  return [{ kind: 'file', remote, local: path.join(destDir, name), size: Number(info.size || 0) }];
}

function jobTitle(paths) {
  const first = path.basename(String(paths[0] || '').replace(/[\\/]+$/, '')) || '파일';
  return paths.length === 1 ? first : `${first} 외 ${paths.length - 1}개`;
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    direction: job.direction,
    transferred: job.transferred,
    total: job.total,
    done: job.done,
    error: job.error,
  };
}
