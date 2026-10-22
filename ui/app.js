const API = `http://127.0.0.1:${window.tkswarmBrowser?.apiPort || 54345}`;

async function json(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function bitListProfiles() {
  const res = await fetch(`${API}/browser/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 0, pageSize: 200 }),
  });
  const j = await res.json();
  return j.data?.list || [];
}

function show(el, on) {
  document.querySelector(el)?.classList.toggle('hidden', !on);
}

function emptyRow(colspan, title, detail) {
  return `<tr><td colspan="${colspan}" class="empty">
    <div class="empty-block">
      <strong>${esc(title)}</strong>
      ${detail ? `<span class="muted">${esc(detail)}</span>` : ''}
    </div>
  </td></tr>`;
}

async function refreshDashboard() {
  const [pack, sys] = await Promise.all([
    json('GET', '/api/dashboard/stats/async'),
    json('GET', '/api/system/info').catch(() => ({})),
  ]);
  if (!pack.ok) return;
  const pathBar = document.getElementById('path-bar');
  if (pathBar && sys.ok) {
    const renderOn = sys.softwareRenderActive
      ? `已开启${sys.softwareRenderReason ? `（${sys.softwareRenderReason}）` : ''}`
      : '未开启';
    pathBar.innerHTML = [
      `<b>便携版数据目录</b>：<code>${esc(sys.dataRoot)}</code>`,
      `<b>settings.json</b>：<code>${esc(sys.settingsPath)}</code>`,
      `软件渲染 ${renderOn} · 内核 ${esc(sys.engine || '—')} · 环境窗 ${esc(sys.envWindowMode || '—')} · v${esc(sys.version || '')}`,
      sys.packagedPortable ? '<span class="muted">便携版环境窗经 portable.exe 子进程拉起（勿用 Temp 内 exe）</span>' : '',
    ].filter(Boolean).join('<br>');
  }
  const { user, self, children, windows } = pack;
  document.getElementById('user-chip').textContent =
    `${user.nickname || user.username} · ${user.role || ''}`;
  show('#user-chip', true);
  show('#btn-logout', true);
  show('#btn-test-env', true);
  document.getElementById('stat-self').textContent = `${self.used} / ${self.limit}`;
  const tokenEl = document.getElementById('api-token');
  if (pack.token) tokenEl.textContent = pack.token;
  document.getElementById('stat-windows').textContent = String(windows.length);
  const childEl = document.getElementById('stat-children');
  if (!children?.length) {
    childEl.textContent = '无子级账号或无权限查看';
  } else {
    childEl.innerHTML = children.map((c) =>
      `<div class="child-row"><span>${esc(c.nickname || c.username)}</span><span class="muted">${c.used}/${c.limit}</span></div>`
    ).join('');
  }

  const winBody = document.getElementById('win-body');
  if (!windows.length) {
    winBody.innerHTML = emptyRow(5, '暂无运行中的窗口', '打开环境后会出现在这里');
  } else {
    winBody.innerHTML = windows.map((w) => `
      <tr>
        <td><code>${esc(w.profileId.slice(0, 10))}…</code></td>
        <td>${esc(w.name)}</td>
        <td><span class="tag ${w.headless ? 'headless' : 'visible'}">${w.headless ? '无头' : '有头'}</span></td>
        <td>${w.pid || '—'}</td>
        <td>
          <div class="row-actions">
            ${w.headless ? `<button class="btn small primary btn-show" type="button" data-id="${esc(w.profileId)}">显示窗口</button>` : ''}
            <button class="btn small ghost btn-close" type="button" data-id="${esc(w.profileId)}">关闭</button>
          </div>
        </td>
      </tr>
    `).join('');
    winBody.querySelectorAll('.btn-show').forEach((btn) => {
      btn.onclick = () => showWindow(btn.dataset.id);
    });
    winBody.querySelectorAll('.btn-close').forEach((btn) => {
      btn.onclick = () => closeWindow(btn.dataset.id);
    });
  }

  const profiles = await bitListProfiles();
  const profileBody = document.getElementById('profile-body');
  if (!profiles.length) {
    profileBody.innerHTML = emptyRow(6, '暂无环境', '请在 Node 账号页创建并绑定');
  } else {
    profileBody.innerHTML = profiles.map((p) => {
      const running = p.status === 1 || p.status === 2;
      return `
      <tr>
        <td><code>${esc(String(p.id).slice(0, 12))}…</code></td>
        <td>${esc(p.name)}${p.remark ? `<div class="cell-sub">${esc(p.remark)}</div>` : ''}</td>
        <td>${esc(p.groupId || 'default')}</td>
        <td>${esc(p.proxyType || 'noproxy')} ${esc(p.host || '')}${p.port ? ':' + p.port : ''}${p.lastIp ? `<div class="cell-sub">IP ${esc(p.lastIp)}</div>` : ''}</td>
        <td>${esc(p.timezone || '—')}</td>
        <td><span class="status-dot ${running ? 'running' : 'idle'}">${running ? '运行中' : '空闲'}</span></td>
      </tr>`;
    }).join('');
  }
}

async function showWindow(id) {
  await json('POST', `/api/windows/${encodeURIComponent(id)}/show`);
  await refreshDashboard();
}

async function closeWindow(id) {
  await json('POST', `/api/windows/${encodeURIComponent(id)}/close`);
  await refreshDashboard();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function doLogin(e) {
  e?.preventDefault?.();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  const pack = await json('POST', '/api/auth/login', {
    apiBase: document.getElementById('api-base').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
  });
  if (!pack.ok) {
    errEl.textContent = pack.message || '登录失败';
    errEl.classList.remove('hidden');
    return;
  }
  show('#login-panel', false);
  show('#dashboard', true);
  await refreshDashboard();
}

const DEFAULT_API_BASE = 'http://tkswarm-api.dyyweb.com/api';

function normalizeLoginApiBase(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v || /127\.0\.0\.1|localhost/i.test(v)) return DEFAULT_API_BASE;
  return v;
}

async function init() {
  document.getElementById('api-url').textContent = API;
  const apiBaseEl = document.getElementById('api-base');
  const settings = await json('GET', '/api/settings').catch(() => ({}));
  apiBaseEl.value = normalizeLoginApiBase(settings.apiBase || settings.defaultApiBase || DEFAULT_API_BASE);
  const st = await json('GET', '/api/auth/status');
  if (st.loggedIn) {
    show('#login-panel', false);
    show('#dashboard', true);
    await refreshDashboard();
  }

  document.getElementById('login-form').addEventListener('submit', doLogin);
  document.getElementById('btn-login').onclick = doLogin;

  document.getElementById('btn-logout').onclick = async () => {
    await json('POST', '/api/auth/logout');
    show('#dashboard', false);
    show('#login-panel', true);
    show('#user-chip', false);
    show('#btn-logout', false);
    show('#btn-test-env', false);
  };
  document.getElementById('btn-test-env').onclick = async () => {
    const btn = document.getElementById('btn-test-env');
    const label = '测试环境窗';
    btn.disabled = true;
    btn.textContent = '打开中…';
    try {
      const pack = await json('POST', '/api/test/open-env-window');
      if (!pack.ok) {
        alert(pack.message || '测试环境窗打开失败');
      } else {
        await refreshDashboard();
      }
    } catch (error) {
      alert(error?.message || '请求失败');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  document.getElementById('btn-refresh').onclick = () => refreshDashboard();
  document.getElementById('btn-copy-token').onclick = async () => {
    const t = document.getElementById('api-token').textContent.trim();
    if (!t || t === '—') return;
    await navigator.clipboard.writeText(t);
    document.getElementById('btn-copy-token').textContent = '已复制';
    setTimeout(() => { document.getElementById('btn-copy-token').textContent = '复制'; }, 1500);
  };
  window.tkswarmBrowser?.onWindowsUpdated?.(() => refreshDashboard());
  window.tkswarmBrowser?.onTestEnvError?.((msg) => {
    alert(`测试环境窗打开失败：${msg}`);
  });
  setInterval(() => refreshDashboard(), 8000);
}

init().catch(console.error);
