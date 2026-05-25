// ============================================================
// 全局状态
// ============================================================
let chartInstances = {};
let currentLoginTarget = null;
let isCrawling = false;
let isCleaning = false;

// ============================================================
// DOM 引用
// ============================================================
const $ = (id) => document.getElementById(id);
const statusText = $('crawlStatus');
const statusDot = document.querySelector('.status-dot');
const updateTime = $('updateTime');
const crawlerDetails = $('crawlerDetails');
const loginModal = $('loginModal');
const loginMessage = $('loginMessage');
const btnCrawl = $('btnCrawl');
const btnClean = $('btnClean');
const btnRefresh = $('btnRefresh');

// ============================================================
// 图表初始化
// ============================================================
function initCharts() {
    const chartIds = ['chartStatus', 'chartType', 'chartExpiry', 'chartTrend', 'chartAssignee'];
    chartIds.forEach(id => {
        const dom = $(id);
        if (dom) {
            chartInstances[id] = echarts.init(dom);
        }
    });

    // 窗口大小变化时自适应
    window.addEventListener('resize', () => {
        Object.values(chartInstances).forEach(chart => chart && chart.resize());
    });
}

// ============================================================
// 数据加载与图表渲染
// ============================================================
async function loadData() {
    try {
        updateStatus('info', '正在加载数据...');

        const result = await window.electronAPI.getData();
        if (!result.success || !result.data) {
            updateStatus('warning', '暂无数据，请先运行数据清洗');
            showEmptyCharts();
            return;
        }

        const data = result.data;
        updateTime.textContent = `最后更新：${new Date().toLocaleString()}`;
        updateStatus('success', `数据加载完成（共 ${data.total || data.patents ? (data.patents ? data.patents.length : 0) : 0} 条）`);

        renderAllCharts(data);
    } catch (err) {
        updateStatus('error', `加载数据失败: ${err.message}`);
        showEmptyCharts();
    }
}

// ============================================================
// 渲染所有图表
// ============================================================
function renderAllCharts(data) {
    const patents = data.patents || data.list || [];
    if (patents.length === 0) {
        showEmptyCharts('暂无专利数据');
        return;
    }

    // 1. 专利法律状态分布（饼图）
    renderStatusPie(patents);

    // 2. 专利类型分布（饼图）
    renderTypePie(patents);

    // 3. 过期时间分布（柱状图）
    renderExpiryBar(patents);

    // 4. 历年申请趋势（折线图）
    renderTrendLine(patents);

    // 5. 专利权人 Top 20（条形图）
    renderAssigneeBar(patents);
}

// ============================================================
// 图表 1：专利法律状态分布
// ============================================================
function renderStatusPie(patents) {
    const countMap = {};
    patents.forEach(p => {
        const status = p.法律状态 || p.status || '未知';
        countMap[status] = (countMap[status] || 0) + 1;
    });

    const data = Object.entries(countMap)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value }));

    const chart = chartInstances['chartStatus'];
    if (!chart) return;

    chart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: {
            type: 'scroll',
            orient: 'vertical',
            right: 10,
            top: 20,
            bottom: 20,
            textStyle: { fontSize: 11 },
        },
        series: [{
            type: 'pie',
            radius: ['30%', '60%'],
            center: ['40%', '50%'],
            avoidLabelOverlap: true,
            itemStyle: {
                borderRadius: 6,
                borderColor: '#fff',
                borderWidth: 2,
            },
            label: {
                show: false,
            },
            emphasis: {
                label: { show: true, fontSize: 14, fontWeight: 'bold' },
                itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' },
            },
            data: data,
        }],
    });
}

// ============================================================
// 图表 2：专利类型分布
// ============================================================
function renderTypePie(patents) {
    const countMap = {};
    patents.forEach(p => {
        const type = p.专利类型 || p.type || p.专利种类 || '未知';
        countMap[type] = (countMap[type] || 0) + 1;
    });

    const data = Object.entries(countMap)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value }));

    const chart = chartInstances['chartType'];
    if (!chart) return;

    chart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: {
            type: 'scroll',
            orient: 'vertical',
            right: 10,
            top: 20,
            bottom: 20,
            textStyle: { fontSize: 11 },
        },
        series: [{
            type: 'pie',
            radius: ['30%', '60%'],
            center: ['40%', '50%'],
            avoidLabelOverlap: true,
            itemStyle: {
                borderRadius: 6,
                borderColor: '#fff',
                borderWidth: 2,
            },
            label: {
                show: false,
            },
            emphasis: {
                label: { show: true, fontSize: 14, fontWeight: 'bold' },
                itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' },
            },
            data: data,
        }],
    });
}

// ============================================================
// 图表 3：过期时间分布
// ============================================================
function renderExpiryBar(patents) {
    const yearMap = {};
    patents.forEach(p => {
        let expiry = p.专利过期时间 || p.expiry_date || p.失效日期 || p.过期日期 || '';
        if (!expiry) return;
        // 提取年份
        const year = String(expiry).match(/(\d{4})/);
        if (!year) return;
        const y = year[1];
        yearMap[y] = (yearMap[y] || 0) + 1;
    });

    const sorted = Object.entries(yearMap).sort((a, b) => a[0].localeCompare(b[0]));

    const chart = chartInstances['chartExpiry'];
    if (!chart) return;

    chart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: '8%', right: '5%', bottom: '10%', top: '10%', containLabel: true },
        xAxis: {
            type: 'category',
            data: sorted.map(d => d[0]),
            axisLabel: { rotate: 45, fontSize: 11 },
        },
        yAxis: {
            type: 'value',
            name: '专利数量',
        },
        series: [{
            type: 'bar',
            data: sorted.map(d => d[1]),
            itemStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: '#f56a00' },
                    { offset: 1, color: '#ffc069' },
                ]),
                borderRadius: [4, 4, 0, 0],
            },
            barMaxWidth: 40,
        }],
    });
}

// ============================================================
// 图表 4：历年申请趋势
// ============================================================
function renderTrendLine(patents) {
    const yearMap = {};
    patents.forEach(p => {
        let date = p.申请日期 || p.application_date || p.申请日 || '';
        if (!date) return;
        const year = String(date).match(/(\d{4})/);
        if (!year) return;
        const y = year[1];
        yearMap[y] = (yearMap[y] || 0) + 1;
    });

    const sorted = Object.entries(yearMap).sort((a, b) => a[0].localeCompare(b[0]));

    const chart = chartInstances['chartTrend'];
    if (!chart) return;

    chart.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: '8%', right: '5%', bottom: '10%', top: '10%', containLabel: true },
        xAxis: {
            type: 'category',
            data: sorted.map(d => d[0]),
            boundaryGap: false,
            axisLabel: { rotate: 45, fontSize: 11 },
        },
        yAxis: {
            type: 'value',
            name: '申请数量',
        },
        series: [{
            type: 'line',
            data: sorted.map(d => d[1]),
            smooth: true,
            lineStyle: { width: 3, color: '#5470c6' },
            areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(84,112,198,0.5)' },
                    { offset: 1, color: 'rgba(84,112,198,0.05)' },
                ]),
            },
            itemStyle: { color: '#5470c6' },
            symbol: 'circle',
            symbolSize: 6,
        }],
    });
}

// ============================================================
// 图表 5：专利权人 Top 20
// ============================================================
function renderAssigneeBar(patents) {
    const countMap = {};
    patents.forEach(p => {
        const assignee = p.专利权人 || p.assignee || p.申请人 || '未知';
        countMap[assignee] = (countMap[assignee] || 0) + 1;
    });

    const sorted = Object.entries(countMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

    const chart = chartInstances['chartAssignee'];
    if (!chart) return;

    chart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: '25%', right: '5%', bottom: '5%', top: '5%', containLabel: true },
        xAxis: {
            type: 'value',
            name: '专利数量',
        },
        yAxis: {
            type: 'category',
            data: sorted.map(d => d[0]).reverse(),
            axisLabel: {
                fontSize: 11,
                width: 180,
                overflow: 'truncate',
            },
        },
        series: [{
            type: 'bar',
            data: sorted.map(d => d[1]).reverse(),
            itemStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                    { offset: 0, color: '#91cc75' },
                    { offset: 1, color: '#5470c6' },
                ]),
                borderRadius: [0, 4, 4, 0],
            },
            barMaxWidth: 24,
            label: {
                show: true,
                position: 'right',
                fontSize: 11,
            },
        }],
    });
}

// ============================================================
// 显示空图表
// ============================================================
function showEmptyCharts(message = '暂无数据') {
    Object.values(chartInstances).forEach(chart => {
        if (!chart) return;
        chart.clear();
        chart.setOption({
            title: {
                text: message,
                left: 'center',
                top: 'center',
                textStyle: { fontSize: 14, color: '#999' },
            },
        });
    });
}

// ============================================================
// 状态更新
// ============================================================
function updateStatus(type, message) {
    statusText.textContent = message;
    statusDot.className = 'status-dot ' + type;

    // 更新按钮状态
    if (type === 'running') {
        btnCrawl.disabled = true;
        btnClean.disabled = true;
    } else {
        btnCrawl.disabled = false;
        btnClean.disabled = false;
    }
}

// ============================================================
// 爬虫状态回调
// ============================================================
function setupListeners() {
    window.electronAPI.onCrawlerStatus((data) => {
        const { name, status, message } = data;

        // 更新爬虫详情区域
        crawlerDetails.style.display = 'block';
        let detail = crawlerDetails.querySelector(`[data-name="${name}"]`);
        if (!detail) {
            detail = document.createElement('span');
            detail.className = 'crawler-status-item';
            detail.dataset.name = name;
            crawlerDetails.appendChild(detail);
        }

        const icon = status === 'completed' ? '✅' :
                     status === 'error' ? '❌' :
                     status === 'running' ? '⏳' : '⬜';
        detail.textContent = `${icon} ${name}: ${message}`;

        // 如果所有爬虫都完成了
        if (data.allDone) {
            updateStatus('success', '一键爬取完成');
            isCrawling = false;
        }
    });

    window.electronAPI.onCleaningStatus((data) => {
        const { status, message } = data;
        if (status === 'running') {
            updateStatus('running', message);
            isCleaning = true;
        } else if (status === 'completed') {
            updateStatus('success', message);
            isCleaning = false;
            // 清洗完成后自动刷新数据
            setTimeout(() => loadData(), 500);
        } else {
            updateStatus('error', message);
            isCleaning = false;
        }
    });

    window.electronAPI.onLoginRequired((data) => {
        currentLoginTarget = data.name;
        showLoginModal(data.name);
    });
}

// ============================================================
// 一键爬取
// ============================================================
async function handleCrawl() {
    if (isCrawling) return;
    isCrawling = true;

    updateStatus('running', '正在启动爬虫...');
    crawlerDetails.style.display = 'block';
    crawlerDetails.innerHTML = '<span class="crawler-status-item">⏳ 正在启动爬虫任务...</span>';

    try {
        const result = await window.electronAPI.runAllCrawlers();
        // 显示每个爬虫的结果
        crawlerDetails.innerHTML = '';
        if (result.results) {
            result.results.forEach(r => {
                const icon = r.status === 'completed' ? '✅' : '❌';
                const el = document.createElement('span');
                el.className = 'crawler-status-item';
                el.textContent = `${icon} ${r.name}: ${r.message}`;
                crawlerDetails.appendChild(el);
            });
        }
        updateStatus(result.results.every(r => r.status === 'completed') ? 'success' : 'warning', '爬取完成');
    } catch (err) {
        updateStatus('error', `爬取失败: ${err.message}`);
    } finally {
        isCrawling = false;
    }
}

// ============================================================
// 一键清洗
// ============================================================
async function handleClean() {
    if (isCleaning) return;
    isCleaning = true;

    updateStatus('running', '正在清洗数据...');
    try {
        await window.electronAPI.runCleaning();
        // 状态由 onCleaningStatus 事件更新
    } catch (err) {
        updateStatus('error', `清洗失败: ${err.message}`);
        isCleaning = false;
    }
}

// ============================================================
// 登录弹窗
// ============================================================
function showLoginModal(name) {
    loginMessage.textContent = `"${name}" 需要登录网站才能使用。`;
    loginModal.style.display = 'flex';
}

function closeLoginModal() {
    loginModal.style.display = 'none';
    currentLoginTarget = null;
}

async function startLogin() {
    if (!currentLoginTarget) return;

    const btn = $('btnStartLogin');
    btn.disabled = true;
    btn.textContent = '正在打开浏览器...';

    try {
        const result = await window.electronAPI.guideLogin(currentLoginTarget);
        if (result.success) {
            alert('登录浏览器已打开，请完成登录后关闭浏览器窗口。');
            closeLoginModal();
        } else {
            alert('启动登录失败: ' + (result.error || '未知错误'));
        }
    } catch (err) {
        alert('启动登录失败: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '开始登录';
    }
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    setupListeners();
    loadData();
});