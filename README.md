# 页间 · 小说阅读器

一个可在手机、平板和桌面浏览器使用的轻量小说阅读器。无需安装依赖，直接用现代浏览器打开 `index.html`，或在项目目录运行：

```powershell
python -m http.server 8000
```

然后访问 <http://localhost:8000>。

支持 TXT、Markdown、EPUB 导入，浏览器本地保存书籍和阅读位置；提供章节导航、字号、三种阅读主题，以及 JSON 备份导入导出。EPUB 渲染使用开源 [epub.js](https://github.com/futurepress/epub.js) 和 [JSZip](https://github.com/Stuk/jszip)，运行时从公共 CDN 加载；字体使用 Google Fonts，离线时回退到系统字体。

## 安装为应用

网站通过 HTTPS 访问时，可在 Microsoft Edge 打开后，从浏览器菜单选择“应用”→“将此站点安装为应用”，或使用地址栏中的安装图标。安装后会以独立窗口运行；书架和书籍保存在浏览器本地。离线时会缓存阅读器页面，但 GitHub 同步及通过 CDN 加载的 EPUB 组件需要联网。

## GitHub 同步

建议为阅读器数据创建一个专用私有 GitHub 仓库，并初始化默认分支：

1. 创建私有仓库，例如 `novel-web-data`，初始化 `main` 分支。
2. 创建 Fine-grained personal access token，只选择该仓库，并授予 Repository permissions → Contents → Read and write。
3. 打开阅读器设置，填写 `owner/repository`、分支名和 token，点击“连接并同步”。

同步文件放在仓库的 `sync/` 目录。首次同步会上传本机书架或下载云端书架；后续用 SHA-256 内容哈希核对书籍，只传新增或内容变化的书。阅读进度和书籍信息放在轻量清单中，自动同步延迟约 10 秒以减少仓库提交。删除操作使用清单删除标记传播到其他设备，并从当前分支删除对应书籍文件。

每台设备首次都要填写同一个仓库和 token，之后凭据会保存在该设备浏览器中自动同步。token 保存在当前浏览器的 `localStorage`，可以被此网站运行的脚本读取；不要把它写进源码或提交到仓库。为 token 设置到期时间并限制到专用私有仓库。删除文件会产生新的 Git 提交，旧版本仍留在仓库历史中。本机 IndexedDB 仍是阅读时的数据来源；首次在新设备同步需要下载书籍。JSON 导出/导入仍可用于额外备份。

GitHub API 在不同网络环境下的连接速度可能不同；Contents API 单文件上限为 100 MB，EPUB 编码后的备份超过此大小会上传失败。

## 开源参考

界面与导入、章节导航等常见阅读器交互参考了 GitHub 上的项目搜索结果：

- [wallfacer-web/novel_reader_for-Chinese](https://github.com/wallfacer-web/novel_reader_for-Chinese)
- [MrXnneHang/English-Novel-WebReader](https://github.com/MrXnneHang/English-Novel-WebReader)
- [futurepress/epub.js](https://github.com/futurepress/epub.js)

此项目未复制上述阅读器的实现代码。蓝奏云尚未接入：目前能检索到的是非官方第三方接口，可靠性和浏览器端授权方式都不足以作为默认同步方案。
