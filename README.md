# 页间 · 小说阅读器

一个可在手机、平板和桌面浏览器使用的轻量小说阅读器。无需安装依赖，直接用现代浏览器打开 `index.html`，或在项目目录运行：

```powershell
python -m http.server 8000
```

然后访问 <http://localhost:8000>。

支持 TXT、Markdown、EPUB 导入，浏览器本地保存书籍和阅读位置；提供章节导航、字号、三种阅读主题，以及 JSON 备份导入导出。EPUB 渲染使用开源 [epub.js](https://github.com/futurepress/epub.js) 和 [JSZip](https://github.com/Stuk/jszip)，运行时从公共 CDN 加载；字体使用 Google Fonts，离线时回退到系统字体。

## 安装为应用

网站通过 HTTPS 访问时，可在 Microsoft Edge 打开后，从浏览器菜单选择“应用”→“将此站点安装为应用”，或使用地址栏中的安装图标。安装后会以独立窗口运行；书架和书籍保存在浏览器本地。离线时会缓存阅读器页面，但 Google Drive 同步及通过 CDN 加载的 EPUB 组件需要联网。

## Google Drive

需要自行准备 Google Cloud OAuth 网页客户端 ID：

1. 在 Google Cloud 项目中启用 Google Drive API。
2. 创建 OAuth 2.0 网页应用客户端，将 `http://localhost:8000` 加入已获授权的 JavaScript 来源。
3. 打开阅读器设置，填写客户端 ID 并点“连接并同步”。

阅读器只请求 `drive.appdata` 权限，备份保存在 Google Drive 的应用专属数据区。访问令牌会缓存在当前标签页至过期，刷新页面时复用；首次连接或令牌过期后需手动连接。云端只保留最近 10 天打开过的书籍，过期书籍仍留在本机，重新打开后会再次同步。OAuth 客户端 ID 不是密码，但需要由使用者自行配置。

## 开源参考

界面与导入、章节导航等常见阅读器交互参考了 GitHub 上的项目搜索结果：

- [wallfacer-web/novel_reader_for-Chinese](https://github.com/wallfacer-web/novel_reader_for-Chinese)
- [MrXnneHang/English-Novel-WebReader](https://github.com/MrXnneHang/English-Novel-WebReader)
- [futurepress/epub.js](https://github.com/futurepress/epub.js)

此项目未复制上述阅读器的实现代码。蓝奏云尚未接入：目前能检索到的是非官方第三方接口，可靠性和浏览器端授权方式都不足以作为默认同步方案。
