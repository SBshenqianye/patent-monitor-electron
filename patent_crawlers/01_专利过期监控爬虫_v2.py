# 01_专利过期监控爬虫_v2.py
"""
中国专利公布公告爬虫 (Electron 适配版)
支持命令行参数:
  --data-dir <路径>    用户数据根目录
  --action <check|crawl>
  --keywords <关键词1,关键词2,...>  可选
  --headless <true|false>  是否无头模式，默认 false

输出路径: {data-dir}/temp_data/中国专利公布公告网/
日志路径: {data-dir}/log/中国专利公布公告网/
"""

import csv
import logging
import sys
import time
import random
from datetime import datetime
from pathlib import Path
import argparse
import json

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

# ============================ 常量 ============================
URL = "http://epub.cnipa.gov.cn/Index"
DEFAULT_KEYWORDS = ["内江供电公司"]
TOTAL_PAGES = 8
WAIT_TIMEOUT = 90_000
MAX_RETRIES = 3

# ============================ 日志配置 ============================
# 基础日志（stdout）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def setup_file_logging(data_dir):
    """添加文件日志处理器"""
    log_dir = Path(data_dir) / "log" / "中国专利公布公告网"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"crawl_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    fh = logging.FileHandler(log_file, encoding='utf-8')
    fh.setLevel(logging.INFO)
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logging.getLogger().addHandler(fh)
    logger.info(f"日志文件: {log_file}")


def extract_patent_items_via_evaluate(page) -> list[dict]:
    items = page.evaluate("""
        () => {
            const items = document.querySelectorAll('div.overview-default > div.item');
            const result = [];
            
            items.forEach((item, index) => {
                try {
                    const patent = {};
                    
                    const h2 = item.querySelector('h2');
                    if (h2) {
                        const a = h2.querySelector('a');
                        if (a) {
                            patent['标题'] = a.textContent.trim();
                            patent['链接'] = a.getAttribute('href') || '';
                        } else {
                            patent['标题'] = h2.textContent.trim();
                        }
                    } else {
                        const firstA = item.querySelector('a');
                        if (firstA && firstA.textContent.trim()) {
                            patent['标题'] = firstA.textContent.trim();
                            patent['链接'] = firstA.getAttribute('href') || '';
                        }
                    }
                    
                    const ps = item.querySelectorAll('p');
                    ps.forEach(p => {
                        const text = p.textContent.trim();
                        const labels = ['申请号', '申请日', '公开（公告）日', '公开(公告)日', '发明人', '申请人', '地址'];
                        for (const label of labels) {
                            if (text.startsWith(label + '：') || text.startsWith(label + ':')) {
                                const sep = text.startsWith(label + '：') ? '：' : ':';
                                const value = text.substring(label.length + sep.length).trim();
                                patent[label] = value;
                                break;
                            }
                        }
                    });
                    
                    if (Object.keys(patent).length > 0) {
                        result.push(patent);
                    }
                } catch (e) {}
            });
            return result;
        }
    """)
    logger.info(f"evaluate 提取到 {len(items)} 条专利")
    return items


def extract_patent_items_via_evaluate_v2(page) -> list[dict]:
    items = page.evaluate("""
        () => {
            let containers = document.querySelectorAll('div.overview-default > div.item');
            
            if (containers.length === 0) {
                const allDivs = document.querySelectorAll('div[class*="item"], div[class*="patent"], tr[class*="item"]');
                if (allDivs.length > 0) {
                    containers = allDivs;
                }
            }
            
            if (containers.length === 0) {
                const body = document.body;
                const walker = document.createTreeWalker(body, 4, null, false);
                const result = [];
                let node;
                while (node = walker.nextNode()) {
                    if (node.nodeType === 1 && node.children.length > 0) {
                        const text = node.textContent || '';
                        if (text.includes('申请号') && text.includes('申请日') && text.includes('公开')) {
                            result.push(node);
                        }
                    }
                }
                containers = result;
            }
            
            const resultList = [];
            containers.forEach((container, idx) => {
                try {
                    const patent = {};
                    const text = container.textContent.trim();
                    
                    const fieldPatterns = [
                        { label: '申请号', patterns: ['申请号：', '申请号:', '申请号 '] },
                        { label: '申请日', patterns: ['申请日：', '申请日:', '申请日 '] },
                        { label: '公开（公告）日', patterns: ['公开（公告）日：', '公开(公告)日：', '公开（公告）日:', '公开日：', '公开日:'] },
                        { label: '发明人', patterns: ['发明人：', '发明人:', '发明人 '] },
                        { label: '申请人', patterns: ['申请人：', '申请人:', '申请人 '] },
                        { label: '地址', patterns: ['地址：', '地址:', '地址 '] },
                    ];
                    
                    for (const field of fieldPatterns) {
                        for (const pattern of field.patterns) {
                            const idx2 = text.indexOf(pattern);
                            if (idx2 !== -1) {
                                const start = idx2 + pattern.length;
                                let end = text.length;
                                for (const nextField of fieldPatterns) {
                                    for (const nextPat of nextField.patterns) {
                                        const nextIdx = text.indexOf(nextPat, start);
                                        if (nextIdx !== -1 && nextIdx < end) {
                                            end = nextIdx;
                                        }
                                    }
                                }
                                patent[field.label] = text.substring(start, end).trim();
                                break;
                            }
                        }
                    }
                    
                    const lines = text.split('\\n').filter(l => l.trim());
                    if (lines.length > 0) {
                        const firstLine = lines[0].trim();
                        if (!firstLine.includes('：') && !firstLine.includes(':')) {
                            patent['标题'] = firstLine;
                        } else if (lines.length > 1) {
                            patent['标题'] = lines[1].trim();
                        }
                    }
                    
                    if (!patent['标题']) {
                        const heading = container.querySelector('h2, h3, h4, a[title]');
                        if (heading) {
                            patent['标题'] = heading.textContent.trim();
                        }
                    }
                    
                    if (Object.keys(patent).length > 0) {
                        resultList.push(patent);
                    }
                } catch (e) {}
            });
            
            return resultList;
        }
    """)
    logger.info(f"evaluate-v2 提取到 {len(items)} 条专利")
    return items


def trigger_search(page, keyword):
    search_input = page.locator('input#searchStr[name="searchStr"]')
    search_input.wait_for(state="visible", timeout=WAIT_TIMEOUT)
    search_input.fill("")
    page.wait_for_timeout(500 + random.randint(0, 500))
    search_input.fill(keyword)
    logger.info("搜索词已填入")

    try:
        page.evaluate("index_Query()")
        logger.info("已通过 evaluate 调用 index_Query()")
        return
    except Exception as e:
        logger.warning(f"evaluate index_Query() 失败: {e}")

    try:
        search_input.press("Enter")
        logger.info("已按 Enter 键提交搜索")
        return
    except Exception as e:
        logger.warning(f"按 Enter 键失败: {e}")

    try:
        search_btn = page.locator('button[onclick="index_Query()"], button.sbtn').first
        if search_btn.is_visible(timeout=2000):
            search_btn.click(force=True)
            logger.info("已通过 force click 点击搜索按钮")
    except Exception as e:
        logger.error(f"所有搜索触发方式均失败: {e}")


def wait_for_results(page, timeout_seconds=60):
    try:
        page.wait_for_url(
            lambda url: "IndexQuery" in url or "Dxb" in url or "Search" in url,
            timeout=timeout_seconds * 1000
        )
        logger.info(f"搜索结果URL: {page.url}")
        return True
    except PlaywrightTimeout:
        pass

    try:
        page.wait_for_selector("div.overview-default", timeout=5000)
        logger.info("找到 overview-default 容器")
        return True
    except PlaywrightTimeout:
        pass

    try:
        body = page.locator("body").inner_text(timeout=3000)
        if any(kw in body for kw in ["申请号", "申请日", "公开", "overview"]):
            logger.info("从 body 内容检测到搜索结果")
            return True
    except:
        pass
    return False


def main():
    parser = argparse.ArgumentParser(description='中国专利公布公告爬虫')
    parser.add_argument('--data-dir', required=True, help='用户数据根目录')
    parser.add_argument('--action', required=True, choices=['check', 'crawl'], help='操作类型')
    parser.add_argument('--keywords', help='逗号分隔的关键词列表')
    parser.add_argument('--headless', choices=['true', 'false'], default='false',
                        help='是否使用无头模式（默认false）')
    args = parser.parse_args()

    headless = args.headless.lower() == 'true'
    data_dir = Path(args.data_dir)

    # 设置文件日志
    setup_file_logging(data_dir)

    output_dir = data_dir / "temp_data" / "中国专利公布公告网"
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.action == 'check':
        print(json.dumps({"loggedIn": True, "message": "中国专利公布公告无需登录"}))
        return

    if args.keywords:
        keywords = [k.strip() for k in args.keywords.split(',') if k.strip()]
    else:
        keywords = DEFAULT_KEYWORDS

    logger.info("=" * 60)
    logger.info("中国专利公布公告爬虫 (Electron 版) 启动")
    logger.info(f"无头模式: {headless}")
    logger.info(f"搜索关键词: {keywords}")
    logger.info(f"数据目录: {data_dir}")
    logger.info(f"输出目录: {output_dir}")
    logger.info("=" * 60)

    all_patents = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--accept-lang=zh-CN,zh",
            ],
        )
        context = browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            geolocation={"longitude": 116.4074, "latitude": 39.9042},
            permissions=["geolocation"],
        )
        page = context.new_page()

        try:
            for kw_index, keyword in enumerate(keywords):
                if kw_index > 0:
                    wait = random.uniform(3, 7)
                    logger.info(f"等待 {wait:.1f} 秒再搜索下一个关键词...")
                    page.wait_for_timeout(wait * 1000)

                logger.info(f"爬取关键词 {kw_index+1}/{len(keywords)}: {keyword}")

                for attempt in range(1, MAX_RETRIES + 1):
                    try:
                        page.goto(URL, wait_until="load", timeout=WAIT_TIMEOUT)
                        break
                    except Exception as e:
                        if '502' in str(e) or 'Bad Gateway' in str(e):
                            logger.warning(f"502 错误，重试 {attempt}/{MAX_RETRIES}...")
                            time.sleep(5)
                        else:
                            raise
                else:
                    logger.error("连续 502，跳过该关键词")
                    continue

                page.reload(wait_until="networkidle")
                page.wait_for_timeout(random.randint(2000, 4000))

                trigger_search(page, keyword)

                if not wait_for_results(page, 60):
                    logger.warning(f"关键词 '{keyword}' 搜索失败，跳过")
                    continue

                logger.info("搜索结果页已加载")

                page.wait_for_timeout(random.randint(2000, 3000))
                try:
                    size_select = page.locator('select#sizeSelect.listnum')
                    size_select.wait_for(state="visible", timeout=5000)
                    size_select.select_option("10")
                    page.wait_for_timeout(random.randint(1000, 2000))
                    logger.info("已将每页条数设为10")
                except PlaywrightTimeout:
                    logger.warning("无法修改每页条数，继续使用默认值")

                current_page = 1
                while current_page <= TOTAL_PAGES:
                    logger.info(f"处理第 {current_page} 页")
                    page.wait_for_timeout(random.randint(2000, 3000))

                    patents = extract_patent_items_via_evaluate_v2(page)
                    if not patents:
                        patents = extract_patent_items_via_evaluate(page)

                    if patents:
                        for p in patents:
                            p["关键词"] = keyword
                        all_patents.extend(patents)
                        logger.info(f"本页采集 {len(patents)} 条，累计 {len(all_patents)} 条")
                    else:
                        logger.warning("未提取到专利数据，重试一次...")
                        page.wait_for_timeout(5000 + random.randint(0, 2000))
                        patents = extract_patent_items_via_evaluate_v2(page)
                        if patents:
                            for p in patents:
                                p["关键词"] = keyword
                            all_patents.extend(patents)
                            logger.info(f"二次提取到 {len(patents)} 条")
                        else:
                            logger.error("依旧无数据，停止该关键词")
                            break

                    if current_page >= TOTAL_PAGES:
                        break

                    try:
                        next_btn = page.locator('a.next_page')
                        if next_btn.is_visible(timeout=5000):
                            class_attr = next_btn.get_attribute("class") or ""
                            if "disabled" in class_attr:
                                logger.info("下一页已禁用")
                                break
                            next_btn.click()
                            page.wait_for_timeout(random.randint(2000, 4000))
                            current_page += 1
                        else:
                            logger.info("未找到下一页按钮")
                            break
                    except Exception as e:
                        logger.warning(f"翻页异常: {e}")
                        break

        except PlaywrightTimeout as e:
            logger.error(f"页面加载超时: {e}")
        except Exception as e:
            logger.error(f"爬取过程出错: {e}", exc_info=True)
        finally:
            browser.close()

    if not all_patents:
        logger.error("未采集到任何专利数据")
        print(json.dumps({"success": False, "error": "未采集到数据"}))
        return

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    csv_path = output_dir / f"专利数据_v2_{timestamp}.csv"
    fieldnames = ["标题", "申请号", "申请日", "公开（公告）日", "发明人", "申请人", "地址", "链接", "关键词"]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_patents)
    logger.info(f"CSV已保存: {csv_path}")

    result_info = {
        "success": True,
        "crawler": "中国专利公布公告",
        "total": len(all_patents),
        "csv": str(csv_path),
        "timestamp": datetime.now().isoformat()
    }
    print(json.dumps(result_info, ensure_ascii=False))


if __name__ == "__main__":
    main()