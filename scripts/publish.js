import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, readVersion, repoSlug, versionParts } from '../server/update.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const owner = 'Sorrypark';
const repo = 'pi-link';

const notes = process.argv.slice(2).join(' ').trim() || [
  '노트북 브라우저로 라즈베리파이에 접속합니다.',
  '새 버전이 있으면 설치한 컴퓨터의 프로그램에 업데이트 버튼이 나타납니다.',
  '저장한 기기와 암호는 업데이트해도 지워지지 않습니다.',
].join('\n');

function git(args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} 실패`).trim());
  }
  return result;
}

function githubToken() {
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd: rootDir,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const line = String(result.stdout || '').split(/\r?\n/).find((row) => row.startsWith('password='));
  const token = line ? line.slice('password='.length).trim() : '';
  if (!token) throw new Error('GitHub 로그인 정보를 찾지 못했습니다.');
  return token;
}

async function gh(token, method, apiPath, { json, body, headers = {} } = {}) {
  const url = apiPath.startsWith('https://') ? apiPath : `https://api.github.com${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pi-link',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 180) }; }
  }
  if (!response.ok) {
    const error = new Error(`GitHub ${response.status}: ${data?.message || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function bump(version) {
  const parts = versionParts(version);
  if (!parts) throw new Error(`버전 형식이 이상합니다. ${version}`);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function writeVersion(version) {
  const file = path.join(rootDir, 'package.json');
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('"version"')) throw new Error('package.json에 버전이 없습니다.');
  writeFileSync(file, raw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
}

async function main() {
  if (repoSlug() !== `${owner}/${repo}`) throw new Error('저장소 이름이 코드와 다릅니다.');
  let version = readVersion(rootDir);
  if (!version) throw new Error('package.json 버전이 없습니다.');
  console.log(`파이 연결 ${version}을 공개합니다.`);
  const token = githubToken();

  let created = false;
  try {
    const existing = await gh(token, 'GET', `/repos/${owner}/${repo}`);
    if (existing.private) await gh(token, 'PATCH', `/repos/${owner}/${repo}`, { json: { private: false } });
  } catch (err) {
    if (err.status !== 404) throw err;
    await gh(token, 'POST', '/user/repos', {
      json: {
        name: repo,
        private: false,
        description: '노트북 브라우저로 라즈베리파이에 접속합니다.',
        has_issues: false,
        has_wiki: false,
        auto_init: false,
      },
    });
    created = true;
  }

  let remoteVersion = null;
  if (!created) {
    try {
      const latest = await gh(token, 'GET', `/repos/${owner}/${repo}/releases/latest`);
      remoteVersion = String(latest.tag_name || '').replace(/^v/, '');
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  if (remoteVersion && compareVersions(version, remoteVersion) <= 0) {
    version = bump(remoteVersion);
    writeVersion(version);
    console.log(`버전을 ${version}으로 올립니다.`);
  }

  git(['init', '-b', 'main'], { allowFail: true });
  git(['checkout', '-B', 'main']);
  git(['config', 'user.name', 'Sorrypark']);
  git(['config', 'user.email', '127264974+Sorrypark@users.noreply.github.com']);
  const origin = git(['remote', 'get-url', 'origin'], { allowFail: true });
  if (origin.status !== 0) git(['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`]);
  console.log('파일을 올리고 있습니다.');
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']).stdout.split(/\r?\n/).filter(Boolean);
  if (staged.some((name) => name === 'data' || name.startsWith('data/') || name.startsWith('data\\'))) {
    throw new Error('저장한 기기 정보가 함께 올라가려 합니다. 올리지 않고 멈춥니다.');
  }
  const dirty = git(['status', '--porcelain']).stdout.trim();
  if (dirty) git(['commit', '-m', `파이 연결 ${version}`]);
  const tag = `v${version}`;
  git(['tag', '-a', tag, '-m', version], { allowFail: true });
  console.log(`${tag} 태그를 푸시합니다.`);
  git(['push', '-u', 'origin', 'main']);
  git(['push', 'origin', tag]);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-link-release-'));
  const zipName = `pi-link-${version}.zip`;
  const zipPath = path.join(tmp, zipName);
  try {
    git(['archive', '--format=zip', `--output=${zipPath}`, 'HEAD']);
    let release;
    try {
      release = await gh(token, 'GET', `/repos/${owner}/${repo}/releases/tags/${tag}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      release = await gh(token, 'POST', `/repos/${owner}/${repo}/releases`, {
        json: { tag_name: tag, name: version, body: notes, target_commitish: 'main', draft: false, prerelease: false },
      });
    }
    const hasAsset = (release.assets || []).some((asset) => asset.name === zipName);
    if (!hasAsset) {
      const bytes = await readFile(zipPath);
      await gh(token, 'POST', `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(zipName)}`, {
        body: bytes,
        headers: { 'Content-Type': 'application/zip' },
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`올렸습니다. https://github.com/${owner}/${repo}/releases/tag/${tag}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
