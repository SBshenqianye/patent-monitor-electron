# 02_天眼查专利导出.py
"""
天眼查专利导出爬虫（登录检测 + 下载捕获优化）
- 先检查登录态（元素 + cookie），未登录则引导登录
- 登录后导航到专利页，点击导出，等待下载事件
- 确保下载文件保存到指定目录
"""
import os, sys, json, time, logging, argparse
from pathlib import Path
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", handlers=[logging.StreamHandler(sys.stdout)])
logger = logging.getLogger(__name__)

TIANYAN_URL = "https://www.tianyancha.com"
PATENT_URL = "https://www.tianyancha.com/company/2434381675/zhishi"
DOWNLOAD_TIMEOUT = 30_000  # 点击导出后等待下载 30 秒
LOGIN_TIMEOUT = 600        # 登录等待 10 分钟

def setup_file_logging(data_dir):
    log_dir = Path(data_dir) / "log" / "天眼查"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"tianyan_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    fh = logging.FileHandler(log_file, encoding='utf-8')
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logging.getLogger().addHandler(fh)
    logger.info(f"日志文件: {log_file}")

def check_login(page):
    """检测天眼查登录状态：优先判断登录/注册按钮是否存在且可见"""
    try:
        page.goto(TIANYAN_URL, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)
        
        # 方法1: 检查“登录/注册”按钮（未登录时一定存在，可能有多个）
        login_btns = page.locator('span.tyc-nav-user-btn:has-text("登录/注册")')
        count = login_btns.count()
        if count > 0:
            # 取第一个按钮检查可见性
            if login_btns.first.is_visible():
                logger.info("[登录检查] 检测到可见的'登录/注册'按钮 → 未登录")
                return False
        
        # 方法2: 检查登录后的用户菜单（只有登录后才出现）
        user_label = page.locator('span.tyc-nav-user-dropdown-label')
        if user_label.count() > 0 and user_label.first.is_visible():
            # 进一步检查是否有实际文本内容（避免空占位）
            text = user_label.first.text_content().strip()
            if text and text != "登录/注册":
                logger.info(f"[登录检查] 检测到用户菜单文本: {text} → 已登录")
                return True
        
        # 兜底: cookie 检测
        cookies = page.context.cookies()
        has_token = any('token' in c['name'].lower() or 'tycid' in c['name'].lower() for c in cookies)
        if has_token:
            # 如果 cookie 有 token，再检查一次元素以防止脏数据
            logger.info("[登录检查] Cookie 有 token，但元素未确认，暂认为未登录")
            return False
        return False
    except Exception as e:
        logger.warning(f"[登录检查] 异常: {e}")
        return False

def wait_for_login(page, timeout=LOGIN_TIMEOUT):
    """等待用户完成登录：轮询检测登录后特有的用户菜单元素出现且有内容"""
    logger.info("[登录] 请在弹出的浏览器中扫码或输入账号密码登录...")
    start = time.time()
    while time.time() - start < timeout:
        try:
            page.wait_for_timeout(2000)
            # 检测登录后特有的 span.tyc-nav-user-dropdown-label 且文本非空
            user_label = page.locator('span.tyc-nav-user-dropdown-label')
            if user_label.count() > 0:
                # 确保元素可见且有实际文本（不是空字符串）
                if user_label.first.is_visible():
                    text = user_label.first.text_content().strip()
                    if text and text != "登录/注册":
                        logger.info(f"[登录] 检测到用户菜单: {text} → 登录成功")
                        return True
        except Exception:
            pass
        # 每30秒提示一次
        if (time.time() - start) % 30 < 2:
            remaining = int(timeout - (time.time() - start)) // 60
            logger.info(f"[登录] 等待中... 剩余约 {remaining} 分钟")
    logger.warning("[登录] 等待超时")
    return False


def export_and_download(page, output_dir):
    """点击导出按钮，监听下载并保存文件"""
    logger.info("[导出] 等待导出按钮...")
    export_btn = page.locator('.index_export-button__9ok1s button:has-text("导出")')
    export_btn.wait_for(state="visible", timeout=15000)
    logger.info("[导出] 点击导出按钮")
    export_btn.click()

    # 使用 expect_download 等待下载事件
    logger.info(f"[下载] 等待下载事件（最长 {DOWNLOAD_TIMEOUT // 1000} 秒）...")
    try:
        with page.expect_download(timeout=DOWNLOAD_TIMEOUT) as download_info:
            pass  # 下载事件由点击触发
        download = download_info.value
        suggested = download.suggested_filename
        dest = os.path.join(output_dir, suggested)
        download.save_as(dest)
        logger.info(f"[下载] 文件已保存: {dest}")
        return True, dest
    except PlaywrightTimeout:
        logger.error("[下载] 未检测到下载事件")
        return False, None

def do_crawl(page, output_dir):
    # 1. 确保已登录
    if not check_login(page):
        logger.info("[爬取] 未登录，进入登录引导...")
        page.goto("https://www.tianyancha.com/login", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
        if not wait_for_login(page):
            return False, None
        logger.info("[爬取] 登录成功")

    # 2. 导航到专利页面
    logger.info(f"[步骤1] 访问专利页面: {PATENT_URL}")
    page.goto(PATENT_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)

    # 3. 导出并下载
    success, file = export_and_download(page, output_dir)
    return success, file

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
    logger.info("[启动] 正在打开天眼查浏览器...")
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

        logger.info("[结束] 操作完成，5秒后关闭浏览器...")
        time.sleep(5)
        browser.close()

if __name__ == "__main__":
    main()