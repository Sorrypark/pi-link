import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPDATE_OWNER = 'Sorrypark';
export const UPDATE_REPO = 'pi-link';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const REDIRECT_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export function repoSlug() {
  return `${UPDATE_OWNER}/${UPDATE_REPO}`;
}

export function versionParts(value) {
  const text = String(value ?? '').trim().replace(/^v/, '');
  const match = VERSION_RE.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function readVersion(rootDir) {
  const file = path.join(rootDir, 'package.json');
  if (!existsSync(file)) return '';
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return versionParts(raw.version) ? String(raw.version).trim() : '';
}

export function safeRelative(name) {
  let text = String(name ?? '').replaceAll('\\', '/');
  if (text.startsWith('./')) text = text.slice(2);
  if (text === '' || text === '.') return true;
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (!text || text === '.') return true;
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return false;
  return text.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function assertReleaseUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { badUrl(); }
  const prefix = `/${repoSlug()}/releases/download/v`;
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(prefix) || !parsed.pathname.endsWith('.zip')) {
    badUrl();
  }
  return parsed.toString();
}

function assertRedirectUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { badUrl(); }
  if (parsed.protocol !== 'https:' || !REDIRECT_HOSTS.has(parsed.hostname)) badUrl();
  return parsed.toString();
}

function badUrl() {
  throw Object.assign(new Error('업데이트 주소가 이 프로그램의 공개 파일이 아닙니다.'), { status: 400 });
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function assertZipEntries(entries) {
  if (!entries.length) throw httpError('업데이트 파일이 비어 있습니다.', 400);
  for (const entry of entries) {
    if (!safeRelative(entry)) throw httpError('업데이트 파일 경로가 이상합니다.', 400);
  }
}

export async function extractZip(zipPath, dest) {
  const listing = await runCommand('tar', ['-tf', zipPath]);
  const entries = listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assertZipEntries(entries);
  await mkdir(dest, { recursive: true });
  await runCommand('tar', ['-xf', zipPath, '-C', dest]);
  await rejectLinks(dest);
}

async function rejectLinks(dest) {
  const root = await realpath(dest);
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw httpError('업데이트 파일에 링크가 들어 있습니다.', 400);
      const resolved = path.resolve(full);
      const inside = resolved === root || resolved.startsWith(root + path.sep);
      if (!inside) throw httpError('업데이트 파일 경로가 이상합니다.', 400);
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(dest);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => reject(httpError('이 컴퓨터에서 압축을 풀지 못했습니다.', 400)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(httpError('업데이트 압축을 풀지 못했습니다.', 400));
    });
  });
}

export function createUpdateService({ rootDir, enabled = true, fetchImpl = fetch } = {}) {
  let cached = null;
  let cachedAt = 0;
  const repo = repoSlug();

  async function loadRelease() {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        'User-Agent': 'pi-link',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw httpError('업데이트 정보를 받지 못했습니다.', 502);
    const body = await response.json();
    const latest = String(body.tag_name || '').replace(/^v/, '');
    if (!versionParts(latest)) return null;
    const asset = (body.assets || []).find((item) => item && item.name === `pi-link-${latest}.zip`);
    let assetUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (assetUrl) {
      try { assetUrl = assertReleaseUrl(assetUrl); } catch { assetUrl = ''; }
    }
    return {
      latest,
      notes: String(body.body || '').replace(/[^\S\n]+/g, ' ').trim().slice(0, 1200),
      assetUrl,
    };
  }

  return {
    async status() {
      const current = readVersion(rootDir);
      if (!enabled) return { current, latest: current, available: false, notes: '' };
      if (cached && Date.now() - cachedAt < 10 * 60 * 1000) return cached;
      try {
        const release = await loadRelease();
        const available = Boolean(release && compareVersions(release.latest, current) > 0 && release.assetUrl);
        cached = {
          current,
          latest: available ? release.latest : current,
          available,
          notes: available ? release.notes : '',
        };
        cachedAt = Date.now();
        return cached;
      } catch {
        return { current, latest: current, available: false, notes: '' };
      }
    },

    async begin() {
      if (!enabled) throw httpError('이 폴더는 배포용 복사본이 아니라서, 업데이트 대신 배포.bat을 사용합니다.', 400);
      const current = readVersion(rootDir);
      const release = await loadRelease();
      if (!release || compareVersions(release.latest, current) <= 0) {
        throw httpError('이미 최신 버전입니다.', 400);
      }
      if (!release.assetUrl) throw httpError('받을 수 있는 업데이트 파일이 없습니다.', 400);
      assertReleaseUrl(release.assetUrl);
      const work = await mkdtemp(path.join(os.tmpdir(), 'pi-link-update-'));
      const zipPath = path.join(work, 'update.zip');
      await downloadZip(release.assetUrl, zipPath, fetchImpl);
      const stage = path.join(work, 'stage');
      await extractZip(zipPath, stage);
      const staged = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
      if (staged.name !== 'pi-link' || staged.version !== release.latest) {
        throw httpError('받은 파일의 버전이 맞지 않습니다.', 400);
      }
      if (!existsSync(path.join(stage, '파이연결.bat'))) {
        throw httpError('받은 파일에 실행 파일이 없습니다.', 400);
      }
      return { work, stage, version: release.latest };
    },

    launch(staged) {
      const script = path.join(rootDir, 'scripts', 'apply-update.ps1');
      const bat = path.join(rootDir, '파이연결.bat');
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-WaitPid', String(process.pid),
        '-Source', staged.stage,
        '-Dest', rootDir,
        '-Bat', bat,
        '-Work', staged.work,
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    },
  };
}

async function downloadZip(url, dest, fetchImpl) {
  let current = assertReleaseUrl(url);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(current, {
      headers: { 'User-Agent': 'pi-link', Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw httpError('업데이트 파일을 받지 못했습니다.', 502);
      current = assertRedirectUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok || !response.body) throw httpError('업데이트 파일을 받지 못했습니다.', 502);
    await writeLimited(response, dest);
    return;
  }
  throw httpError('업데이트 주소가 너무 여러 번 옮겨집니다.', 502);
}

async function writeLimited(response, dest) {
  let received = 0;
  const limited = Readable.from(limit(response.body));
  await pipeline(limited, createWriteStream(dest));

  async function* limit(body) {
    for await (const chunk of body) {
      received += chunk.length;
      if (received > MAX_ZIP_BYTES) throw httpError('업데이트 파일이 너무 큽니다.', 400);
      yield chunk;
    }
  }
}
