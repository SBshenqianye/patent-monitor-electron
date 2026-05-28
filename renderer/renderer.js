// ============================================================
// 专利监控看板 - renderer.js
// ============================================================
let DATA = [];
let currentFilter = '';
let currentTab = 'table';

let currentCrawlMsg = null;
let currentCleaningRunningMsg = null;
let currentRefreshMsg = null;
const runningCrawlerMessages = new Map();

// ======================== 消息列表管理 ========================
function addMessage(text, type = 'info', duration = 5000) {
    const container = document.getElementById('messageList');
    if (!container) return null;
    const maxHeight = 180;
    const oldHeight = Math.min(container.scrollHeight, maxHeight);
    container.style.height = oldHeight + 'px';

    const msgDiv = document.createElement('div');
    msgDiv.className = `message-item ${type}`;
    const iconMap = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
    const icon = iconMap[type] || '📢';
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    msgDiv.innerHTML = `
        <div class="message-icon">${icon}</div>
        <div class="message-text">${escapeHtml(text)}</div>
        <div class="message-time">${timeStr}</div>
        <button class="message-close" title="关闭">✖</button>
    `;
    const closeBtn = msgDiv.querySelector('.message-close');
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeMessage(msgDiv); });

    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    container.offsetHeight;
    let newHeight = container.scrollHeight;
    if (newHeight > maxHeight) newHeight = maxHeight;
    container.style.height = newHeight + 'px';
    container.addEventListener('transitionend', function onEnd() {
        container.style.height = '';
        container.removeEventListener('transitionend', onEnd);
    });

    if (duration > 0) {
        const timer = setTimeout(() => removeMessage(msgDiv), duration);
        msgDiv._autoTimer = timer;
    }
    updateTopStatusFromMessages();
    return msgDiv;
}

function removeMessage(msgDiv) {
    return new Promise(resolve => {
        if (!msgDiv || !msgDiv.parentNode) return resolve();
        const container = document.getElementById('messageList');
        if (!container) return resolve();
        if (msgDiv._autoTimer) { clearTimeout(msgDiv._autoTimer); msgDiv._autoTimer = null; }

        const maxHeight = 180;
        const oldHeight = Math.min(container.scrollHeight, maxHeight);
        container.style.height = oldHeight + 'px';
        msgDiv.classList.add('removing');

        const onEnd = () => {
            msgDiv.removeEventListener('transitionend', onEnd);
            if (msgDiv.parentNode) msgDiv.remove();
            container.offsetHeight;
            let newHeight = container.scrollHeight;
            if (newHeight > maxHeight) newHeight = maxHeight;
            container.style.height = newHeight + 'px';
            container.addEventListener('transitionend', function onParentEnd() {
                container.style.height = '';
                container.removeEventListener('transitionend', onParentEnd);
                updateTopStatusFromMessages();
                resolve();
            });
            if (oldHeight === newHeight) {
                container.style.height = '';
                updateTopStatusFromMessages();
                resolve();
            }
        };
        msgDiv.addEventListener('transitionend', onEnd);
        setTimeout(() => {
            if (msgDiv.parentNode) {
                msgDiv.removeEventListener('transitionend', onEnd);
                msgDiv.remove();
                container.offsetHeight;
                let newHeight = container.scrollHeight;
                if (newHeight > maxHeight) newHeight = maxHeight;
                container.style.height = newHeight + 'px';
                setTimeout(() => { container.style.height = ''; updateTopStatusFromMessages(); resolve(); }, 300);
            }
        }, 300);
    });
}

function clearAllMessages() {
    const container = document.getElementById('messageList');
    if (!container) return;
    const messages = Array.from(container.children);
    if (messages.length === 0) return;
    const maxHeight = 180;
    const oldHeight = Math.min(container.scrollHeight, maxHeight);
    container.style.height = oldHeight + 'px';
    let remaining = messages.length;
    messages.forEach(msg => {
        if (msg._autoTimer) clearTimeout(msg._autoTimer);
        msg.classList.add('removing');
        const onEnd = () => {
            msg.removeEventListener('transitionend', onEnd);
            if (msg.parentNode) msg.remove();
            remaining--;
            if (remaining === 0) {
                container.offsetHeight;
                container.style.height = '0px';
                setTimeout(() => { container.style.height = ''; updateTopStatusFromMessages(); }, 250);
            }
        };
        msg.addEventListener('transitionend', onEnd);
        setTimeout(onEnd, 300);
    });
    currentRefreshMsg = null;
    currentCrawlMsg = null;
    currentCleaningRunningMsg = null;
    runningCrawlerMessages.clear();
}

async function replaceMessage(oldMsg, newText, newType = 'success', newDuration = 5000) {
    if (oldMsg) await removeMessage(oldMsg);
    return addMessage(newText, newType, newDuration);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

function updateTopStatusFromMessages() {
    const container = document.getElementById('messageList');
    const statusEl = document.getElementById('crawlStatus');
    const dotEl = document.getElementById('statusDot');
    if (!container || !statusEl || !dotEl) return;
    const messages = Array.from(container.children);
    let selectedMsg = null, selectedType = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const type = msg.classList.contains('error') ? 'error' :
                     msg.classList.contains('warning') ? 'warning' :
                     msg.classList.contains('info') ? 'info' : 'success';
        const text = msg.querySelector('.message-text')?.innerText || '';
        if (type === 'error') { selectedMsg = text; selectedType = 'error'; break; }
        if (type === 'warning' && !selectedMsg) { selectedMsg = text; selectedType = 'warning'; }
        if (type === 'info' && !selectedMsg) {
            if (text.includes('正在运行') || text.includes('正在启动') || text.includes('正在清洗') || text.includes('正在刷新')) {
                selectedMsg = text; selectedType = 'info'; break;
            } else if (!selectedMsg) { selectedMsg = text; selectedType = 'info'; }
        }
    }
    if (selectedMsg) {
        statusEl.textContent = selectedMsg;
        dotEl.className = 'status-dot ' + (selectedType === 'error' ? 'error' : selectedType === 'warning' ? 'warning' : 'running');
    } else {
        statusEl.textContent = '就绪';
        dotEl.className = 'status-dot idle';
    }
}

// ======================== 工具函数 ========================
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
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
function colorVal(d) { const m = { expired: '#ff4d4f', urgent: '#fa8c16', warning: '#d4b106', safe: '#52c41a', unknown: '#999' }; return m[statusCode(d)] || '#999'; }
function rowClass(d) { const m = { expired: 'expired-row', urgent: 'urgent-row', warning: 'expired-row' }; return m[statusCode(d)] || ''; }
function badgeHtml(d) {
    const cls = { expired: 'badge-expired', urgent: 'badge-urgent', warning: 'badge-warning', safe: 'badge-safe', unknown: 'badge-unknown' };
    const lbl = { expired: '已过期', urgent: '⚠1年内', warning: '✅1-3年', safe: '🔒3年+', unknown: '未知' };
    return '<span class="badge ' + cls[statusCode(d)] + '">' + lbl[statusCode(d)] + '</span>';
}

// ======================== 数据加载 ========================
async function loadData() {
    const btn = document.getElementById('btnRefresh');
    btn.textContent = '🔄 刷新中...'; btn.disabled = true;
    try {
        const result = await window.electronAPI.getData();
        if (result.success) {
            DATA = Array.isArray(result.data) ? result.data : (result.data?.patents || []);
            document.getElementById('dataDate').textContent = new Date().toISOString().slice(0, 10);
            recalcDays(); initFilters(); renderAll(); updateMatchInfo();
            addMessage(`数据刷新成功，共 ${DATA.length} 条专利`, 'success');
        }
    } catch (err) {
        addMessage(`刷新失败: ${err.message}`, 'error', 0);
    } finally {
        btn.textContent = '🔄 刷新数据'; btn.disabled = false;
    }
}

function recalcDays() {
    const now = new Date();
    DATA.forEach(p => {
        if (p.expiryDate) {
            const parts = p.expiryDate.split('-');
            p.daysRemaining = Math.round((new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])) - now) / 86400000);
        } else p.daysRemaining = null;
    });
}

function renderStats() {
    const m = { expired: 0, urgent: 0, warning: 0, safe: 0, unknown: 0 };
    DATA.forEach(p => m[statusCode(p.daysRemaining)]++);
    const labels = { expired: '已过期', urgent: '1年内到期', warning: '1-3年', safe: '3年以上', unknown: '未知' };
    const colors = { expired: '#ff4d4f', urgent: '#fa8c16', warning: '#52c41a', safe: '#1890ff', unknown: '#999' };
    const el = document.getElementById('statsBar');
    el.innerHTML = '';
    ['expired', 'urgent', 'warning', 'safe'].forEach(k => {
        const div = document.createElement('div');
        div.className = 'stat-card' + (currentFilter === k ? ' active' : '');
        div.addEventListener('click', () => { currentFilter = currentFilter === k ? '' : k; renderAll(); updateMatchInfo(); });
        div.innerHTML = `<div class="num" style="color:${colors[k]}">${m[k]}</div><div class="lbl">${labels[k]}</div>`;
        el.appendChild(div);
    });
    const totalDiv = document.createElement('div');
    totalDiv.className = 'stat-card';
    totalDiv.innerHTML = `<div class="num" style="color:#333">${DATA.length}</div><div class="lbl">总计</div>`;
    totalDiv.addEventListener('click', () => { currentFilter = ''; renderAll(); updateMatchInfo(); });
    el.appendChild(totalDiv);
}

function initFilters() {
    const types = {}, years = {};
    DATA.forEach(p => { if (p.patentType) types[p.patentType] = 1; if (p.applyYear) years[p.applyYear] = 1; });
    const ts = document.getElementById('typeFilter');
    ts.innerHTML = '<option value="">全部类型</option>';
    Object.keys(types).sort().forEach(t => ts.appendChild(new Option(t, t)));
    const ys = document.getElementById('yearFilter');
    ys.innerHTML = '<option value="">全部年份</option>';
    Object.keys(years).sort().reverse().forEach(y => ys.appendChild(new Option(y + '年', y)));
}

function getFiltered() {
    const kw = (document.getElementById('searchInput').value || '').trim().toLowerCase();
    const type = document.getElementById('typeFilter').value;
    const year = document.getElementById('yearFilter').value;
    let list = DATA.slice();
    if (kw) list = list.filter(p => (p.title + p.applyId + p.inventor + p.applicant + p.patentAgency).toLowerCase().includes(kw));
    if (type) list = list.filter(p => p.patentType === type);
    if (year) list = list.filter(p => p.applyYear === parseInt(year));
    if (currentFilter) list = list.filter(p => statusCode(p.daysRemaining) === currentFilter);
    const sv = document.getElementById('sortSelect').value;
    list.sort((a, b) => {
        const ad = a.daysRemaining ?? 999999, bd = b.daysRemaining ?? 999999;
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
    document.getElementById('matchInfo').textContent = `显示 ${getFiltered().length}/${DATA.length} 条`;
}

function renderTable() {
    const list = getFiltered();
    const tbody = document.getElementById('tableBody');
    const noData = document.getElementById('noDataMsg');
    if (!list.length) {
        tbody.innerHTML = ''; noData.style.display = 'block'; return;
    }
    noData.style.display = 'none';
    let html = '';
    list.forEach(p => {
        const d = p.daysRemaining;
        html += `<tr class="${rowClass(d)}" data-id="${esc(p.applyId || '')}">`;
        html += `<td>${badgeHtml(d)}<\/td><td style="font-weight:600;color:${colorVal(d)}">${daysStr(d)}<\/td>`;
        html += `<td class="col-id">${esc(p.applyId || '')}<\/td><td class="col-title" title="${esc(p.title || '')}">${esc((p.title || '').substring(0, 60))}<\/td>`;
        html += `<td>${esc(p.applyDate || '')}<\/td><td>${esc(p.pubDate || '')}<\/td><td>${esc(p.expiryDate || '')}<\/td>`;
        html += `<td title="${esc(p.inventor || '')}">${esc((p.inventor || '').substring(0, 14))}<\/td>`;
        html += `<td class="col-agency" title="${esc(p.patentAgency || '')}">${esc((p.patentAgency || '').substring(0, 18))}<\/td>`;
        html += `<td>${esc(p.patentType || '')}<\/td><td><span style="font-size:11px;color:#888">${esc(p.source || '')}<\/span><\/td>`;
        html += `<\/tr>`;
    });
    tbody.innerHTML = html;
}

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
        ['⏱️ 剩余天数', `<span style="color:${colorVal(d)};font-weight:700">${daysStr(d)}</span>`],
        ['🏛️ 法律状态', esc(p.legalStatus || '')],
        ['👤 发明人', esc(p.inventor || '')],
        ['🏭 申请人', esc(p.applicant || '')],
        ['🏢 公司', esc(p.company || '')],
    ];
    if (p.patentAgency) dl.push(['🤝 专利代理机构', esc(p.patentAgency)]);
    if (p.patentAgent) dl.push(['👨‍⚖️ 专利代理师', esc(p.patentAgent)]);
    dl.push(['📍 地址', esc(p.address || '')], ['📬 邮编', esc(p.zipcode || '')], ['📡 数据源', esc(p.source || '')]);
    let h = '<div class="detail-grid">';
    dl.forEach(r => { h += `<div class="detail-label">${r[0]}</div><div class="detail-value">${r[1]}</div>`; });
    h += '</div>';
    if (p.abstract) h += `<div class="detail-section"><strong>📝 摘要</strong><br>${esc(p.abstract)}</div>`;
    document.getElementById('detailBody').innerHTML = h;
    document.getElementById('detailModal').classList.add('show');
}

function closeDetail() { document.getElementById('detailModal').classList.remove('show'); }

function renderPieChart() {
    const el = document.getElementById('pieChart');
    const m = { expired: 0, urgent: 0, warning: 0, safe: 0 };
    DATA.forEach(p => m[statusCode(p.daysRemaining)]++);
    const slices = [
        { l: '已过期', v: m.expired, c: '#ff4d4f' },
        { l: '⚠️ 1年内到期', v: m.urgent, c: '#fa8c16' },
        { l: '✅ 1-3年', v: m.warning, c: '#52c41a' },
        { l: '🔒 3年以上', v: m.safe, c: '#1890ff' }
    ].filter(s => s.v > 0);
    if (!slices.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
    const total = slices.reduce((s, i) => s + i.v, 0);
    const colors = ['#ff4d4f', '#fa8c16', '#52c41a', '#1890ff'];
    el.innerHTML = slices.map((s, i) => `<div style="display:flex;align-items:center;margin:4px 0">
        <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${colors[i]};margin-right:8px"></span>
        <span style="flex:1">${s.l}</span><span style="font-weight:600;color:${colors[i]}">${s.v} (${Math.round(s.v/total*100)}%)</span>
    </div>`).join('');
}

function renderYearChart() {
    const el = document.getElementById('yearChart');
    const years = {};
    DATA.forEach(p => { if (p.applyYear) years[p.applyYear] = (years[p.applyYear] || 0) + 1; });
    const entries = Object.entries(years).sort((a,b) => a[0]-b[0]).map(([y, c]) => ({ y: parseInt(y), c }));
    if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
    const maxC = Math.max(...entries.map(e => e.c), 1);
    el.innerHTML = entries.map(e => `<div class="bar-row"><div class="bar-lbl">${e.y}</div><div class="bar-track"><div class="bar-fill clr-blue" style="width:${(e.c/maxC*100)}%">${e.c}件</div></div></div>`).join('');
}

function renderApplicantChart() {
    const el = document.getElementById('applicantChart');
    const apps = {};
    DATA.forEach(p => { const a = p.applicant || '未知'; apps[a] = (apps[a] || 0) + 1; });
    const entries = Object.entries(apps).sort((a,b) => b[1]-a[1]).slice(0,10).map(([n, c]) => ({ n, c }));
    if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
    const maxC = entries[0].c;
    el.innerHTML = entries.map(e => `<div class="bar-row"><div class="bar-name" title="${esc(e.n)}">${esc(e.n.substring(0,24))}</div><div class="bar-track"><div class="bar-fill clr-blue" style="width:${(e.c/maxC*100)}%">${e.c}件</div></div></div>`).join('');
}

function renderTypeChart() {
    const el = document.getElementById('typeChart');
    const types = {};
    DATA.forEach(p => { const t = p.patentType || '未知'; types[t] = (types[t] || 0) + 1; });
    const entries = Object.entries(types).sort((a,b) => b[1]-a[1]).map(([n, c]) => ({ n, c }));
    if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb">暂无数据</div>'; return; }
    const maxC = entries[0].c;
    el.innerHTML = entries.map(e => `<div class="bar-row"><div class="bar-lbl">${esc(e.n.substring(0,8))}</div><div class="bar-track"><div class="bar-fill clr-blue" style="width:${(e.c/maxC*100)}%">${e.c}件</div></div></div>`).join('');
}

function renderCharts() {
    renderPieChart(); renderYearChart(); renderApplicantChart(); renderTypeChart();
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('tab-table').style.display = tab === 'table' ? 'block' : 'none';
    document.getElementById('tab-chart').style.display = tab === 'chart' ? 'block' : 'none';
    if (tab === 'chart') renderCharts();
}

function renderAll() {
    recalcDays(); renderStats(); renderTable();
    if (currentTab === 'chart') renderCharts();
}

function handleCrawl() {
    const btn = document.getElementById('btnCrawl');
    btn.disabled = true; btn.textContent = '⏳ 爬取中...';
    if (currentCrawlMsg) removeMessage(currentCrawlMsg);
    currentCrawlMsg = addMessage('开始一键爬取任务', 'info', 2000);
    window.electronAPI.runAllCrawlers().catch(err => {
        if (currentCrawlMsg) removeMessage(currentCrawlMsg);
        addMessage(`爬取失败: ${err.message}`, 'error', 0);
        btn.disabled = false; btn.textContent = '🚀 一键爬取';
    });
}

function handleClean() {
    const btn = document.getElementById('btnClean');
    btn.disabled = true; btn.textContent = '⏳ 清洗中...';
    addMessage('开始一键清洗任务', 'info', 1000);
    window.electronAPI.runCleaning().catch(err => {
        addMessage(`清洗失败: ${err.message}`, 'error', 0);
        btn.disabled = false; btn.textContent = '🧹 一键清洗';
    });
}

// ======================== 导出 Excel ========================
async function handleExportExcel() {
    if (!DATA.length) {
        addMessage('暂无数据可导出', 'warning');
        return;
    }
    addMessage('正在生成 Excel 文件...', 'info', 2000);
    try {
        const result = await window.electronAPI.exportToExcel(DATA);
        if (result.success) {
            addMessage(`导出成功！文件保存至: ${result.filepath}`, 'success', 0);
        } else {
            addMessage(`导出失败: ${result.error}`, 'error');
        }
    } catch (err) {
        addMessage(`导出失败: ${err.message}`, 'error');
    }
}

// ======================== 手动导入数据功能 ========================
function renderTree(node, container, level = 0) {
    const div = document.createElement('div');
    div.style.marginLeft = `${level * 20}px`;
    const icon = node.type === 'dir' ? '📁' : '📄';
    const nameSpan = document.createElement('span');
    nameSpan.innerHTML = `${icon} ${escapeHtml(node.name)}`;
    
    if (node.type === 'dir' && node.children && node.children.length) {
        const toggle = document.createElement('span');
        toggle.textContent = ' ▼ ';
        toggle.style.cursor = 'pointer';
        toggle.style.display = 'inline-block';
        toggle.style.width = '24px';
        toggle.onclick = (e) => {
            e.stopPropagation();
            const childContainer = div.querySelector('.tree-children');
            if (childContainer) {
                const isHidden = childContainer.style.display === 'none';
                childContainer.style.display = isHidden ? 'block' : 'none';
                toggle.textContent = isHidden ? ' ▼ ' : ' ▶ ';
            }
        };
        div.appendChild(toggle);
        div.appendChild(nameSpan);
        
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        for (const child of node.children) {
            renderTree(child, childContainer, level + 1);
        }
        div.appendChild(childContainer);
    } else {
        const spacer = document.createElement('span');
        spacer.style.display = 'inline-block';
        spacer.style.width = '24px';
        div.appendChild(spacer);
        div.appendChild(nameSpan);
    }
    container.appendChild(div);
}

async function showManualImportDialog() {
    // 检查是否勾选“不再提示”
    const { ignore } = await window.electronAPI.getManualImportIgnore();
    if (ignore) {
        await window.electronAPI.openTempFolder();
        return;
    }

    // 获取目录结构（内部已自动创建子目录）
    const { success, tree, error } = await window.electronAPI.getTempDataStructure();
    if (!success) {
        addMessage(`无法获取目录结构: ${error}`, 'error');
        await window.electronAPI.openTempFolder();
        return;
    }

    // 获取静态模态框元素
    const modal = document.getElementById('manualImportModal');
    if (!modal) {
        addMessage('模态框未找到，请检查 index.html', 'error');
        return;
    }

    // 渲染目录树
    const container = document.getElementById('treeContainer');
    if (container) {
        container.innerHTML = '';
        if (tree && tree.name) {
            renderTree(tree, container);
        } else {
            container.innerHTML = '<span style="color:#999;">目录为空或无法读取</span>';
        }
    }

    // 同步复选框状态
    const chk = document.getElementById('dontShowAgainCheckbox');
    if (chk) {
        const { ignore: currentIgnore } = await window.electronAPI.getManualImportIgnore();
        chk.checked = currentIgnore;
    }

    // 绑定按钮事件（确保只绑定一次）
    if (!modal._bound) {
        const closeBtn = document.getElementById('closeManualImportModal');
        const cancelBtn = document.getElementById('cancelManualImportBtn');
        const openFolderBtn = document.getElementById('openFolderBtn');
        
        if (closeBtn) closeBtn.onclick = () => modal.classList.remove('show');
        if (cancelBtn) cancelBtn.onclick = () => modal.classList.remove('show');
        if (openFolderBtn) {
            openFolderBtn.onclick = async () => {
                await window.electronAPI.openTempFolder();
                const dontShow = document.getElementById('dontShowAgainCheckbox').checked;
                if (dontShow) {
                    await window.electronAPI.setManualImportIgnore(true);
                }
                modal.classList.remove('show');
            };
        }
        // 点击遮罩关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('show');
        });
        modal._bound = true;
    }

    // 显示模态框
    modal.classList.add('show');
}

// 绑定模态框按钮事件（一次性）
function bindManualImportModalEvents() {
    const modal = document.getElementById('manualImportModal');
    if (!modal) return;
    const closeBtn = document.getElementById('closeManualImportModal');
    const cancelBtn = document.getElementById('cancelManualImportBtn');
    const openBtn = document.getElementById('openFolderBtn');
    const chk = document.getElementById('dontShowAgainCheckbox');
    
    if (closeBtn) closeBtn.onclick = () => modal.classList.remove('show');
    if (cancelBtn) cancelBtn.onclick = () => modal.classList.remove('show');
    if (openBtn) {
        openBtn.onclick = async () => {
            await window.electronAPI.openTempFolder();
            if (chk && chk.checked) {
                await window.electronAPI.setManualImportIgnore(true);
            }
            modal.classList.remove('show');
        };
    }
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('show');
    });
}

// ======================== 事件监听 ========================
function setupEventListeners() {
    window.electronAPI.onCrawlerStatus(async (status) => {
        console.log('爬虫状态:', status);
        if (status.name !== 'all') {
            const msgMap = runningCrawlerMessages;
            if (status.status === 'waiting-login' || status.status === 'running') {
                const oldMsg = msgMap.get(status.name);
                const newMsg = oldMsg
                    ? await replaceMessage(oldMsg, status.message, 'info', 0)
                    : addMessage(status.message, 'info', 0);
                msgMap.set(status.name, newMsg);
            } else if (status.status === 'completed') {
                const oldMsg = msgMap.get(status.name);
                if (oldMsg) {
                    await replaceMessage(oldMsg, `${status.name} 完成`, 'success');
                    msgMap.delete(status.name);
                } else {
                    addMessage(`${status.name} 完成`, 'success');
                }
            } else if (status.status === 'error') {
                const oldMsg = msgMap.get(status.name);
                if (oldMsg) {
                    await replaceMessage(oldMsg, `${status.name} 失败: ${status.message}`, 'error', 0);
                    msgMap.delete(status.name);
                } else {
                    addMessage(`${status.name} 失败: ${status.message}`, 'error', 0);
                }
            }
        }
        if (status.name === 'all' && status.allDone) {
            if (status.suggestClean) {
                addMessage(` ${status.message}`, 'success', 8000);
                addMessage('💡 请点击「一键清洗」完成数据融合', 'info', 8000);
            } else {
                addMessage(`❌ ${status.message}`, 'error', 0);
            }
            document.getElementById('btnCrawl').disabled = false;
            document.getElementById('btnCrawl').textContent = '🚀 一键爬取';
        }
    });

    window.electronAPI.onCleaningStatus(async (status) => {
        if (status.status === 'running') {
            if (currentCleaningRunningMsg) await removeMessage(currentCleaningRunningMsg);
            currentCleaningRunningMsg = addMessage('正在清洗数据...', 'info', 0);
        } else if (status.status === 'completed') {
            if (currentCleaningRunningMsg) {
                await replaceMessage(currentCleaningRunningMsg, '数据清洗完成', 'success');
                currentCleaningRunningMsg = null;
            } else addMessage('数据清洗完成', 'success');
            loadData();
            document.getElementById('btnClean').disabled = false;
            document.getElementById('btnClean').textContent = '🧹 一键清洗';
        } else if (status.status === 'error') {
            if (currentCleaningRunningMsg) {
                await replaceMessage(currentCleaningRunningMsg, `清洗失败: ${status.message}`, 'error', 0);
                currentCleaningRunningMsg = null;
            } else addMessage(`清洗失败: ${status.message}`, 'error', 0);
            document.getElementById('btnClean').disabled = false;
            document.getElementById('btnClean').textContent = '🧹 一键清洗';
        }
    });
}

// ======================== 初始化 ========================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('clearAllMessagesBtn').addEventListener('click', clearAllMessages);
    setupDragAndDrop();
    setupEventListeners();
    bindManualImportModalEvents();
    bindTutorialModalEvents();  // 绑定教程弹窗事件
    showTutorialDialog();       // 检查并显示教程弹窗（如果未忽略）
    loadData();
    
    let st;
    document.getElementById('searchInput').addEventListener('input', () => {
        clearTimeout(st);
        st = setTimeout(() => { renderAll(); updateMatchInfo(); }, 200);
    });
    document.getElementById('sortSelect').addEventListener('change', () => { renderAll(); updateMatchInfo(); });
    document.getElementById('typeFilter').addEventListener('change', () => { renderAll(); updateMatchInfo(); });
    document.getElementById('yearFilter').addEventListener('change', () => { renderAll(); updateMatchInfo(); });
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.getElementById('tab-table').addEventListener('click', e => {
        const tr = e.target.closest('tr');
        if (tr?.dataset.id) showDetail(tr.dataset.id);
    });
    document.getElementById('detailModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeDetail(); });
    document.getElementById('closeModalBtn').addEventListener('click', closeDetail);
    
    const manualBtn = document.getElementById('btnManualImport');
    if (manualBtn) manualBtn.addEventListener('click', showManualImportDialog);
    
    const exportBtn = document.getElementById('btnExport');
    if (exportBtn) exportBtn.addEventListener('click', handleExportExcel);
    
    setInterval(() => {
        document.getElementById('liveClock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    }, 1000);
    setInterval(() => {
        recalcDays(); renderStats(); renderTable();
        if (currentTab === 'chart') renderCharts();
    }, 10000);
});

// ========== 辅助：自动判定目标文件夹 ==========
function determineTargetFolder(filePaths) {
    const hasCSV = filePaths.some(p => p.toLowerCase().endsWith('.csv'));
    const hasXLSX = filePaths.some(p => p.toLowerCase().endsWith('.xlsx'));

    if (hasCSV && !hasXLSX) return '中国专利公布公告网';
    if (!hasCSV && hasXLSX) {
        const tianyan = filePaths.some(p => p.includes('天眼查'));
        return tianyan ? '天眼查' : '专利检索及分析网';
    }
    if (hasCSV && hasXLSX) return '中国专利公布公告网';
    return null;
}

// ========== 辅助：显示目标文件夹选择弹窗 ==========
function showDropTargetDialog() {
    return new Promise((resolve) => {
        const modal = document.getElementById('dropTargetModal');
        if (!modal) {
            resolve(null);
            return;
        }

        const buttons = modal.querySelectorAll('[data-target]');
        const cancelBtn = document.getElementById('cancelDropTargetBtn');

        const close = (target) => {
            modal.classList.remove('show');
            document.body.style.overflow = '';
            buttons.forEach(btn => btn.removeEventListener('click', handler));
            cancelBtn.removeEventListener('click', cancelHandler);
            resolve(target);
        };

        const handler = (e) => {
            const target = e.currentTarget.getAttribute('data-target');
            close(target);
        };
        const cancelHandler = () => close(null);

        buttons.forEach(btn => btn.addEventListener('click', handler));
        cancelBtn.addEventListener('click', cancelHandler);

        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    });
}

// ========== 主函数：设置拖拽 ==========
function setupDragAndDrop() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;

    // 1. 全局事件：区域外禁止放置
    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'none';   // 区域外禁止图标
    });
    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('visible', 'drag-over');
    });

    // 2. 显示 / 隐藏拖拽区域
    document.body.addEventListener('dragenter', () => {
        dropZone.classList.add('visible');
    });
    document.body.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
            dropZone.classList.remove('visible', 'drag-over');
        }
    });
    document.body.addEventListener('drop', () => {
        dropZone.classList.remove('visible');
    });

    // 3. 区域内高亮
    dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';   // 区域内允许复制
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', (e) => {
        if (!dropZone.contains(e.relatedTarget)) {
            dropZone.classList.remove('drag-over');
        }
    });

    // 4. 区域内 drop 事件：获取文件路径并导入（自动识别 + 手动选择）
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over', 'visible');

        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;

        const filePaths = files.map(f => f.path).filter(Boolean);
        console.log('[drop] 文件路径：', filePaths);

        if (filePaths.length === 0) {
            addMessage('无法获取文件路径，请使用手动导入', 'warning');
            return;
        }

        let target = determineTargetFolder(filePaths);
        if (!target) {
            target = await showDropTargetDialog();
            if (!target) {
                addMessage('取消导入', 'info');
                return;
            }
        }

        addMessage(`正在导入 ${filePaths.length} 个文件到“${target}”...`, 'info');
        try {
            const result = await window.electronAPI.importFiles(filePaths, target);
            if (result.success) {
                addMessage(`导入成功！建议运行「一键清洗」`, 'success', 0);
            } else {
                addMessage(`导入失败: ${result.error}`, 'error', 0);
            }
        } catch (err) {
            addMessage(`导入异常: ${err.message}`, 'error');
        }
    });

    // 5. 备用：主进程 drop-file 发来的路径（同样支持自动+手动）
    window.electronAPI.onDroppedFiles(async (filePaths) => {
        console.log('[IPC] 收到文件路径：', filePaths);
        if (!filePaths || filePaths.length === 0) return;

        let target = determineTargetFolder(filePaths);
        if (!target) {
            target = await showDropTargetDialog();
            if (!target) {
                addMessage('取消导入', 'info');
                return;
            }
        }

        addMessage(`正在导入 ${filePaths.length} 个文件到“${target}”...`, 'info');
        try {
            const result = await window.electronAPI.importFiles(filePaths, target);
            if (result.success) {
                addMessage(`导入成功！建议运行「一键清洗」`, 'success', 0);
            } else {
                addMessage(`导入失败: ${result.error}`, 'error', 0);
            }
        } catch (err) {
            addMessage(`导入异常: ${err.message}`, 'error');
        }
    });

    // 6. 启动提示动画
    setTimeout(() => {
        dropZone.classList.add('visible');
        setTimeout(() => dropZone.classList.remove('visible'), 2000);
    }, 500);
}

// async function askTargetFolder() {
//     const choice = prompt(
//         '请选择导入目标文件夹（输入数字）：\n1. 中国专利公布公告网\n2. 天眼查\n3. 专利检索及分析网',
//         '1'
//     );
//     const map = {
//         '1': '中国专利公布公告网',
//         '2': '天眼查',
//         '3': '专利检索及分析网',
//     };
//     return map[choice] || null;
// }


// ======================== 使用教程弹窗 ========================
async function showTutorialDialog() {
    const { ignore } = await window.electronAPI.getTutorialIgnore();
    if (ignore) return; // 已勾选不再提示，直接返回

    const modal = document.getElementById('tutorialModal');
    if (!modal) return;
    modal.classList.add('show');
    document.body.style.overflow = 'hidden'; // ✅ 禁止背景滚动
}

function bindTutorialModalEvents() {
    const modal = document.getElementById('tutorialModal');
    if (!modal) return;

    const closeBtn = document.getElementById('closeTutorialModal');
    const confirmBtn = document.getElementById('confirmTutorialBtn');
    const chk = document.getElementById('tutorialDontShowAgainCheckbox');

    function closeTutorial() {
        if (chk && chk.checked) {
            window.electronAPI.setTutorialIgnore(true);
        }
        modal.classList.remove('show');
        document.body.style.overflow = ''; // ✅ 恢复背景滚动
    }

    if (closeBtn) closeBtn.onclick = closeTutorial;
    if (confirmBtn) confirmBtn.onclick = closeTutorial;

    // ❌ 不再监听遮罩层点击，用户必须通过按钮或 X 关闭
    // modal.addEventListener('click', (e) => { ... });
}

window.handleCrawl = handleCrawl;
window.handleClean = handleClean;
window.loadData = loadData;