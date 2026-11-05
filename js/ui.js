window.YeJian.createUi = function ({ state, storage, profiles }) {
  const { READER_DEFAULTS } = window.YeJian.model;
  const isLocalBook = (id) => window.YeJian.model.isLocalBook(state, id);
  const $ = (selector) => document.querySelector(selector);
  let toastTimer;

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

  function renderReaders() {
    $("#reader-select").innerHTML = READER_DEFAULTS.map(({ id }) => `<option value="${id}" ${id === state.activeReaderId ? "selected" : ""}>${safeText(state.readers[id].name)}</option>`).join("");
    $("#reader-name").value = state.readers[state.activeReaderId].name;
    $("#collection-eyebrow").textContent = `${state.readers[state.activeReaderId].name} · 共用书库`;
  }

  function renderShelf() {
    $("#book-count").textContent = state.books.length;
    $("#cloud-book-count").textContent = state.cloudCatalog.books.length;
  }

  function renderCollection() {
    const query = $("#collection-search").value.trim().toLocaleLowerCase();
    const visibleBooks = [...state.books]
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .filter((book) => `${book.title} ${book.author || ""}`.toLocaleLowerCase().includes(query));
    $("#collection-count").textContent = `${visibleBooks.length} 本书`;
    $("#collection-grid").hidden = visibleBooks.length === 0;
    $("#collection-empty").hidden = visibleBooks.length !== 0;
    $("#collection-empty-title").textContent = state.books.length && query ? "没有找到匹配的书" : "这里还没有书";
    $("#collection-empty-copy").textContent = state.books.length && query ? "试试其他书名或作者。" : "导入 TXT、Markdown 或 EPUB 开始阅读。";
    $("#collection-grid").innerHTML = visibleBooks.map((book) => {
      const chapterCount = book.chapters?.length || book.chapterCount || 0;
      const progressState = profiles.readingState(book);
      const percent = !progressState.lastOpenedAt && !progressState.progress && !progressState.scrollProgress && !progressState.cfi ? 0 : book.format === "text" ? chapterCount ? Math.round((((Number(progressState.progress) || 0) + 1) / chapterCount) * 100) : 0 : Math.round((Number(progressState.progress) || 0) * 100);
      const format = book.format === "epub" ? "EPUB" : book.title.match(/\.md$/i) ? "MD" : "TXT";
      return `<article class="collection-card"><button class="collection-open" data-book-id="${safeText(book.id)}" aria-label="阅读：${safeText(book.title)}"><span class="collection-cover"><span>${safeText(book.title.slice(0, 1))}</span><small>${format}</small></span><span class="collection-card-copy"><strong>${safeText(book.title)}</strong><span class="collection-author">${safeText(book.author || "未知作者")}</span><span class="collection-progress"><span><i style="width:${Math.min(100, percent)}%"></i></span><small>${percent}%</small></span></span></button><span class="collection-card-actions"><button class="text-button book-edit" data-book-id="${safeText(book.id)}">编辑</button><button class="text-button book-delete" data-book-id="${safeText(book.id)}">移出设备</button></span></article>`;
    }).join("");
  }

  function renderCloudCollection() {
    const query = $("#cloud-search").value.trim().toLocaleLowerCase();
    const visibleBooks = [...state.cloudCatalog.books]
      .sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0))
      .filter((book) => `${book.title} ${book.author || ""}`.toLocaleLowerCase().includes(query));
    $("#cloud-collection-count").textContent = `${visibleBooks.length} 本书`;
    $("#cloud-collection-grid").hidden = visibleBooks.length === 0;
    $("#cloud-collection-empty").hidden = visibleBooks.length !== 0;
    $("#cloud-collection-grid").innerHTML = visibleBooks.map((book) => {
      const progressState = profiles.readingState(book);
      const chapterCount = book.chapters?.length || book.chapterCount || 0;
      const percent = !progressState.lastOpenedAt && !progressState.progress && !progressState.scrollProgress && !progressState.cfi ? 0 : book.format === "text" ? chapterCount ? Math.round((((Number(progressState.progress) || 0) + 1) / chapterCount) * 100) : 0 : Math.round((Number(progressState.progress) || 0) * 100);
      const format = book.format === "epub" ? "EPUB" : book.title.match(/\.md$/i) ? "MD" : "TXT";
      const local = isLocalBook(book.id);
      const action = local ? "已在本机" : "下载到本机";
      return `<article class="collection-card cloud-card"><button class="collection-open cloud-book-open" data-book-id="${safeText(book.id)}" aria-label="${local ? "打开" : "下载并打开"}：${safeText(book.title)}"><span class="collection-cover"><span>${safeText(book.title.slice(0, 1))}</span><small>${format}</small><span class="cloud-download-overlay" hidden><span class="download-ring"><span>0%</span></span></span></span><span class="collection-card-copy"><strong>${safeText(book.title)}</strong><span class="collection-author">${safeText(book.author || "未知作者")}</span><span class="cloud-book-status">${action}</span><span class="collection-progress"><span><i style="width:${Math.min(100, percent)}%"></i></span><small>${percent}%</small></span></span></button><span class="collection-card-actions"><button class="text-button cloud-book-delete" data-book-id="${safeText(book.id)}">删除云端</button></span></article>`;
    }).join("");
  }

  function openBookEditor(id) {
    const book = state.books.find((item) => item.id === id);
    if (!book) return;
    $("#edit-book-id").value = book.id;
    $("#edit-book-title").value = book.title;
    $("#edit-book-author").value = book.author || "";
    $("#replace-book-file").value = "";
    $("#edit-book-dialog").showModal();
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
    if (!inLibrary && !inCloud) mainArea.classList.add(`theme-${state.activeTheme}`);
    $("#view-title").textContent = inCloud ? "云端书库" : inLibrary ? "我的书架" : "正在阅读";
    if (inLibrary) renderCollection();
    if (inCloud) renderCloudCollection();
  }

  function setCloudDownloadProgress(id, progress) {
    const overlay = $(`#cloud-collection-grid [data-book-id="${CSS.escape(id)}"] .cloud-download-overlay`);
    if (!overlay) return;
    overlay.hidden = false;
    const percent = progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100);
    overlay.style.setProperty("--download-progress", percent == null ? "25%" : `${percent}%`);
    overlay.querySelector(".download-ring span").textContent = percent == null ? "…" : `${percent}%`;
  }

  function openSettings() {
    renderReaders();
    $("#github-repository").value = storage.loadGitHubConfig().repository;
    $("#github-branch").value = storage.loadGitHubConfig().sourceBranch;
    $("#github-token").value = storage.loadGitHubConfig().token;
    $("#settings-dialog").showModal();
  }

  function readGitHubConfig() {
    return { repository: $("#github-repository").value.trim(), token: $("#github-token").value.trim(), sourceBranch: ($("#github-branch").value || "main").trim() };
  }

  function setSyncFeedback(message) { $("#sync-feedback").textContent = message; }
  function setLocalStatus(message) { $("#local-status").textContent = message; }
  function isReading() { return !$(".reader-stage").hidden; }
  function isLibrary() { return !$("#collection-view").hidden; }
  function closeSettings() { $("#settings-dialog").close(); }
  function closeBookEditor() { $("#edit-book-dialog").close(); }

  return { notify, safeText, renderReaders, renderShelf, renderCollection, renderCloudCollection, openBookEditor, setView, setCloudDownloadProgress, openSettings, readGitHubConfig, setSyncFeedback, setLocalStatus, isReading, isLibrary, closeSettings, closeBookEditor };
};
