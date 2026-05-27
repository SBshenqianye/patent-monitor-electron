# 02_天眼查专利导出.py
"""
天眼查专利导出爬虫（最终可见版）
每次运行必定打开可见浏览器窗口，登录流程清晰。
"""
import os, sys, json, time, logging, argparse
from pathlib import Path
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", handlers=[logging.StreamHandler(sys.stdout)])
logger = logging.getLogger(__name__)

TIANYAN_URL = "https://www.tianyancha.com"
PATENT_URL = "https://www.tianyancha.com/company/2434381675/zhishi"
DOWNLOAD_TIMEOUT = 60_000

def setup_file_logging(data_dir):
    log_dir = Path(data_dir) / "log" / "天眼查"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"tianyan_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    fh = logging.FileHandler(log_file, encoding='utf-8')
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logging.getLogger().addHandler(fh)
    logger.info(f"日志文件: {log_file}")

def check_login(page):
    try:
        logger.info("[登录检查] 正在访问天眼查首页...")
        page.goto(TIANYAN_URL, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(4000)
        has_element = page.evaluate("() => !!document.querySelector('.tyc-nav-user')")
        cookies = page.context.cookies()
        has_token = any('token' in c['name'].lower() or 'tycid' in c['name'].lower() for c in cookies)
        logged_in = has_element and has_token
        logger.info(f"[登录检查] 元素:{has_element} Cookie:{has_token} => {'已登录' if logged_in else '未登录'}")
        return logged_in
    except Exception as e:
        logger.warning(f"[登录检查] 异常: {e}")
        return False

def wait_for_login(page, timeout=600):
    logger.info("[登录引导] ========================================")
    logger.info("[登录引导] 请在弹出的浏览器中完成登录（扫码或账密）")
    logger.info("[登录引导] 登录成功后脚本将自动继续")
    logger.info("[登录引导] ========================================")
    start = time.time()
    while time.time() - start < timeout:
        try:
            page.wait_for_timeout(2000)
            if check_login(page):
                return True
        except: pass
        if int(time.time() - start) % 30 == 0:
            logger.info(f"[登录引导] 等待中... 剩余约 {int(timeout - (time.time() - start)) // 60} 分钟")
    return False

def do_crawl(page, output_dir):
    logger.info("[爬取] 开始专利导出流程...")
    if not check_login(page):
        logger.info("[爬取] 未登录，进入引导页面...")
        page.goto("https://www.tianyancha.com/login", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
        if not wait_for_login(page):
            return False, None
        logger.info("[爬取] 登录成功，开始导出")

    logger.info(f"[步骤1] 访问专利页: {PATENT_URL}")
    page.goto(PATENT_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(6000)  # 多等一会确保表格渲染

    logger.info("[步骤2] 点击导出按钮...")
    export_btn = page.locator('.index_export-button__9ok1s button:has-text("导出")')
    export_btn.wait_for(state="visible", timeout=15000)
    export_btn.click()

    logger.info("[步骤3] 等待下载...")
    try:
        with page.expect_download(timeout=DOWNLOAD_TIMEOUT) as download_info:
            pass
        download = download_info.value
        dest = os.path.join(output_dir, download.suggested_filename)
        download.save_as(dest)
        logger.info(f"[下载] 文件已保存: {dest}")
        return True, dest
    except PlaywrightTimeout:
        logger.error("下载超时")
        return False, None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--action', required=True, choices=['check', 'crawl'])
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    setup_file_logging(data_dir)
    output_dir = data_dir / "temp_data" / "天眼查"
    output_dir.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR = data_dir / "tianyan_context"
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.action == 'check':
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(user_data_dir=str(USER_DATA_DIR), headless=False, viewport={"width":800,"height":600})
            page = browser.pages[0] if browser.pages else browser.new_page()
            logged_in = check_login(page)
            print(json.dumps({"loggedIn": logged_in}))
            browser.close()
        return

    # crawl 动作
    logger.info("[启动] 正在启动天眼查浏览器窗口，请稍候...")
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=str(USER_DATA_DIR),
            headless=False,
            no_viewport=True,
            args=['--start-maximized'],
            locale='zh-CN',
            accept_downloads=True,
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        logger.info("[启动] 浏览器窗口已打开")

        success, file_path = do_crawl(page, str(output_dir))
        if success:
            print(json.dumps({"success": True, "crawler": "天眼查", "file": file_path or "", "total": 0, "timestamp": datetime.now().isoformat()}, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "error": "导出失败或未登录"}))

        logger.info("[结束] 操作完成，3秒后关闭浏览器...")
        time.sleep(3)
        browser.close()

if __name__ == "__main__":
    main()