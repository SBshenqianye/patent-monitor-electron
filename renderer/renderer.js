// ============================================================
// 专利监控看板 - renderer.js
// ============================================================
const { ipcRenderer } = require('electron');

var DATA = [];
var currentFilter = '';
var currentTab = 'table';

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
  var m = { expired: '#ff4d4f', urgent: '#fa8c16', warning: '#d4b106', safe: '#52c41a', unknown: '#999' };
  return m[statusCode(d)] || '#999';
}

function rowClass(d) {
  var m = { expired: 'expired-row', urgent: 'urgent-row', warning: 'expired-row' };
  return m[statusCode(d)] || '';
}

function badgeHtml(d) {
  var cls = { expired: 'badge-expired', urgent: 'badge-urgent', warning: 'badge-warning', safe: 'badge-safe', unknown: 'badge-unknown' };
  var lbl = { expired: '已过期', urgent: '⚠1年内', warning: '✅1-3年', safe: '🔒3年+', unknown: '未知' };
  var c = statusCode(d);
  return '<span class="badge ' + cls[c] + '">' + lbl[c] + '</span>';
}

// ======================== 数据加载 ========================
function loadData() {
  ipcRenderer.send('read-cleaned-data');
}

ipcRenderer.on('cleaned-data', function(event, data) {
  if (data && data.length) {
    DATA = data;
    document.getElementById('dataDate').textContent = new Date().toISOString().slice(0, 10);
  }
  recalcDays();
  initFilters();
  renderAll();
  updateMatchInfo();
});

ipcRenderer.on('cleaned-data-error', function(event, msg) {
  console.error('加载数据失败:', msg);
  document.getElementById('crawlStatus').textContent = '❌ 数据加载失败: ' + msg;
  document.getElementById('statusDot').className = 'status-dot error';
});

// ======================== 剩余天数计算 ========================
function recalcDays() {
  var now = new Date();
  DATA.forEach(function(p) {
    if (p.expiryDate) {
      var parts = p.expiryDate.split('-');
      var ed = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      p.daysRemaining = Math.round((ed - now) / (1000 * 60 * 60 * 24));
    } else {
      p.daysRemaining = null;
    }
  });
}

// ======================== 统计卡片 ========================
function renderStats() {
  var m = { expired: 0, urgent: 0, warning: 0, safe: 0, unknown: 0 };
  DATA.forEach(function(p) { m[statusCode(p.daysRemaining)]++; });
  var labels = { expired: '已过期', urgent: '1年内到期', warning: '1-3年', safe: '3年以上', unknown: '未知' };
  var colors = { expired: '#ff4d4f', urgent: '#fa8c16', warning: '#52c41a', safe: '#1890ff', unknown: '#999' };
  var el = document.getElementById('statsBar');
  el.innerHTML = '';
  var order = ['expired', 'urgent', 'warning', 'safe'];
  order.forEach(function(k) {
    var div = document.createElement('div');
    div.className = 'stat-card' + (currentFilter === k ? ' active' : '');
    div.addEventListener('click', function() {
      currentFilter = (currentFilter === k ? '' : k);
      renderAll();
      updateMatchInfo();
    });
    div.innerHTML = '<div class="num" style="color:' + colors[k] + '">' + m[k] + '</div><div class="lbl">' + labels[k] + '</div>';
    el.appendChild(div);
  });
  // 总数卡片
  var totalDiv = document.createElement('div');
  totalDiv.className = 'stat-card';
  totalDiv.innerHTML = '<div class="num" style="color:#333">' + DATA.length + '</div><div class="lbl">总计</div>';
  totalDiv.addEventListener('click', function() {
    currentFilter = '';
    renderAll();
    updateMatchInfo();
  });
  el.appendChild(totalDiv);
}

// ======================== 筛选器初始化 ========================
function initFilters() {
  var types = {}, years = {};
  DATA.forEach(function(p) {
    if (p.patentType) types[p.patentType] = 1;
    if (p.applyYear) years[p.applyYear] = 1;
  });
  var ts = document.getElementById('typeFilter');
  ts.innerHTML = '<option value="">全部类型</option>';
  Object.keys(types).sort().forEach(function(t) {
    var o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    ts.appendChild(o);
  });
  var ys = document.getElementById('yearFilter');
  ys.innerHTML = '<option value="">全部年份</option>';
  Object.keys(years).sort().reverse().forEach(function(y) {
    var o = document.createElement('option');
    o.value = y;
    o.textContent = y + '年';
    ys.appendChild(o);
  });
}

// ======================== 获取筛选后数据 ========================
function getFiltered() {
  var kw = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  var type = document.getElementById('typeFilter').value;
  var year = document.getElementById('yearFilter').value;
  var list = DATA.slice();
  if (kw) list = list.filter(function(p) {
    return (p.title && p.title.toLowerCase().indexOf(kw) !== -1) ||
      (p.applyId && p.applyId.toLowerCase().indexOf(kw) !== -1) ||
      (p.inventor && p.inventor.toLowerCase().indexOf(kw) !== -1) ||
      (p.applicant && p.applicant.toLowerCase().indexOf(kw) !== -1) ||
      (p.patentAgency && p.patentAgency.toLowerCase().indexOf(kw) !== -1);
  });
  if (type) list = list.filter(function(p) { return p.patentType === type; });
  if (year) list = list.filter(function(p) { return p.applyYear === parseInt(year); });
  if (currentFilter) list = list.filter(function(p) { return statusCode(p.daysRemaining) === currentFilter; });
  var sv = document.getElementById('sortSelect').value;
  list.sort(function(a, b) {
    var ad = (a.daysRemaining === null || a.daysRemaining === undefined) ? 999999 : a.daysRemaining;
    var bd = (b.daysRemaining === null || b.daysRemaining === undefined) ? 999999 : b.daysRemaining;
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
  var list = getFiltered();
  document.getElementById('matchInfo').textContent = '显示 ' + list.length + '/' + DATA.length + ' 条';
}

// ======================== 渲染表格 ========================
function renderTable() {
  var list = getFiltered();
  var tbody = document.getElementById('tableBody');
  var noData = document.getElementById('noDataMsg');
  if (!list.length) {
    tbody.innerHTML = '';
    noData.style.display = 'block';
    document.getElementById('statusInfo').textContent = '0 条匹配';
    return;
  }
  noData.style.display = 'none';
  document.getElementById('statusInfo').textContent = '显示 ' + list.length + '/' + DATA.length + ' 条';
  var html = '';
  list.forEach(function(p) {
    var d = p.daysRemaining;
    var tit = (p.title && p.title.length > 60) ? p.title.substring(0, 60) + '...' : (p.title || '');
    var inv = (p.inventor || '').substring(0, 14);
    var agn = (p.patentAgency || '').substring(0, 18);
    html += '<tr class="' + rowClass(d) + '" data-id="' + esc(p.applyId || '') + '">';
    html += '<td>' + badgeHtml(d) + '</td>';
    html += '<td style="font-weight:600;color:' + colorVal(d) + '">' + daysStr(d) + '</td>';
    html += '<td class="col-id">' + esc(p.applyId || '') + '</td>';
    html += '<td class="col-title" title="' + esc(p.title || '') + '">' + esc(tit) + '</td>';
    html += '<td>' + esc(p.applyDate || '') + '</td>';
    html += '<td>' + esc(p.pubDate || '') + '</td>';
    html += '<td>' + esc(p.expiryDate || '') + '</td>';
    html += '<td title="' + esc(p.inventor || '') + '">' + esc(inv) + '</td>';
    html += '<td class="col-agency" title="' + esc(p.patentAgency || '') + '">' + esc(agn) + '</td>';
    html += '<td>' + esc(p.patentType || '') + '</td>';
    html += '<td><span style="font-size:11px;color:#888">' + esc(p.source || '') + '</span></td></tr>';
  });
  tbody.innerHTML = html;
}

// ======================== 详情弹窗 ========================
function showDetail(id) {
  var p = null;
  for (var i = 0; i < DATA.length; i++) {
    if (DATA[i].applyId === id) { p = DATA[i]; break; }
  }
  if (!p) return;
  document.getElementById('detailTitle').textContent = p.title || '专利详情';
  var d = p.daysRemaining;
  var dl = [
    ['📋 申请号', '<code class="col-id">' + esc(p.applyId || '') + '</code>'],
    ['📄 专利名称', esc(p.title || '')],
    ['📌 专利类型', esc(p.patentType || '')],
    ['🔢 IPC分类', esc(p.classification || '')],
    ['📅 申请日', esc(p.applyDate || '')],
    ['📣 公开(公告)日', esc(p.pubDate || '')],
    ['⏰ 预计到期日', '<span style="color:' + colorVal(d) + ';font-weight:600">' + esc(p.expiryDate || '') + '</span>'],
    ['⏱️ 剩余天数', '<span style="color:' + colorVal(d) + ';font-weight:700;font-size:16px">' + daysStr(d) + '</span>'],
    ['🏛️ 法律状态', esc(p.legalStatus || '')],
  ];
  dl.push(['👤 发明人', esc(p.inventor || '')]);
  dl.push(['🏭 申请人', esc(p.applicant || '')]);
  dl.push(['🏢 公司', esc(p.company || '')]);
  if (p.patentAgency) dl.push(['🤝 专利代理机构', esc(p.patentAgency)]);
  if (p.patentAgent) dl.push(['👨‍⚖️ 专利代理师', esc(p.patentAgent)]);
  dl.push(['📍 地址', esc(p.address || '')]);
  dl.push(['📬 邮编', esc(p.zipcode || '')]);
  dl.push(['📡 数据源', esc(p.source || '')]);
  var h = '<div class="detail-grid">';
  dl.forEach(function(r) { h += '<div class="detail-label">' + r[0] + '</div><div class="detail-value">' + r[1] + '</div>'; });
  h += '</div>';
  if (p.abstract) h += '<div class="detail-section"><strong>📝 摘要</strong><br><span style="font-size:12px;color:#555;line-height:1.6">' + esc(p.abstract) + '</span></div>';
  document.getElementById('detailBody').innerHTML = h;
  document.getElementById('detailModal').classList.add('show');
}

function closeDetail() {
  document.getElementById('detailModal').classList.remove('show');
}

// ======================== 图表渲染 ========================
function renderPieChart() {
  var el = document.getElementById('pieChart');
  var m = { expired: 0, urgent: 0, warning: 0, safe: 0 };
  DATA.forEach(function(p) { m[statusCode(p.daysRemaining)]++; });
  var slices = [
    { l: '已过期', v: m.expired, c: '#ff4d4f' },
    { l: '⚠️  1年内到期', v: m.urgent, c: '#fa8c16' },
    { l: '✅ 1-3年', v: m.warning, c: '#52c41a' },
    { l: '🔒 3年以上', v: m.safe, c: '#1890ff' }
  ];
  slices = slices.filter(function(s) { return s.v > 0; });
  if (!slices.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
  var total = 0;
  slices.forEach(function(s) { total += s.v; });
  var colors = ['#ff4d4f', '#fa8c16', '#52c41a', '#1890ff'];
  var inner = '';
  slices.forEach(function(s, i) {
    var pct = Math.round(s.v / total * 100);
    inner += '<div style="display:flex;align-items:center;margin:4px 0;font-size:13px">';
    inner += '<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:' + colors[i] + ';margin-right:8px"></span>';
    inner += '<span style="flex:1">' + s.l + '</span><span style="font-weight:600;color:' + colors[i] + '">' + s.v + ' (' + pct + '%)</span></div>';
  });
  el.innerHTML = '<div style="display:flex;flex-direction:column;gap:4px">' + inner + '</div>';
}

function renderYearChart() {
  var el = document.getElementById('yearChart');
  var years = {};
  DATA.forEach(function(p) { if (p.applyYear) years[p.applyYear] = (years[p.applyYear] || 0) + 1; });
  var entries = Object.keys(years).sort().map(function(y) { return { y: parseInt(y), c: years[y] }; });
  if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
  var maxC = 0;
  entries.forEach(function(e) { if (e.c > maxC) maxC = e.c; });
  if (maxC < 1) maxC = 1;
  var html = '';
  entries.forEach(function(e) {
    html += '<div class="bar-row"><div class="bar-lbl">' + e.y + '</div><div class="bar-track"><div class="bar-fill clr-blue" style="width:' + (e.c / maxC * 100) + '%">' + e.c + '件</div></div></div>';
  });
  el.innerHTML = html;
}

function renderApplicantChart() {
  var el = document.getElementById('applicantChart');
  var apps = {};
  DATA.forEach(function(p) { var a = p.applicant || '未知'; apps[a] = (apps[a] || 0) + 1; });
  var entries = Object.keys(apps).sort(function(a, b) { return apps[b] - apps[a]; }).slice(0, 10).map(function(n) { return { n: n, c: apps[n] }; });
  if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
  var maxC = entries[0].c || 1;
  var html = '';
  entries.forEach(function(e) {
    html += '<div class="bar-row"><div class="bar-name" title="' + esc(e.n) + '">' + esc(e.n.substring(0, 24)) + '</div><div class="bar-track"><div class="bar-fill clr-blue" style="width:' + (e.c / maxC * 100) + '%">' + e.c + '件</div></div></div>';
  });
  el.innerHTML = html;
}

function renderTypeChart() {
  var el = document.getElementById('typeChart');
  var types = {};
  DATA.forEach(function(p) { var t = p.patentType || '未知'; types[t] = (types[t] || 0) + 1; });
  var entries = Object.keys(types).sort(function(a, b) { return types[b] - types[a]; }).map(function(t) { return { n: t, c: types[t] }; });
  if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
  var maxC = entries[0].c || 1;
  var html = '';
  entries.forEach(function(e) {
    html += '<div class="bar-row"><div class="bar-lbl">' + esc(e.n.substring(0, 8)) + '</div><div class="bar-track"><div class="bar-fill clr-blue" style="width:' + (e.c / maxC * 100) + '%">' + e.c + '件</div></div></div>';
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
  document.querySelectorAll('.tab-btn').forEach(function(b) {
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
  var btn = document.getElementById('btnCrawl');
  btn.disabled = true;
  btn.textContent = '⏳ 爬取中...';
  document.getElementById('crawlStatus').textContent = '正在启动爬虫...';
  document.getElementById('statusDot').className = 'status-dot running';
  ipcRenderer.send('start-crawl');
}

function handleClean() {
  var btn = document.getElementById('btnClean');
  btn.disabled = true;
  btn.textContent = '⏳ 清洗中...';
  document.getElementById('crawlStatus').textContent = '正在启动清洗...';
  document.getElementById('statusDot').className = 'status-dot running';
  ipcRenderer.send('start-clean');
}

// ======================== IPC 监听 ========================
ipcRenderer.on('crawl-progress', function(event, msg) {
  document.getElementById('crawlStatus').textContent = msg;
});

ipcRenderer.on('crawl-done', function(event, result) {
  document.getElementById('btnCrawl').disabled = false;
  document.getElementById('btnCrawl').textContent = '🚀 一键爬取';
  document.getElementById('crawlStatus').textContent = '✅ 爬取完成 (' + result + ')';
  document.getElementById('statusDot').className = 'status-dot success';
  setTimeout(function() {
    document.getElementById('statusDot').className = 'status-dot idle';
    document.getElementById('crawlStatus').textContent = '就绪';
  }, 5000);
  loadData();
});

ipcRenderer.on('clean-done', function(event, result) {
  document.getElementById('btnClean').disabled = false;
  document.getElementById('btnClean').textContent = '🧹 一键清洗';
  document.getElementById('crawlStatus').textContent = '✅ 清洗完成 (' + result + ')';
  document.getElementById('statusDot').className = 'status-dot success';
  setTimeout(function() {
    document.getElementById('statusDot').className = 'status-dot idle';
    document.getElementById('crawlStatus').textContent = '就绪';
  }, 5000);
  loadData();
});

ipcRenderer.on('crawl-error', function(event, msg) {
  document.getElementById('btnCrawl').disabled = false;
  document.getElementById('btnCrawl').textContent = '🚀 一键爬取';
  document.getElementById('btnClean').disabled = false;
  document.getElementById('btnClean').textContent = '🧹 一键清洗';
  document.getElementById('crawlStatus').textContent = '❌ ' + msg;
  document.getElementById('statusDot').className = 'status-dot error';
});

ipcRenderer.on('crawl-error-clean', function(event, msg) {
  document.getElementById('btnCrawl').disabled = false;
  document.getElementById('btnCrawl').textContent = '🚀 一键爬取';
  document.getElementById('btnClean').disabled = false;
  document.getElementById('btnClean').textContent = '🧹 一键清洗';
  document.getElementById('crawlStatus').textContent = '❌ ' + msg;
  document.getElementById('statusDot').className = 'status-dot error';
});

// ======================== 登录弹窗 ========================
function showLoginModal(source) {
  document.getElementById('loginMessage').textContent = '爬虫「' + source + '」需要登录相关网站才能使用。';
  document.getElementById('loginModal').style.display = 'flex';
  window._loginSource = source;
}

function closeLoginModal() {
  document.getElementById('loginModal').style.display = 'none';
  window._loginSource = null;
}

function startLogin() {
  var source = window._loginSource;
  if (source) {
    ipcRenderer.send('start-login', source);
  }
  closeLoginModal();
}

// ======================== 事件绑定 ========================
document.addEventListener('DOMContentLoaded', function() {
  loadData();

  var st = null;
  document.getElementById('searchInput').addEventListener('input', function() {
    if (st) clearTimeout(st);
    st = setTimeout(function() {
      renderAll();
      updateMatchInfo();
    }, 200);
  });
  document.getElementById('sortSelect').addEventListener('change', function() {
    renderAll();
    updateMatchInfo();
  });
  document.getElementById('typeFilter').addEventListener('change', function() {
    renderAll();
    updateMatchInfo();
  });
  document.getElementById('yearFilter').addEventListener('change', function() {
    renderAll();
    updateMatchInfo();
  });
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.addEventListener('click', function() { switchTab(this.getAttribute('data-tab')); });
  });
  document.getElementById('tab-table').addEventListener('click', function(e) {
    var tr = e.target.closest('tr');
    if (tr && tr.dataset && tr.dataset.id) showDetail(tr.dataset.id);
  });
  document.getElementById('detailModal').addEventListener('click', function(e) {
    if (e.target === this) closeDetail();
  });
  document.getElementById('closeModalBtn').addEventListener('click', closeDetail);

  // 实时时钟
  function updateClock() {
    var now = new Date();
    var s = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0');
    document.getElementById('liveClock').textContent = s;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // 定期刷新剩余天数
  setInterval(function() {
    recalcDays();
    renderStats();
    renderTable();
    if (currentTab === 'chart') renderCharts();
  }, 10000);
});

// ======================== 导出 ========================
window.handleCrawl = handleCrawl;
window.handleClean = handleClean;
window.showLoginModal = showLoginModal;
window.closeLoginModal = closeLoginModal;
window.startLogin = startLogin;
window.loadData = loadData;