import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createApi } from './api.js';
import './style.css';

const token = document.querySelector('meta[name="pi-token"]')?.content || '';
const root = document.querySelector('#app');
const request = createApi(token);

const state = {
  profiles: [],
  form: blankForm(),
  error: '',
  connecting: false,
  session: null,
  localPath: '',
  remotePath: '/',
  localParent: null,
  remoteParent: null,
  localEntries: [],
  remoteEntries: [],
  localSel: new Set(),
  remoteSel: new Set(),
  localAnchor: 0,
  remoteAnchor: 0,
  localError: '',
  remoteError: '',
  localLoading: false,
  remoteLoading: false,
  jobs: [],
  jobTimer: null,
  update: null,
  updating: false,
};

let term = null;
let fit = null;
let ws = null;
let unresize = null;

boot();

async function boot() {
  if (!token || token.includes('TOKEN')) {
    root.textContent = '화면을 열지 못했습니다. 파이연결 창을 다시 실행해 주세요.';
    return;
  }
  window.addEventListener('pagehide', () => {
    if (!state.session) return;
    fetch('/api/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pi-token': token },
      body: JSON.stringify({ sessionId: state.session.sessionId }),
      keepalive: true,
    }).catch(() => {});
  });
  try {
    state.profiles = (await request('/api/profiles')).profiles;
  } catch {
    state.profiles = [];
  }
  showConnect();
  refreshUpdate();
  setInterval(refreshUpdate, 30 * 60 * 1000);
}

function showConnect() {
  teardown();
  document.body.className = '';
  document.title = '파이 연결';
  const form = state.form;
  const disabled = state.connecting;
  root.replaceChildren(h('main', { class: 'gate' },
    h('section', { class: 'card' },
      h('div', { class: 'brand' },
        h('div', null,
          h('h1', null, '파이 연결'),
          h('p', { class: 'lede' }, '라즈베리파이에 접속합니다. 한 번 저장하면 다음엔 그 줄을 눌러 연결합니다.'),
        ),
      ),
      updateNotice(),
      state.error ? h('div', { class: 'alert', role: 'alert' }, state.error) : null,
      h('h2', null, '저장된 기기'),
      state.profiles.length
        ? state.profiles.map((profile) => profileRow(profile, disabled))
        : h('p', { class: 'empty' }, '아직 없습니다. 아래에 한 번 적으면 다음에 그 기기를 눌러 연결합니다.'),
      h('h2', null, '접속'),
      h('form', { autocomplete: 'off', onsubmit: submitConnect },
        h('label', { class: 'field' }, '아이피 주소',
          h('input', {
            type: 'text',
            name: 'host',
            value: form.host,
            placeholder: '192.168.0.10',
            disabled,
            spellcheck: 'false',
            autocapitalize: 'off',
            oninput: (e) => { form.host = e.target.value; },
          })),
        h('label', { class: 'field' }, '사용자',
          h('input', { type: 'text', name: 'username', autocomplete: 'username', value: form.username, disabled, spellcheck: 'false', oninput: (e) => { form.username = e.target.value; } })),
        h('div', { class: 'field' },
          h('label', { for: 'password' }, '암호'),
          h('div', { class: 'secret' },
            h('input', {
              id: 'password',
              type: 'password',
              autocomplete: 'current-password',
              value: form.password,
              placeholder: form.reuseSavedPassword ? '저장됨' : '',
              disabled,
              oninput: (e) => {
                form.password = e.target.value;
                form.reuseSavedPassword = !e.target.value && Boolean(form.profileId);
              },
            }),
            h('button', { type: 'button', class: 'quiet', onclick: (e) => togglePassword(e.currentTarget) }, '표시'),
          ),
        ),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: form.savePassword, disabled, onchange: (e) => { form.savePassword = e.target.checked; } }),
          '이 노트북에 암호 저장',
        ),
        h('button', { class: 'primary', type: 'submit', disabled }, disabled ? '연결하는 중' : '연결'),
      ),
      h('p', { class: 'hint' }, 'ssh pi@아이피 처럼, 아이피 칸에 pi@192.168.0.10 이라고 적어도 됩니다. 브라우저가 파이의 SSH에 직접 붙지는 못하고, 이 프로그램이 노트북에서 대신 연결합니다. 암호는 이 Windows 사용자만 풀 수 있게 저장됩니다. 한 번에 한 대만 연결됩니다.'),
    ),
  ));
}

function profileWhere(profile) {
  return `${profile.username}@${profile.host}${profile.port === 22 ? '' : `:${profile.port}`}`;
}

function profileRow(profile, disabled) {
  const where = profileWhere(profile);
  return h('div', { class: 'profile' },
    h('button', {
      type: 'button',
      class: 'profile-go',
      'aria-label': `${where} 연결`,
      disabled,
      onclick: () => quickConnect(profile),
    }, where),
    h('button', { type: 'button', class: 'quiet', disabled, onclick: () => editProfile(profile) }, '고치기'),
    h('button', { type: 'button', class: 'quiet', 'aria-label': `${where} 지우기`, disabled, onclick: () => removeProfile(profile) }, '지우기'),
  );
}

function editProfile(profile) {
  fill(profile);
  state.error = '';
  showConnect();
  document.getElementById('password')?.focus();
}

function fill(profile) {
  state.form = {
    host: profile.host,
    username: profile.username,
    password: '',
    savePassword: profile.hasPassword,
    profileId: profile.id,
    reuseSavedPassword: profile.hasPassword,
  };
}

function submitConnect(event) {
  event.preventDefault();
  const form = state.form;
  if (!form.host.trim()) return failForm('아이피 주소를 적어 주세요.');
  if (!form.username.trim() && !form.host.includes('@')) return failForm('사용자 이름을 적어 주세요.');
  if (!form.password && !form.reuseSavedPassword) return failForm('암호를 적어 주세요.');
  doConnect({
    profileId: form.profileId,
    host: form.host,
    username: form.username,
    password: form.password,
    savePassword: form.savePassword,
    reuseSavedPassword: form.reuseSavedPassword && !form.password,
  });
}

function quickConnect(profile) {
  fill(profile);
  if (!profile.hasPassword) {
    state.error = '이 기기는 암호가 저장되어 있지 않습니다.';
    showConnect();
    document.getElementById('password')?.focus();
    return;
  }
  doConnect({
    profileId: profile.id,
    reuseSavedPassword: true,
    savePassword: true,
  });
}

async function doConnect(payload) {
  if (state.connecting) return;
  state.connecting = true;
  state.error = '';
  showConnect();
  try {
    const data = await request('/api/connect', { method: 'POST', json: payload });
    state.session = data;
    state.localPath = data.localHome;
    state.remotePath = data.home || '/';
    state.localSel.clear();
    state.remoteSel.clear();
    state.jobs = [];
    state.localLoading = true;
    state.remoteLoading = true;
    state.profiles = (await request('/api/profiles')).profiles;
    if (data.profile) fill(data.profile);
    state.connecting = false;
    showSession();
  } catch (err) {
    state.connecting = false;
    if (err.status === 409 && err.data?.fingerprint) {
      const yes = await hostDialog(err.data);
      if (!yes) {
        state.error = '기기 확인을 취소했습니다.';
        showConnect();
        return;
      }
      return doConnect({
        ...payload,
        acceptHost: err.data.code === 'HOST_CHANGED' ? 'changed' : 'new',
      });
    }
    state.error = err.message || '연결하지 못했습니다.';
    showConnect();
  }
}

function failForm(message) {
  state.error = message;
  showConnect();
}

function updateNotice() {
  if (!state.update?.available) return null;
  const latest = state.update.latest;
  return h('div', { class: 'notice' },
    h('p', null, `버전 ${latest}로 올릴 수 있습니다. 이 컴퓨터는 ${state.update.current}입니다.`),
    state.update.notes ? h('pre', { class: 'notes' }, state.update.notes) : null,
    h('button', { type: 'button', class: 'primary slim', disabled: state.updating, onclick: runUpdate }, state.updating ? '올리는 중' : '업데이트'),
  );
}

function updateBar() {
  if (!state.update?.available) return null;
  return h('div', { class: 'update-bar' },
    h('span', null, `버전 ${state.update.latest}`),
    h('button', { type: 'button', class: 'update', disabled: state.updating, onclick: runUpdate }, state.updating ? '올리는 중' : '업데이트'),
  );
}

async function refreshUpdate() {
  let next = null;
  try {
    const data = await request('/api/update');
    if (data?.available) next = data;
  } catch {
    return;
  }
  if (JSON.stringify(state.update) === JSON.stringify(next)) return;
  state.update = next;
  if (state.session) syncSessionUpdate();
  else if (!state.connecting && !document.querySelector('.modal-back')) showConnect();
}

function syncSessionUpdate() {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  const bar = updateBar();
  workspace.classList.toggle('has-update', Boolean(bar));
  workspace.querySelector('.update-bar')?.remove();
  const panes = document.getElementById('panes');
  if (bar && panes) workspace.insertBefore(bar, panes);
}

async function runUpdate() {
  if (state.updating || !state.update?.available) return;
  const latest = state.update.latest;
  const ok = await askConfirm({
    title: '업데이트',
    body: `${latest}로 올리고 프로그램을 다시 시작합니다. 저장한 기기와 암호는 그대로 둡니다.`,
    okLabel: '업데이트',
  });
  if (!ok) return;
  state.updating = true;
  if (state.session) {
    const id = state.session.sessionId;
    state.session = null;
    teardown();
    await request('/api/disconnect', { method: 'POST', json: { sessionId: id } }).catch(() => {});
  }
  showConnect();
  try {
    await request('/api/update', { method: 'POST', json: {} });
    document.body.className = '';
    root.replaceChildren(h('main', { class: 'gate' },
      h('section', { class: 'card' },
        h('h1', null, '업데이트'),
        h('p', { class: 'lede' }, `${latest}로 올리는 중입니다. 잠시 뒤 새 창이 열립니다. 이 페이지는 닫아도 됩니다.`),
      ),
    ));
  } catch (err) {
    state.updating = false;
    state.error = err.message || '업데이트하지 못했습니다.';
    showConnect();
  }
}

function showSession() {
  teardown();
  document.body.className = 'in-session';
  const session = state.session;
  document.title = `${session.username}@${session.host} · 파이 연결`;
  const bar = updateBar();
  root.replaceChildren(h('div', { class: bar ? 'workspace has-update' : 'workspace' },
    h('header', { class: 'top' },
      h('h1', null, '파이 연결'),
      h('div', { class: 'who' }, `${session.username}@${session.host}${session.port === 22 ? '' : `:${session.port}`}`),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'disconnect', onclick: disconnect }, '끊기'),
    ),
    bar,
    h('div', { class: 'panes', id: 'panes' }),
    h('section', { class: 'terminal-wrap' },
      h('div', { class: 'shellbar' }, h('span', null, '셸'), h('span', null, '라즈베리파이의 터미널')),
      h('div', { id: 'terminal' }),
    ),
  ));
  paintPanes();
  openTerminal();
  loadLocal();
  loadRemote();
}

async function disconnect() {
  const id = state.session?.sessionId;
  state.session = null;
  teardown();
  if (id) await request('/api/disconnect', { method: 'POST', json: { sessionId: id } }).catch(() => {});
  try { state.profiles = (await request('/api/profiles')).profiles; } catch { /* keep the list we have */ }
  showConnect();
}

function paintPanes() {
  const panes = document.getElementById('panes');
  if (!panes) return;
  const busy = state.jobs.some((job) => !job.done);
  panes.replaceChildren(...[
    state.session?.saveWarning ? h('p', { class: 'banner' }, state.session.saveWarning) : null,
    filePane({
      side: 'local',
      title: '이 노트북',
      path: state.localPath,
      parent: state.localParent,
      entries: state.localEntries,
      selected: state.localSel,
      error: state.localError,
      loading: state.localLoading,
      onOpen: (entry) => { state.localSel.clear(); loadLocalAt(entry.path); },
      onFile: (entry) => { state.localSel.clear(); state.localSel.add(entry.path); send('put'); },
      onUp: () => { if (state.localParent !== null) { state.localSel.clear(); loadLocalAt(state.localParent); } },
      onPath: (value) => { state.localSel.clear(); loadLocalAt(value); },
      onNew: newLocalFolder,
      onRename: () => renameSelected('local'),
      onRemove: () => removeSelected('local'),
    }),
    h('div', { class: 'bridge' },
      h('button', { id: 'send-btn', type: 'button', disabled: busy || state.localSel.size === 0, onclick: () => send('put') }, state.localSel.size ? `보내기 ${state.localSel.size}` : '보내기'),
      h('button', { id: 'get-btn', type: 'button', disabled: busy || state.remoteSel.size === 0, onclick: () => send('get') }, state.remoteSel.size ? `가져오기 ${state.remoteSel.size}` : '가져오기'),
    ),
    filePane({
      side: 'remote',
      title: '라즈베리파이',
      path: state.remotePath,
      parent: state.remoteParent,
      entries: state.remoteEntries,
      selected: state.remoteSel,
      error: state.remoteError,
      loading: state.remoteLoading,
      onOpen: (entry) => { state.remoteSel.clear(); loadRemoteAt(entry.path); },
      onFile: (entry) => { state.remoteSel.clear(); state.remoteSel.add(entry.path); send('get'); },
      onUp: () => { if (state.remoteParent !== null) { state.remoteSel.clear(); loadRemoteAt(state.remoteParent); } },
      onPath: (value) => { state.remoteSel.clear(); loadRemoteAt(value); },
      onNew: newRemoteFolder,
      onRename: () => renameSelected('remote'),
      onRemove: () => removeSelected('remote'),
      upload: true,
    }),
    jobsView(),
  ].filter(Boolean));
  const remote = panes.querySelector('.pane.remote');
  if (remote) bindDrop(remote);
  requestAnimationFrame(() => {
    for (const box of panes.querySelectorAll('.pathbox')) box.scrollLeft = box.scrollWidth;
  });
}

function paintJobsOnly() {
  const panes = document.getElementById('panes');
  const current = document.getElementById('jobs');
  if (!panes || !current) return;
  const busy = state.jobs.some((job) => !job.done);
  current.replaceWith(jobsView());
  const sendBtn = document.getElementById('send-btn');
  const getBtn = document.getElementById('get-btn');
  if (sendBtn) {
    sendBtn.disabled = busy || state.localSel.size === 0;
    sendBtn.textContent = state.localSel.size ? `보내기 ${state.localSel.size}` : '보내기';
  }
  if (getBtn) {
    getBtn.disabled = busy || state.remoteSel.size === 0;
    getBtn.textContent = state.remoteSel.size ? `가져오기 ${state.remoteSel.size}` : '가져오기';
  }
}

function filePane(opts) {
  const picker = opts.upload ? h('input', { type: 'file', multiple: true, hidden: true }) : null;
  if (picker) {
    picker.addEventListener('change', () => {
      const files = [...picker.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
      picker.value = '';
      uploadFiles(files);
    });
  }
  return h('section', { class: `pane ${opts.side}` },
    h('div', { class: 'pane-head' },
      h('h2', null, opts.title),
      h('span', { class: 'count' }, opts.selected.size ? `${opts.selected.size}개 선택` : ''),
    ),
    h('div', { class: 'tools' },
      h('button', { type: 'button', disabled: opts.parent === null, onclick: opts.onUp }, '위로'),
      h('button', { type: 'button', onclick: opts.side === 'local' ? loadLocal : loadRemote }, '새로고침'),
      h('button', { type: 'button', onclick: opts.onNew }, '새 폴더'),
      h('button', { type: 'button', disabled: opts.selected.size !== 1, onclick: opts.onRename }, '이름 바꾸기'),
      h('button', { type: 'button', disabled: opts.selected.size === 0, onclick: opts.onRemove }, '삭제'),
      opts.upload ? h('button', { type: 'button', onclick: () => picker.click() }, '파일 올리기') : null,
      picker,
    ),
    h('div', { class: 'crumbs' }, ...crumbButtons(opts.path, opts.side, opts.onPath)),
    h('div', { class: 'path-wrap' },
      h('input', {
        class: 'pathbox',
        'aria-label': `${opts.title} 경로`,
        value: opts.path,
        spellcheck: 'false',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); opts.onPath(e.target.value); } },
      }),
    ),
    opts.error ? h('p', { class: 'pane-error', role: 'alert' }, opts.error) : null,
    h('div', { class: 'list' }, ...rowsFor(opts)),
  );
}

function rowsFor(opts) {
  if (opts.loading && !opts.entries.length) return [h('p', { class: 'empty' }, '불러오는 중')];
  if (!opts.entries.length) return [h('p', { class: 'empty' }, '비어 있습니다')];
  return opts.entries.map((entry, index) => h('button', {
    type: 'button',
    class: `row${opts.selected.has(entry.path) ? ' selected' : ''}${entry.name.startsWith('.') ? ' dot' : ''}`,
    'aria-label': entry.name,
    onclick: (event) => {
      choose(opts.side, opts.entries, opts.selected, entry, index, event);
      paintPanes();
    },
    ondblclick: () => {
      if (entry.type === 'dir') opts.onOpen(entry);
      else opts.onFile(entry);
    },
  },
    h('span', { class: `kind ${entry.type}`, 'aria-hidden': 'true' }),
    h('span', { class: 'name' }, entry.name),
    h('span', { class: 'size' }, entry.type === 'file' && entry.size != null ? formatSize(entry.size) : ''),
    h('span', { class: 'time' }, entry.mtime ? formatTime(entry.mtime) : ''),
  ));
}

function crumbButtons(current, side, onPath) {
  const items = side === 'local' ? localCrumbs(current) : remoteCrumbs(current);
  const nodes = [];
  items.forEach((item, index) => {
    if (index) nodes.push(h('span', { class: 'crumb-gap', 'aria-hidden': 'true' }, '›'));
    nodes.push(h('button', { type: 'button', onclick: () => onPath(item.path) }, item.label));
  });
  return nodes;
}

function jobsView() {
  return h('div', { class: 'jobs', id: 'jobs' }, ...state.jobs.map((job) => h('div', { class: 'job' },
    h('p', null, `${labelDirection(job.direction, job.done && !job.error)} · ${job.title}`),
    job.error ? h('p', { class: 'err' }, job.error) : null,
    h('div', { class: job.total ? 'bar' : 'bar unknown' },
      h('span', { style: job.total ? `width:${Math.min(100, Math.round((job.transferred / job.total) * 100))}%` : '' })),
  )));
}

function labelDirection(direction, done) {
  if (direction === 'get') return done ? '노트북으로 가져옴' : '노트북으로 가져오는 중';
  if (direction === 'upload') return done ? '올림' : '올리는 중';
  return done ? '파이로 보냄' : '파이로 보내는 중';
}

function choose(side, entries, selected, entry, index, event) {
  const anchorKey = side === 'local' ? 'localAnchor' : 'remoteAnchor';
  if (event.shiftKey) {
    const start = Math.min(state[anchorKey], index);
    const end = Math.max(state[anchorKey], index);
    selected.clear();
    for (let i = start; i <= end; i += 1) selected.add(entries[i].path);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    if (selected.has(entry.path)) selected.delete(entry.path);
    else selected.add(entry.path);
  } else {
    selected.clear();
    selected.add(entry.path);
  }
  state[anchorKey] = index;
}

async function loadLocal() { return loadLocalAt(state.localPath || undefined); }
async function loadRemote() { return loadRemoteAt(state.remotePath || undefined); }

async function loadLocalAt(pathValue) {
  if (!state.session) return;
  state.localLoading = true;
  const query = new URLSearchParams({ sessionId: state.session.sessionId });
  if (pathValue !== undefined) query.set('path', pathValue);
  try {
    const data = await request(`/api/local/list?${query}`);
    state.localPath = data.path;
    state.localParent = data.parent;
    state.localEntries = data.entries;
    state.localError = '';
    prune(state.localSel, data.entries);
  } catch (err) {
    if (err.status === 410) return lost(err);
    state.localError = err.message;
  } finally {
    state.localLoading = false;
    paintPanes();
  }
}

async function loadRemoteAt(pathValue) {
  if (!state.session) return;
  state.remoteLoading = true;
  const query = new URLSearchParams({
    sessionId: state.session.sessionId,
    path: pathValue || state.remotePath || '/',
  });
  try {
    const data = await request(`/api/remote/list?${query}`);
    state.remotePath = data.path;
    state.remoteParent = data.parent;
    state.remoteEntries = data.entries;
    state.remoteError = '';
    prune(state.remoteSel, data.entries);
  } catch (err) {
    if (err.status === 410) return lost(err);
    state.remoteError = err.message;
  } finally {
    state.remoteLoading = false;
    paintPanes();
  }
}

function prune(selected, entries) {
  const live = new Set(entries.map((entry) => entry.path));
  for (const item of selected) if (!live.has(item)) selected.delete(item);
}

async function send(direction) {
  const paths = [...(direction === 'put' ? state.localSel : state.remoteSel)];
  const destDir = direction === 'put' ? state.remotePath : state.localPath;
  if (!paths.length || state.jobs.some((job) => !job.done)) return;
  try {
    const data = await request('/api/transfer', {
      method: 'POST',
      json: { sessionId: state.session.sessionId, direction, paths, destDir },
    });
    state.jobs = data.jobs;
    paintPanes();
    watchJobs();
  } catch (err) {
    if (err.status === 410) return lost(err);
    if (direction === 'put') state.remoteError = err.message;
    else state.localError = err.message;
    paintPanes();
  }
}

function watchJobs() {
  if (state.jobTimer) return;
  state.jobTimer = setInterval(async () => {
    if (!state.session) return;
    try {
      const data = await request(`/api/transfers?sessionId=${encodeURIComponent(state.session.sessionId)}`);
      state.jobs = data.jobs;
      paintJobsOnly();
      if (data.jobs.every((job) => job.done)) {
        clearInterval(state.jobTimer);
        state.jobTimer = null;
        await loadLocal();
        await loadRemote();
      }
    } catch (err) {
      if (err.status === 410) lost(err);
    }
  }, 300);
}

async function uploadFiles(items) {
  if (!items.length || !state.session) {
    state.remoteError = '올릴 파일이 없습니다.';
    paintPanes();
    return;
  }
  const body = new FormData();
  body.append('sessionId', state.session.sessionId);
  body.append('remoteDir', state.remotePath);
  body.append('paths', JSON.stringify(items.map((item) => item.rel)));
  for (const item of items) body.append('files', item.file, item.rel);
  try {
    const data = await request('/api/upload', { method: 'POST', body });
    state.jobs = data.jobs || [];
    state.remoteError = '';
    paintPanes();
    watchJobs();
  } catch (err) {
    if (err.status === 410) return lost(err);
    state.remoteError = err.message;
    paintPanes();
  }
}

function bindDrop(pane) {
  pane.addEventListener('dragover', (event) => {
    event.preventDefault();
    pane.classList.add('drop');
  });
  pane.addEventListener('dragleave', () => pane.classList.remove('drop'));
  pane.addEventListener('drop', async (event) => {
    event.preventDefault();
    pane.classList.remove('drop');
    try {
      uploadFiles(await entriesFromDrop(event.dataTransfer));
    } catch (err) {
      state.remoteError = err.message || '파일을 읽지 못했습니다.';
      paintPanes();
    }
  });
}

async function entriesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    return [...dataTransfer.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
  }
  const files = [];
  const walk = async (entry, rel) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push({ file, rel });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const kids = [];
      let batch = [];
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        kids.push(...batch);
      } while (batch.length);
      for (const kid of kids) await walk(kid, `${rel}/${kid.name}`);
    }
  };
  for (const entry of entries) await walk(entry, entry.name);
  return files;
}

async function newLocalFolder() {
  const name = await askText({ title: '새 폴더', label: '폴더 이름', okLabel: '만들기' });
  if (!name) return;
  try {
    await request('/api/local/mkdir', { method: 'POST', json: { sessionId: state.session.sessionId, dir: state.localPath, name } });
    await loadLocal();
  } catch (err) {
    if (err.status === 410) return lost(err);
    state.localError = err.message;
    paintPanes();
  }
}

async function newRemoteFolder() {
  const name = await askText({ title: '새 폴더', label: '폴더 이름', okLabel: '만들기' });
  if (!name) return;
  try {
    await request('/api/remote/mkdir', { method: 'POST', json: { sessionId: state.session.sessionId, dir: state.remotePath, name } });
    await loadRemote();
  } catch (err) {
    if (err.status === 410) return lost(err);
    state.remoteError = err.message;
    paintPanes();
  }
}

async function renameSelected(side) {
  const selected = side === 'local' ? state.localSel : state.remoteSel;
  const entries = side === 'local' ? state.localEntries : state.remoteEntries;
  const current = entries.find((entry) => selected.has(entry.path));
  if (!current) return;
  const name = await askText({ title: '이름 바꾸기', label: '새 이름', value: current.name, okLabel: '바꾸기' });
  if (!name || name === current.name) return;
  try {
    await request(side === 'local' ? '/api/local/rename' : '/api/remote/rename', {
      method: 'POST',
      json: { sessionId: state.session.sessionId, path: current.path, name },
    });
    selected.clear();
    if (side === 'local') await loadLocal();
    else await loadRemote();
  } catch (err) {
    if (err.status === 410) return lost(err);
    if (side === 'local') state.localError = err.message;
    else state.remoteError = err.message;
    paintPanes();
  }
}

async function removeSelected(side) {
  const selected = side === 'local' ? state.localSel : state.remoteSel;
  const entries = side === 'local' ? state.localEntries : state.remoteEntries;
  const chosen = entries.filter((entry) => selected.has(entry.path));
  if (!chosen.length) return;
  const folder = chosen.some((entry) => entry.type === 'dir');
  const ok = await askConfirm({
    title: '삭제',
    body: chosen.length === 1
      ? `${chosen[0].name} 을 삭제합니다.${folder ? ' 폴더 안의 파일까지 함께 지워집니다.' : ''}`
      : `${chosen.length}개를 삭제합니다.${folder ? ' 폴더 안의 파일까지 함께 지워집니다.' : ''}`,
    detail: chosen.length === 1 ? chosen[0].path : '',
    okLabel: '삭제',
  });
  if (!ok) return;
  try {
    for (const entry of chosen) {
      await request(side === 'local' ? '/api/local/remove' : '/api/remote/remove', {
        method: 'POST',
        json: { sessionId: state.session.sessionId, path: entry.path },
      });
    }
    selected.clear();
    if (side === 'local') await loadLocal();
    else await loadRemote();
  } catch (err) {
    if (err.status === 410) return lost(err);
    if (side === 'local') state.localError = err.message;
    else state.remoteError = err.message;
    paintPanes();
  }
}

function openTerminal() {
  const host = document.getElementById('terminal');
  term = new Terminal({
    cursorBlink: true,
    rendererType: 'dom',
    fontFamily: 'Consolas, GulimChe, "굴림체", monospace',
    fontSize: 16,
    lineHeight: 1.15,
    scrollback: 5000,
    theme: {
      background: '#000000',
      foreground: '#aaaaaa',
      cursor: '#aaaaaa',
      selectionBackground: '#0000aa',
      black: '#000000',
      red: '#aa0000',
      green: '#00aa00',
      yellow: '#aa5500',
      blue: '#0000aa',
      magenta: '#aa00aa',
      cyan: '#00aaaa',
      white: '#aaaaaa',
      brightBlack: '#555555',
      brightRed: '#ff5555',
      brightGreen: '#55ff55',
      brightYellow: '#ffff55',
      brightBlue: '#5555ff',
      brightMagenta: '#ff55ff',
      brightCyan: '#55ffff',
      brightWhite: '#ffffff',
    },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/term?sessionId=${encodeURIComponent(state.session.sessionId)}&token=${encodeURIComponent(token)}`);
  ws = socket;
  socket.binaryType = 'arraybuffer';
  let ready = false;
  const queue = [];
  const resize = () => {
    if (!fit || socket.readyState !== WebSocket.OPEN) return;
    fit.fit();
    socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };
  window.addEventListener('resize', resize);
  unresize = () => window.removeEventListener('resize', resize);
  term.onData((text) => {
    const bytes = new TextEncoder().encode(text);
    if (!ready || socket.readyState !== WebSocket.OPEN) queue.push(bytes);
    else socket.send(bytes);
  });
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      let msg = {};
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'ready') {
        ready = true;
        resize();
        for (const bytes of queue) socket.send(bytes);
        queue.length = 0;
      } else if (msg.t === 'exit') {
        term.write('\r\n\r\n[셸이 끝났습니다. 끊었다가 다시 연결해 주세요.]\r\n');
      } else if (msg.t === 'error') {
        term.write(`\r\n${msg.error}\r\n`);
      }
      return;
    }
    term.write(new Uint8Array(event.data));
  };
  socket.onclose = () => { ready = false; };
  requestAnimationFrame(() => requestAnimationFrame(resize));
}

function teardown() {
  unresize?.();
  unresize = null;
  if (state.jobTimer) clearInterval(state.jobTimer);
  state.jobTimer = null;
  try { ws?.close(); } catch { /* already closed */ }
  ws = null;
  try { term?.dispose(); } catch { /* already gone */ }
  term = null;
  fit = null;
}

function lost(err) {
  state.session = null;
  state.error = err.message || '연결이 끊겨 있습니다. 다시 연결해 주세요.';
  showConnect();
}

async function removeProfile(profile) {
  const ok = await askConfirm({
    title: '저장된 기기',
    body: `${profileWhere(profile)} 을 목록에서 지웁니다. 파이의 파일은 지우지 않습니다.`,
    okLabel: '지우기',
  });
  if (!ok) return;
  await request(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  if (state.form.profileId === profile.id) state.form = blankForm();
  showConnect();
}

function hostDialog(data) {
  const changed = data.code === 'HOST_CHANGED';
  return modal((finish) => {
    const cancel = h('button', { type: 'button', class: 'quiet', onclick: () => finish(false) }, '취소');
    const trust = h('button', { type: 'button', class: 'primary slim', onclick: () => finish(true) }, changed ? '바뀐 열쇠로 연결' : '이 기기 신뢰');
    queueMicrotask(() => (changed ? cancel : trust).focus());
    return h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('h3', null, changed ? '저장된 열쇠와 다릅니다' : '이 기기에 처음 연결합니다'),
      h('p', null, changed
        ? '이 주소에 예전에 연결했던 기기와 열쇠가 다릅니다. 파이를 새로 설치했거나, 다른 기기일 수 있습니다.'
        : '아래 지문이 접속하려는 라즈베리파이의 열쇠입니다. 지금 네트워크에 그 파이가 맞다면 신뢰를 누르세요.'),
      h('div', { class: 'fp' }, data.fingerprint || ''),
      h('div', { class: 'modal-actions' }, cancel, trust),
    );
  });
}

function askText({ title, label, value = '', okLabel }) {
  return modal((finish) => {
    const input = h('input', { type: 'text', value, 'aria-label': label });
    queueMicrotask(() => { input.focus(); input.select(); });
    return h('form', { class: 'modal', onsubmit: (event) => { event.preventDefault(); const next = input.value.trim(); if (next) finish(next); } },
      h('h3', null, title),
      h('label', { class: 'field' }, label, input),
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'quiet', onclick: () => finish(null) }, '취소'),
        h('button', { type: 'submit', class: 'primary slim' }, okLabel || '확인'),
      ),
    );
  });
}

function askConfirm({ title, body, detail = '', okLabel }) {
  return modal((finish) => h('div', { class: 'modal', role: 'dialog' },
    h('h3', null, title),
    h('p', null, body),
    detail ? h('p', { class: 'detail' }, detail) : null,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'quiet', onclick: () => finish(false) }, '취소'),
      h('button', { type: 'button', class: 'primary slim', onclick: () => finish(true) }, okLabel || '확인'),
    ),
  ));
}

function modal(build) {
  return new Promise((resolve) => {
    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(null); };
    const back = h('div', { class: 'modal-back' });
    back.addEventListener('mousedown', (event) => { if (event.target === back) finish(null); });
    back.append(build(finish));
    document.body.append(back);
    document.addEventListener('keydown', onKey);
  });
}

function togglePassword(button) {
  const input = document.getElementById('password');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? '숨기기' : '표시';
}

function localCrumbs(current) {
  const items = [{ label: '이 PC', path: '' }];
  if (!current) return items;
  const root = current.slice(0, 3);
  items.push({ label: current.slice(0, 2), path: root });
  let acc = root;
  for (const part of current.slice(3).split('\\').filter(Boolean)) {
    acc = acc.endsWith('\\') ? acc + part : `${acc}\\${part}`;
    items.push({ label: part, path: acc });
  }
  return items;
}

function remoteCrumbs(current) {
  const items = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of String(current || '/').split('/').filter(Boolean)) {
    acc += `/${part}`;
    items.push({ label: part, path: acc });
  }
  return items;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(ms) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}

function blankForm() {
  return {
    host: '',
    username: '',
    password: '',
    savePassword: true,
    profileId: null,
    reuseSavedPassword: false,
  };
}

function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'value') node.value = String(value);
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
