const api = window.envChrome;

function $(id) { return document.getElementById(id); }

function renderTabs(tabs) {
  const strip = $('tab-strip');
  strip.innerHTML = tabs.map((t) => `
    <div class="tab-item${t.active ? ' active' : ''}" data-id="${t.id}">
      <span class="tab-title">${esc(t.title || '新标签页')}</span>
      <button type="button" class="tab-close" data-close="${t.id}" title="关闭">×</button>
    </div>
  `).join('');
  strip.querySelectorAll('.tab-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      api.switchTab(Number(el.dataset.id));
    });
  });
  strip.querySelectorAll('.tab-close').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.closeTab(Number(btn.dataset.close));
    });
  });
}

function renderHistory(items) {
  const list = $('history-list');
  if (!items?.length) {
    list.innerHTML = '<li class="muted" style="padding:12px;color:#888;font-size:12px">暂无历史记录</li>';
    return;
  }
  list.innerHTML = items.map((h) => `
    <li><button type="button" data-url="${escAttr(h.url)}">
      <span class="h-title">${esc(h.title || h.url)}</span>
      <span class="h-url">${esc(h.url)}</span>
    </button></li>
  `).join('');
  list.querySelectorAll('button[data-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      api.openHistory(btn.dataset.url);
      $('history-panel').classList.add('hidden');
    });
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

function applyState(state) {
  if (!state) return;
  renderTabs(state.tabs || []);
  const input = $('addr-input');
  if (document.activeElement !== input) input.value = state.url || '';
  $('btn-back').disabled = !state.canGoBack;
  $('btn-forward').disabled = !state.canGoForward;
  renderHistory(state.history || []);
}

$('addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  api.navigate($('addr-input').value.trim());
});

$('btn-back').onclick = () => api.back();
$('btn-forward').onclick = () => api.forward();
$('btn-reload').onclick = () => api.reload();
$('btn-home').onclick = () => api.home();
$('btn-new-tab').onclick = () => api.newTab();
$('btn-close-win').onclick = () => api.closeWindow();
$('btn-history').onclick = () => $('history-panel').classList.toggle('hidden');
$('btn-close-history').onclick = () => $('history-panel').classList.add('hidden');
$('btn-clear-history').onclick = () => api.clearHistory();

api.onState(applyState);
api.ready();
