window.YeJian.createEpubReader = function ({ state, storage, profiles, view, bindChapterGestures }) {
  const { flattenToc } = window.YeJian.model;
  const $ = (selector) => document.querySelector(selector);
  let epubBook = null;
  let rendition = null;
  let chapters = [];
  let activeChapter = 0;
  let readingSession = 0;
  let chapterNavigation = 0;
  let restoringPosition = false;

  const scrollContainers = () => [rendition?.manager?.container, $("#epub-host")];

  function setTheme(theme) {
    if (!rendition) return;
    const ink = theme === "night" ? "#dddcd2" : theme === "warm" ? "#453d34" : "#373833";
    const background = theme === "night" ? "#222623" : theme === "warm" ? "#f4f0e7" : "#fbfbf9";
    const link = theme === "night" ? "#a8c7b3" : "#476b5c";
    rendition.themes.default({
      body: { color: `${ink} !important`, background: `${background} !important` },
      "body *": { color: `${ink} !important`, "-webkit-text-fill-color": `${ink} !important` },
      "a, a *": { color: `${link} !important`, "-webkit-text-fill-color": `${link} !important` }
    });
  }

  function setFontSize(size) {
    rendition?.themes.fontSize(`${size}px`);
  }

  function close() {
    readingSession += 1;
    chapterNavigation += 1;
    restoringPosition = false;
    rendition?.destroy();
    rendition = null;
    epubBook?.destroy();
    epubBook = null;
    chapters = [];
    activeChapter = 0;
  }

  async function open(book) {
    close();
    const session = readingSession;
    const isCurrent = () => session === readingSession;
    restoringPosition = true;
    $("#text-page").hidden = true;
    $("#epub-host").hidden = false;
    $("#epub-host").replaceChildren();
    try {
      if (!window.JSZip || !window.ePub) throw new Error("EPUB 阅读组件未加载，请检查网络后刷新页面。");
      await new Promise(requestAnimationFrame);
      if (!isCurrent()) return;
      const currentBook = ePub(book.data);
      epubBook = currentBook;
      const contentVersion = book.contentUpdatedAt || book.updatedAt || book.addedAt || 0;
      await currentBook.ready;
      if (!isCurrent()) return;
      if (book.locations) currentBook.locations.load(book.locations);
      else {
        await currentBook.locations.generate(1000);
        if (!isCurrent()) return;
        book.locations = currentBook.locations.save();
        await storage.saveBookLocations(book.id, book.locations, contentVersion);
      }
      if (!isCurrent()) return;
      const [navigation, metadata] = await Promise.all([
        currentBook.loaded.navigation.catch(() => ({ toc: [] })),
        currentBook.loaded.metadata.catch(() => ({}))
      ]);
      if (!isCurrent()) return;
      if (metadata.creator && metadata.creator !== book.author) {
        book.author = metadata.creator;
        book.metadataUpdatedAt = Date.now();
        const stored = state.books.find((item) => item.id === book.id);
        if (stored) {
          state.libraryRevision += 1;
          stored.author = book.author;
          stored.metadataUpdatedAt = book.metadataUpdatedAt;
          await storage.saveBookMetadata(stored);
        }
      }
      if (!isCurrent()) return;
      const spineItems = currentBook.spine.spineItems || [];
      const toc = flattenToc(navigation.toc);
      chapters = toc.length ? toc : spineItems.map((item, index) => ({ href: item.href, label: `第 ${index + 1} 节` }));
      if (!chapters.length) throw new Error("这本 EPUB 没有可读取的章节。");
      $("#chapter-select").innerHTML = chapters.map((item) => `<option value="${view.safeText(item.href)}">${view.safeText(item.label)}</option>`).join("");
      $("#prev-chapter").disabled = true;
      $("#next-chapter").disabled = chapters.length < 2;
      const currentRendition = currentBook.renderTo("epub-host", { manager: "default", width: "100%", height: "100%", flow: "scrolled-doc" });
      rendition = currentRendition;
      currentRendition.themes.default({
        body: { "line-height": "2 !important", padding: "18px !important" },
        "body, body *": { "font-family": "'YeJianReading', serif !important" }
      });
      const readingFontUrl = new URL("./fonts/FZFWZHUZGDLMCJW.TTF", document.baseURI).href;
      currentRendition.hooks.content.register((contents) => {
        if (!isCurrent()) return;
        const style = contents.document.createElement("style");
        style.textContent = `@font-face { font-family: "YeJianReading"; src: url("${readingFontUrl}") format("truetype"); font-style: normal; font-weight: 400; } body, body * { font-family: "YeJianReading", serif !important; }`;
        (contents.document.head || contents.document.documentElement).append(style);
        bindChapterGestures(contents.document);
      });
      setFontSize(state.fontSize);
      setTheme(state.activeTheme);
      const updateLocation = (location) => {
        if (!isCurrent() || $(".reader-stage").hidden) return;
        const href = (location.start.href || "").split("#")[0];
        const spineHref = spineItems[location.start.index]?.href;
        const chapter = chapters.find((item) => item.href.split("#")[0] === href) || chapters.find((item) => item.href.split("#")[0] === spineHref) || chapters[0];
        activeChapter = chapters.indexOf(chapter);
        const percent = currentBook.locations.percentageFromCfi(location.start.cfi) || 0;
        const progressState = profiles.readingState(book);
        if (progressState.cfi !== location.start.cfi || progressState.progress !== percent) {
          profiles.updateReadingState(book, { cfi: location.start.cfi, progress: percent, progressUpdatedAt: Date.now() }, { defer: true });
        }
        $("#chapter-title").textContent = chapter.label;
        $("#chapter-select").value = chapter.href;
        $("#chapter-counter").textContent = `${String(activeChapter + 1).padStart(2, "0")} / ${String(chapters.length).padStart(2, "0")}`;
        $("#prev-chapter").disabled = activeChapter === 0;
        $("#next-chapter").disabled = activeChapter >= chapters.length - 1;
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
      currentRendition.on("relocated", updateLocation);
      await currentRendition.display(profiles.readingState(book).cfi || chapters[0].href);
      if (!isCurrent()) return;
      const current = currentRendition.currentLocation();
      if (current?.start) updateLocation(current);
      $("#crumb-title").textContent = book.title;
      $("#reader-scroll").scrollTop = 0;
      restoringPosition = false;
    } catch (error) {
      if (!isCurrent()) return;
      close();
      $("#epub-host").hidden = true;
      $("#text-page").hidden = false;
      $("#chapter-title").textContent = "无法打开这本 EPUB";
      $("#chapter-content").textContent = error.message;
      $("#chapter-select").replaceChildren();
      view.notify(error.message);
    }
  }

  async function selectChapter(value, { position = "start" } = {}) {
    if (!rendition) return;
    const currentRendition = rendition;
    const session = readingSession;
    const navigation = ++chapterNavigation;
    const isCurrent = () => session === readingSession && navigation === chapterNavigation;
    restoringPosition = true;
    profiles.flushReadingState();
    try {
      await currentRendition.display(value);
      if (!isCurrent()) return;
      if (position === "end") {
        // Wait for the chapter's font and iframe layout before measuring its bottom.
        await new Promise(requestAnimationFrame);
        if (!isCurrent()) return;
        await Promise.all(currentRendition.getContents().map((contents) => contents.document.fonts?.ready));
        await new Promise(requestAnimationFrame);
        if (!isCurrent()) return;
        [...scrollContainers(), $("#reader-scroll")].filter(Boolean).forEach((scroller) => {
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        });
        // epub.js reports the new CFI on the next frame; flush after that report.
        await currentRendition.reportLocation();
        await new Promise(requestAnimationFrame);
      }
      if (isCurrent()) profiles.flushReadingState();
    } finally {
      if (isCurrent()) restoringPosition = false;
    }
  }

  function moveChapter(offset, options) {
    const index = activeChapter + offset;
    if (!chapters[index]) return;
    activeChapter = index;
    return selectChapter(chapters[index].href, options);
  }

  return {
    open, close, setTheme, setFontSize, selectChapter, moveChapter,
    chapterKey: () => rendition && !restoringPosition ? activeChapter : null,
    scrollContainers
  };
};
