import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createProfileStore(file) {
  let profiles = [];
  let chain = Promise.resolve();

  function update(fn) {
    const run = chain.then(async () => {
      const next = await fn(profiles);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, profiles: next }, null, 2), { mode: 0o600 });
      await rename(tmp, file);
      profiles = next;
      return next;
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        profiles = [];
      }
    },
    list() {
      return profiles.map(publicProfile);
    },
    get(id) {
      return profiles.find((item) => item.id === id) || null;
    },
    findMatch(host, port, username) {
      return profiles.find((item) => item.host === host && item.port === port && item.username === username) || null;
    },
    upsert(entry) {
      const next = {
        id: entry.id || randomUUID(),
        name: String(entry.name || `${entry.username}@${entry.host}`).trim().slice(0, 40) || `${entry.username}@${entry.host}`,
        host: entry.host,
        port: entry.port,
        username: entry.username,
        password: entry.password || null,
        updatedAt: Date.now(),
      };
      return update((items) => {
        const index = items.findIndex((item) => item.id === next.id);
        const copy = items.slice();
        if (index >= 0) copy[index] = next;
        else copy.unshift(next);
        return copy;
      }).then(() => publicProfile(next));
    },
    remove(id) {
      return update((items) => items.filter((item) => item.id !== id));
    },
  };
}

function publicProfile(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    username: item.username,
    hasPassword: Boolean(item.password),
    updatedAt: item.updatedAt,
  };
}
