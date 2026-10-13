import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';

const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
const DIR_MODE = constants.S_IFDIR | 0o755;
const FILE_MODE = constants.S_IFREG | 0o644;

export function startMock(options = {}) {
  const password = options.password ?? 'secret';
  const username = options.username ?? 'pi';
  const hostKey = options.hostKey || ssh2.utils.generateKeyPairSync('ed25519').private;
  const vfs = options.vfs || createVfs();
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => authenticate(ctx, username, password));
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('window-change', (acceptWin) => { if (acceptWin) acceptWin(); });
        session.on('shell', (acceptShell) => openShell(acceptShell()));
        session.on('sftp', (acceptSftp) => attachSftp(acceptSftp(), vfs));
      });
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      server.on('error', () => {});
      resolve({
        port: server.address().port,
        hostKey,
        vfs,
        close() {
          for (const client of clients) {
            try { client.end(); } catch { /* already closed */ }
          }
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function authenticate(ctx, username, password) {
  if (ctx.method === 'none') {
    ctx.reject(['password']);
    return;
  }
  if (ctx.method === 'keyboard-interactive') {
    ctx.prompt([{ prompt: 'Password: ', echo: false }], (responses) => {
      const answer = Array.isArray(responses) ? responses[0] : '';
      if (sameSecret(ctx.username, username) && sameSecret(answer, password)) ctx.accept();
      else ctx.reject(['password']);
    });
    return;
  }
  if (ctx.method === 'password' && sameSecret(ctx.username, username) && sameSecret(ctx.password, password)) {
    ctx.accept();
    return;
  }
  ctx.reject(['password']);
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function openShell(stream) {
  stream.write('READY\r\n');
  stream.on('data', (data) => stream.write(data));
}

export function createVfs() {
  const nodes = new Map();
  const vfs = { nodes };
  addDir(vfs, '/');
  addDir(vfs, '/home');
  addDir(vfs, '/home/pi');
  addFile(vfs, '/home/pi/readme.txt', 'hello pi\n');
  addDir(vfs, '/home/pi/docs');
  addFile(vfs, '/home/pi/docs/inside.txt', 'inside\n');
  return vfs;
}

function addDir(vfs, target) {
  vfs.nodes.set(target, { type: 'dir', mtime: nowSeconds() });
}

function addFile(vfs, target, text) {
  vfs.nodes.set(target, { type: 'file', data: Buffer.from(text), mtime: nowSeconds() });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function resolvePath(input) {
  const raw = String(input ?? '');
  if (raw === '' || raw === '.' || raw === './') return '/home/pi';
  const abs = raw.startsWith('/') ? raw : path.posix.join('/home/pi', raw);
  const normal = path.posix.normalize(abs);
  return normal === '/' ? '/' : normal.replace(/\/+$/, '');
}

function attrsOf(node) {
  return {
    mode: node.type === 'dir' ? DIR_MODE : FILE_MODE,
    uid: 1000,
    gid: 1000,
    size: node.type === 'file' ? node.data.length : 0,
    atime: node.mtime,
    mtime: node.mtime,
  };
}

function listDir(vfs, dir) {
  const names = [];
  const self = vfs.nodes.get(dir);
  if (self) names.push({ filename: '.', longname: '.', attrs: attrsOf(self) });
  const parentPath = dir === '/' ? '/' : path.posix.dirname(dir);
  const parent = vfs.nodes.get(parentPath);
  if (parent) names.push({ filename: '..', longname: '..', attrs: attrsOf(parent) });
  const prefix = dir === '/' ? '/' : `${dir}/`;
  for (const [full, node] of vfs.nodes) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    if (!rest || rest.includes('/')) continue;
    names.push({ filename: rest, longname: rest, attrs: attrsOf(node) });
  }
  return names;
}

function childCount(vfs, dir) {
  return listDir(vfs, dir).filter((entry) => entry.filename !== '.' && entry.filename !== '..').length;
}

function movePath(vfs, from, to) {
  if (!vfs.nodes.has(from)) return 'missing';
  if (from === to) return 'ok';
  const parent = vfs.nodes.get(path.posix.dirname(to));
  if (!parent || parent.type !== 'dir') return 'missing';
  const keys = [...vfs.nodes.keys()].filter((key) => key === from || key.startsWith(`${from}/`));
  const moves = keys.map((key) => [key, to + key.slice(from.length)]);
  if (moves.some(([, dest]) => vfs.nodes.has(dest) && !keys.includes(dest))) return 'exists';
  for (const [key, dest] of moves) vfs.nodes.set(dest, vfs.nodes.get(key));
  for (const [key] of moves) {
    if (!moves.some(([, dest]) => dest === key)) vfs.nodes.delete(key);
  }
  return 'ok';
}

function attachSftp(sftp, vfs) {
  const handles = new Map();
  let nextId = 1;

  function replyMissing(reqid) {
    sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE, 'No such file');
  }

  function openHandle(kind, extra) {
    const id = nextId;
    nextId += 1;
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id);
    handles.set(id, { kind, ...extra });
    return handle;
  }

  function useHandle(handle) {
    if (!Buffer.isBuffer(handle) || handle.length !== 4) return null;
    return handles.get(handle.readUInt32BE(0)) || null;
  }

  sftp.on('REALPATH', (reqid, target) => {
    const resolved = resolvePath(target);
    const node = vfs.nodes.get(resolved);
    if (!node) return replyMissing(reqid);
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrsOf(node) }]);
  });

  sftp.on('STAT', onStat);
  sftp.on('LSTAT', onStat);
  function onStat(reqid, target) {
    const node = vfs.nodes.get(resolvePath(target));
    if (!node) return replyMissing(reqid);
    sftp.attrs(reqid, attrsOf(node));
  }

  sftp.on('OPENDIR', (reqid, target) => {
    const resolved = resolvePath(target);
    const node = vfs.nodes.get(resolved);
    if (!node) return replyMissing(reqid);
    if (node.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Not a directory');
    sftp.handle(reqid, openHandle('dir', { path: resolved, listed: false }));
  });

  sftp.on('READDIR', (reqid, handle) => {
    const state = useHandle(handle);
    if (!state || state.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Failure');
    if (state.listed) return sftp.status(reqid, STATUS_CODE.EOF);
    state.listed = true;
    sftp.name(reqid, listDir(vfs, state.path));
  });

  sftp.on('OPEN', (reqid, filename, flags) => {
    const resolved = resolvePath(filename);
    let node = vfs.nodes.get(resolved);
    if (node?.type === 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Is a directory');
    if (!node) {
      if ((flags & OPEN_MODE.CREAT) === 0) return replyMissing(reqid);
      const parent = vfs.nodes.get(path.posix.dirname(resolved));
      if (!parent || parent.type !== 'dir') return replyMissing(reqid);
      node = { type: 'file', data: Buffer.alloc(0), mtime: nowSeconds() };
      vfs.nodes.set(resolved, node);
    } else if (flags & OPEN_MODE.EXCL) {
      return sftp.status(reqid, STATUS_CODE.FAILURE, 'already exists');
    }
    if ((flags & OPEN_MODE.TRUNC) && (flags & OPEN_MODE.WRITE)) node.data = Buffer.alloc(0);
    sftp.handle(reqid, openHandle('file', { node }));
  });

  sftp.on('FSTAT', (reqid, handle) => {
    const state = useHandle(handle);
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Failure');
    sftp.attrs(reqid, attrsOf(state.node));
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const state = useHandle(handle);
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Failure');
    const off = Number(offset);
    const len = Number(length);
    if (!Number.isFinite(off) || off >= state.node.data.length) return sftp.status(reqid, STATUS_CODE.EOF);
    const end = Math.min(state.node.data.length, off + len);
    sftp.data(reqid, state.node.data.subarray(off, end));
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const state = useHandle(handle);
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Failure');
    const off = Number(offset);
    const src = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!Number.isFinite(off) || off < 0) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Failure');
    const end = off + src.length;
    if (state.node.data.length < end) {
      const next = Buffer.alloc(end);
      state.node.data.copy(next);
      state.node.data = next;
    }
    src.copy(state.node.data, off);
    state.node.mtime = nowSeconds();
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('CLOSE', (reqid, handle) => {
    if (!Buffer.isBuffer(handle) || handle.length !== 4 || !handles.delete(handle.readUInt32BE(0))) {
      return sftp.status(reqid, STATUS_CODE.FAILURE, 'Failure');
    }
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('MKDIR', (reqid, target) => {
    const resolved = resolvePath(target);
    if (vfs.nodes.has(resolved)) return sftp.status(reqid, STATUS_CODE.FAILURE, 'already exists');
    const parent = vfs.nodes.get(path.posix.dirname(resolved));
    if (!parent || parent.type !== 'dir') return replyMissing(reqid);
    addDir(vfs, resolved);
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('RMDIR', (reqid, target) => {
    const resolved = resolvePath(target);
    const node = vfs.nodes.get(resolved);
    if (!node) return replyMissing(reqid);
    if (node.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Not a directory');
    if (childCount(vfs, resolved)) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Directory not empty');
    vfs.nodes.delete(resolved);
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('REMOVE', (reqid, target) => {
    const resolved = resolvePath(target);
    const node = vfs.nodes.get(resolved);
    if (!node) return replyMissing(reqid);
    if (node.type === 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Is a directory');
    vfs.nodes.delete(resolved);
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('RENAME', (reqid, from, to) => {
    const result = movePath(vfs, resolvePath(from), resolvePath(to));
    if (result === 'missing') return replyMissing(reqid);
    if (result === 'exists') return sftp.status(reqid, STATUS_CODE.FAILURE, 'already exists');
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
}
