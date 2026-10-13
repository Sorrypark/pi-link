import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function openKnownHosts(file) {
  let hosts = {};
  if (exists(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('known-hosts.json 파일을 읽지 못했습니다.');
    }
    hosts = parsed;
  }

  function save() {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(hosts, null, 2));
    renameSync(tmp, file);
  }

  return {
    check(id, hex) {
      const row = hosts[id];
      if (!row) return 'unknown';
      if (row.sha256 === hex) return 'match';
      return 'changed';
    },
    remember(id, hex) {
      hosts[id] = { sha256: hex, updatedAt: Date.now() };
      save();
    },
  };
}

function exists(file) {
  try {
    readFileSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
