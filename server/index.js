import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { openKnownHosts } from './known-hosts.js';
import { createProfileStore } from './profiles.js';
import { attachRoutes, fail } from './routes.js';
import { attachTerminal } from './session.js';
import { createUpdateService, readVersion } from './update.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer(options = {}) {
  const port = options.port ?? Number(process.env.PI_LINK_PORT || 8787);
  const bindHost = '127.0.0.1';
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const quiet = Boolean(options.quiet);
  const localHome = options.localHome || os.homedir();
  const token = randomBytes(32).toString('hex');
  const version = readVersion(rootDir);
  const installedCopy = !existsSync(path.join(rootDir, '.git'));
  const updatesEnabled = options.updates !== false && installedCopy && !options.updatePreview;
  const updateService = createUpdateService({ rootDir, enabled: updatesEnabled });
  let requestShutdown = () => {};
  const profiles = createProfileStore(path.join(dataDir, 'profiles.json'));
  await profiles.load();
  const knownHosts = openKnownHosts(path.join(dataDir, 'known-hosts.json'));
  const sessions = new Map();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const server = createServer(app);

  function allowed(req) {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      return parsed.protocol === 'http:' && hostOk && String(parsed.port || '80') === String(actualPort);
    } catch {
      return false;
    }
  }

  app.use('/api', (req, res, next) => {
    if (!allowed(req) || req.get('x-pi-token') !== token) {
      res.status(401).json({ error: '페이지를 새로고침한 뒤 다시 시도해 주세요.' });
      return;
    }
    next();
  });

  app.get('/', (req, res) => {
    if (!allowed(req)) {
      res.status(403).type('text').send('이 주소는 브라우저 주소창에서 직접 열어야 합니다.');
      return;
    }
    const html = readFileSync(path.join(rootDir, 'client', 'index.html'), 'utf8').replaceAll('__TOKEN__', token);
    res.type('html').send(html);
  });
  app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').sendFile(path.join(rootDir, 'client', 'favicon.svg'));
  });
  app.get('/app.js', (_req, res) => {
    const file = path.join(rootDir, 'public', 'app.js');
    if (!existsSync(file)) {
      res.status(503).type('js').send('document.body.textContent="화면 파일이 없습니다. 파이연결을 다시 실행해 주세요.";');
      return;
    }
    res.type('js').sendFile(file);
  });
  app.get('/app.js.map', (_req, res) => {
    const file = path.join(rootDir, 'public', 'app.js.map');
    if (!existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.type('json').sendFile(file);
  });

  attachRoutes(app, {
    token,
    sessions,
    profiles,
    knownHosts,
    localHome,
    quiet,
    version,
    updatesEnabled,
    updatePreview: options.updatePreview || null,
    updateApply: options.updateApply || null,
    updateService,
    requestShutdown: () => requestShutdown(),
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '그 기능이 없습니다.' });
  });
  app.use((err, _req, res, _next) => fail(err, res));

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let parsed;
    try { parsed = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    if (parsed.pathname !== '/term' || !allowed(req) || parsed.searchParams.get('token') !== token) {
      socket.destroy();
      return;
    }
    const session = sessions.get(parsed.searchParams.get('sessionId'));
    if (!session || session.closed) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachTerminal(session, ws, {
        cols: parsed.searchParams.get('cols'),
        rows: parsed.searchParams.get('rows'),
      });
    });
  });

  await listen(server, port, bindHost);
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (!session.terminalOpen && now - session.lastSeen > 60_000) {
        session.close();
        sessions.delete(session.id);
      }
    }
  }, 10_000);
  timer.unref();
  server.requestTimeout = 0;

  if (!quiet) {
    console.log('');
    console.log(`파이 연결 ${version} 이 켜졌습니다.`);
    console.log(url);
    console.log('');
    console.log('브라우저 주소 칸에 라즈베리파이의 아이피를 적으면 그 파이에 접속합니다.');
    console.log('이 창을 닫으면 접속도 함께 끊깁니다.');
    console.log('');
  }
  if (options.openBrowser) openBrowser(url);

  const handle = {
    url,
    token,
    port: actualPort,
    version,
    async close() {
      clearInterval(timer);
      for (const session of sessions.values()) session.close();
      sessions.clear();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  requestShutdown = () => {
    setTimeout(() => {
      handle.close().finally(() => {
        if (runningAsMain()) process.exit(0);
      });
    }, 500);
  };
  return handle;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, host);
  });
}

export function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function runningAsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (runningAsMain()) {
  const preferred = Number(process.env.PI_LINK_PORT || 8787);
  startServer({ port: preferred, openBrowser: !process.env.PI_LINK_NO_OPEN }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      const url = `http://127.0.0.1:${preferred}`;
      openBrowser(url);
      console.log('이미 실행 중이라 브라우저만 엽니다.');
      console.log(url);
      process.exit(0);
    }
    console.error(err.message || err);
    process.exit(1);
  });
}
