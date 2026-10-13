import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { protectSecret, unprotectSecret } from './dpapi.js';
import { listLocal, mkdirLocal, removeLocal, renameLocal } from './local-fs.js';
import { assertRemote, parseTarget } from './paths.js';
import { listRemote, mkdirRemote, removeRemote, renameRemote } from './remote-fs.js';
import { openSession } from './session.js';
import { fastGet, fileError, isDir, lstat } from './sftp-util.js';
import { startTransfer, startUpload } from './transfer.js';
import { receiveUpload } from './upload.js';

export function attachRoutes(app, ctx) {
  app.get('/api/profiles', (_req, res) => {
    res.json({ profiles: ctx.profiles.list() });
  });

  app.delete('/api/profiles/:id', async (req, res, next) => {
    try {
      await ctx.profiles.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/update', async (_req, res, next) => {
    try {
      res.json(await readUpdate(ctx));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/update', async (_req, res, next) => {
    try {
      if (!(ctx.updatesEnabled || ctx.updatePreview)) {
        res.status(400).json({ error: '이 폴더는 배포용 복사본이 아니라서, 업데이트 대신 배포.bat을 사용합니다.' });
        return;
      }
      if (ctx.sessions.size) {
        res.status(409).json({ error: '연결된 파이를 끊은 뒤에 업데이트해 주세요.' });
        return;
      }
      const preview = ctx.updatePreview;
      if (preview && !preview.available) {
        res.status(400).json({ error: '이미 최신 버전입니다.' });
        return;
      }
      if (ctx.updateApply) {
        await ctx.updateApply();
        res.json({ ok: true, version: preview?.latest || ctx.version });
        return;
      }
      const staged = await ctx.updateService.begin();
      res.json({ ok: true, version: staged.version });
      res.on('finish', () => {
        try { ctx.updateService.launch(staged); } catch (err) { console.error(err.message || err); }
        ctx.requestShutdown?.();
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/connect', async (req, res, next) => {
    try {
      const body = req.body || {};
      const profile = body.profileId ? ctx.profiles.get(body.profileId) : null;
      if (body.profileId && !profile) {
        res.status(404).json({ error: '저장된 기기를 찾지 못했습니다.' });
        return;
      }
      const target = parseTarget(body.host || profile?.host, body.username || profile?.username, body.port ?? profile?.port);
      const typedPassword = typeof body.password === 'string' ? body.password.replace(/\r?\n$/, '') : '';
      const sameTarget = Boolean(
        profile && profile.host === target.host && profile.port === target.port && profile.username === target.username,
      );
      let password = typedPassword;
      if (!password && body.reuseSavedPassword && sameTarget && profile.password) {
        try {
          password = await unprotectSecret(profile.password);
        } catch {
          res.status(400).json({ error: '저장된 암호를 읽지 못했습니다. 암호를 다시 적어 주세요.' });
          return;
        }
      }
      if (!password) {
        res.status(400).json({ error: '암호를 적어 주세요.' });
        return;
      }
      const acceptHost = body.acceptHost === 'new' || body.acceptHost === 'changed' ? body.acceptHost : null;
      if (!ctx.quiet) console.log(`연결 시도 ${target.username}@${target.host}:${target.port}`);
      const session = await openSession({
        ...target,
        password,
        acceptHost,
        knownHosts: ctx.knownHosts,
      });
      for (const old of ctx.sessions.values()) old.close();
      ctx.sessions.clear();
      ctx.sessions.set(session.id, session);
      session.conn.on('close', () => {
        if (ctx.sessions.get(session.id) === session) ctx.sessions.delete(session.id);
        if (!ctx.quiet) console.log(`끊김 ${target.username}@${target.host}:${target.port}`);
      });
      if (!ctx.quiet) console.log(`연결됨 ${target.username}@${target.host}:${target.port}`);

      let saveWarning = null;
      let stored = null;
      const savePassword = Boolean(body.savePassword);
      if (savePassword && typedPassword) {
        try {
          stored = await protectSecret(password);
        } catch {
          saveWarning = '연결은 되었습니다. 암호는 이 컴퓨터에 저장하지 못했습니다.';
          stored = sameTarget ? profile.password : null;
        }
      } else if (savePassword && sameTarget) {
        stored = profile.password;
      }
      const saved = await ctx.profiles.upsert({
        id: sameTarget ? profile.id : undefined,
        name: `${target.username}@${target.host}`,
        ...target,
        password: savePassword ? stored : null,
      });
      res.json({
        sessionId: session.id,
        home: session.home,
        username: session.username,
        host: session.host,
        port: session.port,
        localHome: ctx.localHome,
        saveWarning,
        profile: saved,
      });
    } catch (err) {
      if (err.status === 409) {
        res.status(409).json({ error: err.message, code: err.code, fingerprint: err.fingerprint });
        return;
      }
      next(err);
    }
  });

  app.post('/api/disconnect', (req, res) => {
    const session = ctx.sessions.get(req.body?.sessionId);
    if (session) {
      session.close();
      ctx.sessions.delete(session.id);
    }
    res.json({ ok: true });
  });

  app.get('/api/local/list', async (req, res, next) => {
    try {
      needSession(ctx, req.query.sessionId);
      const listed = await listLocal(req.query.path === undefined ? ctx.localHome : String(req.query.path));
      res.json(listed);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/remote/list', async (req, res, next) => {
    try {
      const session = needSession(ctx, req.query.sessionId);
      res.json(await listRemote(session, String(req.query.path || session.home)));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/local/mkdir', async (req, res, next) => {
    try {
      needSession(ctx, req.body?.sessionId);
      res.json({ path: await mkdirLocal(req.body?.dir, req.body?.name) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/remote/mkdir', async (req, res, next) => {
    try {
      const session = needSession(ctx, req.body?.sessionId);
      res.json({ path: await mkdirRemote(session, req.body?.dir, req.body?.name) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/local/rename', async (req, res, next) => {
    try {
      needSession(ctx, req.body?.sessionId);
      res.json({ path: await renameLocal(req.body?.path, req.body?.name) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/remote/rename', async (req, res, next) => {
    try {
      const session = needSession(ctx, req.body?.sessionId);
      res.json({ path: await renameRemote(session, req.body?.path, req.body?.name) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/local/remove', async (req, res, next) => {
    try {
      needSession(ctx, req.body?.sessionId);
      await removeLocal(req.body?.path);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/remote/remove', async (req, res, next) => {
    try {
      const session = needSession(ctx, req.body?.sessionId);
      await removeRemote(session, req.body?.path);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/transfer', (req, res, next) => {
    try {
      const session = needSession(ctx, req.body?.sessionId);
      const job = startTransfer(session, {
        direction: req.body?.direction === 'get' ? 'get' : 'put',
        paths: req.body?.paths,
        destDir: req.body?.destDir,
      });
      res.json({ jobs: [job] });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/transfers', (req, res, next) => {
    try {
      const session = needSession(ctx, req.query.sessionId);
      res.json({ jobs: session.jobs() });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/upload', async (req, res, next) => {
    let cleanup = async () => {};
    try {
      const incoming = await receiveUpload(req);
      cleanup = incoming.cleanup;
      const session = needSession(ctx, incoming.fields.sessionId);
      const remoteDir = incoming.fields.remoteDir;
      const paths = parsePaths(incoming.fields.paths, incoming.files);
      incoming.files.forEach((file, index) => {
        file.rel = paths[index] || file.rel;
      });
      const job = startUpload(session, remoteDir, incoming.files, cleanup);
      cleanup = async () => {};
      res.json({ jobs: [job] });
    } catch (err) {
      await cleanup().catch(() => {});
      next(err);
    }
  });

  app.get('/api/download', async (req, res, next) => {
    let dir = '';
    try {
      const session = needSession(ctx, req.query.sessionId);
      const remotePath = assertRemote(String(req.query.path || ''));
      const info = await session.copy(() => lstat(session.copier, remotePath));
      if (isDir(info)) throw Object.assign(new Error('폴더는 노트북 창으로 가져가세요. 파일만 브라우저로 받을 수 있습니다.'), { status: 400 });
      dir = await mkdtemp(path.join(os.tmpdir(), 'pi-link-dl-'));
      const tmp = path.join(dir, 'download');
      const job = session.addJob({ title: path.posix.basename(remotePath), direction: 'get', total: Number(info.size || 0) });
      await session.copy(() => fastGet(session.copier, remotePath, tmp, (transferred) => {
        job.transferred = transferred;
      }));
      job.done = true;
      job.finishedAt = Date.now();
      const size = (await stat(tmp)).size;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', attachmentName(path.posix.basename(remotePath)));
      res.setHeader('Cache-Control', 'no-store');
      createReadStream(tmp).pipe(res).on('close', () => {
        rm(dir, { recursive: true, force: true }).catch(() => {});
      });
    } catch (err) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      next(err);
    }
  });
}

async function readUpdate(ctx) {
  if (ctx.updatePreview) return ctx.updatePreview;
  if (!ctx.updatesEnabled) {
    return { current: ctx.version, latest: ctx.version, available: false, notes: '' };
  }
  return ctx.updateService.status();
}

function needSession(ctx, id) {
  const session = ctx.sessions.get(id);
  if (!session || session.closed) {
    throw Object.assign(new Error('연결이 끊겨 있습니다. 다시 연결해 주세요.'), { status: 410 });
  }
  session.touch();
  return session;
}

function parsePaths(raw, files) {
  if (!raw) return files.map((file) => file.rel);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return files.map((file) => file.rel);
    return parsed.map((item) => safeRel(item));
  } catch {
    return files.map((file) => file.rel);
  }
}

function safeRel(name) {
  const parts = String(name || '').split(/[/\\]/).filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/') || 'file';
}

function attachmentName(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function fail(err, res) {
  const msg = String(err?.message || '');
  const io = /no such file|permission denied|already exists|not a directory|directory not empty|is a directory|ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|ENOTEMPTY|EISDIR/i.test(msg);
  const status = err.status || (io || /[가-힣]/.test(msg) ? 400 : 500);
  if (status === 500) console.error(err);
  const error = status === 500 ? '처리하지 못했습니다.' : fileError(err);
  if (!res.headersSent) res.status(status).json({ error });
}
