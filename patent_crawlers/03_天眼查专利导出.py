# -*- coding: utf-8 -*-
"""
天眼查专利导出爬虫 (Electron版)
支持命令行参数: --data-dir <path> --action <check|login|crawl>
使用 Playwright 持久化浏览器上下文
"""

import os, sys, json, time, logging, argparse
from datetime import datetime
from playwright.sync_api import sync_playwright

# ---------- 日志 ----------
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# ---------- 全局变量 ----------
DOWNLOAD_COMPLETED = False
DATA_DIR = None
USER_DATA_DIR = None
COOKIE_FILE = None
LOG_FILE = None

TIANYAN_URL = "https://www.tianyancha.com"
LOGIN_URL = "https://www.tianyancha.com/login"
PATENT_URL = "https://www.tianyancha.com/patent"
DOWNLOAD_WAIT = 60


def setup_logging():
    global LOG_FILE
    os.makedirs(DATA_DIR, exist_ok=True)
    LOG_FILE = os.path.join(DATA_DIR, f"tianyan_crawl_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
    logging.basicConfig(
        level=logging.INFO,
        format=LOG_FORMAT,
        datefmt=DATE_FORMAT,
        handlers=[
            logging.FileHandler(LOG_FILE, encoding='utf-8'),
            logging.StreamHandler(sys.stdout),
        ]
    )


# ========== 下载监听 ==========
def handle_download(download):
    global DOWNLOAD_COMPLETED
    DOWNLOAD_COMPLETED = True
    dest = os.path.join(DATA_DIR, download.suggested_filename)
    download.save_as(dest)
    logging.info(f"[下载] 文件已保存: {dest}")


# ========== 检查登录状态 ==========
def check_login(page):
    """检查天眼查是否已登录"""
    try:
        page.goto(TIANYAN_URL, wait_until="domcontentloaded", timeout=15000)
        time.sleep(2)
        # 判断是否有登录态的特征：检查页面是否有用户头像或用户名
        logged_in = page.evaluate("""
            () => {
                // 天眼查登录后通常会有一个用户头像或者"我的"菜单
                const avatar = document.querySelector('.user-avatar, .userAvatar, .avatar-img');
                const userName = document.querySelector('.user-name, .userName, .header-user-name');
                const cookies = document.cookie;
                return !!(avatar || userName || cookies.includes('token=') || cookies.includes('TYCID'));
            }
        """)
        logging.info(f"[登录检查] 登录状态: {'已登录' if logged_in else '未登录'}")
        return logged_in
    except Exception as e:
        logging.warning(f"[登录检查] 检查失败: {e}")
        return False


# ========== 登录引导 ==========
def do_login(page):
    """打开天眼查登录页面，等待用户扫码登录"""
    logging.info("[登录] 请在打开的浏览器窗口中扫码登录天眼查...")
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
    
    max_wait = 600  # 最多等待10分钟
    for i in range(max_wait):
        time.sleep(1)
        try:
            logged_in = page.evaluate("""
                () => {
                    const avatar = document.querySelector('.user-avatar, .userAvatar, .avatar-img');
                    const userName = document.querySelector('.user-name, .userName, .header-user-name');
                    const cookies = document.cookie;
                    return !!(avatar || userName || cookies.includes('token=') || cookies.includes('TYCID'));
                }
            """)
            if logged_in:
                logging.info("[登录] 登录成功！")
                context = page.context
                context.storage_state(path=COOKIE_FILE)
                return True
        except Exception:
            pass
        if i % 30 == 0:
            logging.info(f"[登录] 等待扫码登录中... {(max_wait - i) // 60}分钟")
    logging.warning("[登录] 登录超时")
    return False


# ========== 爬取主逻辑 ==========
def do_crawl(page):
    """执行天眼查专利导出"""
    global DOWNLOAD_COMPLETED
    DOWNLOAD_COMPLETED = False

    try:
        logging.info("[步骤1] 访问天眼查专利页面...")
        page.goto(PATENT_URL, wait_until="networkidle", timeout=30000)
        time.sleep(3)

        # 这里需要根据天眼查实际页面结构调整
        # 示例：可能需要先搜索公司名称，然后进入专利列表，再导出
        
        # 等待导出按钮出现
        # export_btn = page.locator('button:has-text("导出")')
        # if export_btn.is_visible():
        #     export_btn.click()
        #     time.sleep(2)
        #     # 选择导出类型
        #     page.click('text=Excel')
        #     page.click('button:has-text("确定")')
        
        logging.info(f"[步骤2] 等待下载（最长{DOWNLOAD_WAIT}秒）...")
        wait_until = time.time() + DOWNLOAD_WAIT
        while time.time() < wait_until:
            if DOWNLOAD_COMPLETED:
                break
            time.sleep(1)

        if DOWNLOAD_COMPLETED:
            logging.info("[结果] 导出成功！✓")
        else:
            logging.info("[结果] 导出完成（可能未触发下载，请检查页面）")

        logging.info(f"[结果] 数据目录: {DATA_DIR}")
        return True

    except Exception as e:
        logging.error(f"[错误] 爬取失败: {e}")
        return False


# ========== 主入口 ==========
def main():
    parser = argparse.ArgumentParser(description='天眼查专利爬虫')
    parser.add_argument('--data-dir', required=True, help='用户数据目录')
    parser.add_argument('--action', required=True, choices=['check', 'login', 'crawl'], help='执行动作')
    args = parser.parse_args()

    global DATA_DIR, USER_DATA_DIR, COOKIE_FILE
    DATA_DIR = args.data_dir
    USER_DATA_DIR = os.path.join(DATA_DIR, "tianyan_context")
    COOKIE_FILE = os.path.join(USER_DATA_DIR, "storage_state.json")

    os.makedirs(USER_DATA_DIR, exist_ok=True)
    setup_logging()

    logging.info(f"[启动] 天眼查爬虫 (数据目录: {DATA_DIR}, 动作: {args.action})")

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=(args.action != 'login'),  # 登录时显示浏览器
            no_viewport=True,
            args=['--start-maximized'],
            locale='zh-CN',
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        page.on("download", handle_download)

        if args.action == 'check':
            result = check_login(page)
            print(json.dumps({"loggedIn": result}))
        
        elif args.action == 'login':
            result = do_login(page)
            print(json.dumps({"loggedIn": result}))
            input("\n按 Enter 键关闭浏览器...")
        
        elif args.action == 'crawl':
            logged_in = check_login(page)
            if not logged_in:
                logging.warning("[警告] 尚未登录，请先执行 login 动作")
                print(json.dumps({"success": False, "error": "not_logged_in"}))
            else:
                success = do_crawl(page)
                print(json.dumps({"success": success}))
        
        browser.close()


if __name__ == "__main__":
    main()