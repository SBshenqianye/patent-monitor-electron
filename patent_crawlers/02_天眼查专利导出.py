# 02_天眼查专利导出.py
"""
天眼查专利导出爬虫 (Electron 适配版)
支持命令行参数:
  --data-dir <路径>    用户数据根目录
  --action <crawl>      (check/login 动作已整合到 crawl)
输出路径: {data-dir}/temp_data/天眼查/
日志路径: {data-dir}/log/天眼查/
"""

import os
import sys
import json
import time
import logging
import argparse
from pathlib import Path
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

# ==================== 日志配置 ====================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

TIANYAN_URL = "https://www.tianyancha.com"
PATENT_URL = "https://www.tianyancha.com/company/2434381675/zhishi"
DOWNLOAD_TIMEOUT = 60_000  # 1分钟


def setup_file_logging(data_dir):
    log_dir = Path(data_dir) / "log" / "天眼查"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"tianyan_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    fh = logging.FileHandler(log_file, encoding='utf-8')
    fh.setLevel(logging.INFO)
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logging.getLogger().addHandler(fh)
    logger.info(f"日志文件: {log_file}")


def check_login(page):
    """检查登录状态（有头模式下元素 + cookie 双重检测）"""
    try:
        page.goto(TIANYAN_URL, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)
        has_element = page.evaluate("() => !!document.querySelector('.tyc-nav-user')")
        cookies = page.context.cookies()
        has_token = any('token' in c['name'].lower() or 'tycid' in c['name'].lower() for c in cookies)
        logged_in = has_element and has_token  # 必须两者同时满足
        logger.info(f"[登录检查] 元素: {has_element}, Cookie: {has_token} => 登录: {logged_in}")
        return logged_in
    except Exception as e:
        logger.warning(f"[登录检查] 异常: {e}")
        return False


def wait_for_login(page, timeout=600):
    """等待用户完成登录（在当前页面轮询）"""
    logger.info("[登录引导] 请扫码或输入账号密码完成登录...")
    start = time.time()
    while time.time() - start < timeout:
        try:
            page.wait_for_timeout(2000)
            if check_login(page):
                logger.info("[登录引导] 登录成功")
                return True
        except Exception:
            pass
        if int(time.time() - start) % 30 == 0:
            remaining = int(timeout - (time.time() - start))
            logger.info(f"[登录引导] 等待中... 剩余约 {remaining // 60} 分钟")
    logger.warning("[登录引导] 超时")
    return False


def do_crawl(page, output_dir):
    """
    执行专利导出：检测登录 → 若未登录则引导 → 访问专利页 → 点击导出 → 等待下载
    返回 (success, file_path)
    """
    # 1. 检查登录状态
    if not check_login(page):
        logger.info("[爬取] 未登录，进入引导...")
        page.goto("https://www.tianyancha.com/login", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
        if not wait_for_login(page):
            return False, None
        logger.info("[爬取] 登录成功，重新导航到专利页面")

    # 2. 重新导航到专利页面（确保干净状态）
    logger.info(f"[步骤1] 访问专利页面: {PATENT_URL}")
    page.goto(PATENT_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)

    # 3. 点击导出按钮
    logger.info("[步骤2] 等待导出按钮...")
    export_btn = page.locator('.index_export-button__9ok1s button:has-text("导出")')
    export_btn.wait_for(state="visible", timeout=15000)
    export_btn.click()
    logger.info("[步骤2] 已点击导出按钮")

    # 4. 等待下载事件
    logger.info("[步骤3] 等待下载事件...")
    try:
        with page.expect_download(timeout=DOWNLOAD_TIMEOUT) as download_info:
            pass
        download = download_info.value
        suggested = download.suggested_filename
        dest = os.path.join(output_dir, suggested)
        download.save_as(dest)
        logger.info(f"[下载] 文件已保存: {dest}")
        return True, dest
    except PlaywrightTimeout:
        logger.error("[步骤3] 下载超时，未触发下载事件")
        return False, None


def main():
    parser = argparse.ArgumentParser(description='天眼查专利爬虫')
    parser.add_argument('--data-dir', required=True, help='用户数据根目录')
    parser.add_argument('--action', required=True, choices=['check', 'crawl'], help='操作类型')
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    setup_file_logging(data_dir)

    output_dir = data_dir / "temp_data" / "天眼查"
    output_dir.mkdir(parents=True, exist_ok=True)

    USER_DATA_DIR = data_dir / "tianyan_context"
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.action == 'check':
        # 保留 check 用于手动调试，但主流程不再调用
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data_dir=str(USER_DATA_DIR),
                headless=False,
                viewport={"width": 800, "height": 600},
            )
            page = browser.pages[0] if browser.pages else browser.new_page()
            logged_in = check_login(page)
            print(json.dumps({"loggedIn": logged_in}))
            browser.close()
        return

    if args.action == 'crawl':
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

            success, file_path = do_crawl(page, str(output_dir))

            if success:
                result = {
                    "success": True,
                    "crawler": "天眼查",
                    "file": file_path or "",
                    "total": 0,
                    "timestamp": datetime.now().isoformat()
                }
                print(json.dumps(result, ensure_ascii=False))
            else:
                print(json.dumps({"success": False, "error": "导出失败或未登录"}))

            browser.close()


if __name__ == "__main__":
    main()