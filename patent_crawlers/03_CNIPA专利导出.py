# 03_CNIPA专利导出.py
"""
CNIPA专利检索及分析网 - 智能下载捕获脚本（被动等待版）
- 打开浏览器后仅首次导航，之后所有检测均不打断用户操作
- 通过Cookie+当前页面DOM静默检测登录状态
- 用户登录后手动搜索、下载，脚本自动捕获下载文件
"""
import os, sys, json, time, logging, argparse
from pathlib import Path
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", handlers=[logging.StreamHandler(sys.stdout)])
logger = logging.getLogger(__name__)

CNIPA_URL = "https://pss-system.cponline.cnipa.gov.cn"
# 注意: main.js 有 5 分钟总超时 (CRAWLER_TIMEOUT=300000ms)
# 此处两个超时之和需小于 300 秒，预留启动/导航时间
MANUAL_TIMEOUT = 150          # 等待用户手动下载 2.5 分钟
LOGIN_WAIT_TIMEOUT = 120      # 登录等待 2 分钟

# 登录后CNIPA设置的常见session cookie名称
LOGIN_COOKIE_PATTERNS = ["session", "token", "auth", "castgc", "iPlanetDirectoryPro",
                         "tgTCookie", "rememberMe", "cnipa_"]


def setup_file_logging(data_dir):
    log_dir = Path(data_dir) / "log" / "专利检索及分析网"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"cnipa_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    fh = logging.FileHandler(log_file, encoding='utf-8')
    fh.setLevel(logging.INFO)
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logging.getLogger().addHandler(fh)
    logger.info(f"日志文件: {log_file}")


def check_login(page):
    """
    静默检测登录状态 - 不导航、不刷新页面。
    优先级:
      1. Cookie检测（最快，零副作用）
      2. 当前页面DOM检测（不导航，仅在当前URL属于CNIPA域时执行）
    """
    # ---------- 方法1: Cookie检测 ----------
    try:
        cookies = page.context.cookies()
        # 只关心 CNIPA 域下的 cookie
        cnipa_cookies = [c for c in cookies if "cponline.cnipa.gov.cn" in c.get("domain", "")]
        for c in cnipa_cookies:
            name_lower = c["name"].lower()
            if any(pattern in name_lower for pattern in LOGIN_COOKIE_PATTERNS):
                if c.get("value", "").strip():
                    logger.info(f"[登录检测-Cookie] 检测到登录cookie: {c['name']}")
                    return True
        logger.debug(f"[登录检测-Cookie] CNIPA cookie数量: {len(cnipa_cookies)}, 名称: {[c['name'] for c in cnipa_cookies]}")
    except Exception as e:
        logger.debug(f"[登录检测-Cookie] 异常: {e}")

    # ---------- 方法2: 当前页面DOM检测（不导航） ----------
    try:
        current_url = page.url
        # 只在CNIPA域下检测，避免跨域错误
        if "cponline.cnipa.gov.cn" not in current_url:
            logger.debug(f"[登录检测-DOM] 当前URL不在CNIPA域: {current_url}")
            return False

        body_text = page.evaluate("document.body?.innerText || ''")
        # 登录后的特征文本（优先用更稳定的关键词）
        logged_in_keywords = ['退出登录', '个人中心', '批量下载库', '我的专利']
        login_page_keywords = ['登录', '注册']

        has_logged_in = any(kw in body_text for kw in logged_in_keywords)
        has_login_form = any(kw in body_text for kw in login_page_keywords)

        if has_logged_in and not has_login_form:
            logger.info("[登录检测-DOM] 检测到用户已登录")
            return True

        logger.debug(f"[登录检测-DOM] 当前URL={current_url}, logged_in_kw={has_logged_in}, login_form_kw={has_login_form}")
    except Exception as e:
        logger.debug(f"[登录检测-DOM] 异常: {e}")

    return False


def initial_navigate(page):
    """首次导航到CNIPA首页，只在启动时调用一次"""
    try:
        logger.info(f"[导航] 正在打开 CNIPA: {CNIPA_URL}")
        page.goto(CNIPA_URL, wait_until="load", timeout=30000)
        page.wait_for_timeout(5000)
        logger.info(f"[导航] 当前页面: {page.url}")
        return True
    except Exception as e:
        logger.warning(f"[导航] 异常: {e}")
        return False


def wait_for_login(page, timeout=LOGIN_WAIT_TIMEOUT):
    """静默等待用户登录 - 不导航、不刷新页面"""
    logger.info("[登录] 请在弹出的浏览器中扫码或输入账号密码登录...")
    logger.info("[登录] 脚本将静默检测登录状态，不会打断您的操作")
    start = time.time()
    last_log_time = 0
    while time.time() - start < timeout:
        time.sleep(2)
        try:
            if check_login(page):
                return True
        except Exception as e:
            logger.debug(f"[登录检测] 轮询异常: {e}")
        elapsed = time.time() - start
        if elapsed - last_log_time >= 30:
            remaining = int(timeout - elapsed) // 60
            logger.info(f"[登录] 等待登录中... 剩余约 {remaining} 分钟")
            last_log_time = elapsed
    logger.warning("[登录] 登录超时")
    return False


def wait_for_manual_download(page, output_dir, timeout=MANUAL_TIMEOUT):
    """等待用户手动操作并捕获下载文件"""
    print("\n" + "=" * 60)
    print("📋 已检测到登录成功！请手动完成以下操作：")
    print("  1️⃣  在搜索框中输入专利号或申请人，点击搜索")
    print("  2️⃣  在搜索结果中勾选需要导出的专利")
    print("  3️⃣  点击「加入批量下载库」→ 选择「追加到默认库」")
    print("  4️⃣  点击右上角用户菜单 → 「批量下载库」")
    print("  5️⃣  在批量下载库页面点击「下载」")
    print("  6️⃣  全选字段标签（申请人、摘要等）")
    print("  7️⃣  输入验证码，点击确认下载")
    print("=" * 60)
    print(f"脚本将自动捕获下载文件... 最长等待时间: {timeout // 60} 分钟\n")

    download_occurred = False
    download_file = None

    def handle_download(download):
        nonlocal download_occurred, download_file
        suggested = download.suggested_filename
        dest = os.path.join(output_dir, suggested)
        download.save_as(dest)
        logger.info(f"[下载] 文件已保存: {dest}")
        download_file = dest
        download_occurred = True

    page.on("download", handle_download)

    start = time.time()
    last_log_time = 0
    while time.time() - start < timeout:
        if download_occurred:
            break
        time.sleep(1)
        elapsed = time.time() - start
        if elapsed - last_log_time >= 30:
            remaining = int(timeout - elapsed) // 60
            logger.info(f"[等待下载] 剩余约 {remaining} 分钟...")
            last_log_time = elapsed

    page.remove_listener("download", handle_download)
    return download_file if download_occurred else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--action', required=True, choices=['check', 'crawl'])
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    setup_file_logging(data_dir)
    output_dir = data_dir / "temp_data" / "专利检索及分析网"
    output_dir.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR = data_dir / "cnipa_context"
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.action == 'check':
        # 快速检查登录状态 - 无头模式，仅查cookie
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data_dir=str(USER_DATA_DIR),
                headless=True,
                args=['--disable-blink-features=AutomationControlled']
            )
            page = browser.pages[0] if browser.pages else browser.new_page()
            # check 动作仅用 cookie 检测，不导航加载页面
            logged_in = check_login(page)
            print(json.dumps({"loggedIn": logged_in}))
            browser.close()
        return

    # crawl 动作
    logger.info("[启动] 正在打开 CNIPA 浏览器窗口...")
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=str(USER_DATA_DIR),
            headless=False,
            no_viewport=True,
            args=['--start-maximized', '--disable-blink-features=AutomationControlled'],
            locale='zh-CN',
            accept_downloads=True,
        )
        page = browser.pages[0] if browser.pages else browser.new_page()

        # 1. 首次导航到CNIPA首页（仅此一次）
        initial_navigate(page)

        # 2. 静默等待用户登录（不导航、不刷新、不打断用户操作）
        logged_in = wait_for_login(page)
        if not logged_in:
            print(json.dumps({"success": False, "error": "登录超时"}))
            browser.close()
            return

        # 3. 登录成功，等待用户手动搜索、导出、下载
        download_file = wait_for_manual_download(page, str(output_dir))
        if download_file:
            print(json.dumps({
                "success": True,
                "crawler": "专利检索分析网",
                "file": download_file,
                "timestamp": datetime.now().isoformat()
            }, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "error": "未检测到下载文件"}))

        logger.info("[结束] 操作完成，3秒后关闭浏览器...")
        time.sleep(3)
        browser.close()


if __name__ == "__main__":
    main()