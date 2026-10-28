const DB_NAME = "yejian-reader";
const DB_VERSION = 1;
const GITHUB_REPO_KEY = "yejian-github-repo";
const GITHUB_BRANCH_KEY = "yejian-github-branch";
const GITHUB_TOKEN_KEY = "yejian-github-token";
const GITHUB_MANIFEST_PATH = "sync/library-manifest.json";
const GITHUB_BOOKS_BRANCH = "sync-books";
const READER_BRANCHES = { "reader-a": "sync-reader-a", "reader-b": "sync-reader-b" };
const DEMO_BOOK_ID = "sample-mist-port";
const DELETED_BOOKS_KEY = "yejian-deleted-books";
const SETTINGS_UPDATED_KEY = "yejian-settings-updated-at";
const ACTIVE_BOOK_KEY = "yejian-active-book-id";
const READERS_KEY = "yejian-readers-v1";
const ACTIVE_READER_KEY = "yejian-active-reader";
const CLOUD_CATALOG_KEY = "yejian-cloud-catalog-v1";
const SYNC_LOCK_KEY = "yejian-github-sync-lock";
const SYNC_LOCK_TTL = 30000;
const READER_DEFAULTS = [{ id: "reader-a", name: "纨絔" }, { id: "reader-b", name: "澪" }];
const READING_FIELDS = ["progress", "scrollProgress", "cfi", "progressUpdatedAt", "lastOpenedAt"];

const $ = (selector) => document.querySelector(selector);
const dbPromise = openDatabase();
let books = [];
let cloudCatalog = { version: 3, updatedAt: 0, books: [], deleted: [] };
let activeBookId = "";
let activeChapter = 0;
let readers = {};
let activeReaderId = READER_DEFAULTS.some((reader) => reader.id === localStorage.getItem(ACTIVE_READER_KEY)) ? localStorage.getItem(ACTIVE_READER_KEY) : "reader-a";
let fontSize = 18;
let activeTheme = "paper";
let readingSession = 0;
let restoringTextPosition = false;
let switchingReader = false;
let libraryRevision = 0;
let epubBook = null;
let epubBookId = null;
let epubBookContentVersion = null;
let epubRendition = null;
let epubChapters = [];
let activeEpubChapter = 0;
const chapterGestureState = { wheelAt: -Infinity, wheelChapter: "", wheelAtBottom: false, wheelUsed: false, touchReadyChapter: "", touchScrollChapter: "", changing: false };
let githubToken = null;
let toastTimer;
let syncInProgress = false;
let syncPending = false;
let manifestConflictRetries = 0;
let syncRunId = 0;
let syncLockTimer = null;
let lastSyncSucceeded = null;
const syncOwner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function acquireSyncLock() {
  const now = Date.now();
  try {
    const current = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || "null");
    if (current?.owner !== syncOwner && current?.updatedAt && now - current.updatedAt < SYNC_LOCK_TTL) return false;
    localStorage.setItem(SYNC_LOCK_KEY, JSON.stringify({ owner: syncOwner, updatedAt: now }));
    return true;
  } catch {
    return true;
  }
}

function refreshSyncLock() {
  try {
    const current = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || "null");
    if (current?.owner === syncOwner) localStorage.setItem(SYNC_LOCK_KEY, JSON.stringify({ owner: syncOwner, updatedAt: Date.now() }));
  } catch {
    // A failed heartbeat must not interrupt an active sync.
  }
}

function releaseSyncLock() {
  clearInterval(syncLockTimer);
  syncLockTimer = null;
  try {
    const current = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || "null");
    if (current?.owner === syncOwner) localStorage.removeItem(SYNC_LOCK_KEY);
  } catch {
    // The TTL will release a lock if localStorage is unavailable.
  }
}

function emptyReader({ id, name }) {
  return { id, name, nameUpdatedAt: 0, settings: { fontSize: 18, theme: "paper" }, settingsUpdatedAt: 0, activeBookId: "", activeBookUpdatedAt: 0, books: {} };
}

function saveReaders() {
  localStorage.setItem(READERS_KEY, JSON.stringify(readers));
}

function saveCloudCatalog() {
  localStorage.setItem(CLOUD_CATALOG_KEY, JSON.stringify(cloudCatalog));
}

function loadCloudCatalog() {
  try {
    const stored = JSON.parse(localStorage.getItem(CLOUD_CATALOG_KEY) || "null");
    if (stored && Array.isArray(stored.books) && Array.isArray(stored.deleted)) cloudCatalog = { ...cloudCatalog, ...stored };
  } catch {
    localStorage.removeItem(CLOUD_CATALOG_KEY);
  }
}

function cloudDescriptor(id) {
  return cloudCatalog.books.find((book) => book.id === id) || null;
}

function isLocalBook(id) {
  return books.some((book) => book.id === id);
}

function mergeReader(local, remote) {
  if (!remote) return local;
  const name = (remote.nameUpdatedAt || 0) > (local.nameUpdatedAt || 0) ? remote : local;
  const settings = (remote.settingsUpdatedAt || 0) > (local.settingsUpdatedAt || 0) ? remote : local;
  const active = (remote.activeBookUpdatedAt || 0) > (local.activeBookUpdatedAt || 0) ? remote : local;
  const states = {};
  for (const id of [...new Set([...Object.keys(local.books || {}), ...Object.keys(remote.books || {})])].sort()) {
    const a = local.books?.[id];
    const b = remote.books?.[id];
    const aVersion = a?.contentUpdatedAt || 0;
    const bVersion = b?.contentUpdatedAt || 0;
    const chosen = !a || (b && (bVersion > aVersion || (bVersion === aVersion && (b.progressUpdatedAt || 0) > (a.progressUpdatedAt || 0)))) ? b : a;
    states[id] = { ...chosen, lastOpenedAt: aVersion === bVersion ? Math.max(a?.lastOpenedAt || 0, b?.lastOpenedAt || 0) : chosen.lastOpenedAt || 0 };
  }
  return { id: local.id, name: name.name, nameUpdatedAt: name.nameUpdatedAt || 0, settings: settings.settings, settingsUpdatedAt: settings.settingsUpdatedAt || 0, activeBookId: active.activeBookId || "", activeBookUpdatedAt: active.activeBookUpdatedAt || 0, books: states };
}

function migrateLegacyData(rows, settings, settingsUpdatedAt = 0, savedBookId = "") {
  const legacy = emptyReader(READER_DEFAULTS[0]);
  if (settings) {
    legacy.settings = { fontSize: Number(settings.fontSize) || 18, theme: settings.theme || "paper" };
    legacy.settingsUpdatedAt = Number(settingsUpdatedAt) || 1;
  }
  legacy.activeBookId = savedBookId;
  legacy.activeBookUpdatedAt = savedBookId ? 1 : 0;
  const cleaned = rows.map((book) => {
    if (READING_FIELDS.some((key) => Object.hasOwn(book, key))) {
      legacy.books[book.id] = { progress: book.progress || 0, scrollProgress: book.scrollProgress || 0, cfi: book.cfi || "", progressUpdatedAt: book.progressUpdatedAt || book.updatedAt || book.addedAt || 1, lastOpenedAt: book.lastOpenedAt || 0, contentUpdatedAt: book.contentUpdatedAt || book.addedAt || book.updatedAt || 0 };
    }
    const shared = { ...book };
    READING_FIELDS.forEach((key) => delete shared[key]);
    return shared;
  });
  readers[legacy.id] = mergeReader(readers[legacy.id], legacy);
  saveReaders();
  return cleaned;
}

function readingState(book, readerId = activeReaderId) {
  if (!book) return {};
  const state = readers[readerId].books[book.id];
  if (!state || (state.contentUpdatedAt || 0) < (book.contentUpdatedAt || book.addedAt || 0)) return {};
  return state;
}

function updateReadingState(book, changes) {
  readers[activeReaderId].books[book.id] = { ...readingState(book), ...changes, contentUpdatedAt: book.contentUpdatedAt || book.addedAt || 0 };
  saveReaders();
}

function applyReader() {
  const reader = readers[activeReaderId];
  setTheme(["paper", "warm", "night"].includes(reader.settings.theme) ? reader.settings.theme : "paper", false);
  setFontSize(Number(reader.settings.fontSize) || 18, false);
  activeBookId = books.find((book) => book.id === reader.activeBookId)?.id || books[0]?.id || "";
  renderReaders();
}

function renderReaders() {
  $("#reader-select").innerHTML = READER_DEFAULTS.map(({ id }) => `<option value="${id}" ${id === activeReaderId ? "selected" : ""}>${safeText(readers[id].name)}</option>`).join("");
  $("#reader-name").value = readers[activeReaderId].name;
  $("#collection-eyebrow").textContent = `${readers[activeReaderId].name} · 共用书库`;
}

async function switchReader(id) {
  if (switchingReader || id === activeReaderId || !readers[id]) return;
  switchingReader = true;
  $("#reader-select").disabled = true;
  try {
    await saveTextProgress(true);
    readingSession += 1;
    setView("library");
    epubRendition?.destroy();
    epubRendition = epubBook = null;
    epubBookId = epubBookContentVersion = null;
    epubChapters = [];
    activeReaderId = id;
    localStorage.setItem(ACTIVE_READER_KEY, id);
    applyReader();
    renderShelf();
    renderCollection();
    $("#crumb-title").textContent = "共用书库";
    notify(`已切换到${readers[id].name}`);
  } finally {
    switchingReader = false;
    $("#reader-select").disabled = false;
  }
}

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
    request.onsuccess = () => resolve(request.result.map((book) => book?.format === "text" ? { ...book, chapters: normalizeTextChapters(book.chapters) } : book));
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
  return books.find((book) => book.id === activeBookId) || books[0] || null;
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
  $("#book-count").textContent = books.length;
  $("#cloud-book-count").textContent = cloudCatalog.books.length;
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
    const chapterCount = book.chapters?.length || book.chapterCount || 0;
    const state = readingState(book);
    const percent = !state.lastOpenedAt && !state.progress && !state.scrollProgress && !state.cfi ? 0 : book.format === "text" ? chapterCount ? Math.round((((Number(state.progress) || 0) + 1) / chapterCount) * 100) : 0 : Math.round((Number(state.progress) || 0) * 100);
    const format = book.format === "epub" ? "EPUB" : book.title.match(/\.md$/i) ? "MD" : "TXT";
    return `<article class="collection-card"><button class="collection-open" data-book-id="${safeText(book.id)}" aria-label="阅读：${safeText(book.title)}"><span class="collection-cover"><span>${safeText(book.title.slice(0, 1))}</span><small>${format}</small></span><span class="collection-card-copy"><strong>${safeText(book.title)}</strong><span class="collection-author">${safeText(book.author || "未知作者")}</span><span class="collection-progress"><span><i style="width:${Math.min(100, percent)}%"></i></span><small>${percent}%</small></span></span></button><span class="collection-card-actions"><button class="text-button book-edit" data-book-id="${safeText(book.id)}">编辑</button><button class="text-button book-delete" data-book-id="${safeText(book.id)}">移出设备</button></span></article>`;
  }).join("");
  $("#collection-grid").querySelectorAll(".collection-open").forEach((button) => button.addEventListener("click", () => selectBook(button.dataset.bookId)));
  $("#collection-grid").querySelectorAll(".book-edit").forEach((button) => button.addEventListener("click", () => openBookEditor(button.dataset.bookId)));
  $("#collection-grid").querySelectorAll(".book-delete").forEach((button) => button.addEventListener("click", () => removeBook(button.dataset.bookId).catch((error) => notify(error.message))));
}

function renderCloudCollection() {
  const query = $("#cloud-search").value.trim().toLocaleLowerCase();
  const visibleBooks = [...cloudCatalog.books]
    .sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0))
    .filter((book) => `${book.title} ${book.author || ""}`.toLocaleLowerCase().includes(query));
  $("#cloud-collection-count").textContent = `${visibleBooks.length} 本书`;
  $("#cloud-collection-grid").hidden = visibleBooks.length === 0;
  $("#cloud-collection-empty").hidden = visibleBooks.length !== 0;
  $("#cloud-collection-grid").innerHTML = visibleBooks.map((book) => {
    const state = readingState(book);
    const chapterCount = book.chapters?.length || book.chapterCount || 0;
    const percent = !state.lastOpenedAt && !state.progress && !state.scrollProgress && !state.cfi ? 0 : book.format === "text" ? chapterCount ? Math.round((((Number(state.progress) || 0) + 1) / chapterCount) * 100) : 0 : Math.round((Number(state.progress) || 0) * 100);
    const format = book.format === "epub" ? "EPUB" : book.title.match(/\.md$/i) ? "MD" : "TXT";
    const local = isLocalBook(book.id);
    const action = local ? "已在本机" : "下载到本机";
    return `<article class="collection-card cloud-card"><button class="collection-open cloud-book-open" data-book-id="${safeText(book.id)}" aria-label="${local ? "打开" : "下载并打开"}：${safeText(book.title)}"><span class="collection-cover"><span>${safeText(book.title.slice(0, 1))}</span><small>${format}</small><span class="cloud-download-overlay" hidden><span class="download-ring"><span>0%</span></span></span></span><span class="collection-card-copy"><strong>${safeText(book.title)}</strong><span class="collection-author">${safeText(book.author || "未知作者")}</span><span class="cloud-book-status">${action}</span><span class="collection-progress"><span><i style="width:${Math.min(100, percent)}%"></i></span><small>${percent}%</small></span></span></button><span class="collection-card-actions"><button class="text-button cloud-book-delete" data-book-id="${safeText(book.id)}">删除云端</button></span></article>`;
  }).join("");
  $("#cloud-collection-grid").querySelectorAll(".cloud-book-open").forEach((button) => button.addEventListener("click", () => downloadCloudBook(button.dataset.bookId).catch((error) => notify(error.message))));
  $("#cloud-collection-grid").querySelectorAll(".cloud-book-delete").forEach((button) => button.addEventListener("click", () => removeCloudBook(button.dataset.bookId).catch((error) => notify(error.message))));
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
  if (!book || !confirm(`从此设备移出《${book.title}》？云端书库和两位读者的阅读记录会保留。`)) return;
  if (id === activeBookId) await saveTextProgress(true);
  libraryRevision += 1;
  await deleteBook(id);
  books = books.filter((item) => item.id !== id);
  if (id === activeBookId) {
    readingSession += 1;
    epubRendition?.destroy();
    epubRendition = epubBook = null;
    epubBookId = epubBookContentVersion = null;
    epubChapters = [];
    activeBookId = books[0]?.id || "";
    if (activeBookId) await selectBook(activeBookId, { persistCurrent: false });
    else setView("library");
  }
  renderShelf();
  renderCollection();
  renderCloudCollection();
  notify("书籍已移出此设备");
}

async function downloadCloudBook(id) {
  const repository = githubRepository();
  const token = localStorage.getItem(GITHUB_TOKEN_KEY) || "";
  const branch = GITHUB_BOOKS_BRANCH;
  if (!repository || !token) throw new Error("请先在同步设置中连接 GitHub");
  githubToken = token;
  await ensureGitHubBranch(branch, localStorage.getItem(GITHUB_BRANCH_KEY) || "main");
  let descriptor = cloudDescriptor(id);
  if (!descriptor) throw new Error("云端书籍目录中没有这本书");
  if (isLocalBook(id)) {
    await selectBook(id);
    return;
  }
  $("#local-status").textContent = `正在下载《${descriptor.title}》`;
  setCloudDownloadProgress(id, 0);
  try {
    const manifestRead = await readGitHubJson(GITHUB_MANIFEST_PATH, branch);
    const freshDescriptor = manifestRead?.value?.books?.find((book) => book.id === id);
    if (manifestRead?.value && !freshDescriptor) throw new Error(`《${descriptor.title}》已从云端书库删除，请重新同步目录`);
    if (freshDescriptor) {
      descriptor = freshDescriptor;
      cloudCatalog = { ...cloudCatalog, ...manifestRead.value };
      saveCloudCatalog();
      renderCloudCollection();
      setCloudDownloadProgress(id, 0);
    }
    const contentRead = await readGitHubJson(`sync/books/${id}.json`, branch, { onProgress: (progress) => setCloudDownloadProgress(id, progress) });
    if (!contentRead) throw new Error(`云端缺少《${descriptor.title}》的书籍文件`);
    const actualHash = await contentHash(contentRead.value);
    if (actualHash !== descriptor.contentHash) {
      if (!isCloudContent(contentRead.value)) throw new Error(`《${descriptor.title}》的云端内容校验失败`);
      descriptor = { ...descriptor, contentHash: actualHash };
      cloudCatalog = { ...cloudCatalog, books: cloudCatalog.books.map((book) => book.id === id ? descriptor : book) };
      saveCloudCatalog();
      if (manifestRead?.value && manifestRead.sha) {
        const repairedManifest = { ...manifestRead.value, books: manifestRead.value.books.map((book) => book.id === id ? { ...book, contentHash: actualHash } : book) };
        try {
          await writeGitHubJson(GITHUB_MANIFEST_PATH, repairedManifest, branch, manifestRead.sha);
        } catch (error) {
          if (!error.isConflict) throw error;
        }
      }
    }
    const book = { ...descriptor, ...contentRead.value, fileSha: contentRead.sha };
    delete book.fileSha;
    await saveBook(book);
    books = await allBooks();
    renderShelf();
    renderCollection();
    renderCloudCollection();
    notify(`《${descriptor.title}》已下载到本机`);
  } finally {
    $("#local-status").textContent = "已连接 GitHub";
    renderCloudCollection();
  }
}

async function waitForSyncIdle(timeout = 60000) {
  const startedAt = Date.now();
  while (syncInProgress) {
    if (Date.now() - startedAt > timeout) throw new Error("当前同步仍在进行，请稍后再删除云端书籍");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function removeCloudBook(id) {
  const descriptor = cloudDescriptor(id);
  if (!descriptor) throw new Error("云端书籍目录中没有这本书");
  if (!confirm(`从共享云端书库永久删除《${descriptor.title}》？\n\n这会删除云端书籍文件，并从所有设备移除这本书，同时删除两位读者对应的阅读记录。`)) return;
  if (!githubRepository() || !localStorage.getItem(GITHUB_TOKEN_KEY)) throw new Error("请先在同步设置中连接 GitHub");
  const deleted = JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
  localStorage.setItem(DELETED_BOOKS_KEY, JSON.stringify([...new Set([...deleted, id])]));
  notify(`正在从云端删除《${descriptor.title}》…`);
  await waitForSyncIdle();
  const synced = await syncToGitHub({ automatic: true });
  setView("cloud");
  if (!synced || cloudCatalog.books.some((book) => book.id === id)) throw new Error("云端删除未完成，请稍后重试");
  notify(`《${descriptor.title}》已从云端删除`);
}

function setCloudDownloadProgress(id, progress) {
  const overlay = $(`#cloud-collection-grid [data-book-id="${CSS.escape(id)}"] .cloud-download-overlay`);
  if (!overlay) return;
  overlay.hidden = false;
  const percent = progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100);
  overlay.style.setProperty("--download-progress", percent == null ? "25%" : `${percent}%`);
  overlay.querySelector(".download-ring span").textContent = percent == null ? "…" : `${percent}%`;
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
    else if (/\.(txt|md|markdown)$/i.test(file.name)) replacement = { format: "text", chapters: await splitIntoChapters(decodeTextFile(await file.arrayBuffer())) };
    else { notify("请选择 TXT、Markdown 或 EPUB 文件"); return; }
    if (!replacement.chapters?.length && replacement.format === "text") { notify("文件中没有可导入的正文"); return; }
  }
  if (id === activeBookId) await saveTextProgress(true);
  libraryRevision += 1;
  book.title = title;
  book.author = $("#edit-book-author").value.trim();
  book.updatedAt = Date.now();
  book.metadataUpdatedAt = book.updatedAt;
  if (replacement) {
    if (id === activeBookId) {
      readingSession += 1;
      setView("library");
    }
    Object.assign(book, replacement, { contentUpdatedAt: book.updatedAt });
    for (const reader of Object.values(readers)) {
      reader.books[id] = { progress: 0, scrollProgress: 0, cfi: "", progressUpdatedAt: book.updatedAt, lastOpenedAt: 0, contentUpdatedAt: book.contentUpdatedAt };
    }
    saveReaders();
    delete book.contentHash;
    delete book.cfi;
    delete book.locations;
  }
  await saveBook(book);
  books = await allBooks();
  $("#edit-book-dialog").close();
  renderShelf();
  renderCollection();
  if (id === activeBookId) await selectBook(id, { persistCurrent: false });
  notify(replacement ? "书籍信息和文件已更新" : "书籍信息已更新");
}

function setView(view) {
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const inLibrary = view === "library";
  const inCloud = view === "cloud";
  $("#collection-view").hidden = !inLibrary;
  $("#cloud-view").hidden = !inCloud;
  $(".reader-stage").hidden = inLibrary || inCloud;
  const mainArea = document.querySelector(".main-area");
  mainArea.classList.remove("theme-paper", "theme-warm", "theme-night");
  if (!inLibrary && !inCloud) mainArea.classList.add(`theme-${activeTheme}`);
  $("#view-title").textContent = inCloud ? "云端书库" : inLibrary ? "我的书架" : "正在阅读";
  if (inLibrary) renderCollection();
  if (inCloud) renderCloudCollection();
}

function currentChapters(book) {
  return book?.format === "text" ? normalizeTextChapters(book.chapters) : [];
}

function bindChapterGestures(target) {
  let touch = null;
  const chapterKey = () => {
    const book = activeBook();
    if (!book || $(".reader-stage").hidden || $("#next-chapter").disabled || restoringTextPosition || chapterGestureState.changing || document.querySelector("dialog[open]")) return "";
    const index = book.format === "epub" ? activeEpubChapter : activeChapter;
    return `${readingSession}:${book.id}:${index}`;
  };
  const atBottom = () => {
    // EPUB iframes expand to content height; their outer containers do the scrolling.
    const scrollers = [$("#reader-scroll")];
    if (activeBook()?.format === "epub") scrollers.push(epubRendition?.manager?.container, $("#epub-host"));
    return scrollers.filter(Boolean).every((scroller) => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 3);
  };
  const advance = async () => {
    chapterGestureState.touchReadyChapter = chapterGestureState.touchScrollChapter = "";
    chapterGestureState.changing = true;
    try {
      await moveChapter(1);
    } catch (error) {
      notify(error.message);
    } finally {
      chapterGestureState.changing = false;
    }
  };
  target.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const now = performance.now();
    const key = chapterKey();
    if (now - chapterGestureState.wheelAt > 200) {
      chapterGestureState.wheelChapter = key;
      chapterGestureState.wheelAtBottom = atBottom();
      chapterGestureState.wheelUsed = false;
    }
    chapterGestureState.wheelAt = now;
    if (event.deltaY < 0) chapterGestureState.wheelAtBottom = false;
    if (!key || key !== chapterGestureState.wheelChapter || !chapterGestureState.wheelAtBottom || chapterGestureState.wheelUsed || event.deltaY <= 0 || !atBottom()) return;
    event.preventDefault();
    chapterGestureState.wheelUsed = true;
    advance();
  }, { passive: false, capture: true });
  target.addEventListener("scroll", () => {
    const key = chapterKey();
    if (!key) return;
    if (!atBottom()) chapterGestureState.touchReadyChapter = "";
    else if (chapterGestureState.touchScrollChapter === key) chapterGestureState.touchReadyChapter = key;
  }, { passive: true, capture: true });
  target.addEventListener("touchstart", (event) => {
    touch = null;
    chapterGestureState.touchScrollChapter = "";
    const key = chapterKey();
    if (event.touches.length !== 1 || !key) return;
    const startedAtBottom = atBottom();
    if (!startedAtBottom) chapterGestureState.touchReadyChapter = "";
    const point = event.touches[0];
    touch = { id: point.identifier, x: point.screenX, y: point.screenY, chapter: key, startedAtBottom, ready: chapterGestureState.touchReadyChapter === key };
  }, { passive: true, capture: true });
  target.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1) { touch = null; chapterGestureState.touchScrollChapter = ""; return; }
    if (!touch || touch.chapter !== chapterKey()) return;
    const point = event.touches[0];
    const distance = touch.y - point.screenY;
    if (distance > 0 && distance > Math.abs(point.screenX - touch.x)) {
      chapterGestureState.touchScrollChapter = touch.chapter;
      if (touch.startedAtBottom && atBottom() && event.cancelable) event.preventDefault();
    }
  }, { passive: false, capture: true });
  target.addEventListener("touchend", (event) => {
    const gesture = touch;
    touch = null;
    if (!gesture || gesture.chapter !== chapterKey()) return;
    const point = Array.from(event.changedTouches).find((item) => item.identifier === gesture.id);
    if (!point) return;
    const distance = gesture.y - point.screenY;
    if (distance < 48 || distance <= Math.abs(point.screenX - gesture.x)) return;
    chapterGestureState.touchScrollChapter = gesture.chapter;
    if (!atBottom()) return;
    if (gesture.startedAtBottom && gesture.ready) advance();
    else chapterGestureState.touchReadyChapter = gesture.chapter;
  }, { passive: true, capture: true });
  target.addEventListener("touchcancel", () => { touch = null; }, { passive: true, capture: true });
}

function saveTextProgress(immediate = false) {
  const book = activeBook();
  if (!book || book.format !== "text" || $(".reader-stage").hidden || restoringTextPosition) return;
  const scroller = $("#reader-scroll");
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const progress = activeChapter;
  const scrollProgress = maxScroll ? Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)) : 0;
  const state = readingState(book);
  const changed = (state.progress || 0) !== progress || (state.scrollProgress || 0) !== scrollProgress;
  if (changed) {
    updateReadingState(book, { progress, scrollProgress, progressUpdatedAt: Date.now() });
  }
}

function renderTextChapter(index, save = true) {
  if (save) saveTextProgress(true);
  chapterGestureState.touchReadyChapter = chapterGestureState.touchScrollChapter = "";
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
  restoringTextPosition = true;
  scroller.scrollTop = 0;
  const scrollProgress = save ? 0 : Math.min(1, Math.max(0, Number(readingState(book).scrollProgress) || 0));
  const targetChapter = activeChapter;
  const session = readingSession;
  const restorePosition = () => {
    if (session !== readingSession || activeBookId !== book.id || activeChapter !== targetChapter) return;
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * scrollProgress;
    requestAnimationFrame(() => { if (session === readingSession && activeChapter === targetChapter) restoringTextPosition = false; });
  };
  requestAnimationFrame(restorePosition);
  $("#crumb-title").textContent = book.title;
  $("#reading-state").textContent = "正在阅读";
  if (save) {
    updateReadingState(book, { progress: activeChapter, scrollProgress: 0, progressUpdatedAt: Date.now() });
  }
}

function setTheme(theme, sync = true) {
  theme = ["paper", "warm", "night"].includes(theme) ? theme : "paper";
  activeTheme = theme;
  const stage = document.querySelector(".reader-stage");
  stage.classList.remove("theme-paper", "theme-warm", "theme-night");
  stage.classList.add(`theme-${theme}`);
  if (!$(".reader-stage").hidden) {
    const mainArea = document.querySelector(".main-area");
    mainArea.classList.remove("theme-paper", "theme-warm", "theme-night");
    mainArea.classList.add(`theme-${theme}`);
  }
  document.querySelectorAll(".theme-swatch").forEach((button) => button.classList.toggle("selected", button.dataset.theme === theme));
  document.querySelector("meta[name='theme-color']").content = theme === "night" ? "#222623" : theme === "warm" ? "#f4f0e7" : "#f7f7f4";
  if (sync) {
    readers[activeReaderId].settings.theme = theme;
    readers[activeReaderId].settingsUpdatedAt = Date.now();
    saveReaders();
  }
  const rendition = epubRendition;
  if (rendition) rendition.themes.default({ body: { color: theme === "night" ? "#dddcd2 !important" : theme === "warm" ? "#453d34 !important" : "#373833 !important", background: theme === "night" ? "#222623 !important" : theme === "warm" ? "#f4f0e7 !important" : "#fbfbf9 !important" } });
}

function setFontSize(size, sync = true) {
  fontSize = Math.max(14, Math.min(28, size));
  $("#font-size-value").textContent = fontSize;
  $("#chapter-content").style.fontSize = `${fontSize}px`;
  if (sync) {
    readers[activeReaderId].settings.fontSize = fontSize;
    readers[activeReaderId].settingsUpdatedAt = Date.now();
    saveReaders();
  }
  if (epubRendition) epubRendition.themes.fontSize(`${fontSize}px`);
}

async function selectBook(id, { persistCurrent = true } = {}) {
  if (persistCurrent) await saveTextProgress(true);
  readingSession += 1;
  restoringTextPosition = false;
  activeBookId = id;
  const book = activeBook();
  readers[activeReaderId].activeBookId = book.id;
  readers[activeReaderId].activeBookUpdatedAt = Date.now();
  updateReadingState(book, { lastOpenedAt: Date.now() });
  renderShelf();
  setView("reader");
  if (book.format === "epub") {
    await showEpub(book);
    return;
  }
  if (epubRendition) epubRendition.destroy();
  epubRendition = null;
  epubChapters = [];
  renderTextChapter(Number(readingState(book).progress) || 0, false);
  if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
}

function flattenToc(items, result = []) {
  for (const item of items || []) {
    if (item.href) result.push({ href: item.href, label: item.label || item.href });
    flattenToc(item.subitems, result);
  }
  return result;
}

async function showEpub(book) {
  const session = readingSession;
  $("#text-page").hidden = true;
  $("#epub-host").hidden = false;
  $("#epub-host").replaceChildren();
  if (epubRendition) epubRendition.destroy();
  epubRendition = null;
  try {
    if (!window.JSZip || !window.ePub) throw new Error("EPUB 阅读组件未加载，请检查网络后刷新页面。");
    await new Promise(requestAnimationFrame);
    if (session !== readingSession) return;
    const contentVersion = book.contentUpdatedAt || book.updatedAt || book.addedAt || 0;
    if (epubBookId !== book.id || epubBookContentVersion !== contentVersion) {
      epubBook = ePub(book.data);
      epubBookId = book.id;
      epubBookContentVersion = contentVersion;
      await epubBook.ready;
      if (session !== readingSession) return;
      if (book.locations) epubBook.locations.load(book.locations);
      else {
        await epubBook.locations.generate(1000);
        if (session !== readingSession) return;
        book.locations = epubBook.locations.save();
        await saveBook(book);
      }
    }
    const [navigation, metadata] = await Promise.all([
      epubBook.loaded.navigation.catch(() => ({ toc: [] })),
      epubBook.loaded.metadata.catch(() => ({}))
    ]);
    if (session !== readingSession) return;
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
    epubRendition.themes.default({
      body: { "line-height": "2 !important", padding: "18px !important" },
      "body, body *": { "font-family": "'YeJianReading', serif !important" }
    });
    const readingFontUrl = new URL("./fonts/FZFWZHUZGDLMCJW.TTF", document.baseURI).href;
    epubRendition.hooks.content.register((contents) => {
      const style = contents.document.createElement("style");
      style.textContent = `@font-face { font-family: "YeJianReading"; src: url("${readingFontUrl}") format("truetype"); font-style: normal; font-weight: 400; } body, body * { font-family: "YeJianReading", serif !important; }`;
      (contents.document.head || contents.document.documentElement).append(style);
      bindChapterGestures(contents.document);
    });
    epubRendition.themes.fontSize(`${fontSize}px`);
    setTheme(activeTheme, false);
    const updateLocation = (location) => {
      if (session !== readingSession || $(".reader-stage").hidden) return;
      const href = (location.start.href || "").split("#")[0];
      const spineHref = spineItems[location.start.index]?.href;
      const chapter = epubChapters.find((item) => item.href.split("#")[0] === href) || epubChapters.find((item) => item.href.split("#")[0] === spineHref) || epubChapters[0];
      activeEpubChapter = epubChapters.indexOf(chapter);
      const percent = epubBook.locations.percentageFromCfi(location.start.cfi) || 0;
      const state = readingState(book);
      const progressChanged = state.cfi !== location.start.cfi || state.progress !== percent;
      if (progressChanged) {
        updateReadingState(book, { cfi: location.start.cfi, progress: percent, progressUpdatedAt: Date.now() });
      }
      $("#chapter-title").textContent = chapter.label;
      $("#chapter-select").value = chapter.href;
      $("#chapter-counter").textContent = `${String(activeEpubChapter + 1).padStart(2, "0")} / ${String(epubChapters.length).padStart(2, "0")}`;
      $("#prev-chapter").disabled = activeEpubChapter === 0;
      $("#next-chapter").disabled = activeEpubChapter >= epubChapters.length - 1;
      $("#book-author").textContent = book.author || "未知作者";
      $("#progress-fill").style.width = `${Math.round(percent * 100)}%`;
      $("#progress-percent").textContent = `${Math.round(percent * 100)}%`;
      $("#progress-chapter").textContent = chapter.label;
      const card = $(`#collection-grid [data-book-id="${CSS.escape(book.id)}"]`);
      if (card) {
        const progressBar = card.closest(".collection-card")?.querySelector(".collection-progress i");
        const progressLabel = card.closest(".collection-card")?.querySelector(".collection-progress small");
        if (progressBar) progressBar.style.width = `${Math.min(100, Math.round(percent * 100))}%`;
        if (progressLabel) progressLabel.textContent = `${Math.round(percent * 100)}%`;
      }
    };
    epubRendition.on("relocated", updateLocation);
    await epubRendition.display(readingState(book).cfi || epubChapters[0].href);
    if (session !== readingSession) return;
    const current = epubRendition.currentLocation();
    if (current?.start) updateLocation(current);
    $("#crumb-title").textContent = book.title;
    $("#reader-scroll").scrollTop = 0;
    if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
  } catch (error) {
    if (session !== readingSession) return;
    epubRendition?.destroy();
    epubRendition = epubBook = null;
    epubBookId = epubBookContentVersion = null;
    epubChapters = [];
    $("#epub-host").hidden = true;
    $("#text-page").hidden = false;
    $("#chapter-title").textContent = "无法打开这本 EPUB";
    $("#chapter-content").textContent = error.message;
    $("#chapter-select").replaceChildren();
    notify(error.message);
  }
}

function decodeTextFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      throw new Error("无法识别 TXT 文件编码，请将文件另存为 UTF-8 后重试");
    }
  }
}

function normalizeTextChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters.map((chapter) => {
    const item = chapter && typeof chapter === "object" ? chapter : {};
    const paragraphs = Array.isArray(item.paragraphs) ? item.paragraphs.map((line) => String(line).trim()).filter(Boolean) : [];
    return { ...item, title: String(item.title || "正文").trim() || "正文", subtitle: String(item.subtitle || "").trim(), paragraphs };
  }).filter((chapter) => chapter.paragraphs.length);
}

async function splitIntoChapters(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const headings = /^(?:第[零〇一二三四五六七八九十百千万\d]+[章节回卷部篇].*|序章.*|楔子.*|序言.*|Chapter\s+\d+.*)$/i;
  const chapters = [];
  let current = { title: "正文", subtitle: "", paragraphs: [] };
  for (let start = 0; start < lines.length; start += 2000) {
    for (const raw of lines.slice(start, start + 2000)) {
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
    if (start + 2000 < lines.length) await new Promise(requestAnimationFrame);
  }
  if (current.paragraphs.length || !chapters.length) chapters.push(current);
  return normalizeTextChapters(chapters);
}

async function importFiles(fileList) {
  await saveTextProgress(true);
  libraryRevision += 1;
  readingSession += 1;
  setView("library");
  for (const file of fileList) {
    const title = file.name.replace(/\.(txt|md|markdown|epub)$/i, "");
    const id = crypto.randomUUID();
    if (/\.epub$/i.test(file.name)) {
      const data = await file.arrayBuffer();
      const book = { id, title, author: "", format: "epub", data, addedAt: Date.now(), updatedAt: Date.now(), contentUpdatedAt: Date.now() };
      await saveBook(book);
      activeBookId = id;
      continue;
    }
    const content = decodeTextFile(await file.arrayBuffer());
    const chapters = await splitIntoChapters(content);
    await saveBook({ id, title, author: "", format: "text", chapters, addedAt: Date.now(), updatedAt: Date.now(), contentUpdatedAt: Date.now() });
    activeBookId = id;
  }
  books = await allBooks();
  renderShelf();
  await selectBook(activeBookId, { persistCurrent: false });
  if (fileList.length) notify(`已导入 ${fileList.length} 本书`);
}

function openSettings() {
  renderReaders();
  $("#github-repository").value = localStorage.getItem(GITHUB_REPO_KEY) || "";
  $("#github-branch").value = localStorage.getItem(GITHUB_BRANCH_KEY) || "main";
  $("#github-token").value = localStorage.getItem(GITHUB_TOKEN_KEY) || "";
  $("#settings-dialog").showModal();
}

async function downloadBackup() {
  await saveTextProgress(true);
  const payload = { version: 2, exportedAt: new Date().toISOString(), books, readers };
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
  if (data.version >= 2 && !READER_DEFAULTS.every(({ id }) => data.readers?.[id]?.id === id && typeof data.readers[id].name === "string" && data.readers[id].name.trim() && data.readers[id].settings && data.readers[id].books && typeof data.readers[id].books === "object" && !Array.isArray(data.readers[id].books))) throw new Error("备份中的读者档案格式不正确");
  await saveTextProgress(true);
  libraryRevision += 1;
  readingSession += 1;
  setView("library");
  epubRendition?.destroy();
  epubRendition = epubBook = null;
  epubBookId = epubBookContentVersion = null;
  for (const defaults of READER_DEFAULTS) readers[defaults.id] = data.readers?.[defaults.id] || emptyReader(defaults);
  const sharedBooks = migrateLegacyData(data.books, data.settings, 1);
  await replaceBooks(sharedBooks);
  books = await allBooks();
  applyReader();
  renderShelf();
  renderCollection();
  notify("备份已导入");
}

function moveChapter(offset) {
  const book = activeBook();
  if (!book) return;
  if (book.format === "epub") {
    chapterGestureState.touchReadyChapter = chapterGestureState.touchScrollChapter = "";
    const index = activeEpubChapter + offset;
    if (epubChapters[index]) {
      activeEpubChapter = index;
      return epubRendition?.display(epubChapters[index].href);
    }
    return;
  }
  renderTextChapter(activeChapter + offset);
}

function cloudContent(book) {
  return book.format === "epub" ? { format: "epub", data: book.data } : { format: "text", chapters: book.chapters };
}

function isCloudContent(value) {
  return Boolean(value && ((value.format === "text" && Array.isArray(value.chapters)) || (value.format === "epub" && value.data instanceof ArrayBuffer)));
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

function githubRefUrl(ref) {
  const [owner, name] = githubRepository().split("/");
  const encodedRef = ["heads", ...ref.split("/")].map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/${encodedRef}`;
}

async function ensureGitHubBranch(branch, sourceBranch) {
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
  let response = await fetch(githubRefUrl(branch), { headers });
  if (response.ok) return;
  if (response.status !== 404) throw new Error(`读取 GitHub 分支失败 (${response.status})`);
  const sourceResponse = await fetch(githubRefUrl(sourceBranch), { headers });
  if (!sourceResponse.ok) throw new Error(`找不到用于初始化同步分支的基准分支“${sourceBranch}”`);
  const source = await sourceResponse.json();
  const [owner, name] = githubRepository().split("/");
  response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.object.sha })
  });
  if (response.ok) return;
  if (response.status === 422) {
    const existing = await fetch(githubRefUrl(branch), { headers });
    if (existing.ok) return;
  }
  const detail = await response.text();
  throw new Error(`创建 GitHub 分支“${branch}”失败 (${response.status})${detail ? `：${detail.slice(0, 180)}` : ""}`);
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
    const isConflict = response.status === 409 || (response.status === 422 && /sha|conflict|reference|fast.forward/i.test(detail));
    const error = new Error(isConflict
      ? "GitHub 仓库刚被另一台设备更新，请重新同步"
      : `GitHub 请求失败 (${response.status})${detail ? `：${detail.slice(0, 180)}` : ""}`);
    error.status = response.status;
    error.isConflict = isConflict;
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

async function readResponseText(response, onProgress) {
  if (!response.body?.getReader) {
    const text = await response.text();
    onProgress?.(1);
    return text;
  }
  const reader = response.body.getReader();
  const total = Number(response.headers.get("content-length")) || 0;
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    onProgress?.(total ? received / total : null);
  }
  text += decoder.decode();
  onProgress?.(1);
  return text;
}

async function readGitHubJson(path, branch, { onProgress } = {}) {
  let response = await githubRequest(path, branch, { allowMissing: true });
  if (!response) return null;
  let file = JSON.parse(await readResponseText(response, onProgress));
  if (file.encoding === "base64" && file.content) {
    return { value: decodeBackup(decodeGitHubContent(file.content)), sha: file.sha };
  }
  if (file.git_url) {
    const blobResponse = await fetch(file.git_url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!blobResponse.ok) throw new Error(`GitHub 请求失败 (${blobResponse.status})`);
    const blob = JSON.parse(await readResponseText(blobResponse, onProgress));
    if (blob.encoding === "base64" && blob.content) {
      return { value: decodeBackup(decodeGitHubContent(blob.content)), sha: file.sha };
    }
  }
  response = await githubRequest(path, branch, { raw: true });
  const rawText = await readResponseText(response, onProgress);
  try {
    const rawFile = JSON.parse(rawText);
    if (rawFile.encoding === "base64" && rawFile.content) {
      return { value: decodeBackup(decodeGitHubContent(rawFile.content)), sha: file.sha };
    }
  } catch {
    // The raw endpoint normally returns the JSON document directly.
  }
  return { value: decodeBackup(rawText), sha: file.sha };
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
  const addedAt = Number(book.addedAt || 0);
  const updatedAt = Number(book.updatedAt || addedAt);
  return {
    id: book.id, title: book.title, author: book.author || "", format: book.format,
    addedAt, updatedAt,
    metadataUpdatedAt: book.metadataUpdatedAt || addedAt || updatedAt,
    contentUpdatedAt: book.contentUpdatedAt || addedAt || updatedAt,
    chapterCount: book.format === "text" ? (book.chapters?.length || 0) : (book.chapterCount || 0),
    contentHash, fileSha
  };
}

function mergeDescriptor(local, remote) {
  const metadata = (remote.metadataUpdatedAt || 0) > (local.metadataUpdatedAt || 0) ? remote : local;
  return { ...local, title: metadata.title, author: metadata.author, addedAt: Math.min(local.addedAt || local.updatedAt || 0, remote.addedAt || remote.updatedAt || 0), metadataUpdatedAt: metadata.metadataUpdatedAt };
}

async function syncReader(readerId, branch, remote, revision, removedIds) {
  const snapshot = JSON.parse(JSON.stringify(mergeReader(readers[readerId], remote?.value)));
  for (const bookId of removedIds) delete snapshot.books[bookId];
  if (!remote || JSON.stringify(snapshot) !== JSON.stringify(mergeReader(emptyReader(READER_DEFAULTS.find((reader) => reader.id === readerId)), remote.value))) {
    await writeGitHubJson(`sync/readers/${readerId}.json`, snapshot, branch, remote?.sha || null);
  }
  if (revision !== libraryRevision) { syncPending = true; return; }
  saveTextProgress(true);
  const book = activeBook();
  const before = JSON.stringify(readingState(book));
  readers[readerId] = mergeReader(readers[readerId], snapshot);
  for (const bookId of removedIds) delete readers[readerId].books[bookId];
  saveReaders();
  if (book && before !== JSON.stringify(readingState(book)) && !$(".reader-stage").hidden && !removedIds.has(book.id)) {
    readingSession += 1;
    restoringTextPosition = false;
    if (book.format === "epub") await showEpub(book);
    else renderTextChapter(Number(readingState(book).progress) || 0, false);
  }
}

async function removeDeletedReaderStates(readerId, removedIds) {
  if (!removedIds.size) return;
  const branch = READER_BRANCHES[readerId];
  const remote = await readGitHubJson(`sync/readers/${readerId}.json`, branch);
  if (!remote) return;
  const snapshot = mergeReader(readers[readerId], remote.value);
  let changed = false;
  for (const bookId of removedIds) {
    if (Object.hasOwn(snapshot.books, bookId)) {
      delete snapshot.books[bookId];
      changed = true;
    }
  }
  if (changed) await writeGitHubJson(`sync/readers/${readerId}.json`, snapshot, branch, remote.sha);
  readers[readerId] = snapshot;
}

async function syncToGitHub({ automatic = false } = {}) {
  if (syncInProgress) { syncPending = syncPending || automatic; return false; }
  const repository = (automatic ? localStorage.getItem(GITHUB_REPO_KEY) || "" : $("#github-repository").value).trim();
  const token = (automatic ? localStorage.getItem(GITHUB_TOKEN_KEY) || "" : $("#github-token").value).trim();
  const sourceBranch = (automatic ? localStorage.getItem(GITHUB_BRANCH_KEY) || "main" : $("#github-branch").value || "main").trim();
  const branch = GITHUB_BOOKS_BRANCH;
  const readerId = activeReaderId;
  const readerBranch = READER_BRANCHES[readerId];
  if (!repository || !token) {
    if (!automatic) notify("请填写 GitHub 仓库和访问令牌");
    return false;
  }
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    if (!automatic) notify("仓库格式应为 owner/repository");
    return false;
  }
  if (!acquireSyncLock()) {
    syncPending = true;
    $("#sync-feedback").textContent = "本机另一个页面正在同步…";
    setTimeout(() => syncToGitHub({ automatic: true }), 2000);
    return false;
  }
  syncInProgress = true;
  lastSyncSucceeded = null;
  syncLockTimer = setInterval(refreshSyncLock, 5000);
  const runId = ++syncRunId;
  localStorage.setItem(GITHUB_REPO_KEY, repository);
  localStorage.setItem(GITHUB_BRANCH_KEY, sourceBranch);
  localStorage.setItem(GITHUB_TOKEN_KEY, token);
  githubToken = token;
  $("#sync-feedback").textContent = automatic ? "正在自动同步…" : "正在连接 GitHub…";
  try {
    await saveTextProgress(true);
    if (runId !== syncRunId) return false;
    await Promise.all([
      ensureGitHubBranch(GITHUB_BOOKS_BRANCH, sourceBranch),
      ...READER_DEFAULTS.map(({ id }) => ensureGitHubBranch(READER_BRANCHES[id], sourceBranch))
    ]);
    $("#sync-feedback").textContent = "正在核对书架…";
    const manifestRead = await readGitHubJson(GITHUB_MANIFEST_PATH, branch);
    let cloudManifest = manifestRead?.value || null;
    if (cloudManifest && (cloudManifest.version || 1) < 3) {
      cloudManifest = { ...cloudManifest, books: migrateLegacyData(cloudManifest.books || [], cloudManifest.settings, cloudManifest.settingsUpdatedAt) };
    }
    const remoteReader = await readGitHubJson(`sync/readers/${readerId}.json`, readerBranch);
    const revision = libraryRevision;
    const localBooks = new Map(books.map((book) => [book.id, { ...book }]));
    const remoteBooks = new Map((cloudManifest?.books || []).map((book) => [book.id, book]));
    const tombstones = new Map((cloudManifest?.deleted || []).map((item) => [item.id, item.deletedAt]));
    const localDeleted = JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
    localDeleted.forEach((id) => {
      const remote = remoteBooks.get(id);
      const remoteUpdatedAt = remote?.updatedAt || remote?.addedAt || 0;
      tombstones.set(id, Math.max(tombstones.get(id) || 0, Date.now(), remoteUpdatedAt + 1));
    });
    const mergedBooks = new Map(remoteBooks);
    const nextLocalBooks = new Map(localBooks);

    for (const [id, local] of localBooks) {
      const deletedAt = tombstones.get(id) || 0;
      if (deletedAt >= (local.updatedAt || local.addedAt || 0)) {
        nextLocalBooks.delete(id);
        continue;
      }
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
        const descriptor = bookDescriptor(local, localHash, fileSha);
        mergedBooks.set(id, descriptor);
      } else if (remote.contentHash !== localHash) {
        const localContentAt = local.contentUpdatedAt || local.addedAt || local.updatedAt || 0;
        if (localContentAt >= (remote.contentUpdatedAt || 0)) {
          const saved = await writeGitHubJson(path, cloudContent(local), branch, remote.fileSha);
          fileSha = saved.content.sha;
          mergedBooks.set(id, bookDescriptor(local, localHash, fileSha));
        } else {
          const remoteContentRead = await readGitHubJson(path, branch);
          if (!remoteContentRead) throw new Error(`云端缺少《${remote.title}》的书籍文件`);
          const remoteContentHash = await contentHash(remoteContentRead.value);
          if (remoteContentHash !== remote.contentHash && !isCloudContent(remoteContentRead.value)) throw new Error(`《${remote.title}》的云端内容校验失败`);
          chosen = { ...local, ...remoteContentRead.value, contentHash: remoteContentHash, contentUpdatedAt: remote.contentUpdatedAt };
          delete chosen.locations;
          fileSha = remoteContentRead.sha;
          nextLocalBooks.set(id, chosen);
          mergedBooks.set(id, { ...remote, contentHash: remoteContentHash, fileSha });
        }
      } else {
        const merged = mergeDescriptor(local, remote);
        mergedBooks.set(id, merged);
        nextLocalBooks.set(id, { ...local, title: merged.title, author: merged.author, metadataUpdatedAt: merged.metadataUpdatedAt });
      }
    }

    for (const [id, remote] of remoteBooks) {
      if ((tombstones.get(id) || 0) >= (remote.updatedAt || remote.addedAt || 0)) mergedBooks.delete(id);
    }

    const syncedBooks = [...mergedBooks.values()];
    const syncedLocalBooks = [...nextLocalBooks.values()];
    if (revision !== libraryRevision) { syncPending = true; return false; }
    for (const [id] of tombstones) {
      const remote = remoteBooks.get(id);
      if (remote?.fileSha) await deleteGitHubFile(`sync/books/${id}.json`, branch, remote.fileSha);
    }
    const removedIds = new Set([...tombstones.keys()].filter((id) => !mergedBooks.has(id)));
    await syncReader(readerId, readerBranch, remoteReader, revision, removedIds);
    for (const { id } of READER_DEFAULTS) {
      if (id !== readerId) await removeDeletedReaderStates(id, removedIds);
    }
    if (revision !== libraryRevision) { syncPending = true; return false; }
    for (const reader of Object.values(readers)) {
      for (const id of Object.keys(reader.books)) {
        if (tombstones.has(id) && !mergedBooks.has(id)) delete reader.books[id];
      }
    }
    saveReaders();
    const currentReader = readers[activeReaderId];
    setTheme(currentReader.settings.theme, false);
    setFontSize(Number(currentReader.settings.fontSize) || 18, false);
    renderReaders();
    const manifest = { version: 3, updatedAt: cloudManifest?.updatedAt || 0, books: syncedBooks.map((book) => bookDescriptor(book, book.contentHash, book.fileSha)), deleted: [...tombstones].map(([id, deletedAt]) => ({ id, deletedAt })) };
    const { updatedAt: ignoredUpdatedAt, ...manifestState } = manifest;
    const { updatedAt: ignoredCloudUpdatedAt, ...cloudManifestState } = cloudManifest || {};
    if (!cloudManifest || JSON.stringify(manifestState) !== JSON.stringify(cloudManifestState)) {
      manifest.updatedAt = Date.now();
      await writeGitHubJson(GITHUB_MANIFEST_PATH, manifest, branch, manifestRead?.sha || null);
    }
    cloudCatalog = { ...manifest, updatedAt: manifest.updatedAt || cloudManifest?.updatedAt || Date.now() };
    saveCloudCatalog();
    if (revision !== libraryRevision) { syncPending = true; return false; }
    const previousBook = activeBook();
    await replaceBooks(syncedLocalBooks);
    if (revision !== libraryRevision) { syncPending = true; return; }
    books = syncedLocalBooks;
    const currentBook = activeBook();
    if (!currentBook && !$(".reader-stage").hidden) {
      activeBookId = "";
      setView("library");
    } else if (currentBook && !$(".reader-stage").hidden && (!previousBook || previousBook.id !== currentBook.id || previousBook.contentUpdatedAt !== currentBook.contentUpdatedAt)) {
      readingSession += 1;
      restoringTextPosition = false;
      activeBookId = currentBook.id;
      if (currentBook.format === "epub") await showEpub(currentBook);
      else renderTextChapter(Number(readingState(currentBook).progress) || 0, false);
    }
    renderCloudCollection();
    const pendingDeleted = JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
    const syncedDeleted = new Set(localDeleted);
    const remainingDeleted = pendingDeleted.filter((id) => !syncedDeleted.has(id));
    if (remainingDeleted.length) localStorage.setItem(DELETED_BOOKS_KEY, JSON.stringify(remainingDeleted));
    else localStorage.removeItem(DELETED_BOOKS_KEY);
    manifestConflictRetries = 0;
    $("#sync-feedback").textContent = `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    $("#local-status").textContent = "已连接 GitHub";
    renderShelf();
    if (!$("#collection-view").hidden) renderCollection();
    if (!automatic) {
      $("#settings-dialog").close();
      setView("library");
      renderCollection();
      notify("书架已同步到 GitHub");
    }
    lastSyncSucceeded = true;
    return true;
  } catch (error) {
    if (runId !== syncRunId) return false;
    const isConflict = Boolean(error.isConflict);
    const willRetry = isConflict;
    if (willRetry) {
      manifestConflictRetries += 1;
      syncPending = true;
    } else {
      manifestConflictRetries = 0;
    }
    $("#sync-feedback").textContent = willRetry ? `检测到云端更新，2 秒后重新合并（第 ${manifestConflictRetries} 次）` : error.message;
    if (willRetry) {
      $("#local-status").textContent = "正在重新同步到 GitHub";
    } else if (automatic) {
      $("#local-status").textContent = "自动同步未完成，请在设置中手动连接";
    } else {
      notify(error.message);
    }
    lastSyncSucceeded = false;
    return false;
  } finally {
    if (runId === syncRunId) {
      syncInProgress = false;
      if (syncPending) {
        syncPending = false;
        setTimeout(() => syncToGitHub({ automatic: true }), 2000);
      }
      releaseSyncLock();
    }
  }
}

function bindEvents() {
  $("#reader-select").addEventListener("change", (event) => switchReader(event.target.value).catch((error) => notify(error.message)));
  $("#rename-reader").addEventListener("click", () => {
    const name = $("#reader-name").value.trim();
    if (!name) { notify("读者名字不能为空"); return; }
    readers[activeReaderId].name = name;
    readers[activeReaderId].nameUpdatedAt = Date.now();
    saveReaders();
    renderReaders();
    notify("读者名字已保存");
  });
  const persistReadingState = () => saveTextProgress(true);
  window.addEventListener("pagehide", persistReadingState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistReadingState();
  });
  $(".brand").addEventListener("click", async (event) => {
    event.preventDefault();
    await saveTextProgress(true);
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
  $("#chapter-select").addEventListener("change", (event) => {
    const book = activeBook();
    if (!book) return;
    if (book.format === "epub") {
      chapterGestureState.touchReadyChapter = chapterGestureState.touchScrollChapter = "";
      epubRendition?.display(event.target.value);
    } else renderTextChapter(Number(event.target.value));
  });
  $("#prev-chapter").addEventListener("click", () => moveChapter(-1));
  $("#next-chapter").addEventListener("click", () => moveChapter(1));
  $("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#reader-scroll").addEventListener("scroll", () => saveTextProgress(), { passive: true });
  bindChapterGestures($("#reader-scroll"));
  $("#collection-search").addEventListener("input", renderCollection);
  $("#cloud-search").addEventListener("input", renderCloudCollection);
  $("#collection-import").addEventListener("click", () => $("#file-input").click());
  $("#collection-empty-import").addEventListener("click", () => $("#file-input").click());
  $("#edit-book-form").addEventListener("submit", (event) => updateBook(event).catch((error) => notify(error.message)));
  $("#close-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
  $("#cancel-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
  $("#clear-library").addEventListener("click", async () => {
    if (!confirm("移出此设备上的全部已下载书籍？云端书库和两位读者的阅读记录会保留。")) return;
    await saveTextProgress(true);
    libraryRevision += 1;
    readingSession += 1;
    setView("library");
    epubRendition?.destroy();
    epubRendition = epubBook = null;
    epubBookId = epubBookContentVersion = null;
    await replaceBooks([]);
    books = [];
    activeBookId = "";
    renderShelf();
    setView("library");
    $("#settings-dialog").close();
    renderCloudCollection();
    notify("已移出此设备上的书籍");
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", async () => {
    await saveTextProgress(true);
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
  const hadDemoBook = books.some((book) => book.id === DEMO_BOOK_ID);
  books = books.filter((book) => book.id !== DEMO_BOOK_ID);
  const savedReaders = localStorage.getItem(READERS_KEY);
  const stored = savedReaders ? JSON.parse(savedReaders) : {};
  loadCloudCatalog();
  for (const defaults of READER_DEFAULTS) readers[defaults.id] = stored[defaults.id] || emptyReader(defaults);
  const hadDemoReaderData = Object.values(readers).some((reader) => Object.hasOwn(reader.books, DEMO_BOOK_ID) || reader.activeBookId === DEMO_BOOK_ID);
  for (const reader of Object.values(readers)) {
    delete reader.books[DEMO_BOOK_ID];
    if (reader.activeBookId === DEMO_BOOK_ID) reader.activeBookId = "";
  }
  if (hadDemoBook || hadDemoReaderData) saveReaders();
  books = migrateLegacyData(books, savedReaders ? null : { fontSize: localStorage.getItem("yejian-font-size"), theme: localStorage.getItem("yejian-theme") }, localStorage.getItem(SETTINGS_UPDATED_KEY), localStorage.getItem(ACTIVE_BOOK_KEY) || "");
  await replaceBooks(books);
  applyReader();
  renderShelf();
  setTheme(activeTheme, false);
  setFontSize(fontSize, false);
  bindEvents();
  setView("library");
  $("#crumb-title").textContent = "共用书库";
  githubToken = localStorage.getItem(GITHUB_TOKEN_KEY);
  syncToGitHub({ automatic: true }).catch((error) => { $("#sync-feedback").textContent = error.message; });
}

init().catch((error) => notify(`阅读器启动失败：${error.message}`));
