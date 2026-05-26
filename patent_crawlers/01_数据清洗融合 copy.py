# -*- coding: utf-8 -*-
"""
专利数据清洗融合 v4.0 (Electron版)
从临时目录读取爬虫输出的JSON文件，融合后输出 cleaned_data.json
"""

import os, re, json, sys, argparse, glob
from datetime import datetime, date
from collections import Counter


def safe_str(v):
    if v is None:
        return ''
    if isinstance(v, (int, float)):
        return str(v)
    return str(v).strip()


# ========== 解析地址（从CSV样式的地址字段提取）==========
def parse_address(raw_addr):
    """解析地址字段，提取分类号、代理人、摘要等"""
    result = {"addr_clean": "", "classification": "", "patentAgency": "", "patentAgent": "", "abstract": "", "zipcode": ""}
    if not raw_addr or raw_addr.strip() in ['', '""']:
        return result

    text = re.sub(r'\s+', ' ', raw_addr).strip().strip('"\'')

    # 提取摘要
    m = re.search(r'摘要[：:]\s*(.+?)(?:全部|发明专利申请|实用新型专利|外观设计|事务数据|$)', text, re.DOTALL)
    if m:
        result['abstract'] = re.sub(r'\s+', ' ', m.group(1)).replace('全部', '').strip()

    # 提取分类号
    m = re.search(r'分类号[：:]\s*(.+?)(?:摘要|全部|发明专利申请|实用新型专利|外观设计|$)', text, re.DOTALL)
    if m:
        cls_text = m.group(1)
        codes = re.findall(r'[A-Z]\d+[A-Z]\d+/\d+[\d\w\.;]*', cls_text)
        cls_clean = '; '.join(c.strip('();，,; ') for c in codes)
        if cls_clean:
            result['classification'] = cls_clean

    # 专利代理机构
    m = re.search(r'专利代理机构[：:]\s*(.+?)(?:专利代理师|代理人|$)', text, re.DOTALL)
    if m:
        result['patentAgency'] = re.sub(r'\s+', ' ', m.group(1)).strip()

    # 专利代理师/代理人
    m = re.search(r'(?:专利代理师|代理人)[：:]\s*(.+?)(?:分类号|摘要|发明专利申请|$)', text, re.DOTALL)
    if m:
        result['patentAgent'] = re.sub(r'\s+', ' ', m.group(1)).strip()

    # 地址：从开头到第一个关键词
    addr = text
    for kw in ["分类号", "摘要", "发明专利申请", "实用新型专利", "专利代理机构", "事务数据"]:
        i = addr.find(kw)
        if i > 0:
            addr = addr[:i].strip()
    addr = addr.replace('全部', '').strip(';，, ')

    zipcode = ""
    m = re.match(r'(\d{6})', addr)
    if m:
        zipcode = m.group(1)
        addr = addr[len(zipcode):].strip()

    result['addr_clean'] = addr
    result['zipcode'] = zipcode
    return result


# ========== 计算到期日 ==========
def compute_expiry(apply_date_str, patent_type):
    """计算到期日和剩余天数"""
    if not apply_date_str:
        return "", -1
    for fmt in ["%Y-%m-%d", "%Y.%m.%d", "%Y年%m月%d日", "%Y/%m/%d"]:
        try:
            apply_date = datetime.strptime(apply_date_str[:10], fmt).date()
            break
        except ValueError:
            continue
    else:
        return "", -1

    years = 10
    if '发明' in patent_type:
        years = 20
    elif '外观' in patent_type:
        years = 15
    try:
        from calendar import monthrange
        expiry_date = date(apply_date.year + years, apply_date.month, apply_date.day)
    except ValueError:
        last_day = monthrange(apply_date.year + years, apply_date.month)[1]
        expiry_date = date(apply_date.year + years, apply_date.month, min(apply_date.day, last_day))

    days = (expiry_date - date.today()).days
    return expiry_date.strftime("%Y-%m-%d"), days


# ========== 标准化日期 ==========
def standardize_date(d_str):
    """统一日期格式为 YYYY-MM-DD"""
    if not d_str or str(d_str).strip() in ['', '-']:
        return ''
    d_str = str(d_str).strip()
    if re.match(r'^\d{4}-\d{2}-\d{2}$', d_str):
        return d_str
    d_str = d_str.replace('年', '-').replace('月', '-').replace('日', '').replace('/', '-').replace('.', '-')
    m = re.match(r'(\d{4})[^\d]*(\d{1,2})[^\d]*(\d{1,2})', d_str)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return d_str[:10]


# ========== 清洗（脚本A的核心逻辑）==========
def clean(records):
    cleaned = []
    for rec in records:
        item = {}

        item['applyId'] = rec.get('applyId', '')
        item['title'] = re.sub(r'\s+', ' ', rec.get('title', '')).strip()
        item['applyDate'] = standardize_date(rec.get('applyDate', ''))
        item['pubDate'] = standardize_date(rec.get('pubDate', ''))
        item['applicant'] = re.sub(r'\s+', ' ', rec.get('applicant', '')).strip()
        item['company'] = rec.get('company', '')

        # 发明人清洗
        inv = rec.get('inventor', '')
        inv = re.sub(r'\s+', ' ', inv).replace('全部', '').strip('; ')
        item['inventor'] = re.sub(r'[;；]+', ';', inv)

        # 地址清洗
        addr = (rec.get('address') or rec.get('addr_clean') or '').strip()
        addr = re.sub(r'\s+', '', addr).replace('全部', '').strip(';，, ')
        zipcode = rec.get('zipcode', '')
        if not zipcode:
            m = re.match(r'(\d{6})', addr)
            if m:
                zipcode = m.group(1)
                addr = addr[6:].strip()
        item['address'] = addr
        item['zipcode'] = zipcode

        # IPC分类清洗
        cls = rec.get('classification', '')
        cls = cls.replace('全部', '').replace(' ', '')
        cls = re.sub(r'[;；]+', ';', cls).strip('; ')
        cls = re.sub(r'\([\d.]+\)', '', cls)
        item['classification'] = cls

        # 专利类型归类
        pt = (rec.get('patentType') or rec.get('patentTypeRaw') or '').strip()
        pt = re.sub(r'\s+', '', pt)
        tp = '发明'
        if '实用' in pt:
            tp = '实用新型'
        elif '外观' in pt:
            tp = '外观设计'
        item['patentType'] = tp

        # 法律状态
        ls = rec.get('legalStatus', '')
        if not ls:
            ls = '未知'
        item['legalStatus'] = ls

        # 过期天数 - 优先使用已有的，否则根据申请日+类型推算
        expiryDate = str(rec.get('expiryDate', '') or '')[:10]
        daysRemaining = rec.get('daysRemaining', -1)
        if not expiryDate or daysRemaining == -1:
            expiryDate, daysRemaining = compute_expiry(item['applyDate'], tp)
        item['expiryDate'] = expiryDate
        item['daysRemaining'] = int(daysRemaining) if daysRemaining != '' else -1

        # 申请年份
        if item['applyDate'] and len(item['applyDate']) >= 4:
            item['applyYear'] = int(item['applyDate'][:4])
        else:
            item['applyYear'] = 0

        item['patentAgency'] = rec.get('patentAgency', '')
        item['patentAgent'] = rec.get('patentAgent', '')
        item['abstract'] = rec.get('abstract', '')
        item['source'] = rec.get('source', '')

        cleaned.append(item)
    return cleaned


# ========== 读取JSON文件（支持单个或多个文件）==========
def read_json_files(file_paths):
    records = []
    for fpath in file_paths:
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                records.extend(data)
            elif isinstance(data, dict):
                if 'rows' in data:
                    records.extend(data['rows'])
                elif 'records' in data:
                    records.extend(data['records'])
                elif 'data' in data:
                    records.extend(data['data'])
                else:
                    records.append(data)
            print(f"  读取JSON: {os.path.basename(fpath)} → {len(data) if isinstance(data, list) else 1} 条")
        except Exception as e:
            print(f"  ⚠ JSON读取失败 {os.path.basename(fpath)}: {e}")
    return records


# ========== 保存JSON ==========
def save_json(records, output_path):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    print(f"[OK] JSON: {output_path} ({len(records)}条)")


# ========== 去重（按applyId + source去重）==========
def remove_duplicates(records):
    seen = set()
    unique = []
    for rec in records:
        key = (rec.get('applyId', ''), rec.get('source', ''))
        if key not in seen:
            seen.add(key)
            unique.append(rec)
    return unique


# ========== 输出CSV ==========
def save_csv(records, path):
    import csv
    fields = ['applyId', 'title', 'patentType', 'classification',
              'applicant', 'inventor', 'applyDate', 'pubDate',
              'expiryDate', 'daysRemaining', 'legalStatus',
              'patentAgency', 'patentAgent', 'address', 'zipcode', 'company', 'abstract', 'source',
              'applyYear']
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for rec in records:
            row = {k: rec.get(k, '') for k in fields}
            writer.writerow(row)
    print(f"[OK] CSV: {path} ({len(records)}条)")


# ========== 统计 ==========
def stats(records):
    n = len(records)
    expired = sum(1 for r in records if r.get('daysRemaining', -1) <= 0)
    urgent = sum(1 for r in records if 0 < r.get('daysRemaining', 0) <= 365)
    warning = sum(1 for r in records if 365 < r.get('daysRemaining', 0) <= 1095)
    safe = sum(1 for r in records if r.get('daysRemaining', 0) > 1095)
    unknown = sum(1 for r in records if r.get('daysRemaining') is None)

    print(f"\n📊 统计:")
    print(f"  总计: {n} 条")
    print(f"  已过期: {expired} 条")
    print(f"  1年内到期: {urgent} 条")
    print(f"  1-3年到期: {warning} 条")
    print(f"  3年以上: {safe} 条")
    if unknown:
        print(f"  未知: {unknown} 条")

    type_counts = Counter(r.get('patentType', '未知') for r in records)
    print(f"\n📌 专利类型分布:")
    for t, c in type_counts.most_common():
        print(f"  {t}: {c} 条")

    source_counts = Counter(r.get('source', '未知') for r in records)
    print(f"\n📡 数据来源分布:")
    for s, c in source_counts.most_common():
        print(f"  {s}: {c} 条")

    if n > 0:
        print(f"\n📈 有效专利占比: {((safe + warning) / n * 100):.1f}%")


# ========== 融合 ==========
def merge(all_records):
    """多来源融合拼接，保留所有字段"""
    merged = []
    for rec in all_records:
        item = dict(rec)
        # 标准化source
        src = item.get('source', '')
        if not src:
            item['source'] = '未知'
        merged.append(item)
    return merged


# ========== Main ==========
def main():
    parser = argparse.ArgumentParser(description='专利数据清洗融合')
    parser.add_argument('--data-dir', required=True, help='用户数据目录（包含爬虫输出JSON文件）')
    args = parser.parse_args()

    data_dir = args.data_dir
    print(f"{'=' * 70}")
    print(f"专利数据清洗融合 v4.0 (Electron版)")
    print(f"数据目录: {data_dir}")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'=' * 70}")

    # 读取所有JSON文件
    json_files = sorted(glob.glob(os.path.join(data_dir, "*.json")))
    if not json_files:
        print("  ⚠ 未找到JSON文件")
        result = {"success": False, "error": "未找到JSON文件"}
        print(f"\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")
        return

    all_records = read_json_files(json_files)
    print(f"  原始总数: {len(all_records)} 条")

    # 去重
    all_records = remove_duplicates(all_records)
    print(f"  去重后: {len(all_records)} 条")

    # 融合
    merged = merge(all_records)

    # 清洗
    print(f"\n[标准化清洗]...")
    cleaned = clean(merged)
    print(f"  清洗后: {len(cleaned)} 条")

    # 输出
    output_json = os.path.join(data_dir, "cleaned_data.json")
    save_json(cleaned, output_json)

    # 输出全部字段版本
    output_all_json = os.path.join(data_dir, "cleaned_data_all.json")
    save_json(cleaned, output_all_json)

    output_csv = os.path.join(data_dir, "cleaned_data.csv")
    save_csv(cleaned, output_csv)

    # 统计
    stats(cleaned)

    # 返回结果（stdout JSON供Electron读取）
    result = {
        "success": True,
        "total_raw": len(all_records),
        "total_cleaned": len(cleaned),
        "output_file": output_json,
        "timestamp": datetime.now().isoformat(),
        "patent_types": dict(Counter(r['patentType'] for r in cleaned)),
        "days_distribution": {
            'expired': sum(1 for r in cleaned if r.get('daysRemaining', -1) <= 0),
            'urgent': sum(1 for r in cleaned if 0 < r.get('daysRemaining', 0) <= 365),
            'warning': sum(1 for r in cleaned if 365 < r.get('daysRemaining', 0) <= 1095),
            'safe': sum(1 for r in cleaned if r.get('daysRemaining', 0) > 1095),
        }
    }
    print(f"\n[RESULT]{json.dumps(result, ensure_ascii=False)}[/RESULT]")

    print(f"\n{'=' * 70}")
    print(f"数据清洗完成！")
    print(f"{'=' * 70}")

    return cleaned


if __name__ == "__main__":
    main()