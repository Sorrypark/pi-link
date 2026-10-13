import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { chromium } from 'playwright-core';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { protectSecret, unprotectSecret } from '../server/dpapi.js';
import { startServer } from '../server/index.js';
import { parseTarget } from '../server/paths.js';
import { assertReleaseUrl, assertZipEntries, compareVersions, createUpdateService, extractZip, safeRelative } from '../server/update.js';
import { startMock } from './mock-ssh.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let updateApplies = 0;

const shotDir = os.tmpdir();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(base, token, urlPath, { method = 'GET', json, headers = {} } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(token ? { 'x-pi-token': token } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { status: res.status, data, text };
}

async function waitJobs(base, token, sessionId) {
  let last = [];
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const { status, data } = await call(base, token, `/api/transfers?sessionId=${encodeURIComponent(sessionId)}`);
    if (status !== 200) throw new Error(`전송 상태를 읽지 못했습니다. ${status} ${data.error || ''}`);
    last = data.jobs || [];
    if (last.length && last.every((job) => job.done)) {
      const bad = last.find((job) => job.error);
      if (bad) throw new Error(`${bad.title}: ${bad.error}`);
      return last;
    }
    await sleep(40);
  }
  throw new Error(`전송이 끝나지 않았습니다. ${JSON.stringify(last)}`);
}

function namesOf(data) {
  return (data.entries || []).map((entry) => entry.name);
}

async function launchBrowser() {
  const errors = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      errors.push(`${channel}: ${err.message}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function startMockRetry(options) {
  let last;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return await startMock(options);
    } catch (err) {
      last = err;
      if (err.code !== 'EADDRINUSE') throw err;
      await sleep(100);
    }
  }
  throw last;
}

async function main() {
  const sshTarget = parseTarget('ssh pi@192.168.0.8', '', 22);
  check(sshTarget.username === 'pi' && sshTarget.host === '192.168.0.8' && sshTarget.port === 22, `주소 해석 ${JSON.stringify(sshTarget)}`);
  const portInHost = parseTarget('192.168.0.8:2200', 'pi', 22);
  check(portInHost.host === '192.168.0.8' && portInHost.port === 2200, `포트 해석 ${JSON.stringify(portInHost)}`);
  const explicitPort = parseTarget('192.168.0.8', 'pi', 2222);
  check(explicitPort.port === 2222 && explicitPort.host === '192.168.0.8', `지정 포트 ${JSON.stringify(explicitPort)}`);

  const sealed = await protectSecret('secret');
  check(sealed && sealed !== 'secret', '암호가 그대로 저장되었습니다.');
  check(await unprotectSecret(sealed) === 'secret', '저장한 암호를 되돌리지 못했습니다.');
  console.log('암호 저장 확인');
  await checkUpdater();
  console.log('업데이트 확인');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-link-check-'));
  const fixture = path.join(tmp, 'laptop');
  await mkdir(fixture, { recursive: true });
  await writeFile(path.join(fixture, 'note.txt'), 'from laptop\n');
  let mock;
  let api;
  let ui;
  let changedMock;
  let changedServer;
  let browser;
  try {
    mock = await startMock();
    updateApplies = 0;
    api = await startServer({
      port: 0,
      openBrowser: false,
      quiet: true,
      dataDir: path.join(tmp, 'api-data'),
      localHome: fixture,
      updates: true,
      updatePreview: { current: '1.0.0', latest: '9.9.9', available: true, notes: '시험용 알림' },
      updateApply: async () => { updateApplies += 1; },
    });
    await checkApi(api, mock, fixture, tmp);
    console.log('서버 확인');

    ui = await startServer({
      port: 0,
      openBrowser: false,
      quiet: true,
      dataDir: path.join(tmp, 'ui-data'),
      localHome: fixture,
      updates: false,
    });
    browser = await launchBrowser();
    await checkBrowser(browser, ui, mock.port);
    console.log('브라우저 확인');
    await checkUpdateBanner(browser, tmp);
    console.log('업데이트 화면 확인');

    const firstKey = ssh2.utils.generateKeyPairSync('ed25519').private;
    changedMock = await startMock({ hostKey: firstKey });
    const changedPort = changedMock.port;
    changedServer = await startServer({
      port: 0,
      openBrowser: false,
      quiet: true,
      dataDir: path.join(tmp, 'changed-data'),
      localHome: fixture,
      updates: false,
    });
    await checkChangedKey(changedServer, changedMock, changedPort, firstKey);
    changedMock = null;
    console.log('열쇠 변경 확인');
    console.log('selfcheck ok');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (ui) await ui.close().catch(() => {});
    if (api) await api.close().catch(() => {});
    if (changedServer) await changedServer.close().catch(() => {});
    if (changedMock) await changedMock.close().catch(() => {});
    if (mock) await mock.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkApi(api, mock, fixture, tmp) {
  const page = await fetch(api.url);
  const html = await page.text();
  check(page.status === 200 && html.includes(api.token) && !html.includes('__TOKEN__'), '첫 화면에 접속 토큰이 없습니다.');

  const noToken = await call(api.url, '', '/api/profiles');
  check(noToken.status === 401, `토큰 없는 요청 ${noToken.status}`);
  const crossApi = await call(api.url, api.token, '/api/profiles', {
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  check(crossApi.status === 401, `다른 사이트 API ${crossApi.status}`);
  const crossPage = await fetch(api.url, { headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } });
  check(crossPage.status === 403, `다른 사이트 페이지 ${crossPage.status}`);

  const base = {
    name: '테스트파이',
    host: '127.0.0.1',
    port: mock.port,
    username: 'pi',
    savePassword: true,
  };
  const unknown = await call(api.url, api.token, '/api/connect', {
    method: 'POST',
    json: { ...base, password: 'nope' },
  });
  check(unknown.status === 409 && unknown.data.code === 'HOST_UNKNOWN' && String(unknown.data.fingerprint).startsWith('SHA256:'), `처음 접속 ${unknown.status} ${unknown.data.code || unknown.data.error}`);

  const wrong = await call(api.url, api.token, '/api/connect', {
    method: 'POST',
    json: { ...base, password: 'nope', acceptHost: 'new' },
  });
  check(wrong.status === 400 && wrong.data.error === '사용자 이름 또는 암호가 맞지 않습니다.', `틀린 암호 ${wrong.status} ${wrong.data.error}`);

  const good = await call(api.url, api.token, '/api/connect', {
    method: 'POST',
    json: { ...base, password: 'secret' },
  });
  check(good.status === 200 && good.data.home === '/home/pi', `접속 ${good.status} ${good.data.error || good.data.home}`);
  const sessionId = good.data.sessionId;
  const profileId = good.data.profile.id;

  const remote = await call(api.url, api.token, `/api/remote/list?sessionId=${encodeURIComponent(sessionId)}`);
  check(namesOf(remote.data).includes('readme.txt') && namesOf(remote.data).includes('docs'), `파이 목록 ${namesOf(remote.data).join(',')}`);
  const docs = await call(api.url, api.token, `/api/remote/list?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent('/home/pi/docs')}`);
  check(namesOf(docs.data).includes('inside.txt'), `하위 폴더 ${namesOf(docs.data).join(',')}`);
  const local = await call(api.url, api.token, `/api/local/list?sessionId=${encodeURIComponent(sessionId)}`);
  check(namesOf(local.data).includes('note.txt'), `노트북 목록 ${namesOf(local.data).join(',')}`);

  const put = await call(api.url, api.token, '/api/transfer', {
    method: 'POST',
    json: { sessionId, direction: 'put', paths: [path.join(fixture, 'note.txt')], destDir: '/home/pi' },
  });
  check(put.status === 200, `보내기 ${put.status} ${put.data.error}`);
  await waitJobs(api.url, api.token, sessionId);
  const afterPut = await call(api.url, api.token, `/api/remote/list?sessionId=${encodeURIComponent(sessionId)}`);
  check(namesOf(afterPut.data).includes('note.txt'), '파이로 보낸 파일이 보이지 않습니다.');

  const got = await call(api.url, api.token, '/api/transfer', {
    method: 'POST',
    json: { sessionId, direction: 'get', paths: ['/home/pi/readme.txt'], destDir: fixture },
  });
  check(got.status === 200, `가져오기 ${got.status} ${got.data.error}`);
  await waitJobs(api.url, api.token, sessionId);
  check(await readFile(path.join(fixture, 'readme.txt'), 'utf8') === 'hello pi\n', '가져온 파일 내용이 다릅니다.');

  const download = await fetch(`${api.url}/api/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent('/home/pi/note.txt')}`, {
    headers: { 'x-pi-token': api.token },
  });
  const downloaded = await download.text();
  check(download.status === 200 && downloaded === 'from laptop\n', `다운로드 ${download.status} ${downloaded}`);

  const made = await call(api.url, api.token, '/api/remote/mkdir', {
    method: 'POST',
    json: { sessionId, dir: '/home/pi', name: 'beta' },
  });
  check(made.status === 200, `폴더 만들기 ${made.status} ${made.data.error}`);
  const renamed = await call(api.url, api.token, '/api/remote/rename', {
    method: 'POST',
    json: { sessionId, path: '/home/pi/beta', name: 'gamma' },
  });
  check(renamed.status === 200, `이름 바꾸기 ${renamed.status} ${renamed.data.error}`);
  const removed = await call(api.url, api.token, '/api/remote/remove', {
    method: 'POST',
    json: { sessionId, path: '/home/pi/gamma' },
  });
  check(removed.status === 200, `삭제 ${removed.status} ${removed.data.error}`);
  const removedFile = await call(api.url, api.token, '/api/remote/remove', {
    method: 'POST',
    json: { sessionId, path: '/home/pi/note.txt' },
  });
  check(removedFile.status === 200, `파일 삭제 ${removedFile.status} ${removedFile.data.error}`);

  await expectEcho(api, sessionId);

  const profiles = await call(api.url, api.token, '/api/profiles');
  const listed = JSON.stringify(profiles.data);
  check(profiles.status === 200 && !listed.includes('secret') && !listed.includes('"password"'), `목록에 암호가 보입니다. ${listed}`);
  const stored = JSON.parse(await readFile(path.join(tmp, 'api-data', 'profiles.json'), 'utf8'));
  check(stored.profiles[0].password && stored.profiles[0].password !== 'secret', '암호 파일이 평문입니다.');
  check(await unprotectSecret(stored.profiles[0].password) === 'secret', '저장 파일을 풀지 못했습니다.');

  const offered = await call(api.url, api.token, '/api/update');
  check(offered.status === 200 && offered.data.available === true && offered.data.latest === '9.9.9', `업데이트 표시 ${offered.status} ${offered.data.latest}`);
  const blocked = await call(api.url, api.token, '/api/update', { method: 'POST', json: {} });
  check(blocked.status === 409 && updateApplies === 0, `연결 중 업데이트 ${blocked.status} ${blocked.data.error}`);

  await call(api.url, api.token, '/api/disconnect', { method: 'POST', json: { sessionId } });
  const again = await call(api.url, api.token, '/api/connect', {
    method: 'POST',
    json: { profileId, reuseSavedPassword: true, savePassword: true },
  });
  check(again.status === 200 && again.data.home === '/home/pi', `저장된 기기 ${again.status} ${again.data.error || ''}`);
  await call(api.url, api.token, '/api/disconnect', { method: 'POST', json: { sessionId: again.data.sessionId } });
  const applied = await call(api.url, api.token, '/api/update', { method: 'POST', json: {} });
  check(applied.status === 200 && applied.data.version === '9.9.9' && updateApplies === 1, `업데이트 실행 ${applied.status} ${applied.data.error || applied.data.version}`);
}

function expectEcho(api, sessionId) {
  const ws = new WebSocket(`${api.url.replace(/^http/, 'ws')}/term?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(api.token)}&cols=80&rows=24`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let ready = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`셸 응답 없음: ${Buffer.concat(chunks).toString()}`));
    }, 8000);
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        let msg = {};
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.t === 'error') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.error));
          return;
        }
        if (msg.t === 'ready') {
          ready = true;
          ws.send(Buffer.from('hi'));
        }
        return;
      }
      chunks.push(Buffer.from(data));
      const text = Buffer.concat(chunks).toString();
      if (ready && text.includes('READY') && text.includes('hi')) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
  });
}

async function checkBrowser(browser, ui, port) {
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource: the server responded with a status of (409|400)/.test(text)) return;
    errors.push(text);
  });
  page.setDefaultTimeout(15000);
  await page.goto(ui.url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(shotDir, 'pi-link-connect.png'), fullPage: true });

  await page.getByLabel('아이피 주소', { exact: true }).fill(`127.0.0.1:${port}`);
  await page.getByLabel('사용자', { exact: true }).fill('pi');
  await page.getByLabel('암호', { exact: true }).fill('nope');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('button', { name: '이 기기 신뢰' }).waitFor();
  await page.screenshot({ path: path.join(shotDir, 'pi-link-host.png') });
  await page.getByRole('button', { name: '이 기기 신뢰' }).click();
  await page.getByText('사용자 이름 또는 암호가 맞지 않습니다.').waitFor();

  await page.getByLabel('암호', { exact: true }).fill('secret');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByText('셸', { exact: true }).waitFor({ timeout: 20000 });
  check(await page.getByRole('button', { name: '이 기기 신뢰' }).count() === 0, '이미 신뢰한 기기에서 다시 물어봅니다.');

  await page.locator('#terminal').click();
  await page.locator('.xterm-helper-textarea').focus();
  await waitFor(async () => (await page.locator('#terminal').innerText()).includes('READY'), '셸에 READY가 없습니다.');
  await page.keyboard.type('hi');
  await waitFor(async () => (await page.locator('#terminal').innerText()).includes('hi'), '셸이 입력을 그대로 보여 주지 않습니다.');

  await page.locator('.pane.remote').getByRole('button', { name: 'readme.txt', exact: true }).click();
  await page.getByRole('button', { name: /^가져오기/ }).click();
  await page.locator('.pane.local').getByRole('button', { name: 'readme.txt', exact: true }).waitFor();
  await page.locator('.pane.local').getByRole('button', { name: 'note.txt', exact: true }).click();
  await page.getByRole('button', { name: /^보내기/ }).click();
  await page.locator('.pane.remote').getByRole('button', { name: 'note.txt', exact: true }).waitFor();

  await page.locator('.pane.remote').getByRole('button', { name: '새 폴더', exact: true }).click();
  await page.getByLabel('폴더 이름', { exact: true }).fill('alpha');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.locator('.pane.remote').getByRole('button', { name: 'alpha', exact: true }).dblclick();
  await waitFor(async () => (await page.getByLabel('라즈베리파이 경로').inputValue()) === '/home/pi/alpha', '파이 폴더로 들어가지 못했습니다.');

  const desktop = await layout(page);
  check(desktop.scroll <= desktop.client + 1 && desktop.term > 80, `데스크톱 배치 ${JSON.stringify(desktop)}`);
  await page.screenshot({ path: path.join(shotDir, 'pi-link-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const mobile = await layout(page);
  check(mobile.scroll <= mobile.client + 1 && mobile.term > 80, `작은 화면 배치 ${JSON.stringify(mobile)}`);
  await page.screenshot({ path: path.join(shotDir, 'pi-link-mobile.png'), fullPage: true });

  await page.getByRole('button', { name: '끊기', exact: true }).click();
  await page.getByRole('button', { name: `pi@127.0.0.1:${port} 연결` }).click();
  await page.getByText('셸', { exact: true }).waitFor({ timeout: 20000 });
  check(await page.getByRole('button', { name: '이 기기 신뢰' }).count() === 0, '저장된 기기에서 열쇠를 다시 물어봅니다.');
  check(errors.length === 0, `브라우저 오류\n${errors.join('\n')}`);
  await context.close();
}

async function checkChangedKey(server, mock, port, firstKey) {
  const off = await call(server.url, server.token, '/api/update');
  check(off.status === 200 && off.data.available === false && off.data.current === '1.0.0', `업데이트 끔 ${off.status} ${off.data.current}`);
  const denied = await call(server.url, server.token, '/api/update', { method: 'POST', json: {} });
  check(denied.status === 400, `꺼진 업데이트 ${denied.status} ${denied.data.error}`);
  const body = {
    name: '다른열쇠',
    host: '127.0.0.1',
    port,
    username: 'pi',
    password: 'secret',
    savePassword: false,
  };
  const first = await call(server.url, server.token, '/api/connect', {
    method: 'POST',
    json: { ...body, acceptHost: 'new' },
  });
  check(first.status === 200, `첫 열쇠 ${first.status} ${first.data.error || ''}`);
  await call(server.url, server.token, '/api/disconnect', { method: 'POST', json: { sessionId: first.data.sessionId } });
  await mock.close();
  const replacement = await startMockRetry({ port, hostKey: ssh2.utils.generateKeyPairSync('ed25519').private });
  try {
    check(replacement.hostKey !== firstKey, '같은 열쇠로 다시 열렸습니다.');
    const changed = await call(server.url, server.token, '/api/connect', { method: 'POST', json: body });
    check(changed.status === 409 && changed.data.code === 'HOST_CHANGED', `바뀐 열쇠 ${changed.status} ${changed.data.code || changed.data.error}`);
    const accepted = await call(server.url, server.token, '/api/connect', {
      method: 'POST',
      json: { ...body, acceptHost: 'changed' },
    });
    check(accepted.status === 200, `바뀐 열쇠 신뢰 ${accepted.status} ${accepted.data.error || ''}`);
    await call(server.url, server.token, '/api/disconnect', { method: 'POST', json: { sessionId: accepted.data.sessionId } });
  } finally {
    await replacement.close();
  }
}

function layout(page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    term: document.querySelector('#terminal')?.getBoundingClientRect().height || 0,
  }));
}

async function waitFor(fn, message) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      if (await fn()) return;
    } catch { /* element not ready */ }
    await sleep(80);
  }
  throw new Error(message);
}

async function checkUpdater() {
  check(compareVersions('1.0.1', '1.0.0') === 1, '상위 버전');
  check(compareVersions('1.0.0', '1.0.0') === 0, '같은 버전');
  check(compareVersions('1.0.0', '1.2.0') === -1, '하위 버전');
  check(compareVersions('1.0.10', '1.0.9') === 1, '자리 비교');
  check(compareVersions('v2.0.0', '1.9.9') === 1, 'v 접두');
  check(compareVersions('1.2', '1.2.0') === null, '짧은 버전');
  check(safeRelative('server/index.js') && safeRelative('파이연결.bat') && safeRelative('./client/src/main.js'), '정상 경로');
  check(!safeRelative('../x') && !safeRelative('a/../../x') && !safeRelative('/etc/passwd') && !safeRelative('C:/Windows/x') && !safeRelative('a/../b'), '벗어나는 경로');
  assertReleaseUrl('https://github.com/Sorrypark/pi-link/releases/download/v1.2.3/pi-link-1.2.3.zip');
  for (const bad of [
    'http://github.com/Sorrypark/pi-link/releases/download/v1.2.3/pi-link-1.2.3.zip',
    'https://github.com/other/pi-link/releases/download/v1.2.3/pi-link-1.2.3.zip',
    'https://objects.githubusercontent.com/pi-link.zip',
    'https://github.com/Sorrypark/pi-link/archive/refs/heads/main.zip',
  ]) {
    let rejected = false;
    try { assertReleaseUrl(bad); } catch { rejected = true; }
    check(rejected, `막지 못한 주소 ${bad}`);
  }

  const release = (url) => async () => new Response(JSON.stringify({
    tag_name: 'v9.9.9',
    body: '시험 설명',
    assets: [{ name: 'pi-link-9.9.9.zip', browser_download_url: url }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const poisoned = await createUpdateService({
    rootDir,
    enabled: true,
    fetchImpl: release('https://evil.example/pi-link-9.9.9.zip'),
  }).status();
  check(poisoned.available === false, '다른 주소의 파일을 업데이트로 봤습니다.');
  const offered = await createUpdateService({
    rootDir,
    enabled: true,
    fetchImpl: release('https://github.com/Sorrypark/pi-link/releases/download/v9.9.9/pi-link-9.9.9.zip'),
  }).status();
  check(offered.available === true && offered.latest === '9.9.9' && offered.current === '1.0.0' && offered.notes.includes('시험'), `공개 버전 ${JSON.stringify(offered)}`);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-link-zip-'));
  try {
    const good = path.join(tmp, 'good.zip');
    const bad = path.join(tmp, 'bad.zip');
    await writeFile(good, zipStored([
      { name: 'package.json', data: '{"name":"pi-link","version":"9.9.9"}\n' },
      { name: 'server/hello.js', data: 'export const hello = 1;\n' },
    ]));
    await writeFile(bad, zipStored([{ name: '../evil.txt', data: 'nope\n' }]));
    const stage = path.join(tmp, 'stage');
    await extractZip(good, stage);
    check((await readFile(path.join(stage, 'package.json'), 'utf8')).includes('"9.9.9"'), '압축을 풀지 못했습니다.');
    check((await readFile(path.join(stage, 'server', 'hello.js'), 'utf8')).includes('hello'), '하위 폴더를 풀지 못했습니다.');
    let rejected = false;
    try { assertZipEntries(['server/ok.js', '../evil.txt']); } catch { rejected = true; }
    check(rejected, '나쁜 목록을 통과시켰습니다.');
    let extracted = false;
    try { await extractZip(bad, path.join(tmp, 'bad-stage')); extracted = true; } catch { extracted = false; }
    check(!extracted, '벗어나는 압축을 풀었습니다.');
    check(!(await fileExists(path.join(tmp, 'evil.txt'))), '압축 밖에 파일이 생겼습니다.');

    const source = path.join(tmp, 'source');
    const dest = path.join(tmp, 'dest');
    await mkdir(path.join(source, 'server'), { recursive: true });
    await mkdir(path.join(source, 'data'), { recursive: true });
    await mkdir(path.join(source, 'node_modules'), { recursive: true });
    await mkdir(path.join(dest, 'data'), { recursive: true });
    await mkdir(path.join(dest, 'node_modules'), { recursive: true });
    await writeFile(path.join(source, 'server', 'hello.js'), 'next\n');
    await writeFile(path.join(source, 'data', 'EVIL.txt'), 'evil\n');
    await writeFile(path.join(source, 'node_modules', 'evil.js'), 'evil\n');
    await writeFile(path.join(dest, 'data', 'profiles.json'), 'SECRET\n');
    await writeFile(path.join(dest, 'node_modules', 'keep.txt'), 'keep\n');
    const script = path.join(rootDir, 'scripts', 'apply-update.ps1');
    const applied = await runFile(script, ['-WaitPid', '0', '-Source', source, '-Dest', dest, '-Bat', path.join(dest, 'missing.bat'), '-Work', tmp, '-CopyOnly']);
    check(applied.code === 0, `복사 스크립트 ${applied.code} ${applied.stderr || applied.stdout}`);
    check(await readFile(path.join(dest, 'server', 'hello.js'), 'utf8') === 'next\n', '새 파일을 복사하지 못했습니다.');
    check(await readFile(path.join(dest, 'data', 'profiles.json'), 'utf8') === 'SECRET\n', '저장한 기기 정보를 건드렸습니다.');
    check(!(await fileExists(path.join(dest, 'data', 'EVIL.txt'))), '업데이트 안의 data를 덮어썼습니다.');
    check(await readFile(path.join(dest, 'node_modules', 'keep.txt'), 'utf8') === 'keep\n', '설치된 꾸러미를 지웠습니다.');
    check(!(await fileExists(path.join(dest, 'node_modules', 'evil.js'))), '업데이트의 node_modules를 복사했습니다.');
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const sum = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function fileExists(file) {
  return readFile(file).then(() => true, () => false);
}

function runFile(script, args) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function checkUpdateBanner(browser, tmp) {
  const server = await startServer({
    port: 0,
    openBrowser: false,
    quiet: true,
    dataDir: path.join(tmp, 'banner-data'),
    localHome: os.homedir(),
    updates: true,
    updatePreview: { current: '1.0.0', latest: '9.9.9', available: true, notes: '시험용 알림' },
    updateApply: async () => { throw new Error('배너 시험이 업데이트를 실행했습니다.'); },
  });
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  try {
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.getByText('버전 9.9.9로 올릴 수 있습니다.').waitFor();
    await page.getByText('시험용 알림').waitFor();
    await page.screenshot({ path: path.join(shotDir, 'pi-link-update.png') });
    await page.getByRole('button', { name: '업데이트', exact: true }).click();
    await page.getByRole('heading', { name: '업데이트', exact: true }).waitFor();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.getByText('버전 9.9.9로 올릴 수 있습니다.').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    const narrow = await layout(page);
    check(narrow.scroll <= narrow.client + 1, `업데이트 화면 배치 ${JSON.stringify(narrow)}`);
    await page.screenshot({ path: path.join(shotDir, 'pi-link-update-mobile.png'), fullPage: true });
    check(errors.length === 0, `업데이트 화면 오류\n${errors.join('\n')}`);
  } finally {
    await context.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
