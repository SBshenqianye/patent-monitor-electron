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
<!-- python -m PyInstaller --onefile --distpath extraResources "patent_crawlers\01_专利过期监控爬虫_v2.py" -->
python -m PyInstaller --onefile --distpath extraResources --add-data "C:\Users\shenq\AppData\Local\ms-playwright\chromium-1223;playwright/browsers/chromium-1223" "patent_crawlers\01_专利过期监控爬虫_v2.py"
# 打包爬虫 B
<!-- python -m PyInstaller --onefile --distpath extraResources "patent_crawlers\02_天眼查专利导出.py" -->
python -m PyInstaller --onefile --distpath extraResources --add-data "C:\Users\shenq\AppData\Local\ms-playwright\chromium-1223;playwright/browsers/chromium-1223" "patent_crawlers\02_天眼查专利导出.py"

# 移除 --add-data 参数(不内置浏览器，减少空间)
python -m PyInstaller --onefile --distpath extraResources patent_crawlers\01_专利过期监控爬虫_v2.py

python -m PyInstaller --onefile --distpath extraResources patent_crawlers\02_天眼查专利导出.py