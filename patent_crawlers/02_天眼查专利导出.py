# 02_天眼查专利导出.py
"""
天眼查专利导出爬虫 (Electron 适配版)
支持命令行参数:
  --data-dir <路径>    用户数据根目录
  --action <check|login|crawl>
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
LOGIN_URL = "https://www.tianyancha.com/login"
# 专利页面URL（公司ID可能变化，此处固定为用户提供的测试ID）
PATENT_URL = "https://www.tianyancha.com/company/2434381675/zhishi"
DOWNLOAD_WAIT = 60  # 等待下载的最长时间（秒）


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
    """检查天眼查登录状态（基于页面右上角用户菜单）"""
    logger.info("[登录检查] 检测页面登录状态...")
    try:
        page.goto(TIANYAN_URL, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)
        # 检查是否存在用户菜单容器 (tyc-nav-user)
        logged_in = page.evaluate("""() => {
            return !!document.querySelector('.tyc-nav-user');
        }""")
        if logged_in:
            logger.info("[登录检查] 已登录（检测到 .tyc-nav-user）")
        else:
            logger.info("[登录检查] 未登录（未找到 .tyc-nav-user）")
        return logged_in
    except Exception as e:
        logger.warning(f"[登录检查] 异常: {e}")
        return False


def do_login(page, user_data_dir):
    """打开登录页，等待用户扫码登录，成功后保存 storage_state"""
    logger.info("[登录] 正在打开登录页面...")
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3000)
    logger.info("[登录] 请在浏览器中扫码或输入账号密码完成登录")

    max_wait = 600  # 最多等待10分钟
    for i in range(max_wait):
        time.sleep(1)
        try:
            if check_login(page):
                logger.info("[登录] 登录成功！正在保存登录状态...")
                context = page.context
                storage_path = os.path.join(user_data_dir, "storage_state.json")
                context.storage_state(path=storage_path)
                logger.info(f"[登录] 登录状态已保存至: {storage_path}")
                return True
        except Exception:
            pass
        if (i + 1) % 30 == 0:
            remaining = (max_wait - i - 1) // 60
            logger.info(f"[登录] 等待中... 剩余约 {remaining} 分钟")
    logger.warning("[登录] 等待超时")
    return False


def handle_download(download, output_dir):
    """下载回调：自动保存文件"""
    suggested = download.suggested_filename
    dest = os.path.join(output_dir, suggested)
    download.save_as(dest)
    logger.info(f"[下载] 文件已保存: {dest}")
    return dest


def do_crawl(page, output_dir):
    """执行专利导出：导航到专利页 → 点击导出按钮 → 等待下载"""
    logger.info("[爬取] 开始天眼查专利导出...")
    try:
        # 步骤1：打开专利页面
        logger.info(f"[步骤1] 访问专利页面: {PATENT_URL}")
        page.goto(PATENT_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(5000)  # 等待页面动态渲染

        # 步骤2：等待导出按钮出现并点击
        logger.info("[步骤2] 等待导出按钮...")
        export_btn = page.locator('.index_export-button__9ok1s button:has-text("导出")')
        export_btn.wait_for(state="visible", timeout=15000)
        logger.info("[步骤2] 导出按钮已可见，准备点击")
        export_btn.click()
        logger.info("[步骤2] 已点击导出按钮")

        # 步骤3：监听下载
        download_completed = False
        downloaded_file = None

        def on_download(download):
            nonlocal download_completed, downloaded_file
            downloaded_file = handle_download(download, output_dir)
            download_completed = True

        page.on("download", on_download)

        # 步骤4：等待下载完成
        logger.info(f"[步骤3] 等待下载完成 (最长 {DOWNLOAD_WAIT} 秒)...")
        wait_until = time.time() + DOWNLOAD_WAIT
        while time.time() < wait_until:
            if download_completed:
                break
            time.sleep(1)

        if download_completed:
            logger.info(f"[完成] 导出成功，文件: {downloaded_file}")
            return True
        else:
            logger.warning("[完成] 等待超时，未检测到下载文件")
            return False

    except PlaywrightTimeout as e:
        logger.error(f"[爬取] 元素等待超时: {e}")
        return False
    except Exception as e:
        logger.error(f"[爬取] 异常: {e}", exc_info=True)
        return False


def main():
    parser = argparse.ArgumentParser(description='天眼查专利爬虫')
    parser.add_argument('--data-dir', required=True, help='用户数据根目录')
    parser.add_argument('--action', required=True, choices=['check', 'login', 'crawl'], help='操作类型')
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    setup_file_logging(data_dir)

    output_dir = data_dir / "temp_data" / "天眼查"
    output_dir.mkdir(parents=True, exist_ok=True)

    USER_DATA_DIR = data_dir / "tianyan_context"
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.action == 'check':
        # 快速检查登录状态（无头）
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data_dir=str(USER_DATA_DIR),
                headless=True,
            )
            page = browser.pages[0] if browser.pages else browser.new_page()
            logged_in = check_login(page)
            print(json.dumps({"loggedIn": logged_in}))
            browser.close()
        return

    if args.action == 'login':
        # 打开可见浏览器引导登录
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data_dir=str(USER_DATA_DIR),
                headless=False,
                no_viewport=True,
                args=['--start-maximized'],
                locale='zh-CN',
            )
            page = browser.pages[0] if browser.pages else browser.new_page()
            success = do_login(page, str(USER_DATA_DIR))
            print(json.dumps({"loggedIn": success}))
            if success:
                logger.info("登录流程结束，可按 Enter 关闭浏览器")
            input("\n按 Enter 键关闭浏览器...")
            browser.close()
        return

    if args.action == 'crawl':
        # 执行爬取（有头模式，避免反爬）
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

            # 先确保已登录
            if not check_login(page):
                logger.error("[爬取] 未登录，请先执行 login 动作")
                print(json.dumps({"success": False, "error": "not_logged_in"}))
                browser.close()
                return

            # 执行导出
            success = do_crawl(page, str(output_dir))

            if success:
                # 查找最新下载的 xlsx 文件
                xlsx_files = list(Path(output_dir).glob('*.xlsx'))
                latest_file = max(xlsx_files, key=os.path.getmtime) if xlsx_files else None
                result = {
                    "success": True,
                    "crawler": "天眼查",
                    "total": 0,   # 数量由清洗脚本统计
                    "file": str(latest_file) if latest_file else "",
                    "timestamp": datetime.now().isoformat()
                }
                print(json.dumps(result, ensure_ascii=False))
            else:
                print(json.dumps({"success": False, "error": "导出失败或超时"}))

            browser.close()


if __name__ == "__main__":
    main()