window.YeJian.createTextReader = function ({ state, profiles, view }) {
  const $ = (selector) => document.querySelector(selector);
  let currentBook = null;
  let activeChapter = 0;
  let readingSession = 0;
  let restoringTextPosition = false;

  function saveProgress({ defer = false } = {}) {
    const book = currentBook;
    if (!book || book.format !== "text" || $(".reader-stage").hidden || restoringTextPosition) {
      if (!defer) profiles.flushReadingState();
      return;
    }
    const scroller = $("#reader-scroll");
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const progress = activeChapter;
    const scrollProgress = maxScroll ? Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)) : 0;
    const progressState = profiles.readingState(book);
    const changed = (progressState.progress || 0) !== progress || (progressState.scrollProgress || 0) !== scrollProgress;
    if (changed) {
      profiles.updateReadingState(book, { progress, scrollProgress, progressUpdatedAt: Date.now() }, { defer });
    }
    if (!defer) profiles.flushReadingState();
  }

  function renderChapter(index, save = true, { position = "start" } = {}) {
    if (save) saveProgress();
    const book = currentBook;
    const chapters = book?.chapters || [];
    if (!chapters.length) return;
    activeChapter = Math.max(0, Math.min(index, chapters.length - 1));
    const chapter = chapters[activeChapter];
    $("#text-page").hidden = false;
    $("#epub-host").hidden = true;
    $("#chapter-title").textContent = chapter.title;
    $("#chapter-subtitle").textContent = chapter.subtitle || "";
    $("#book-author").textContent = book.author || "未知作者";
    $("#chapter-content").innerHTML = chapter.paragraphs.map((line) => `<p>${view.safeText(line)}</p>`).join("");
    $("#chapter-reading-time").textContent = `约 ${Math.max(1, Math.ceil(chapter.paragraphs.join("").length / 500))} 分钟`;
    $("#chapter-counter").textContent = `${String(activeChapter + 1).padStart(2, "0")} / ${String(chapters.length).padStart(2, "0")}`;
    $("#chapter-select").innerHTML = chapters.map((item, i) => `<option value="${i}" ${i === activeChapter ? "selected" : ""}>${view.safeText(item.title)}</option>`).join("");
    $("#prev-chapter").disabled = activeChapter === 0;
    $("#next-chapter").disabled = activeChapter === chapters.length - 1;
    $("#progress-fill").style.width = `${((activeChapter + 1) / chapters.length) * 100}%`;
    $("#progress-percent").textContent = `${Math.round(((activeChapter + 1) / chapters.length) * 100)}%`;
    $("#progress-chapter").textContent = `第 ${activeChapter + 1} 章 · ${chapter.title.replace(/^第.{1,8}章[　 ]*/, "")}`;
    const scroller = $("#reader-scroll");
    restoringTextPosition = true;
    scroller.scrollTop = 0;
    const scrollProgress = save ? (position === "end" ? 1 : 0) : Math.min(1, Math.max(0, Number(profiles.readingState(book).scrollProgress) || 0));
    const targetChapter = activeChapter;
    const session = readingSession;
    const restorePosition = () => {
      if (session !== readingSession || state.activeBookId !== book.id || activeChapter !== targetChapter) return;
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * scrollProgress;
      requestAnimationFrame(() => { if (session === readingSession && activeChapter === targetChapter) restoringTextPosition = false; });
    };
    requestAnimationFrame(restorePosition);
    $("#crumb-title").textContent = book.title;
    $("#reading-state").textContent = "正在阅读";
    if (save) {
      profiles.updateReadingState(book, { progress: activeChapter, scrollProgress, progressUpdatedAt: Date.now() });
    }
  }

  function open(book) {
    readingSession += 1;
    currentBook = book;
    restoringTextPosition = false;
    setFontSize(state.fontSize);
    renderChapter(Number(profiles.readingState(book).progress) || 0, false);
  }

  function setFontSize(size) {
    $("#chapter-content").style.fontSize = `${size}px`;
  }

  function close() {
    readingSession += 1;
    currentBook = null;
    restoringTextPosition = false;
  }

  return {
    open, close, saveProgress, setFontSize,
    selectChapter: (value) => renderChapter(Number(value)),
    moveChapter: (offset, options) => renderChapter(activeChapter + offset, true, options),
    chapterKey: () => restoringTextPosition ? null : activeChapter,
    scrollContainers: () => []
  };
};
