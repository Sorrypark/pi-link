import { randomUUID } from 'node:crypto';
import { Client } from 'ssh2';
import { formatSha256, normalizeHash } from './paths.js';
import { call } from './sftp-util.js';

export function openSession({ host, port, username, password, acceptHost, knownHosts }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let pending = null;
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('시간이 지나도 응답이 없습니다. 주소와 같은 네트워크인지 확인해 주세요.'), { status: 400 }));
    }, 22000);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* already closing */ }
      reject(error);
    }

    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish((prompts || []).map(() => password));
    });
    conn.on('ready', async () => {
      if (settled) return;
      try {
        const sftp = await openSftp(conn);
        let copier = sftp;
        try { copier = await openSftp(conn); } catch { copier = sftp; }
        const home = await call(sftp.realpath.bind(sftp), '.');
        settled = true;
        clearTimeout(timer);
        resolve(new PiSession({ conn, sftp, copier, home, host, port, username }));
      } catch (err) {
        fail(Object.assign(new Error('파일 목록을 열지 못했습니다.'), { status: 400, cause: err }));
      }
    });
    conn.on('error', (err) => fail(toConnectError(err, pending)));
    conn.on('close', () => {
      if (!settled) fail(toConnectError(new Error('연결이 바로 끊겼습니다.'), pending));
    });
    conn.connect({
      host,
      port,
      username,
      password,
      tryKeyboard: true,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier(hash) {
        const hex = normalizeHash(hash);
        const fingerprint = formatSha256(hex);
        const id = `${host}:${port}`;
        const decision = knownHosts.check(id, hex);
        if (decision === 'match') return true;
        if (decision === 'unknown' && acceptHost === 'new') {
          knownHosts.remember(id, hex);
          return true;
        }
        if (decision === 'changed' && acceptHost === 'changed') {
          knownHosts.remember(id, hex);
          return true;
        }
        pending = { decision, fingerprint };
        return false;
      },
    });
  });
}

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function toConnectError(err, pending) {
  if (pending?.decision === 'unknown' || pending?.decision === 'changed') {
    const error = new Error(pending.decision === 'unknown' ? '이 기기에 처음 연결합니다.' : '저장된 열쇠와 다릅니다.');
    error.code = pending.decision === 'unknown' ? 'HOST_UNKNOWN' : 'HOST_CHANGED';
    error.fingerprint = pending.fingerprint;
    error.status = 409;
    return error;
  }
  const error = new Error(explainSsh(err));
  error.status = 400;
  return error;
}

function explainSsh(err) {
  const msg = String(err?.message || err || '');
  if (/시간이 지나도|사용자 이름 또는 암호|SSH 연결을 거절|그 주소를/.test(msg)) return msg;
  if (/timed out|Timed out|ETIMEDOUT/i.test(msg)) return '시간이 지나도 응답이 없습니다. 주소와 같은 네트워크인지 확인해 주세요.';
  if (/ECONNREFUSED/.test(msg)) return 'SSH 연결을 거절했습니다. 파이에서 SSH가 켜져 있는지, 포트가 맞는지 확인해 주세요.';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '그 주소를 찾지 못했습니다.';
  if (/EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(msg)) return '그 주소까지 닿지 않습니다.';
  if (/authentication methods failed|All configured authentication/i.test(msg)) return '사용자 이름 또는 암호가 맞지 않습니다.';
  if (/Host key verification failed/i.test(msg)) return '기기 확인이 끝나지 않았습니다.';
  return '연결하지 못했습니다.';
}

export class PiSession {
  constructor({ conn, sftp, copier, home, host, port, username }) {
    this.id = randomUUID();
    this.conn = conn;
    this.sftp = sftp;
    this.copier = copier;
    this.home = home;
    this.host = host;
    this.port = port;
    this.username = username;
    this.closed = false;
    this.terminalOpen = false;
    this.shell = null;
    this.lastSeen = Date.now();
    this.transfers = new Map();
    this.browseChain = Promise.resolve();
    this.copyChain = Promise.resolve();
    conn.on('close', () => {
      this.closed = true;
    });
  }

  touch() {
    this.lastSeen = Date.now();
  }

  browse(fn) {
    return enqueue(this, 'browseChain', fn);
  }

  copy(fn) {
    return enqueue(this, 'copyChain', fn);
  }

  addJob(fields) {
    const job = {
      id: randomUUID(),
      title: fields.title,
      direction: fields.direction,
      transferred: 0,
      total: fields.total || 0,
      done: false,
      error: null,
      finishedAt: 0,
    };
    this.transfers.set(job.id, job);
    return job;
  }

  jobs() {
    const now = Date.now();
    for (const [id, job] of this.transfers) {
      if (job.done && job.finishedAt && now - job.finishedAt > 60_000) this.transfers.delete(id);
    }
    return [...this.transfers.values()].map((job) => ({
      id: job.id,
      title: job.title,
      direction: job.direction,
      transferred: job.transferred,
      total: job.total,
      done: job.done,
      error: job.error,
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.shell?.end(); } catch { /* shell already gone */ }
    try { this.conn.end(); } catch { /* connection already gone */ }
  }
}

function enqueue(session, key, fn) {
  const run = session[key].then(() => fn());
  session[key] = run.then(() => {}, () => {});
  return run;
}

export function attachTerminal(session, socket, size) {
  session.terminalOpen = true;
  session.touch();
  const cols = clamp(size.cols, 20, 400, 80);
  const rows = clamp(size.rows, 5, 200, 24);
  session.conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
    if (err || session.closed) {
      sendJson(socket, { t: 'error', error: '셸을 열지 못했습니다.' });
      socket.close();
      session.terminalOpen = false;
      return;
    }
    session.shell = stream;
    const send = (chunk) => {
      if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
      if (socket.bufferedAmount > 1024 * 1024) stream.pause();
    };
    stream.on('data', send);
    stream.stderr?.on('data', send);
    stream.on('close', () => {
      sendJson(socket, { t: 'exit' });
      if (socket.readyState === socket.OPEN) socket.close();
    });
    socket.on('message', (data, isBinary) => {
      session.touch();
      if (socket.bufferedAmount < 256 * 1024) stream.resume();
      if (!isBinary) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg?.t === 'resize') {
          const nextCols = clamp(msg.cols, 20, 400, 0);
          const nextRows = clamp(msg.rows, 5, 200, 0);
          if (nextCols && nextRows) stream.setWindow(nextRows, nextCols, 0, 0);
        }
        return;
      }
      stream.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    socket.on('close', () => {
      session.terminalOpen = false;
      session.touch();
      try { stream.end(); } catch { /* already closed */ }
      if (session.shell === stream) session.shell = null;
    });
    sendJson(socket, { t: 'ready' });
  });
}

function sendJson(socket, value) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
