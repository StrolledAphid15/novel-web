(() => {
  const storage = window.YeJian.createStorage();
  const state = { books: [], cloudCatalog: { version: 3, updatedAt: 0, books: [], deleted: [] }, activeBookId: "", readers: {}, activeReaderId: storage.loadActiveReader(), fontSize: 18, activeTheme: "paper", libraryRevision: 0 };
  const profiles = window.YeJian.createProfiles({ state, storage });
  const view = window.YeJian.createUi({ state, storage, profiles });
  const reading = window.YeJian.createReader({ state, storage, profiles, view });
  const library = window.YeJian.createLibrary({ state, storage, profiles, view, reading, onReaderChanged: applyReader });
  const sync = window.YeJian.createSync({ state, storage, profiles, view, reading, onSelectBook: library.selectBook });
  let switchingReader = false;
  const { emptyReader, DEMO_BOOK_ID, READER_DEFAULTS, READING_FIELDS } = window.YeJian.model;
  const saveReaders = () => profiles.saveReaders();
  const $ = (selector) => document.querySelector(selector);

  function applyReader() {
    const reader = state.readers[state.activeReaderId];
    reading.setTheme(["paper", "warm", "night"].includes(reader.settings.theme) ? reader.settings.theme : "paper", false);
    reading.setFontSize(Number(reader.settings.fontSize) || 18, false);
    state.activeBookId = state.books.find((book) => book.id === reader.activeBookId)?.id || state.books[0]?.id || "";
    view.renderReaders();
  }

  async function switchReader(id) {
    if (switchingReader || id === state.activeReaderId || !state.readers[id]) return;
    switchingReader = true;
    $("#reader-select").disabled = true;
    try {
      await reading.saveProgress();
      reading.close();
      view.setView("library");
      state.activeReaderId = id;
      storage.saveActiveReader(id);
      applyReader();
      view.renderShelf();
      view.renderCollection();
      $("#crumb-title").textContent = "共用书库";
      view.notify(`已切换到${state.readers[id].name}`);
    } finally {
      switchingReader = false;
      $("#reader-select").disabled = false;
    }
  }

  function bindEvents() {
    $("#collection-grid").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-book-id]");
      if (!button) return;
      const id = button.dataset.bookId;
      if (button.classList.contains("book-edit")) view.openBookEditor(id);
      else if (button.classList.contains("book-delete")) library.removeBook(id).catch((error) => view.notify(error.message));
      else library.selectBook(id).catch((error) => view.notify(error.message));
    });
    $("#cloud-collection-grid").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-book-id]");
      if (!button) return;
      const operation = button.classList.contains("cloud-book-delete") ? sync.removeCloudBook : sync.downloadCloudBook;
      operation(button.dataset.bookId).catch((error) => view.notify(error.message));
    });
    $("#reader-select").addEventListener("change", (event) => switchReader(event.target.value).catch((error) => view.notify(error.message)));
    $("#rename-reader").addEventListener("click", () => {
      const name = $("#reader-name").value.trim();
      if (!name) { view.notify("读者名字不能为空"); return; }
      state.readers[state.activeReaderId].name = name;
      state.readers[state.activeReaderId].nameUpdatedAt = Date.now();
      saveReaders();
      view.renderReaders();
      view.notify("读者名字已保存");
    });
    reading.bindEvents();
    $(".brand").addEventListener("click", async (event) => {
      event.preventDefault();
      await reading.saveProgress();
      view.setView("library");
    });
    $("#file-input").addEventListener("change", (event) => library.importFiles(event.target.files).catch((error) => view.notify(error.message)).finally(() => { event.target.value = ""; }));
    $("#backup-input").addEventListener("change", (event) => { const file = event.target.files[0]; if (file) library.importBackup(file).catch((error) => view.notify(error.message)).finally(() => { event.target.value = ""; }); });
    $("#add-book-side").addEventListener("click", () => $("#file-input").click());
    $("#import-books").addEventListener("click", () => $("#file-input").click());
    $("#export-backup").addEventListener("click", () => library.downloadBackup().catch((error) => view.notify(error.message)));
    $("#import-backup").addEventListener("click", () => $("#backup-input").click());
    $("#sync-open").addEventListener("click", view.openSettings);
    $("#github-sync").addEventListener("click", () => sync.run());
    $("#font-down").addEventListener("click", () => reading.setFontSize(state.fontSize - 1));
    $("#font-up").addEventListener("click", () => reading.setFontSize(state.fontSize + 1));
    document.querySelectorAll(".theme-swatch").forEach((button) => button.addEventListener("click", () => reading.setTheme(button.dataset.theme)));
    $("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#collection-search").addEventListener("input", view.renderCollection);
    $("#cloud-search").addEventListener("input", view.renderCloudCollection);
    $("#collection-import").addEventListener("click", () => $("#file-input").click());
    $("#collection-empty-import").addEventListener("click", () => $("#file-input").click());
    $("#edit-book-form").addEventListener("submit", (event) => library.updateBook(event).catch((error) => view.notify(error.message)));
    $("#close-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
    $("#cancel-edit-book").addEventListener("click", () => $("#edit-book-dialog").close());
    $("#clear-library").addEventListener("click", () => library.clearLocalBooks().catch((error) => view.notify(error.message)));
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", async () => {
      await reading.saveProgress();
      view.setView(button.dataset.view);
      if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
    }));
  }

  async function init() {
    storage.clearLegacyCredentials();
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service Worker 注册失败：", error));
    }
    state.books = await storage.allBooks();
    const hadDemoBook = state.books.some((book) => book.id === DEMO_BOOK_ID);
    if (hadDemoBook) await storage.deleteBook(DEMO_BOOK_ID);
    state.books = state.books.filter((book) => book.id !== DEMO_BOOK_ID);
    const savedReaders = storage.loadReaders();
    const stored = savedReaders || {};
    state.cloudCatalog = storage.loadCloudCatalog();
    for (const defaults of READER_DEFAULTS) state.readers[defaults.id] = stored[defaults.id] || emptyReader(defaults);
    const hadDemoReaderData = Object.values(state.readers).some((reader) => Object.hasOwn(reader.books, DEMO_BOOK_ID) || reader.activeBookId === DEMO_BOOK_ID);
    for (const reader of Object.values(state.readers)) {
      delete reader.books[DEMO_BOOK_ID];
      if (reader.activeBookId === DEMO_BOOK_ID) reader.activeBookId = "";
    }
    if (hadDemoBook || hadDemoReaderData) saveReaders();
    const legacyBooks = state.books.filter((book) => READING_FIELDS.some((key) => Object.hasOwn(book, key)));
    if (!savedReaders || legacyBooks.length) {
      const legacy = storage.loadLegacyPreferences();
      const cleaned = profiles.migrateLegacyData(legacyBooks, savedReaders ? null : legacy.settings, legacy.settingsUpdatedAt, savedReaders ? "" : legacy.savedBookId);
      if (cleaned.length) {
        await storage.applyBookChanges(cleaned);
        state.books = await storage.allBooks();
      }
    }
    applyReader();
    view.renderShelf();
    reading.setTheme(state.activeTheme, false);
    reading.setFontSize(state.fontSize, false);
    bindEvents();
    view.setView("library");
    $("#crumb-title").textContent = "共用书库";
    sync.run({ automatic: true }).catch((error) => { $("#sync-feedback").textContent = error.message; });
  }

  init().catch((error) => view.notify(`阅读器启动失败：${error.message}`));
})();
