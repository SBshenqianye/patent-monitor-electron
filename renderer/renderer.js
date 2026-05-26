// ============================================================
// 专利监控看板 - renderer.js (使用 window.electronAPI)
// ============================================================
let DATA = [];
let currentFilter = '';
let currentTab = 'table';
let pendingLoginName = null;

// ======================== 工具函数 ========================
function esc(s) { return String(s || '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"'); }

function statusCode(d) {
  if (d === null || d === undefined) return 'unknown';
  if (d < 0) return 'expired';
  if (d <= 365) return 'urgent';
  if (d <= 1095) return 'warning';
  return 'safe';
}

function daysStr(d) {
  if (d === null || d === undefined) return '未知';
  if (d < 0) return '已过期' + Math.abs(d) + '天';
  return d + '天';
}

function colorVal(d) {
  const m = { expired: '#ff4d4f', urgent: '#fa8c16', warning: '#d4b106', safe: '#52c41a', unknown: '#999' };
  return m[statusCode(d)] || '#999';
}

function rowClass(d) {
  const m = { expired: 'expired-row', urgent: 'urgent-row', warning: 'expired-row' };
  return m[statusCode(d)] || '';
}

function badgeHtml(d) {
  const cls = { expired: 'badge-expired', urgent: 'badge-urgent', warning: 'badge-warning', safe: 'badge-safe', unknown: 'badge-unknown' };
  const lbl = { expired: '已过期', urgent: '⚠1年内', warning: '✅1-3年', safe: '🔒3年+', unknown: '未知' };
  const c = statusCode(d);
  return '<span class="badge ' + cls[c] + '">' + lbl[c] + '</span>';
}

// ======================== 数据加载 ========================
async function loadData() {
  const statusEl = document.getElementById('crawlStatus');
  const dotEl = document.getElementById('statusDot');
  const btnRefresh = document.getElementById('btnRefresh');
  
  // 保存按钮原始文本并禁用按钮（防止重复点击）
  const originalBtnText = btnRefresh.textContent;
  btnRefresh.disabled = true;

  // 更新状态栏
  dotEl.className = 'status-dot running';
  statusEl.textContent = '正在刷新数据...';

  try {
    const result = await window.electronAPI.getData();
    if (result.success) {
      const data = result.data;
      // 兼容数据结构：可能直接是数组，也可能包含 patents 字段
      if (Array.isArray(data)) {
        DATA = data;
      } else if (data && Array.isArray(data.patents)) {
        DATA = data.patents;
      } else {
        DATA = [];
      }
      document.getElementById('dataDate').textContent = new Date().toISOString().slice(0, 10);
      recalcDays();
      initFilters();
      renderAll();
      updateMatchInfo();

      // 显示成功信息，3秒后恢复为“就绪”
      dotEl.className = 'status-dot success';
      statusEl.textContent = `✅ 数据刷新成功，共 ${DATA.length} 条专利`;
      setTimeout(() => {
        if (dotEl.className === 'status-dot success') {
          dotEl.className = 'status-dot idle';
          statusEl.textContent = '就绪';
        }
      }, 3000);
    } else {
      throw new Error('返回数据格式错误');
    }
  } catch (err) {
    console.error('加载数据异常:', err);
    dotEl.className = 'status-dot error';
    statusEl.textContent = `❌ 刷新失败: ${err.message || '未知错误'}`;
    setTimeout(() => {
      if (dotEl.className === 'status-dot error') {
        dotEl.className = 'status-dot idle';
        statusEl.textContent = '就绪';
      }
    }, 4000);
  } finally {
    // 恢复刷新按钮
    btnRefresh.textContent = originalBtnText;
    btnRefresh.disabled = false;
  }
}

// ======================== 剩余天数计算 ========================
function recalcDays() {
  const now = new Date();
  DATA.forEach(p => {
    if (p.expiryDate) {
      const parts = p.expiryDate.split('-');
      const ed = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      p.daysRemaining = Math.round((ed - now) / (1000 * 60 * 60 * 24));
    } else {
      p.daysRemaining = null;
    }
  });
}

// ======================== 统计卡片 ========================
function renderStats() {
  const m = { expired: 0, urgent: 0, warning: 0, safe: 0, unknown: 0 };
  DATA.forEach(p => m[statusCode(p.daysRemaining)]++);
  const labels = { expired: '已过期', urgent: '1年内到期', warning: '1-3年', safe: '3年以上', unknown: '未知' };
  const colors = { expired: '#ff4d4f', urgent: '#fa8c16', warning: '#52c41a', safe: '#1890ff', unknown: '#999' };
  const el = document.getElementById('statsBar');
  el.innerHTML = '';
  const order = ['expired', 'urgent', 'warning', 'safe'];
  order.forEach(k => {
    const div = document.createElement('div');
    div.className = 'stat-card' + (currentFilter === k ? ' active' : '');
    div.addEventListener('click', () => {
      currentFilter = (currentFilter === k ? '' : k);
      renderAll();
      updateMatchInfo();
    });
    div.innerHTML = `<div class="num" style="color:${colors[k]}">${m[k]}</div><div class="lbl">${labels[k]}</div>`;
    el.appendChild(div);
  });
  // 总数卡片
  const totalDiv = document.createElement('div');
  totalDiv.className = 'stat-card';
  totalDiv.innerHTML = `<div class="num" style="color:#333">${DATA.length}</div><div class="lbl">总计</div>`;
  totalDiv.addEventListener('click', () => {
    currentFilter = '';
    renderAll();
    updateMatchInfo();
  });
  el.appendChild(totalDiv);
}

// ======================== 筛选器初始化 ========================
function initFilters() {
  const types = {}, years = {};
  DATA.forEach(p => {
    if (p.patentType) types[p.patentType] = 1;
    if (p.applyYear) years[p.applyYear] = 1;
  });
  const ts = document.getElementById('typeFilter');
  ts.innerHTML = '<option value="">全部类型</option>';
  Object.keys(types).sort().forEach(t => {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    ts.appendChild(o);
  });
  const ys = document.getElementById('yearFilter');
  ys.innerHTML = '<option value="">全部年份</option>';
  Object.keys(years).sort().reverse().forEach(y => {
    const o = document.createElement('option');
    o.value = y;
    o.textContent = y + '年';
    ys.appendChild(o);
  });
}

// ======================== 获取筛选后数据 ========================
function getFiltered() {
  const kw = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const type = document.getElementById('typeFilter').value;
  const year = document.getElementById('yearFilter').value;
  let list = DATA.slice();
  if (kw) {
    list = list.filter(p => 
      (p.title && p.title.toLowerCase().includes(kw)) ||
      (p.applyId && p.applyId.toLowerCase().includes(kw)) ||
      (p.inventor && p.inventor.toLowerCase().includes(kw)) ||
      (p.applicant && p.applicant.toLowerCase().includes(kw)) ||
      (p.patentAgency && p.patentAgency.toLowerCase().includes(kw))
    );
  }
  if (type) list = list.filter(p => p.patentType === type);
  if (year) list = list.filter(p => p.applyYear === parseInt(year));
  if (currentFilter) list = list.filter(p => statusCode(p.daysRemaining) === currentFilter);
  const sv = document.getElementById('sortSelect').value;
  list.sort((a, b) => {
    const ad = (a.daysRemaining === null || a.daysRemaining === undefined) ? 999999 : a.daysRemaining;
    const bd = (b.daysRemaining === null || b.daysRemaining === undefined) ? 999999 : b.daysRemaining;
    if (sv === 'days_asc') return ad - bd;
    if (sv === 'days_desc') return bd - ad;
    if (sv === 'title') return (a.title || '').localeCompare(b.title || '');
    if (sv === 'apply_desc') return (b.applyDate || '').localeCompare(a.applyDate || '');
    if (sv === 'apply_asc') return (a.applyDate || '').localeCompare(b.applyDate || '');
    return ad - bd;
  });
  return list;
}

function updateMatchInfo() {
  const list = getFiltered();
  document.getElementById('matchInfo').textContent = `显示 ${list.length}/${DATA.length} 条`;
}

// ======================== 渲染表格 ========================
function renderTable() {
  const list = getFiltered();
  const tbody = document.getElementById('tableBody');
  const noData = document.getElementById('noDataMsg');
  if (!list.length) {
    tbody.innerHTML = '';
    noData.style.display = 'block';
    document.getElementById('statusInfo').textContent = '0 条匹配';
    return;
  }
  noData.style.display = 'none';
  document.getElementById('statusInfo').textContent = `显示 ${list.length}/${DATA.length} 条`;
  let html = '';
  list.forEach(p => {
    const d = p.daysRemaining;
    const tit = (p.title && p.title.length > 60) ? p.title.substring(0, 60) + '...' : (p.title || '');
    const inv = (p.inventor || '').substring(0, 14);
    const agn = (p.patentAgency || '').substring(0, 18);
    html += `<tr class="${rowClass(d)}" data-id="${esc(p.applyId || '')}">`;
    html += `<td>${badgeHtml(d)}</td>`;
    html += `<td style="font-weight:600;color:${colorVal(d)}">${daysStr(d)}</td>`;
    html += `<td class="col-id">${esc(p.applyId || '')}</td>`;
    html += `<td class="col-title" title="${esc(p.title || '')}">${esc(tit)}</td>`;
    html += `<td>${esc(p.applyDate || '')}</td>`;
    html += `<td>${esc(p.pubDate || '')}</td>`;
    html += `<td>${esc(p.expiryDate || '')}</td>`;
    html += `<td title="${esc(p.inventor || '')}">${esc(inv)}</td>`;
    html += `<td class="col-agency" title="${esc(p.patentAgency || '')}">${esc(agn)}</td>`;
    html += `<td>${esc(p.patentType || '')}</td>`;
    html += `<td><span style="font-size:11px;color:#888">${esc(p.source || '')}</span></td>`;
    html += `</tr>`;
  });
  tbody.innerHTML = html;
}

// ======================== 详情弹窗 ========================
function showDetail(id) {
  const p = DATA.find(item => item.applyId === id);
  if (!p) return;
  document.getElementById('detailTitle').textContent = p.title || '专利详情';
  const d = p.daysRemaining;
  const dl = [
    ['📋 申请号', `<code class="col-id">${esc(p.applyId || '')}</code>`],
    ['📄 专利名称', esc(p.title || '')],
    ['📌 专利类型', esc(p.patentType || '')],
    ['🔢 IPC分类', esc(p.classification || '')],
    ['📅 申请日', esc(p.applyDate || '')],
    ['📣 公开(公告)日', esc(p.pubDate || '')],
    ['⏰ 预计到期日', `<span style="color:${colorVal(d)};font-weight:600">${esc(p.expiryDate || '')}</span>`],
    ['⏱️ 剩余天数', `<span style="color:${colorVal(d)};font-weight:700;font-size:16px">${daysStr(d)}</span>`],
    ['🏛️ 法律状态', esc(p.legalStatus || '')],
    ['👤 发明人', esc(p.inventor || '')],
    ['🏭 申请人', esc(p.applicant || '')],
    ['🏢 公司', esc(p.company || '')],
  ];
  if (p.patentAgency) dl.push(['🤝 专利代理机构', esc(p.patentAgency)]);
  if (p.patentAgent) dl.push(['👨‍⚖️ 专利代理师', esc(p.patentAgent)]);
  dl.push(['📍 地址', esc(p.address || '')]);
  dl.push(['📬 邮编', esc(p.zipcode || '')]);
  dl.push(['📡 数据源', esc(p.source || '')]);
  let h = '<div class="detail-grid">';
  dl.forEach(r => { h += `<div class="detail-label">${r[0]}</div><div class="detail-value">${r[1]}</div>`; });
  h += '</div>';
  if (p.abstract) h += `<div class="detail-section"><strong>📝 摘要</strong><br><span style="font-size:12px;color:#555;line-height:1.6">${esc(p.abstract)}</span></div>`;
  document.getElementById('detailBody').innerHTML = h;
  document.getElementById('detailModal').classList.add('show');
}

function closeDetail() {
  document.getElementById('detailModal').classList.remove('show');
}

// ======================== 图表渲染 ========================
function renderPieChart() {
  const el = document.getElementById('pieChart');
  const m = { expired: 0, urgent: 0, warning: 0, safe: 0 };
  DATA.forEach(p => m[statusCode(p.daysRemaining)]++);
  const slices = [
    { l: '已过期', v: m.expired, c: '#ff4d4f' },
    { l: '⚠️  1年内到期', v: m.urgent, c: '#fa8c16' },
    { l: '✅ 1-3年', v: m.warning, c: '#52c41a' },
    { l: '🔒 3年以上', v: m.safe, c: '#1890ff' }
  ].filter(s => s.v > 0);
  if (!slices.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>';
    return;
  }
  const total = slices.reduce((sum, s) => sum + s.v, 0);
  const colors = ['#ff4d4f', '#fa8c16', '#52c41a', '#1890ff'];
  let inner = '';
  slices.forEach((s, i) => {
    const pct = Math.round(s.v / total * 100);
    inner += `<div style="display:flex;align-items:center;margin:4px 0;font-size:13px">
                <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${colors[i]};margin-right:8px"></span>
                <span style="flex:1">${s.l}</span>
                <span style="font-weight:600;color:${colors[i]}">${s.v} (${pct}%)</span>
              </div>`;
  });
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">${inner}</div>`;
}

function renderYearChart() {
  const el = document.getElementById('yearChart');
  const years = {};
  DATA.forEach(p => { if (p.applyYear) years[p.applyYear] = (years[p.applyYear] || 0) + 1; });
  let entries = Object.keys(years).sort().map(y => ({ y: parseInt(y), c: years[y] }));
  if (!entries.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>';
    return;
  }
  const maxC = Math.max(...entries.map(e => e.c), 1);
  let html = '';
  entries.forEach(e => {
    html += `<div class="bar-row">
              <div class="bar-lbl">${e.y}</div>
              <div class="bar-track">
                <div class="bar-fill clr-blue" style="width:${(e.c / maxC * 100)}%">${e.c}件</div>
              </div>
            </div>`;
  });
  el.innerHTML = html;
}

function renderApplicantChart() {
  const el = document.getElementById('applicantChart');
  const apps = {};
  DATA.forEach(p => { const a = p.applicant || '未知'; apps[a] = (apps[a] || 0) + 1; });
  let entries = Object.keys(apps).sort((a,b) => apps[b] - apps[a]).slice(0,10).map(n => ({ n, c: apps[n] }));
  if (!entries.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>';
    return;
  }
  const maxC = entries[0].c || 1;
  let html = '';
  entries.forEach(e => {
    html += `<div class="bar-row">
              <div class="bar-name" title="${esc(e.n)}">${esc(e.n.substring(0, 24))}</div>
              <div class="bar-track">
                <div class="bar-fill clr-blue" style="width:${(e.c / maxC * 100)}%">${e.c}件</div>
              </div>
            </div>`;
  });
  el.innerHTML = html;
}

function renderTypeChart() {
  const el = document.getElementById('typeChart');
  const types = {};
  DATA.forEach(p => { const t = p.patentType || '未知'; types[t] = (types[t] || 0) + 1; });
  let entries = Object.keys(types).sort((a,b) => types[b] - types[a]).map(t => ({ n: t, c: types[t] }));
  if (!entries.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>';
    return;
  }
  const maxC = entries[0].c || 1;
  let html = '';
  entries.forEach(e => {
    html += `<div class="bar-row">
              <div class="bar-lbl">${esc(e.n.substring(0, 8))}</div>
              <div class="bar-track">
                <div class="bar-fill clr-blue" style="width:${(e.c / maxC * 100)}%">${e.c}件</div>
              </div>
            </div>`;
  });
  el.innerHTML = html;
}

function renderCharts() {
  renderPieChart();
  renderYearChart();
  renderApplicantChart();
  renderTypeChart();
}

// ======================== Tab切换 ========================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tab);
  });
  document.getElementById('tab-table').style.display = tab === 'table' ? 'block' : 'none';
  document.getElementById('tab-chart').style.display = tab === 'chart' ? 'block' : 'none';
  if (tab === 'chart') renderCharts();
}

// ======================== 渲染全部 ========================
function renderAll() {
  recalcDays();
  renderStats();
  renderTable();
  if (currentTab === 'chart') renderCharts();
}

// ======================== 爬虫/清洗操作 ========================
function handleCrawl() {
  const btn = document.getElementById('btnCrawl');
  btn.disabled = true;
  btn.textContent = '⏳ 爬取中...';
  document.getElementById('crawlStatus').textContent = '正在启动爬虫...';
  document.getElementById('statusDot').className = 'status-dot running';
  window.electronAPI.runAllCrawlers().catch(err => {
    console.error('爬取失败:', err);
    document.getElementById('crawlStatus').textContent = '❌ 爬取启动失败';
    document.getElementById('statusDot').className = 'status-dot error';
    btn.disabled = false;
    btn.textContent = '🚀 一键爬取';
  });
}

function handleClean() {
  const btn = document.getElementById('btnClean');
  btn.disabled = true;
  btn.textContent = '⏳ 清洗中...';
  document.getElementById('crawlStatus').textContent = '正在启动清洗...';
  document.getElementById('statusDot').className = 'status-dot running';
  window.electronAPI.runCleaning().then(() => {
    loadData();
  }).catch(err => {
    console.error('清洗失败:', err);
    document.getElementById('crawlStatus').textContent = '❌ 清洗启动失败';
    document.getElementById('statusDot').className = 'status-dot error';
  }).finally(() => {
    btn.disabled = false;
    btn.textContent = '🧹 一键清洗';
  });
}

// ======================== 登录弹窗 ========================
function showLoginModal(source) {
  pendingLoginName = source;
  document.getElementById('loginMessage').textContent = `爬虫「${source}」需要登录相关网站才能使用。`;
  document.getElementById('loginModal').style.display = 'flex';
}

function closeLoginModal() {
  document.getElementById('loginModal').style.display = 'none';
  pendingLoginName = null;
}

function startLogin() {
  if (pendingLoginName) {
    window.electronAPI.guideLogin(pendingLoginName).catch(err => console.error('登录引导失败:', err));
  }
  closeLoginModal();
}

// ======================== 事件监听（来自主进程） ========================
function setupEventListeners() {
  // 爬虫状态更新
  window.electronAPI.onCrawlerStatus((status) => {
    console.log('爬虫状态:', status);
    const statusEl = document.getElementById('crawlStatus');
    const dotEl = document.getElementById('statusDot');
    if (status.name === 'all' && status.allDone) {
      dotEl.className = 'status-dot success';
      statusEl.textContent = '✅ 爬取完成，正在刷新数据...';
      loadData();
      setTimeout(() => {
        if (dotEl.className === 'status-dot success') {
          dotEl.className = 'status-dot idle';
          statusEl.textContent = '就绪';
        }
      }, 5000);
    } else if (status.status === 'running') {
      dotEl.className = 'status-dot running';
      statusEl.textContent = status.message;
    } else if (status.status === 'completed') {
      statusEl.textContent = status.message;
    } else if (status.status === 'error') {
      dotEl.className = 'status-dot error';
      statusEl.textContent = status.message;
    }
    if (status.name === 'all' && status.allDone) {
      document.getElementById('btnCrawl').disabled = false;
      document.getElementById('btnCrawl').textContent = '🚀 一键爬取';
    }
  });

  // 清洗状态更新
  window.electronAPI.onCleaningStatus((status) => {
    console.log('清洗状态:', status);
    const statusEl = document.getElementById('crawlStatus');
    const dotEl = document.getElementById('statusDot');
    if (status.status === 'running') {
      dotEl.className = 'status-dot running';
      statusEl.textContent = status.message;
    } else if (status.status === 'completed') {
      dotEl.className = 'status-dot success';
      statusEl.textContent = status.message;
      loadData();
      setTimeout(() => {
        if (dotEl.className === 'status-dot success') {
          dotEl.className = 'status-dot idle';
          statusEl.textContent = '就绪';
        }
      }, 5000);
      document.getElementById('btnClean').disabled = false;
      document.getElementById('btnClean').textContent = '🧹 一键清洗';
    } else if (status.status === 'error') {
      dotEl.className = 'status-dot error';
      statusEl.textContent = status.message;
      document.getElementById('btnClean').disabled = false;
      document.getElementById('btnClean').textContent = '🧹 一键清洗';
    }
  });

  // 需要登录事件
  window.electronAPI.onLoginRequired((data) => {
    console.log('需要登录:', data);
    showLoginModal(data.name);
  });

  // 登录完成事件
  window.electronAPI.onLoginDone((data) => {
    console.log('登录完成:', data);
    loadData();
  });
}

// ======================== 页面初始化 ========================
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadData();

  let st = null;
  document.getElementById('searchInput').addEventListener('input', () => {
    if (st) clearTimeout(st);
    st = setTimeout(() => {
      renderAll();
      updateMatchInfo();
    }, 200);
  });
  document.getElementById('sortSelect').addEventListener('change', () => {
    renderAll();
    updateMatchInfo();
  });
  document.getElementById('typeFilter').addEventListener('change', () => {
    renderAll();
    updateMatchInfo();
  });
  document.getElementById('yearFilter').addEventListener('change', () => {
    renderAll();
    updateMatchInfo();
  });
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.getAttribute('data-tab')));
  });
  document.getElementById('tab-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr && tr.dataset && tr.dataset.id) showDetail(tr.dataset.id);
  });
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target === this) closeDetail();
  });
  document.getElementById('closeModalBtn').addEventListener('click', closeDetail);

  // 实时时钟
  function updateClock() {
    const now = new Date();
    const s = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    document.getElementById('liveClock').textContent = s;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // 定期刷新剩余天数
  setInterval(() => {
    recalcDays();
    renderStats();
    renderTable();
    if (currentTab === 'chart') renderCharts();
  }, 10000);
});

// ======================== 全局函数暴露给 HTML 按钮 ========================
window.handleCrawl = handleCrawl;
window.handleClean = handleClean;
window.loadData = loadData;
window.showLoginModal = showLoginModal;
window.closeLoginModal = closeLoginModal;
window.startLogin = startLogin;