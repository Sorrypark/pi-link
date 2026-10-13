import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dpapi.ps1');
const cache = new Map();

async function runPowerShell(mode, inputText) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-link-'));
  const inFile = path.join(dir, 'in.txt');
  const outFile = path.join(dir, 'out.txt');
  try {
    await writeFile(inFile, inputText, 'utf8');
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, mode, inFile, outFile],
        { windowsHide: true, timeout: 20000 },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).trim() || '암호 저장에 실패했습니다.'));
          else resolve();
        },
      );
    });
    return (await readFile(outFile, 'utf8')).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function protectSecret(plain) {
  const b64 = Buffer.from(String(plain), 'utf8').toString('base64');
  const stored = await runPowerShell('protect', b64);
  cache.set(stored, String(plain));
  return stored;
}

export async function unprotectSecret(stored) {
  if (cache.has(stored)) return cache.get(stored);
  const b64 = await runPowerShell('unprotect', stored);
  const plain = Buffer.from(b64, 'base64').toString('utf8');
  cache.set(stored, plain);
  return plain;
}
