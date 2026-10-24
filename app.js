const DB_NAME = "yejian-reader";
const DB_VERSION = 1;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const SYNC_FILE = "yejian-library-backup.json";
const CLOUD_BOOK_MAX_AGE = 10 * 24 * 60 * 60 * 1000;
const GOOGLE_TOKEN_KEY = "yejian-google-access-token";

const sampleBook = {
  id: "sample-mist-port",
  title: "雾港来信",
  author: "原创短篇 · 试读",
  format: "text",
  addedAt: 1,
  progress: 0,
  chapters: [
    { title: "第一章　雾起时分", subtitle: "一封寄错地址的信", paragraphs: ["林澄第一次见到那封信，是在一个雾很重的清晨。", "它躺在旧邮局门口的铁皮信箱里，信封被雨水洇开了一角。收信人的名字模糊得只剩一个“周”字，下面的地址却清清楚楚：雾港，北街十七号。", "这条街上没有十七号。至少，林澄在这里住了二十六年，从来没有见过。", "她把信翻过来，寄件人的一栏空着。纸页很轻，贴在指尖上，像一片刚从树上落下来的叶子。", "邮局里挂钟停在六点十二分。窗外，渡船的汽笛穿过雾传过来，比平时慢，也比平时远。", "林澄把信揣进口袋，推开邮局的门。她决定沿着北街走一遍。"] },
    { title: "第二章　北街十七号", subtitle: "地图上没有的门牌", paragraphs: ["北街沿着海岸弯了一个很缓的弧，尽头是废弃的灯塔。清晨的铺面还没有开门，卷帘门上凝着一层细细的水珠。", "从一号数到十五号，接下来是一段被围墙截断的旧路。墙根长着青苔，里侧有一棵歪斜的山茶树。", "林澄在墙前停下时，信封里忽然传来一声轻响，像是有人在里面折了一下纸。", "她看见墙上有一道窄门。门牌钉得很低，上面写着十七。指腹碰到门环的瞬间，远处的渡船正好靠岸。", "门后没有院子，只有一条长长的走廊。走廊尽头亮着灯，灯下站着一个撑红伞的人。", "“你来得比信早。”那人说。林澄这才发现，自己手里的信已经拆开了。"] },
    { title: "第三章　未寄出的信", subtitle: "雾散之后", paragraphs: ["信纸上只有一行字：如果你找到这里，请替我把门打开。", "字迹和林澄的笔迹一模一样，连那个总是写得太轻的“开”字，也一笔不差。", "她抬起头，红伞已经收了起来。门外的雾慢慢退到海面，露出熟悉的旧灯塔和一排潮湿的屋顶。", "邮局的钟重新走动，秒针越过六点十三分。", "林澄把信纸折好，放进口袋。北街十七号的门在身后轻轻合上。她沿着来时的路往回走，第一次觉得这座小城并不只有她知道的那些地方。", "远处汽笛再次响起。天气很好，渡船正等着出发。"] }
  ]
};

const $ = (selector) => document.querySelector(selector);
const dbPromise = openDatabase();
let books = [];
let activeBookId = sampleBook.id;
let activeChapter = 0;
let fontSize = Number(localStorage.getItem("yejian-font-size")) || 18;
let activeTheme = localStorage.getItem("yejian-theme") || "paper";
let epubBook = null;
let epubRendition = null;
let epubChapters = [];
let activeEpubChapter = 0;
let googleTokenClient = null;
let accessToken = null;
let toastTimer;
let textProgressSaveTimer = null;
let syncInProgress = false;
let syncRunId = 0;
let currentSyncAutomatic = false;
let rejectPendingTokenRequest = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore("books", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function allBooks() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction("books").objectStore("books").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveBook(book) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction("books", "readwrite").objectStore("books").put(book);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

async function deleteBook(id) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction("books", "readwrite").objectStore("books").delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

async function replaceBooks(rows) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("books", "readwrite");
    const store = transaction.objectStore("books");
    store.clear();
    rows.forEach((row) => store.put(row));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function activeBook() {
  return books.find((book) => book.id === activeBookId) || books[0] || sampleBook;
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function safeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderShelf() {
  const query = $("#book-search").value.trim().toLocaleLowerCase();
  const visibleBooks = [...books]
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .filter((book) => `${book.title} ${book.author || ""}`.toLocaleLowerCase().includes(query));
  $("#book-count").textContent = visibleBooks.length;
  $("#book-list").innerHTML = visibleBooks.map((book) => `<button class="book-row ${book.id === activeBookId ? "active" : ""}" data-book-id="${safeText(book.id)}"><span class="book-mini-cover">${safeText(book.title.slice(0, 1))}</span><span class="book-row-copy"><span class="book-row-title">${safeText(book.title)}</span><span class="book-row-author">${safeText(book.author || "未知作者")}</span></span></button>`).join("");
  $("#book-list").querySelectorAll("[data-book-id]").forEach((row) => row.addEventListener("click", () => selectBook(row.dataset.bookId)));
}

function renderCollection() {
  const query = $("#collection-search").value.trim().toLocaleLowerCase();
  const visibleBooks = [...books]
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .filter((book) => `${book.title} ${book.author || ""}`.toLocaleLowerCase().includes(query));
  $("#collection-count").textContent = `${visibleBooks.length} 本书`;
  $("#collection-grid").hidden = visibleBooks.length === 0;
  $("#collection-empty").hidden = visibleBooks.length !== 0;
  $("#collection-empty-title").textContent = books.length && query ? "没有找到匹配的书" : "这里还没有书";
  $("#collection-empty-copy").textContent = books.length && query ? "试试其他书名或作者。" : "导入 TXT、Markdown 或 EPUB 开始阅读。";
  $("#collection-grid").innerHTML = visibleBooks.map((book) => {
    const chapterCount = book.chapters?.length || 0;
    const percent = book.format === "text" ? chapterCount ? Math.round(((Number(book.progress) + 1) / chapterCount) * 100) : 0 : Math.round((Number(book.progress) || 0) * 100);
    const format = book.format === "epub" ? "EPUB" : book.title.match(/\.md$/i) ? "MD" : "TXT";
    return `<article class="collection-card"><button class="collection-open" data-book-id="${safeText(book.id)}" aria-label="阅读：${safeText(book.title)}"><span class="collection-cover"><span>${safeText(book.title.slice(0, 1))}</span><small>${format}</small></span><span class="collection-card-copy"><strong>${safeText(book.title)}</strong><span class="collection-author">${safeText(book.author || "未知作者")}</span><span class="collection-progress"><span><i style="width:${Math.min(100, percent)}%"></i></span><small>${percent}%</small></span></span></button><span class="collection-card-actions"><button class="text-button book-edit" data-book-id="${safeText(book.id)}">编辑</button><button class="text-button book-delete" data-book-id="${safeText(book.id)}">删除</button></span></article>`;
  }).join("");
  $("#collection-grid").querySelectorAll(".collection-open").forEach((button) => button.addEventListener("click", () => selectBook(button.dataset.bookId)));
  $("#collection-grid").querySelectorAll(".book-edit").forEach((button) => button.addEventListener("click", () => openBookEditor(button.dataset.bookId)));
  $("#collection-grid").querySelectorAll(".book-delete").forEach((button) => button.addEventListener("click", () => removeBook(button.dataset.bookId).catch((error) => notify(error.message))));
}

function openBookEditor(id) {
  const book = books.find((item) => item.id === id);
  if (!book) return;
  $("#edit-book-id").value = book.id;
  $("#edit-book-title").value = book.title;
  $("#edit-book-author").value = book.author || "";
  $("#replace-book-file").value = "";
  $("#edit-book-dialog").showModal();
}

async function removeBook(id) {
  const book = books.find((item) => item.id === id);
  if (!book || !confirm(`删除《${book.title}》及其书籍文件和阅读进度？此操作无法撤销。`)) return;
  if (id === activeBookId) saveTextProgress(true);
  await deleteBook(id);
  books = books.filter((item) => item.id !== id);
  if (id === activeBookId) {
    epubRendition?.destroy();
    epubRendition = epubBook = null;
    epubChapters = [];
    activeBookId = books[0]?.id || sampleBook.id;
    if (!books.length) {
      await saveBook(sampleBook);
      books = [sampleBook];
    }
    await selectBook(activeBookId);
  }
  renderShelf();
  renderCollection();
  notify("书籍已删除");
}

async function updateBook(event) {
  event.preventDefault();
  const id = $("#edit-book-id").value;
  const book = books.find((item) => item.id === id);
  if (!book) return;
  const title = $("#edit-book-title").value.trim();
  if (!title) { notify("书名不能为空"); return; }
  const file = $("#replace-book-file").files[0];
  let replacement = null;
  if (file) {
    if (/\.epub$/i.test(file.name)) replacement = { format: "epub", data: await file.arrayBuffer() };
    else if (/\.(txt|md|markdown)$/i.test(file.name)) replacement = { format: "text", chapters: splitIntoChapters(await file.text()) };
    else { notify("请选择 TXT、Markdown 或 EPUB 文件"); return; }
    if (!replacement.chapters?.length && replacement.format === "text") { notify("文件中没有可导入的正文"); return; }
  }
  if (id === activeBookId) saveTextProgress(true);
  book.title = title;
  book.author = $("#edit-book-author").value.trim();
  book.updatedAt = Date.now();
  if (replacement) {
    Object.assign(book, replacement, { progress: 0, scrollProgress: 0 });
    delete book.cfi;
  }
  await saveBook(book);
  books = await allBooks();
  $("#edit-book-dialog").close();
  renderShelf();
  renderCollection();
  if (id === activeBookId) await selectBook(id);
  notify(replacement ? "书籍信息和文件已更新" : "书籍信息已更新");
}

function setView(view) {
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const inCollection = view === "library";
  $("#collection-view").hidden = !inCollection;
  $(".reader-stage").hidden = inCollection;
  if (inCollection) renderCollection();
}

function currentChapters(book) {
  return book.format === "text" ? book.chapters : [];
}

function saveTextProgress(immediate = false) {
  const book = activeBook();
  if (book.format !== "text" || $(".reader-stage").hidden) return;
  const scroller = $("#reader-scroll");
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  book.progress = activeChapter;
  book.scrollProgress = maxScroll ? Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)) : 0;
  book.updatedAt = Date.now();
  clearTimeout(textProgressSaveTimer);
  if (immediate) {
    textProgressSaveTimer = null;
    saveBook(book);
    return;
  }
  textProgressSaveTimer = setTimeout(() => {
    textProgressSaveTimer = null;
    saveBook(book);
  }, 250);
}

function renderTextChapter(index, save = true) {
  if (save) saveTextProgress(true);
  const book = activeBook();
  const chapters = currentChapters(book);
  if (!chapters.length) return;
  activeChapter = Math.max(0, Math.min(index, chapters.length - 1));
  const chapter = chapters[activeChapter];
  $("#text-page").hidden = false;
  $("#epub-host").hidden = true;
  $("#chapter-title").textContent = chapter.title;
  $("#chapter-subtitle").textContent = chapter.subtitle || "";
  $("#book-author").textContent = book.author || "未知作者";
  $("#chapter-content").innerHTML = chapter.paragraphs.map((line) => `<p>${safeText(line)}</p>`).join("");
  $("#chapter-reading-time").textContent = `约 ${Math.max(1, Math.ceil(chapter.paragraphs.join("").length / 500))} 分钟`;
  $("#chapter-counter").textContent = `${String(activeChapter + 1).padStart(2, "0")} / ${String(chapters.length).padStart(2, "0")}`;
  $("#chapter-select").innerHTML = chapters.map((item, i) => `<option value="${i}" ${i === activeChapter ? "selected" : ""}>${safeText(item.title)}</option>`).join("");
  $("#prev-chapter").disabled = activeChapter === 0;
  $("#next-chapter").disabled = activeChapter === chapters.length - 1;
  $("#progress-fill").style.width = `${((activeChapter + 1) / chapters.length) * 100}%`;
  $("#progress-percent").textContent = `${Math.round(((activeChapter + 1) / chapters.length) * 100)}%`;
  $("#progress-chapter").textContent = `第 ${activeChapter + 1} 章 · ${chapter.title.replace(/^第.{1,8}章[　 ]*/, "")}`;
  const scroller = $("#reader-scroll");
  scroller.scrollTop = 0;
  const scrollProgress = save ? 0 : Math.min(1, Math.max(0, Number(book.scrollProgress) || 0));
  const targetChapter = activeChapter;
  const restorePosition = () => {
    if (activeBookId !== book.id || activeChapter !== targetChapter) return;
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * scrollProgress;
  };
  requestAnimationFrame(restorePosition);
  document.fonts?.ready?.then(restorePosition);
  $("#crumb-title").textContent = book.title;
  $("#reading-state").textContent = "正在阅读";
  if (save) {
    book.progress = activeChapter;
    book.scrollProgress = 0;
    book.updatedAt = Date.now();
    saveBook(book);
  }
}

function setTheme(theme) {
  activeTheme = theme;
  const stage = document.querySelector(".reader-stage");
  stage.classList.remove("theme-paper", "theme-warm", "theme-night");
  stage.classList.add(`theme-${theme}`);
  document.querySelectorAll(".theme-swatch").forEach((button) => button.classList.toggle("selected", button.dataset.theme === theme));
  document.querySelector("meta[name='theme-color']").content = theme === "night" ? "#222623" : theme === "warm" ? "#f4f0e7" : "#f7f7f4";
  localStorage.setItem("yejian-theme", theme);
  const rendition = epubRendition;
  if (rendition) rendition.themes.default({ body: { color: theme === "night" ? "#dddcd2 !important" : theme === "warm" ? "#453d34 !important" : "#373833 !important", background: theme === "night" ? "#222623 !important" : theme === "warm" ? "#f4f0e7 !important" : "#fbfbf9 !important" } });
}

function setFontSize(size) {
  fontSize = Math.max(14, Math.min(28, size));
  $("#font-size-value").textContent = fontSize;
  $("#chapter-content").style.fontSize = `${fontSize}px`;
  localStorage.setItem("yejian-font-size", String(fontSize));
  if (epubRendition) epubRendition.themes.fontSize(`${fontSize}px`);
}

async function selectBook(id, { sync = true } = {}) {
  saveTextProgress(true);
  activeBookId = id;
  const book = activeBook();
  book.updatedAt = Date.now();
  book.lastOpenedAt = book.updatedAt;
  await saveBook(book);
  renderShelf();
  setView("reader");
  if (book.format === "epub") {
    await showEpub(book);
    if (sync) syncToDrive({ automatic: true });
    return;
  }
  if (epubRendition) epubRendition.destroy();
  epubBook = epubRendition = null;
  epubChapters = [];
  renderTextChapter(Number(book.progress) || 0, false);
  if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
  if (sync) syncToDrive({ automatic: true });
}

function flattenToc(items, result = []) {
  for (const item of items || []) {
    if (item.href) result.push({ href: item.href, label: item.label || item.href });
    flattenToc(item.subitems, result);
  }
  return result;
}

async function showEpub(book) {
  $("#text-page").hidden = true;
  $("#epub-host").hidden = false;
  $("#epub-host").replaceChildren();
  if (epubRendition) epubRendition.destroy();
  epubRendition = null;
  try {
    if (!window.JSZip || !window.ePub) throw new Error("EPUB 阅读组件未加载，请检查网络后刷新页面。");
    await new Promise(requestAnimationFrame);
    epubBook = ePub(book.data);
    await epubBook.ready;
    const [navigation, metadata] = await Promise.all([
      epubBook.loaded.navigation.catch(() => ({ toc: [] })),
      epubBook.loaded.metadata.catch(() => ({}))
    ]);
    if (metadata.creator) book.author = metadata.creator;
    const spineItems = epubBook.spine.spineItems || [];
    const toc = flattenToc(navigation.toc);
    epubChapters = toc.length ? toc : spineItems.map((item, index) => ({ href: item.href, label: `第 ${index + 1} 节` }));
    activeEpubChapter = 0;
    if (!epubChapters.length) throw new Error("这本 EPUB 没有可读取的章节。");

    $("#chapter-select").innerHTML = epubChapters.map((item) => `<option value="${safeText(item.href)}">${safeText(item.label)}</option>`).join("");
    $("#prev-chapter").disabled = true;
    $("#next-chapter").disabled = epubChapters.length < 2;
    epubRendition = epubBook.renderTo("epub-host", { manager: "default", width: "100%", height: "100%", flow: "scrolled-doc" });
    epubRendition.themes.default({ body: { "font-family": "'Noto Serif SC', serif !important", "line-height": "2 !important", padding: "18px !important" } });
    epubRendition.themes.fontSize(`${fontSize}px`);
    const updateLocation = (location) => {
      const href = (location.start.href || "").split("#")[0];
      const spineHref = spineItems[location.start.index]?.href;
      const chapter = epubChapters.find((item) => item.href.split("#")[0] === href) || epubChapters.find((item) => item.href.split("#")[0] === spineHref) || epubChapters[0];
      activeEpubChapter = epubChapters.indexOf(chapter);
      const percent = location.start.percentage || 0;
      book.cfi = location.start.cfi;
      book.progress = percent;
      book.updatedAt = Date.now();
      $("#chapter-title").textContent = chapter.label;
      $("#chapter-select").value = chapter.href;
      $("#chapter-counter").textContent = `${String(activeEpubChapter + 1).padStart(2, "0")} / ${String(epubChapters.length).padStart(2, "0")}`;
      $("#prev-chapter").disabled = activeEpubChapter === 0;
      $("#next-chapter").disabled = activeEpubChapter >= epubChapters.length - 1;
      $("#book-author").textContent = book.author || "未知作者";
      $("#progress-fill").style.width = `${Math.round(percent * 100)}%`;
      $("#progress-percent").textContent = `${Math.round(percent * 100)}%`;
      $("#progress-chapter").textContent = chapter.label;
      saveBook(book);
    };
    epubRendition.on("relocated", updateLocation);
    await epubRendition.display(book.cfi || epubChapters[0].href);
    const current = epubRendition.currentLocation();
    if (current?.start) updateLocation(current);
    $("#crumb-title").textContent = book.title;
    $("#reader-scroll").scrollTop = 0;
    if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
  } catch (error) {
    epubRendition?.destroy();
    epubRendition = epubBook = null;
    epubChapters = [];
    $("#epub-host").hidden = true;
    $("#text-page").hidden = false;
    $("#chapter-title").textContent = "无法打开这本 EPUB";
    $("#chapter-content").textContent = error.message;
    $("#chapter-select").replaceChildren();
    notify(error.message);
  }
}

function splitIntoChapters(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const headings = /^(?:第[零〇一二三四五六七八九十百千万\d]+[章节回卷部篇].*|序章.*|楔子.*|序言.*|Chapter\s+\d+.*)$/i;
  const chapters = [];
  let current = { title: "正文", subtitle: "", paragraphs: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (headings.test(line) && (current.paragraphs.length || current.title !== "正文")) {
      chapters.push(current);
      current = { title: line, subtitle: "", paragraphs: [] };
    } else if (headings.test(line) && current.title === "正文" && !current.paragraphs.length) {
      current.title = line;
    } else {
      current.paragraphs.push(line);
    }
  }
  if (current.paragraphs.length || !chapters.length) chapters.push(current);
  return chapters.filter((chapter) => chapter.paragraphs.length);
}

async function importFiles(fileList) {
  for (const file of fileList) {
    const title = file.name.replace(/\.(txt|md|markdown|epub)$/i, "");
    const id = crypto.randomUUID();
    if (/\.epub$/i.test(file.name)) {
      const data = await file.arrayBuffer();
      const book = { id, title, author: "", format: "epub", data, addedAt: Date.now(), updatedAt: Date.now(), progress: 0 };
      await saveBook(book);
      activeBookId = id;
      continue;
    }
    const content = await file.text();
    const chapters = splitIntoChapters(content);
    await saveBook({ id, title, author: "", format: "text", chapters, addedAt: Date.now(), updatedAt: Date.now(), progress: 0 });
    activeBookId = id;
  }
  books = await allBooks();
  renderShelf();
  await selectBook(activeBookId);
  if (fileList.length) notify(`已导入 ${fileList.length} 本书`);
}

function openSettings() {
  $("#google-client-id").value = localStorage.getItem("yejian-google-client-id") || "";
  $("#settings-dialog").showModal();
}

function downloadBackup() {
  const payload = { version: 1, exportedAt: new Date().toISOString(), books, settings: { fontSize, theme: activeTheme } };
  const blob = new Blob([encodeBackup(payload)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "yejian-reader-backup.json";
  link.click();
  URL.revokeObjectURL(link.href);
  notify("备份已导出");
}

function encodeBackup(payload) {
  return JSON.stringify(payload, (key, value) => {
    if (!(value instanceof ArrayBuffer)) return value;
    const bytes = new Uint8Array(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { __arrayBuffer: true, data: btoa(binary) };
  });
}

function decodeBackup(text) {
  return JSON.parse(text, (key, value) => value && value.__arrayBuffer ? Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0)).buffer : value);
}

async function importBackup(file) {
  const data = decodeBackup(await file.text());
  if (!Array.isArray(data.books) || !data.books.every((book) => book.id && book.title && ["text", "epub"].includes(book.format))) throw new Error("备份文件格式不正确");
  await replaceBooks(data.books);
  books = await allBooks();
  activeBookId = books[0]?.id || sampleBook.id;
  if (data.settings?.fontSize) setFontSize(data.settings.fontSize);
  if (data.settings?.theme) setTheme(data.settings.theme);
  renderShelf();
  if (books.length) await selectBook(activeBookId);
  notify("备份已导入");
}

function loadGoogleIdentity() {
  const interval = setInterval(() => {
    if (!window.google?.accounts?.oauth2) return;
    clearInterval(interval);
    const clientId = localStorage.getItem("yejian-google-client-id");
    if (clientId) syncToDrive({ automatic: true });
  }, 150);
  setTimeout(() => clearInterval(interval), 15000);
}

function moveChapter(offset) {
  if (activeBook().format === "epub") {
    const index = activeEpubChapter + offset;
    if (epubChapters[index]) {
      activeEpubChapter = index;
      epubRendition?.display(epubChapters[index].href);
    }
    return;
  }
  renderTextChapter(activeChapter + offset);
}

function requestGoogleToken(clientId, prompt) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error("Google 授权组件尚未加载，请刷新页面后重试"));
    const timeout = setTimeout(() => {
      rejectPendingTokenRequest = null;
      reject(new Error(prompt === "none" ? "无法静默连接 Google，请点击“连接并同步”重新授权" : "Google 授权超时，请重试"));
    }, prompt === "none" ? 8000 : 120000);
    const finish = (callback) => (value) => {
      clearTimeout(timeout);
      rejectPendingTokenRequest = null;
      callback(value);
    };
    rejectPendingTokenRequest = finish(reject);
    googleTokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: GOOGLE_SCOPE, callback: (response) => {
      if (response.error) {
        finish(reject)(new Error(response.error_description || response.error));
        return;
      }
      const token = { value: response.access_token, expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000 };
      sessionStorage.setItem(GOOGLE_TOKEN_KEY, JSON.stringify(token));
      finish(resolve)(token.value);
    } });
    if (prompt) googleTokenClient.requestAccessToken({ prompt });
    else googleTokenClient.requestAccessToken();
  });
}

function cachedGoogleToken() {
  try {
    const token = JSON.parse(sessionStorage.getItem(GOOGLE_TOKEN_KEY) || "null");
    if (token?.value && token.expiresAt > Date.now() + 30000) return token.value;
  } catch {}
  sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
  return null;
}

function recentForCloud(book, now = Date.now()) {
  const lastOpened = Number(book.lastOpenedAt || book.updatedAt || book.addedAt || 0);
  return lastOpened >= now - CLOUD_BOOK_MAX_AGE;
}

async function driveRequest(path, options = {}) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...options.headers } });
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
    throw new Error(`Google Drive 请求失败 (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

async function syncToDrive({ automatic = false } = {}) {
  if (syncInProgress) {
    if (automatic || !currentSyncAutomatic) return;
    rejectPendingTokenRequest?.(new Error("自动连接已由手动连接接管"));
  }
  const clientId = (automatic ? localStorage.getItem("yejian-google-client-id") || "" : $("#google-client-id").value).trim();
  if (!clientId) {
    if (!automatic) notify("请先填写 OAuth 网页客户端 ID");
    return;
  }
  const savedToken = cachedGoogleToken();
  if (automatic && !savedToken) {
    $("#sync-feedback").textContent = "请点击“连接并同步”完成授权";
    $("#local-status").textContent = "等待 Google 授权";
    return;
  }
  syncInProgress = true;
  currentSyncAutomatic = automatic;
  const runId = ++syncRunId;
  localStorage.setItem("yejian-google-client-id", clientId);
  $("#sync-feedback").textContent = automatic ? "正在自动同步…" : "正在授权…";
  try {
    accessToken = savedToken || await requestGoogleToken(clientId);
    if (runId !== syncRunId) return;
    $("#sync-feedback").textContent = "正在同步书架…";
    const result = await driveRequest("files?spaces=appDataFolder&q=name%3D%27yejian-library-backup.json%27&fields=files(id,name)");
    const fileId = result.files?.[0]?.id;
    if (fileId) {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`无法读取云端备份 (${response.status})`);
      const cloudBackup = decodeBackup(await response.text());
      if (!Array.isArray(cloudBackup.books)) throw new Error("云端备份文件格式不正确");
      const now = Date.now();
      const merged = new Map(cloudBackup.books.filter((book) => recentForCloud(book, now)).map((book) => [book.id, book]));
      for (const local of books.filter((book) => recentForCloud(book, now))) {
        const cloud = merged.get(local.id);
        if (!cloud || (local.updatedAt || local.addedAt || 0) > (cloud.updatedAt || cloud.addedAt || 0)) merged.set(local.id, local);
      }
      const localById = new Map(books.map((book) => [book.id, book]));
      for (const cloud of merged.values()) {
        const local = localById.get(cloud.id);
        if (!local || (cloud.updatedAt || cloud.addedAt || 0) > (local.updatedAt || local.addedAt || 0)) localById.set(cloud.id, cloud);
      }
      books = [...localById.values()];
      await replaceBooks(books);
    }
    const cloudBooks = books.filter((book) => recentForCloud(book));
    const payload = encodeBackup({ version: 1, exportedAt: new Date().toISOString(), books: cloudBooks, settings: { fontSize, theme: activeTheme } });
    const fileMetadata = { name: SYNC_FILE, mimeType: "application/json", ...(!fileId ? { parents: ["appDataFolder"] } : {}) };
    const boundary = `yejian_${crypto.randomUUID()}`;
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fileMetadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`], { type: `multipart/related; boundary=${boundary}` });
    const endpoint = fileId ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart` : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    const response = await fetch(endpoint, { method: fileId ? "PATCH" : "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    if (!response.ok) throw new Error(`备份上传失败 (${response.status})`);
    $("#sync-feedback").textContent = `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    $("#local-status").textContent = "已连接 Google Drive";
    renderShelf();
    $("#settings-dialog").close();
    setView("library");
    renderCollection();
    if (!automatic) notify("书架已同步到 Google Drive");
  } catch (error) {
    if (runId !== syncRunId) return;
    $("#sync-feedback").textContent = error.message;
    if (automatic) {
      $("#local-status").textContent = "自动同步未完成，请在设置中手动连接";
    } else {
      notify(error.message);
    }
  } finally {
    if (runId === syncRunId) {
      syncInProgress = false;
      currentSyncAutomatic = false;
      rejectPendingTokenRequest = null;
    }
  }
}

function bindEvents() {
  window.addEventListener("pagehide", () => saveTextProgress(true));
  $(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    saveTextProgress(true);
    setView("library");
  });
  $("#file-input").addEventListener("change", (event) => importFiles(event.target.files).catch((error) => notify(error.message)).finally(() => { event.target.value = ""; }));
  $("#backup-input").addEventListener("change", (event) => { const file = event.target.files[0]; if (file) importBackup(file).catch((error) => notify(error.message)).finally(() => { event.target.value = ""; }); });
  $("#add-book-side").addEventListener("click", () => $("#file-input").click());
  $("#import-books").addEventListener("click", () => $("#file-input").click());
  $("#export-backup").addEventListener("click", downloadBackup);
  $("#import-backup").addEventListener("click", () => $("#backup-input").click());
  $("#sync-open").addEventListener("click", openSettings);
  $("#google-sync").addEventListener("click", syncToDrive);
  $("#font-down").addEventListener("click", () => setFontSize(fontSize - 1));
  $("#font-up").addEventListener("click", () => setFontSize(fontSize + 1));
  document.querySelectorAll(".theme-swatch").forEach((button) => button.addEventListener("click", () => setTheme(button.dataset.theme)));
  $("#chapter-select").addEventListener("change", (event) => activeBook().format === "epub" ? epubRendition?.display(event.target.value) : renderTextChapter(Number(event.target.value)));
  $("#prev-chapter").addEventListener("click", () => moveChapter(-1));
  $("#next-chapter").addEventListener("click", () => moveChapter(1));
  $("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#reader-scroll").addEventListener("scroll", () => saveTextProgress(), { passive: true });
  $("#book-search").addEventListener("input", renderShelf);
  $("#collection-search").addEventListener("input", renderCollection);
  $("#collection-import").addEventListener("click", () => $("#file-input").click());
  $("#collection-empty-import").addEventListener("click", () => $("#file-input").click());
  $("#edit-book-form").addEventListener("submit", (event) => updateBook(event).catch((error) => notify(error.message)));
  $("#close-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
  $("#cancel-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
  $("#clear-library").addEventListener("click", async () => {
    if (!confirm("清空此设备上的书架和阅读进度？此操作无法撤销。")) return;
    await replaceBooks([sampleBook]);
    books = [sampleBook];
    activeBookId = sampleBook.id;
    renderShelf();
    setView("library");
    renderTextChapter(0, false);
    $("#settings-dialog").close();
    notify("本机书架已清空");
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    saveTextProgress(true);
    setView(button.dataset.view);
    if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
  }));
}

async function init() {
  books = await allBooks();
  if (!books.length) {
    await saveBook(sampleBook);
    books = [sampleBook];
  }
  activeBookId = books.find((book) => book.id === activeBookId)?.id || books[0].id;
  const openedBook = books.find((book) => book.id === activeBookId);
  openedBook.lastOpenedAt = Date.now();
  await saveBook(openedBook);
  renderShelf();
  setTheme(activeTheme);
  setFontSize(fontSize);
  bindEvents();
  setView("library");
  if (activeBook().format === "epub") await showEpub(activeBook());
  else renderTextChapter(Number(activeBook().progress) || 0, false);
  loadGoogleIdentity();
}

init().catch((error) => notify(`阅读器启动失败：${error.message}`));
