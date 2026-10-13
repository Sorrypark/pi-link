import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Busboy from 'busboy';

export function receiveUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 5000, fieldSize: 2 * 1024 * 1024 },
      });
    } catch (err) {
      reject(Object.assign(new Error('올릴 파일을 읽지 못했습니다.'), { status: 400, cause: err }));
      return;
    }
    const fields = {};
    const files = [];
    const writes = [];
    let dirPromise = null;
    let index = 0;
    const dir = () => {
      if (!dirPromise) dirPromise = mkdtemp(path.join(os.tmpdir(), 'pi-link-up-'));
      return dirPromise;
    };
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (_name, stream, info) => {
      const mine = index;
      index += 1;
      const filename = typeof info === 'string' ? info : info?.filename;
      const write = dir().then((folder) => new Promise((done, fail) => {
        const tmp = path.join(folder, randomBytes(8).toString('hex'));
        const out = createWriteStream(tmp);
        stream.pipe(out);
        out.on('finish', () => {
          files[mine] = { tmp, rel: safeRelative(filename) };
          done();
        });
        out.on('error', fail);
        stream.on('error', fail);
      }));
      writes.push(write);
    });
    bb.on('error', reject);
    bb.on('close', () => {
      Promise.all(writes).then(() => resolve({
        fields,
        files,
        cleanup: async () => {
          if (dirPromise) await rm(await dirPromise, { recursive: true, force: true });
        },
      })).catch(reject);
    });
    req.pipe(bb);
  });
}

function safeRelative(name) {
  const parts = String(name || 'file').split(/[/\\]/).filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/') || 'file';
}
