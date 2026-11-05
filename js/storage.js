window.YeJian.createStorage = function () {
  const { normalizeTextChapters, bookMetadata, isCloudContent, READER_DEFAULTS } = window.YeJian.model;
  const DB_NAME = "yejian-reader";
  const DB_VERSION = 2;
  const GITHUB_REPO_KEY = "yejian-github-repo";
  const GITHUB_BRANCH_KEY = "yejian-github-branch";
  const GITHUB_TOKEN_KEY = "yejian-github-token";
  const DELETED_BOOKS_KEY = "yejian-deleted-books";
  const SETTINGS_UPDATED_KEY = "yejian-settings-updated-at";
  const ACTIVE_BOOK_KEY = "yejian-active-book-id";
  const READERS_KEY = "yejian-readers-v1";
  const ACTIVE_READER_KEY = "yejian-active-reader";
  const CLOUD_CATALOG_KEY = "yejian-cloud-catalog-v1";
  const SYNC_LOCK_KEY = "yejian-github-sync-lock";
  const dbPromise = openDatabase();

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
        const contents = db.createObjectStore("bookContents", { keyPath: "id" });
        const cursorRequest = request.transaction.objectStore("books").openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const { metadata, content } = splitBook(cursor.value);
          contents.put(content);
          cursor.update(metadata);
          cursor.continue();
        };
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onblocked = () => reject(new Error("请关闭其他阅读器页面后刷新，以升级本地书库"));
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

  function splitBook(book) {
    const normalized = book.format === "text" ? { ...book, chapters: normalizeTextChapters(book.chapters) } : book;
    const content = normalized.format === "text" ? { id: book.id, chapters: normalized.chapters } : { id: book.id, data: book.data };
    if (book.locations) content.locations = book.locations;
    return { metadata: bookMetadata(normalized), content };
  }

  async function getBook(id) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["books", "bookContents"]);
      const metadata = transaction.objectStore("books").get(id);
      const content = transaction.objectStore("bookContents").get(id);
      transaction.oncomplete = () => resolve(metadata.result && content.result ? { ...metadata.result, ...content.result } : null);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function exportBooks() {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["books", "bookContents"]);
      const metadata = transaction.objectStore("books").getAll();
      const contents = transaction.objectStore("bookContents").getAll();
      transaction.oncomplete = () => {
        const byId = new Map(contents.result.map((content) => [content.id, content]));
        resolve(metadata.result.map((book) => ({ ...book, ...byId.get(book.id) })));
      };
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function writeBooks(rows, deleted = [], replace = false) {
    const entries = rows.map((book) => isCloudContent(book) ? splitBook(book) : { metadata: bookMetadata(book) });
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["books", "bookContents"], "readwrite");
      const store = transaction.objectStore("books");
      const contents = transaction.objectStore("bookContents");
      if (replace) { store.clear(); contents.clear(); }
      deleted.forEach((id) => { store.delete(id); contents.delete(id); });
      entries.forEach(({ metadata, content }) => {
        store.put(metadata);
        if (content) contents.put(content);
      });
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function saveBook(book) {
    if (!isCloudContent(book)) throw new Error("书籍正文不完整，无法保存");
    return writeBooks([book]);
  }

  function saveBookMetadata(book) {
    return writeBooks([bookMetadata(book)]);
  }

  async function saveBookLocations(id, locations, contentVersion) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["books", "bookContents"], "readwrite");
      const store = transaction.objectStore("bookContents");
      const metadata = transaction.objectStore("books").get(id);
      const request = store.get(id);
      request.onsuccess = () => {
        const book = metadata.result;
        if (book?.format === "epub" && (book.contentUpdatedAt || book.updatedAt || book.addedAt || 0) === contentVersion && request.result) store.put({ ...request.result, locations });
      };
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  const deleteBook = (id) => writeBooks([], [id]);
  const replaceBooks = (rows) => writeBooks(rows, [], true);

  function loadReaders() {
    const saved = localStorage.getItem(READERS_KEY);
    return saved ? JSON.parse(saved) : null;
  }

  function saveReaders(readers) {
    localStorage.setItem(READERS_KEY, JSON.stringify(readers));
  }

  function loadCloudCatalog() {
    const empty = { version: 3, updatedAt: 0, books: [], deleted: [] };
    try {
      const stored = JSON.parse(localStorage.getItem(CLOUD_CATALOG_KEY) || "null");
      return stored && Array.isArray(stored.books) && Array.isArray(stored.deleted) ? { ...empty, ...stored } : empty;
    } catch {
      localStorage.removeItem(CLOUD_CATALOG_KEY);
      return empty;
    }
  }

  function saveCloudCatalog(catalog) {
    localStorage.setItem(CLOUD_CATALOG_KEY, JSON.stringify(catalog));
  }

  function loadActiveReader() {
    const id = localStorage.getItem(ACTIVE_READER_KEY);
    return READER_DEFAULTS.some((reader) => reader.id === id) ? id : "reader-a";
  }

  function saveActiveReader(id) {
    localStorage.setItem(ACTIVE_READER_KEY, id);
  }

  function loadGitHubConfig() {
    return { repository: (localStorage.getItem(GITHUB_REPO_KEY) || "").trim(), token: (localStorage.getItem(GITHUB_TOKEN_KEY) || "").trim(), sourceBranch: (localStorage.getItem(GITHUB_BRANCH_KEY) || "main").trim() };
  }

  function saveGitHubConfig({ repository, token, sourceBranch }) {
    localStorage.setItem(GITHUB_REPO_KEY, repository);
    localStorage.setItem(GITHUB_TOKEN_KEY, token);
    localStorage.setItem(GITHUB_BRANCH_KEY, sourceBranch);
  }

  function clearGitHubToken(token) {
    if (localStorage.getItem(GITHUB_TOKEN_KEY) === token) localStorage.removeItem(GITHUB_TOKEN_KEY);
  }

  function loadDeletedBooks() {
    return JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY) || "[]");
  }

  function saveDeletedBooks(ids) {
    if (ids.length) localStorage.setItem(DELETED_BOOKS_KEY, JSON.stringify(ids));
    else localStorage.removeItem(DELETED_BOOKS_KEY);
  }

  function loadSyncLock() {
    return JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || "null");
  }

  function saveSyncLock(lock) {
    if (lock) localStorage.setItem(SYNC_LOCK_KEY, JSON.stringify(lock));
    else localStorage.removeItem(SYNC_LOCK_KEY);
  }

  function loadLegacyPreferences() {
    return { settings: { fontSize: localStorage.getItem("yejian-font-size"), theme: localStorage.getItem("yejian-theme") }, settingsUpdatedAt: localStorage.getItem(SETTINGS_UPDATED_KEY), savedBookId: localStorage.getItem(ACTIVE_BOOK_KEY) || "" };
  }

  function clearLegacyCredentials() {
    localStorage.removeItem("yejian-onedrive-client-id");
    localStorage.removeItem("yejian-google-client-id");
    localStorage.removeItem("yejian-google-access-token");
    sessionStorage.removeItem("yejian-google-access-token");
  }

  return { allBooks, getBook, exportBooks, saveBook, saveBookMetadata, saveBookLocations, applyBookChanges: writeBooks, deleteBook, replaceBooks, loadReaders, saveReaders, loadCloudCatalog, saveCloudCatalog, loadActiveReader, saveActiveReader, loadGitHubConfig, saveGitHubConfig, clearGitHubToken, loadDeletedBooks, saveDeletedBooks, loadSyncLock, saveSyncLock, loadLegacyPreferences, clearLegacyCredentials };
};
