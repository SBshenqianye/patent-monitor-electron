# 开发模式（直接运行）
cd patent-monitor-electron
npx electron .

# 生产打包
cd patent-monitor-electron
npm run build    # 先确保 patent_crawlers/ 下各 .py 已用 PyInstaller 打成 exe


cd patent-monitor-electron
pip install pyinstaller


cd patent-monitor-electron
# 打包清洗脚本
python -m PyInstaller --onefile --distpath extraResources "patent_crawlers\00_数据清洗融合.py"
# 打包爬虫 A
python -m PyInstaller --onefile --distpath extraResources "patent_crawlers\01_专利过期监控爬虫_v2.py"
# 打包爬虫 B
python -m PyInstaller --onefile --distpath extraResources "patent_crawlers\02_天眼查专利导出.py"
# 打包爬虫 C
python -m PyInstaller --onefile --distpath extraResources "patent_crawlers\03_CNIPA专利导出.py"
