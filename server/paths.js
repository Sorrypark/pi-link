import path from 'node:path';

export function parseTarget(rawHost, rawUser, rawPort) {
  let host = String(rawHost || '').trim();
  let username = String(rawUser || '').trim();
  let port = rawPort == null || rawPort === '' ? 22 : Number(rawPort);

  host = host.replace(/^ssh\s+/i, '');
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.split('/')[0];

  const at = host.lastIndexOf('@');
  if (at > 0) {
    const userPart = host.slice(0, at);
    const hostPart = host.slice(at + 1);
    if (userPart && hostPart && !/\s/.test(userPart)) {
      if (!username) username = userPart;
      host = hostPart;
    }
  }

  if (host.startsWith('[') && host.includes(']')) {
    const end = host.indexOf(']');
    const rest = host.slice(end + 1);
    host = host.slice(1, end);
    if (rest.startsWith(':')) port = Number(rest.slice(1));
  } else {
    const m = host.match(/^(.*):(\d+)$/);
    if (m && m[1] && !m[1].includes(':')) {
      host = m[1];
      port = Number(m[2]);
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw bad('포트는 1부터 65535까지입니다.');
  }
  if (!host || host.length > 253 || /[\s\u0000-\u001f]/.test(host)) {
    throw bad('아이피 주소나 이름을 확인해 주세요.');
  }
  if (!username || username.length > 128 || /[\u0000-\u001f\s]/.test(username)) {
    throw bad('사용자 이름을 확인해 주세요.');
  }
  return { host, port, username };
}

export function assertName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || /[\\/\u0000]/.test(n)) {
    throw bad('그 이름은 쓸 수 없습니다.');
  }
  return n;
}

export function assertRemote(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\0')) {
    throw bad('경로가 올바르지 않습니다.');
  }
  const n = path.posix.normalize(raw);
  if (!n.startsWith('/')) throw bad('경로가 올바르지 않습니다.');
  return n === '/' ? '/' : n.replace(/\/+$/, '');
}

export function remoteParent(raw) {
  const n = assertRemote(raw);
  if (n === '/') return null;
  const parent = path.posix.dirname(n);
  return parent === n ? null : parent;
}

export function assertLocal(raw) {
  if (raw == null) throw bad('경로가 올바르지 않습니다.');
  const text = String(raw);
  if (text === '') return '';
  if (text.includes('\0') || text.includes('\\\\.\\') || text.includes('\\\\?\\')) {
    throw bad('그 폴더는 열 수 없습니다.');
  }
  let resolved = /^[A-Za-z]:$/.test(text) ? `${text[0].toUpperCase()}:\\` : path.resolve(text);
  const root = path.parse(resolved).root;
  if (!/^[A-Za-z]:\\$/.test(root)) throw bad('그 폴더는 열 수 없습니다.');
  const base = path.win32.basename(resolved);
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(base)) {
    throw bad('그 폴더는 열 수 없습니다.');
  }
  return resolved;
}

export function localParent(raw) {
  const resolved = assertLocal(raw);
  if (!resolved) return null;
  const root = path.parse(resolved).root;
  if (resolved.toLowerCase() === root.toLowerCase()) return '';
  return path.dirname(resolved);
}

export function formatSha256(hex) {
  const clean = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (clean.length < 32 || clean.length % 2 !== 0) return String(hex || '');
  const b64 = Buffer.from(clean, 'hex').toString('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

export function normalizeHash(hash) {
  if (Buffer.isBuffer(hash)) return hash.toString('hex');
  const text = String(hash || '').trim().toLowerCase();
  if (/^[0-9a-f]{2}(:[0-9a-f]{2})+$/.test(text)) return text.replace(/:/g, '');
  return text.replace(/[^0-9a-f]/g, '');
}

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
