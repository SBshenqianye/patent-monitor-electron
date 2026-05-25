# -*- coding: utf-8 -*-
"""
中国专利公布公告 - 过期监控爬虫 (Electron 适配版)
支持命令行参数:
  --data-dir <路径>    输出数据目录
  --action <动作>      check | crawl
"""

import os, sys, re, csv, json, logging, argparse
from datetime import datetime, timedelta
from pathlib import Path
import urllib.request
import urllib.parse
import urllib.error
from bs4 import BeautifulSoup
import ssl

# 抑制 SSL 警告
ssl._create_default_https_context = ssl._create_unverified_context

sys.stdout.reconfigure(encoding='utf-8')

# ========== 常量 ==========
# 搜索参数
SEARCH_URL = "https://epub.sipo.gov.cn/advancedSearch"
# 公告日期范围（天）
DAYS_BACK = 7

# 监控关键词（申请人）
MONITOR_KEYWORDS = [
    "浙江金固", "金固股份", "金固",
    "富通", "富通集团",
    "吉利", "吉利汽车",
    "万向", "万向集团",
    "亚太机电", "亚太股份",
]

def setup_logger(log_dir):
    """设置日志"""
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"patent_monitor_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    
    logger = logging.getLogger('patent_monitor')
    logger.setLevel(logging.INFO)
    
    fh = logging.FileHandler(log_file, encoding='utf-8')
    fh.setLevel(logging.INFO)
    
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    fh.setFormatter(formatter)
    ch.setFormatter(formatter)
    
    logger.handlers.clear()
    logger.addHandler(fh)
    logger.addHandler(ch)
    
    return logger, log_file


def search_patents(query_params, logger):
    """执行高级搜索"""
    all_patents = []
    page = 1
    max_retries = 3
    
    for keyword in MONITOR_KEYWORDS:
        logger.info(f"正在搜索关键词: {keyword}")
        
        params = query_params.copy()
        params['keyword'] = keyword
        
        retry_count = 0
        while retry_count < max_retries:
            try:
                url = f"{SEARCH_URL}?{urllib.parse.urlencode(params)}&page={page}"
                req = urllib.request.Request(url)
                req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
                
                response = urllib.request.urlopen(req, timeout=30)
                html = response.read().decode('utf-8', errors='ignore')
                
                patents = parse_patent_list(html, keyword, logger)
                all_patents.extend(patents)
                logger.info(f"  找到 {len(patents)} 条专利")
                break
                
            except Exception as e:
                retry_count += 1
                logger.warning(f"  搜索失败 (尝试 {retry_count}/{max_retries}): {e}")
                if retry_count >= max_retries:
                    logger.error(f"  搜索关键词 '{keyword}' 最终失败")
    
    return all_patents


def parse_patent_list(html, keyword, logger):
    """解析专利列表HTML"""
    patents = []
    soup = BeautifulSoup(html, 'html.parser')
    
    # 查找专利条目 - 根据实际页面结构调整选择器
    items = soup.select('.patent-item, .list-item, table tr')
    
    if not items:
        logger.warning(f"  未找到专利条目，尝试其他选择器")
        items = soup.find_all(['tr', 'div'], class_=True)
    
    for item in items:
        try:
            title_elem = item.select_one('.title a, .patent-title a, a[href*="detail"]')
            if not title_elem:
                continue
            
            title = title_elem.get_text(strip=True)
            link = title_elem.get('href', '')
            if link and not link.startswith('http'):
                link = 'https://epub.sipo.gov.cn' + link
            
            # 提取其他字段
            cells = item.select('td, .field, .value')
            apply_id = ''
            apply_date = ''
            pub_date = ''
            inventor = ''
            applicant = ''
            address = ''
            
            for cell in cells:
                text = cell.get_text(strip=True)
                if '申请号' in text or '申请（专利）号' in text:
                    apply_id = text.split('：')[-1].split(':')[-1].strip() if '：' in text or ':' in text else text
                elif '申请日' in text:
                    apply_date = text.split('：')[-1].split(':')[-1].strip() if '：' in text or ':' in text else text
                elif '公开（公告）日' in text or '公开日' in text:
                    pub_date = text.split('：')[-1].split(':')[-1].strip() if '：' in text or ':' in text else text
                elif '发明人' in text:
                    inventor = text.split('：')[-1].split(':')[-1].strip() if '：' in text or ':' in text else text
                elif '申请人' in text or '专利权人' in text:
                    applicant = text.split('：')[-1].split(':')[-1].strip() if '：' in text or ':' in text else text
                elif '地址' in text:
                    address = text.split('：')[-1].split(':')[-1].strip() if '：' in text or ':' in text else text
            
            patent = {
                "标题": title,
                "申请号": apply_id,
                "申请日": apply_date,
                "公开（公告）日": pub_date,
                "发明人": inventor,
                "申请人": applicant or keyword,
                "地址": address,
                "链接": link,
                "关键词": keyword
            }
            patents.append(patent)
            
        except Exception as e:
            logger.debug(f"  解析条目失败: {e}")
            continue
    
    return patents


def save_results(all_patents, output_dir, logger):
    """保存结果到CSV和JSON"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    csv_path = output_dir / f"专利数据_v2_{timestamp}.csv"
    json_path = output_dir / f"专利数据_v2_{timestamp}.json"
    
    # 保存 CSV
    fieldnames = ["标题", "申请号", "申请日", "公开（公告）日", "发明人", "申请人", "地址", "链接", "关键词"]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_patents)
    logger.info(f"CSV已保存: {csv_path}")
    
    # 保存 JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"source": "中国专利公布公告", "patents": all_patents, "count": len(all_patents), "timestamp": timestamp}, f, ensure_ascii=False, indent=2)
    logger.info(f"JSON已保存: {json_path}")
    
    return csv_path, json_path


def check_login(data_dir, logger):
    """检查登录状态 - 此网站无需登录，始终返回True"""
    logger.info("中国专利公布公告：无需登录")
    return True


def do_crawl(data_dir, logger):
    """执行爬取"""
    logger.info("=" * 60)
    logger.info("开始爬取中国专利公布公告数据")
    logger.info(f"数据目录: {data_dir}")
    logger.info(f"监控关键词: {MONITOR_KEYWORDS}")
    logger.info("=" * 60)
    
    query_params = {
        'daysBack': str(DAYS_BACK),
        'type': 'patent',
    }
    
    all_patents = search_patents(query_params, logger)
    
    logger.info(f"\n总计找到 {len(all_patents)} 条专利")
    
    if all_patents:
        csv_path, json_path = save_results(all_patents, data_dir, logger)
        # 保存输出文件路径 info 供外部读取
        result_info = {
            "success": True,
            "crawler": "中国专利公布公告",
            "total": len(all_patents),
            "csv": str(csv_path),
            "json": str(json_path),
            "timestamp": datetime.now().isoformat()
        }
        result_path = Path(data_dir) / "crawl_result_patentA.json"
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result_info, f, ensure_ascii=False, indent=2)
        logger.info(f"结果摘要已保存: {result_path}")
    else:
        logger.warning("未找到任何专利数据")
        result_info = {"success": False, "crawler": "中国专利公布公告", "total": 0, "timestamp": datetime.now().isoformat()}
        result_path = Path(data_dir) / "crawl_result_patentA.json"
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result_info, f, ensure_ascii=False, indent=2)
    
    return result_info


def main():
    parser = argparse.ArgumentParser(description='中国专利公布公告 - 过期监控爬虫')
    parser.add_argument('--data-dir', required=True, help='数据输出目录')
    parser.add_argument('--action', required=True, choices=['check', 'crawl'], help='操作类型')
    parser.add_argument('--log-dir', help='日志目录（可选，默认使用 data-dir/logs）')
    
    args = parser.parse_args()
    
    data_dir = args.data_dir
    log_dir = args.log_dir or os.path.join(data_dir, 'logs')
    
    logger, log_file = setup_logger(log_dir)
    logger.info(f"启动爬虫 A - 中国专利公布公告")
    logger.info(f"动作: {args.action}")
    logger.info(f"数据目录: {data_dir}")
    
    if args.action == 'check':
        result = check_login(data_dir, logger)
        print(json.dumps({"loggedIn": result, "message": "无需登录"}))
        return
    
    elif args.action == 'crawl':
        result = do_crawl(data_dir, logger)
        print(json.dumps(result))
        return


if __name__ == "__main__":
    main()