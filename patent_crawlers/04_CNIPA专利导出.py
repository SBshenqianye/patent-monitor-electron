# -*- coding: utf-8 -*-
"""
CNIPA专利检索及分析网 - 爬虫 (Electron版)
支持命令行参数: --data-dir <path> --action <check|login|crawl>
使用 Playwright 持久化浏览器上下文
"""

import os, sys, json, time, logging, argparse
from pathlib import Path
from datetime import datetime

from playwright.sync_api import sync_playwright

# ---------- 日志 ----------
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# ---------- 全局变量 ----------
DOWNLOAD_COMPLETED = False
DATA_DIR = None  # 由 --data-dir 指定
USER_DATA_DIR = None  # 持久化上下文目录
COOKIE_FILE = None
LOG_FILE = None

CNIPA_URL = "https://pss-system.cponline.cnipa.gov.cn"
LOGIN_CHECK_URL = f"{CNIPA_URL}/api/online/user/loginUserInfo"
DOWNLOAD_WAIT = 30  # 等待下载的最大秒数


def setup_logging():
    global LOG_FILE
    os.makedirs(DATA_DIR, exist_ok=True)
    LOG_FILE = os.path.join(DATA_DIR, f"cnipa_crawl_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
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
    """检查是否已登录，返回 True/False"""
    try:
        page.goto(LOGIN_CHECK_URL, wait_until="domcontentloaded", timeout=15000)
        resp = page.evaluate("() => document.body.innerText")
        data = json.loads(resp)
        logged_in = data.get("success", False) and data.get("data") is not None
        logging.info(f"[登录检查] 登录状态: {'已登录' if logged_in else '未登录'}")
        return logged_in
    except Exception as e:
        logging.warning(f"[登录检查] 检查失败: {e}")
        return False


# ========== 登录引导 ==========
def do_login(page):
    """打开登录页面，等待用户手动完成登录"""
    logging.info("[登录] 请在打开的浏览器窗口中扫码或账号密码登录...")
    page.goto(CNIPA_URL, wait_until="domcontentloaded", timeout=30000)
    
    # 等待用户完成登录（检测到登录成功）
    max_wait = 600  # 最多等待10分钟
    for i in range(max_wait):
        time.sleep(1)
        try:
            page.goto(LOGIN_CHECK_URL, wait_until="domcontentloaded", timeout=5000)
            resp = page.evaluate("() => document.body.innerText")
            data = json.loads(resp)
            if data.get("success", False) and data.get("data") is not None:
                logging.info("[登录] 登录成功！")
                # 保存Cookie状态
                context = page.context
                context.storage_state(path=COOKIE_FILE)
                return True
        except Exception:
            pass
        if i % 30 == 0:
            logging.info(f"[登录] 等待登录中... {(max_wait - i) // 60}分钟")
    logging.warning("[登录] 登录超时")
    return False


# ========== 爬取主逻辑 ==========
def do_crawl(page):
    """执行爬取流程"""
    global DOWNLOAD_COMPLETED
    DOWNLOAD_COMPLETED = False

    try:
        # ---------- 1. 访问专利检索页面 ----------
        logging.info("[步骤1] 打开专利检索页面...")
        search_url = f"{CNIPA_URL}/login/search"
        page.goto(search_url, wait_until="networkidle", timeout=30000)

        # 页面上的专利检索逻辑 - 这里需要根据实际页面结构调整
        # 以下为示例逻辑，实际使用时需要根据页面 DOM 结构调整
        
        # 搜索框输入
        # page.fill('input[placeholder*="申请号"]', search_keyword)
        # page.click('button:has-text("搜索")')
        # page.wait_for_selector('.table-container', timeout=10000)
        
        # 导出按钮
        # page.click('button:has-text("导出")')
        
        # ---------- 2. 等待下载 ----------
        logging.info(f"[步骤2] 等待下载（最长{DOWNLOAD_WAIT}秒）...")
        wait_until = time.time() + DOWNLOAD_WAIT
        while time.time() < wait_until:
            if DOWNLOAD_COMPLETED:
                break
            time.sleep(1)

        # ---------- 3. 结果 ----------
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
    parser = argparse.ArgumentParser(description='CNIPA专利检索爬虫')
    parser.add_argument('--data-dir', required=True, help='用户数据目录')
    parser.add_argument('--action', required=True, choices=['check', 'login', 'crawl'], help='执行动作')
    args = parser.parse_args()

    global DATA_DIR, USER_DATA_DIR, COOKIE_FILE
    DATA_DIR = args.data_dir
    USER_DATA_DIR = os.path.join(DATA_DIR, "cnipa_context")
    COOKIE_FILE = os.path.join(USER_DATA_DIR, "storage_state.json")

    os.makedirs(USER_DATA_DIR, exist_ok=True)
    setup_logging()

    logging.info(f"[启动] CNIPA爬虫 (数据目录: {DATA_DIR}, 动作: {args.action})")

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
            # 先检查登录
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