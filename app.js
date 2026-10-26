const DB_NAME = "yejian-reader";
const DB_VERSION = 1;
const GITHUB_REPO_KEY = "yejian-github-repo";
const GITHUB_BRANCH_KEY = "yejian-github-branch";
const GITHUB_TOKEN_KEY = "yejian-github-token";
const GITHUB_MANIFEST_PATH = "sync/library-manifest.json";
const DELETED_BOOKS_KEY = "yejian-deleted-books";
const SETTINGS_UPDATED_KEY = "yejian-settings-updated-at";
const ACTIVE_BOOK_KEY = "yejian-active-book-id";

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
let githubToken = null;
let toastTimer;
let textProgressSaveTimer = null;
let syncDebounceTimer = null;
let syncInProgress = false;
let syncPending = false;
let manifestConflictRetries = 0;
let syncRunId = 0;
let lastAutoSyncAttempt = 0;

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
  const visibleBooks = [...books]
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
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
  const deleted = JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
  localStorage.setItem(DELETED_BOOKS_KEY, JSON.stringify([...new Set([...deleted, id])]));
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
  scheduleGitHubSync();
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
  book.metadataUpdatedAt = book.updatedAt;
  if (replacement) {
    Object.assign(book, replacement, { progress: 0, scrollProgress: 0, contentUpdatedAt: book.updatedAt });
    delete book.contentHash;
    delete book.cfi;
  }
  await saveBook(book);
  books = await allBooks();
  $("#edit-book-dialog").close();
  renderShelf();
  renderCollection();
  if (id === activeBookId) await selectBook(id);
  scheduleGitHubSync();
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
  book.progressUpdatedAt = book.updatedAt;
  clearTimeout(textProgressSaveTimer);
  if (immediate) {
    textProgressSaveTimer = null;
    const saved = saveBook(book);
    scheduleGitHubSync();
    return saved;
  }
  textProgressSaveTimer = setTimeout(() => {
    textProgressSaveTimer = null;
    saveBook(book);
    scheduleGitHubSync();
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
  $("#crumb-title").textContent = book.title;
  $("#reading-state").textContent = "正在阅读";
  if (save) {
    book.progress = activeChapter;
    book.scrollProgress = 0;
    book.updatedAt = Date.now();
    book.progressUpdatedAt = book.updatedAt;
    saveBook(book);
  }
}

function setTheme(theme, sync = true) {
  activeTheme = theme;
  const stage = document.querySelector(".reader-stage");
  stage.classList.remove("theme-paper", "theme-warm", "theme-night");
  stage.classList.add(`theme-${theme}`);
  document.querySelectorAll(".theme-swatch").forEach((button) => button.classList.toggle("selected", button.dataset.theme === theme));
  document.querySelector("meta[name='theme-color']").content = theme === "night" ? "#222623" : theme === "warm" ? "#f4f0e7" : "#f7f7f4";
  localStorage.setItem("yejian-theme", theme);
  if (sync) {
    localStorage.setItem(SETTINGS_UPDATED_KEY, String(Date.now()));
    scheduleGitHubSync();
  }
  const rendition = epubRendition;
  if (rendition) rendition.themes.default({ body: { color: theme === "night" ? "#dddcd2 !important" : theme === "warm" ? "#453d34 !important" : "#373833 !important", background: theme === "night" ? "#222623 !important" : theme === "warm" ? "#f4f0e7 !important" : "#fbfbf9 !important" } });
}

function setFontSize(size, sync = true) {
  fontSize = Math.max(14, Math.min(28, size));
  $("#font-size-value").textContent = fontSize;
  $("#chapter-content").style.fontSize = `${fontSize}px`;
  localStorage.setItem("yejian-font-size", String(fontSize));
  if (sync) {
    localStorage.setItem(SETTINGS_UPDATED_KEY, String(Date.now()));
    scheduleGitHubSync();
  }
  if (epubRendition) epubRendition.themes.fontSize(`${fontSize}px`);
}

async function selectBook(id, { sync = true } = {}) {
  saveTextProgress(true);
  activeBookId = id;
  localStorage.setItem(ACTIVE_BOOK_KEY, id);
  const book = activeBook();
  book.updatedAt = Date.now();
  book.lastOpenedAt = book.updatedAt;
  await saveBook(book);
  renderShelf();
  setView("reader");
  if (book.format === "epub") {
    await showEpub(book);
    if (sync) scheduleGitHubSync();
    return;
  }
  if (epubRendition) epubRendition.destroy();
  epubBook = epubRendition = null;
  epubChapters = [];
  renderTextChapter(Number(book.progress) || 0, false);
  if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
  if (sync) scheduleGitHubSync();
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
    if (metadata.creator && metadata.creator !== book.author) {
      book.author = metadata.creator;
      book.metadataUpdatedAt = Date.now();
      saveBook(book);
    }
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
      book.progressUpdatedAt = book.updatedAt;
      scheduleGitHubSync();
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
      const book = { id, title, author: "", format: "epub", data, addedAt: Date.now(), updatedAt: Date.now(), contentUpdatedAt: Date.now(), progress: 0 };
      await saveBook(book);
      activeBookId = id;
      continue;
    }
    const content = await file.text();
    const chapters = splitIntoChapters(content);
    await saveBook({ id, title, author: "", format: "text", chapters, addedAt: Date.now(), updatedAt: Date.now(), contentUpdatedAt: Date.now(), progress: 0 });
    activeBookId = id;
  }
  books = await allBooks();
  renderShelf();
  await selectBook(activeBookId);
  scheduleGitHubSync();
  if (fileList.length) notify(`已导入 ${fileList.length} 本书`);
}

function openSettings() {
  $("#github-repository").value = localStorage.getItem(GITHUB_REPO_KEY) || "";
  $("#github-branch").value = localStorage.getItem(GITHUB_BRANCH_KEY) || "main";
  $("#github-token").value = localStorage.getItem(GITHUB_TOKEN_KEY) || "";
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
  scheduleGitHubSync();
  notify("备份已导入");
}

function resumeGitHubSync() {
  if (document.visibilityState === "hidden") return;
  if (!localStorage.getItem(GITHUB_REPO_KEY) || !localStorage.getItem(GITHUB_TOKEN_KEY)) return;
  if (Date.now() - lastAutoSyncAttempt < 5000) return;
  lastAutoSyncAttempt = Date.now();
  syncToGitHub({ automatic: true });
}

function scheduleGitHubSync(delay = 10000) {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => syncToGitHub({ automatic: true }), delay);
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

function cloudContent(book) {
  return book.format === "epub" ? { format: "epub", data: book.data } : { format: "text", chapters: book.chapters };
}

async function contentHash(content) {
  const bytes = new TextEncoder().encode(encodeBackup(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function bookContentHash(book) {
  if (book.contentHash) return book.contentHash;
  book.contentHash = await contentHash(cloudContent(book));
  book.contentUpdatedAt ||= book.addedAt || book.updatedAt || Date.now();
  await saveBook(book);
  return book.contentHash;
}

function githubRepository() {
  return (localStorage.getItem(GITHUB_REPO_KEY) || "").trim();
}

function githubFileUrl(path, branch) {
  const repository = githubRepository();
  const [owner, name] = repository.split("/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}${query}`;
}

async function githubRequest(path, branch, options = {}) {
  const { raw = false, allowMissing = false, ...requestOptions } = options;
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...requestOptions.headers
  };
  const url = githubFileUrl(path, ["PUT", "DELETE"].includes(requestOptions.method) ? "" : branch);
  const response = await fetch(url, { ...requestOptions, headers });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) {
    if (response.status === 401) localStorage.removeItem(GITHUB_TOKEN_KEY);
    const detail = await response.text();
    const error = new Error((response.status === 409 || response.status === 422) && /sha|conflict|reference|fast.forward/i.test(detail)
      ? "GitHub 仓库刚被另一台设备更新，请重新同步"
      : `GitHub 请求失败 (${response.status})${detail ? `：${detail.slice(0, 180)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function encodeGitHubContent(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decodeGitHubContent(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function readGitHubJson(path, branch) {
  let response = await githubRequest(path, branch, { allowMissing: true });
  if (!response) return null;
  let file = await response.json();
  if (file.encoding !== "base64" || !file.content) {
    response = await githubRequest(path, branch, { raw: true });
    file = { content: await response.text(), sha: file.sha };
    return { value: decodeBackup(file.content), sha: file.sha };
  }
  return { value: decodeBackup(decodeGitHubContent(file.content)), sha: file.sha };
}

async function writeGitHubJson(path, value, branch, sha = null) {
  const response = await githubRequest(path, branch, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Sync novel-web data: ${path.split("/").at(-1)}`, content: encodeGitHubContent(encodeBackup(value)), branch, ...(sha ? { sha } : {}) })
  });
  return response.json();
}

async function deleteGitHubFile(path, branch, sha) {
  const response = await githubRequest(path, branch, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Delete novel-web data: ${path.split("/").at(-1)}`, sha, branch }),
    allowMissing: true
  });
  return response?.json();
}

function bookDescriptor(book, contentHash, fileSha) {
  return {
    id: book.id, title: book.title, author: book.author || "", format: book.format,
    addedAt: book.addedAt || Date.now(), updatedAt: book.updatedAt || Date.now(),
    metadataUpdatedAt: book.metadataUpdatedAt || book.addedAt || book.updatedAt || Date.now(),
    contentUpdatedAt: book.contentUpdatedAt || book.addedAt || book.updatedAt || Date.now(),
    progress: book.progress || 0, scrollProgress: book.scrollProgress || 0, cfi: book.cfi || "",
    progressUpdatedAt: book.progressUpdatedAt || book.updatedAt || book.addedAt || Date.now(),
    lastOpenedAt: book.lastOpenedAt || 0, contentHash, fileSha
  };
}

function mergeDescriptor(local, remote) {
  const metadata = (remote.metadataUpdatedAt || 0) > (local.metadataUpdatedAt || 0) ? remote : local;
  const progress = (remote.progressUpdatedAt || 0) > (local.progressUpdatedAt || 0) ? remote : local;
  return { ...local, title: metadata.title, author: metadata.author, addedAt: Math.min(local.addedAt || Date.now(), remote.addedAt || Date.now()), metadataUpdatedAt: metadata.metadataUpdatedAt, progress: progress.progress, scrollProgress: progress.scrollProgress, cfi: progress.cfi, progressUpdatedAt: progress.progressUpdatedAt, lastOpenedAt: Math.max(local.lastOpenedAt || 0, remote.lastOpenedAt || 0) };
}

async function syncToGitHub({ automatic = false } = {}) {
  if (syncInProgress) { syncPending = syncPending || automatic; return; }
  const repository = (automatic ? localStorage.getItem(GITHUB_REPO_KEY) || "" : $("#github-repository").value).trim();
  const token = (automatic ? localStorage.getItem(GITHUB_TOKEN_KEY) || "" : $("#github-token").value).trim();
  const branch = (automatic ? localStorage.getItem(GITHUB_BRANCH_KEY) || "main" : $("#github-branch").value || "main").trim();
  if (!repository || !token) {
    if (!automatic) notify("请填写 GitHub 仓库和访问令牌");
    return;
  }
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    if (!automatic) notify("仓库格式应为 owner/repository");
    return;
  }
  syncInProgress = true;
  const runId = ++syncRunId;
  localStorage.setItem(GITHUB_REPO_KEY, repository);
  localStorage.setItem(GITHUB_BRANCH_KEY, branch);
  localStorage.setItem(GITHUB_TOKEN_KEY, token);
  githubToken = token;
  $("#sync-feedback").textContent = automatic ? "正在自动同步…" : "正在连接 GitHub…";
  try {
    if (!automatic) await saveTextProgress(true);
    if (runId !== syncRunId) return;
    $("#sync-feedback").textContent = "正在核对书架…";
    const manifestRead = await readGitHubJson(GITHUB_MANIFEST_PATH, branch);
    let cloudManifest = manifestRead?.value || null;
    if (cloudManifest?.settings && (cloudManifest.settingsUpdatedAt || 0) > Number(localStorage.getItem(SETTINGS_UPDATED_KEY) || 0)) {
      setFontSize(Number(cloudManifest.settings.fontSize) || fontSize, false);
      setTheme(cloudManifest.settings.theme || activeTheme, false);
      localStorage.setItem(SETTINGS_UPDATED_KEY, String(cloudManifest.settingsUpdatedAt));
    }
    const localBooks = new Map(books.map((book) => [book.id, book]));
    const remoteBooks = new Map((cloudManifest?.books || []).map((book) => [book.id, book]));
    const tombstones = new Map((cloudManifest?.deleted || []).map((item) => [item.id, item.deletedAt]));
    const localDeleted = JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
    localDeleted.forEach((id) => tombstones.set(id, Math.max(tombstones.get(id) || 0, Date.now())));
    const mergedBooks = new Map();

    for (const [id, local] of localBooks) {
      const deletedAt = tombstones.get(id) || 0;
      if (deletedAt >= (local.updatedAt || local.addedAt || 0)) continue;
      const remote = remoteBooks.get(id);
      const localHash = await bookContentHash(local);
      let chosen = { ...local };
      let fileSha = remote?.fileSha || null;
      const path = `sync/books/${id}.json`;
      if (!remote) {
        const existing = await readGitHubJson(path, branch);
        if (existing && await contentHash(existing.value) === localHash) {
          fileSha = existing.sha;
        } else {
          const saved = await writeGitHubJson(path, cloudContent(local), branch, existing?.sha || null);
          fileSha = saved.content.sha;
        }
      } else if (remote.contentHash !== localHash) {
        const localContentAt = local.contentUpdatedAt || local.addedAt || local.updatedAt || 0;
        if (localContentAt >= (remote.contentUpdatedAt || 0)) {
          const saved = await writeGitHubJson(path, cloudContent(local), branch, remote.fileSha);
          fileSha = saved.content.sha;
        } else {
          const remoteContentRead = await readGitHubJson(path, branch);
          if (!remoteContentRead) throw new Error(`云端缺少《${remote.title}》的书籍文件`);
          if (await contentHash(remoteContentRead.value) !== remote.contentHash) throw new Error(`《${remote.title}》的云端内容校验失败`);
          chosen = { ...local, ...remoteContentRead.value, contentHash: remote.contentHash, contentUpdatedAt: remote.contentUpdatedAt };
          fileSha = remoteContentRead.sha;
        }
      }
      if (remote) chosen = mergeDescriptor(chosen, remote);
      mergedBooks.set(id, { ...chosen, contentHash: chosen.contentHash || localHash, fileSha });
    }

    for (const [id, remote] of remoteBooks) {
      if (mergedBooks.has(id) || (tombstones.get(id) || 0) >= (remote.updatedAt || remote.addedAt || 0)) continue;
      const contentRead = await readGitHubJson(`sync/books/${id}.json`, branch);
      if (!contentRead) throw new Error(`云端缺少《${remote.title}》的书籍文件`);
      if (await contentHash(contentRead.value) !== remote.contentHash) throw new Error(`《${remote.title}》的云端内容校验失败`);
      mergedBooks.set(id, { ...remote, ...contentRead.value, progress: remote.progress || 0, fileSha: contentRead.sha });
    }

    const syncedBooks = [...mergedBooks.values()];
    await replaceBooks(syncedBooks);
    books = syncedBooks;
    for (const [id] of tombstones) {
      const remote = remoteBooks.get(id);
      if (remote?.fileSha) await deleteGitHubFile(`sync/books/${id}.json`, branch, remote.fileSha);
    }
    const manifest = { version: 2, updatedAt: cloudManifest?.updatedAt || 0, settingsUpdatedAt: Number(localStorage.getItem(SETTINGS_UPDATED_KEY) || Date.now()), settings: { fontSize, theme: activeTheme }, books: syncedBooks.map((book) => bookDescriptor(book, book.contentHash, book.fileSha)), deleted: [...tombstones].map(([id, deletedAt]) => ({ id, deletedAt })) };
    const { updatedAt: ignoredUpdatedAt, ...manifestState } = manifest;
    const { updatedAt: ignoredCloudUpdatedAt, ...cloudManifestState } = cloudManifest || {};
    if (!cloudManifest || JSON.stringify(manifestState) !== JSON.stringify(cloudManifestState)) {
      manifest.updatedAt = Date.now();
      await writeGitHubJson(GITHUB_MANIFEST_PATH, manifest, branch, manifestRead?.sha || null);
    }
    localStorage.removeItem(DELETED_BOOKS_KEY);
    manifestConflictRetries = 0;
    $("#sync-feedback").textContent = `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    $("#local-status").textContent = "已连接 GitHub";
    renderShelf();
    if (!automatic) {
      $("#settings-dialog").close();
      setView("library");
      renderCollection();
      notify("书架已同步到 GitHub");
    }
  } catch (error) {
    if (runId !== syncRunId) return;
    const isConflict = error.status === 409 || error.status === 422;
    const willRetry = isConflict && manifestConflictRetries < 5;
    if (willRetry) {
      manifestConflictRetries += 1;
      syncPending = true;
    }
    $("#sync-feedback").textContent = willRetry ? "云端清单刚有更新，正在重新同步…" : isConflict ? "云端清单持续更新，请稍后重试同步" : error.message;
    if (willRetry) {
      $("#local-status").textContent = "正在重新同步到 GitHub";
    } else if (automatic) {
      $("#local-status").textContent = "自动同步未完成，请在设置中手动连接";
    } else {
      notify(isConflict ? "云端清单持续更新，请稍后重试同步" : error.message);
    }
  } finally {
    if (runId === syncRunId) {
      syncInProgress = false;
      if (syncPending) {
        syncPending = false;
        scheduleGitHubSync(manifestConflictRetries ? 1000 : 10000);
      }
    }
  }
}

function bindEvents() {
  const persistReadingState = () => saveTextProgress(true);
  window.addEventListener("pagehide", persistReadingState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistReadingState();
    else resumeGitHubSync();
  });
  window.addEventListener("pageshow", resumeGitHubSync);
  window.addEventListener("online", resumeGitHubSync);
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
  $("#github-sync").addEventListener("click", syncToGitHub);
  $("#font-down").addEventListener("click", () => setFontSize(fontSize - 1));
  $("#font-up").addEventListener("click", () => setFontSize(fontSize + 1));
  document.querySelectorAll(".theme-swatch").forEach((button) => button.addEventListener("click", () => setTheme(button.dataset.theme)));
  $("#chapter-select").addEventListener("change", (event) => activeBook().format === "epub" ? epubRendition?.display(event.target.value) : renderTextChapter(Number(event.target.value)));
  $("#prev-chapter").addEventListener("click", () => moveChapter(-1));
  $("#next-chapter").addEventListener("click", () => moveChapter(1));
  $("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#reader-scroll").addEventListener("scroll", () => saveTextProgress(), { passive: true });
  $("#collection-search").addEventListener("input", renderCollection);
  $("#collection-import").addEventListener("click", () => $("#file-input").click());
  $("#collection-empty-import").addEventListener("click", () => $("#file-input").click());
  $("#edit-book-form").addEventListener("submit", (event) => updateBook(event).catch((error) => notify(error.message)));
  $("#close-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
  $("#cancel-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
  $("#clear-library").addEventListener("click", async () => {
    if (!confirm("清空此设备上的书架和阅读进度？此操作无法撤销。")) return;
    const deleted = JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
    localStorage.setItem(DELETED_BOOKS_KEY, JSON.stringify([...new Set([...deleted, ...books.filter((book) => book.id !== sampleBook.id).map((book) => book.id)])]));
    await replaceBooks([sampleBook]);
    books = [sampleBook];
    activeBookId = sampleBook.id;
    renderShelf();
    setView("library");
    renderTextChapter(0, false);
    scheduleGitHubSync();
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
  localStorage.removeItem("yejian-onedrive-client-id");
  localStorage.removeItem("yejian-google-client-id");
  localStorage.removeItem("yejian-google-access-token");
  sessionStorage.removeItem("yejian-google-access-token");
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service Worker 注册失败：", error));
  }
  books = await allBooks();
  if (!books.length) {
    await saveBook(sampleBook);
    books = [sampleBook];
  }
  const savedBookId = localStorage.getItem(ACTIVE_BOOK_KEY);
  activeBookId = books.find((book) => book.id === savedBookId)?.id || books[0].id;
  localStorage.setItem(ACTIVE_BOOK_KEY, activeBookId);
  const openedBook = books.find((book) => book.id === activeBookId);
  openedBook.lastOpenedAt = Date.now();
  await saveBook(openedBook);
  renderShelf();
  setTheme(activeTheme, false);
  setFontSize(fontSize, false);
  bindEvents();
  setView("library");
  if (activeBook().format === "epub") await showEpub(activeBook());
  else renderTextChapter(Number(activeBook().progress) || 0, false);
  const repository = localStorage.getItem(GITHUB_REPO_KEY);
  const token = localStorage.getItem(GITHUB_TOKEN_KEY);
  if (repository && token) {
    githubToken = token;
    resumeGitHubSync();
  }
}

init().catch((error) => notify(`阅读器启动失败：${error.message}`));
