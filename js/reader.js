window.YeJian.createReader = function ({ state, storage, profiles, view }) {
  const { isCloudContent } = window.YeJian.model;
  const $ = (selector) => document.querySelector(selector);
  const saveReaders = () => profiles.saveReaders();
  let currentBook = null;
  let activeAdapter = null;
  let readingSession = 0;
  const activeBook = () => currentBook;
  const chapterGestureState = { wheelAt: -Infinity, wheelChapter: "", wheelOffset: 0, wheelAtEdge: false, wheelUsed: false, touchReady: null, touchScroll: null, changing: false };
  const textReader = window.YeJian.createTextReader({ state, profiles, view });
  const epubReader = window.YeJian.createEpubReader({ state, storage, profiles, view, bindChapterGestures });

  function bindChapterGestures(target) {
    let touch = null;
    const chapterKey = () => {
      const book = activeBook();
      if (!book || $(".reader-stage").hidden || chapterGestureState.changing || document.querySelector("dialog[open]")) return "";
      const index = activeAdapter?.chapterKey();
      if (index == null) return "";
      return `${readingSession}:${book.id}:${index}`;
    };
    const canMove = (offset) => !$(offset < 0 ? "#prev-chapter" : "#next-chapter").disabled;
    const atEdge = (offset) => {
      // EPUB iframes expand to content height; their outer containers do the scrolling.
      const scrollers = [$("#reader-scroll"), ...(activeAdapter?.scrollContainers() || [])];
      return scrollers.filter(Boolean).every((scroller) => offset < 0
        ? scroller.scrollTop <= 3
        : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 3);
    };
    const turnChapter = async (offset) => {
      const session = readingSession;
      resetChapterGesture();
      chapterGestureState.changing = true;
      try {
        await moveChapter(offset, { position: offset < 0 ? "end" : "start" });
      } catch (error) {
        if (session === readingSession) view.notify(error.message);
      } finally {
        if (session === readingSession) chapterGestureState.changing = false;
      }
    };
    target.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const now = performance.now();
      const key = chapterKey();
      const offset = event.deltaY > 0 ? 1 : -1;
      if (now - chapterGestureState.wheelAt > 200) {
        chapterGestureState.wheelChapter = key;
        chapterGestureState.wheelOffset = offset;
        chapterGestureState.wheelAtEdge = atEdge(offset);
        chapterGestureState.wheelUsed = false;
      }
      chapterGestureState.wheelAt = now;
      if (offset !== chapterGestureState.wheelOffset) chapterGestureState.wheelAtEdge = false;
      if (!key || key !== chapterGestureState.wheelChapter || !canMove(offset) || !chapterGestureState.wheelAtEdge || chapterGestureState.wheelUsed || !atEdge(offset)) return;
      event.preventDefault();
      chapterGestureState.wheelUsed = true;
      turnChapter(offset);
    }, { passive: false, capture: true });
    target.addEventListener("scroll", () => {
      const key = chapterKey();
      if (!key) return;
      const ready = chapterGestureState.touchReady;
      const scrolling = chapterGestureState.touchScroll;
      if (ready && (ready.chapter !== key || !atEdge(ready.offset))) chapterGestureState.touchReady = null;
      if (scrolling?.chapter === key && canMove(scrolling.offset) && atEdge(scrolling.offset)) chapterGestureState.touchReady = scrolling;
    }, { passive: true, capture: true });
    target.addEventListener("touchstart", (event) => {
      touch = null;
      chapterGestureState.touchScroll = null;
      const key = chapterKey();
      if (event.touches.length !== 1 || !key) return;
      const ready = chapterGestureState.touchReady;
      if (ready && (ready.chapter !== key || !atEdge(ready.offset))) chapterGestureState.touchReady = null;
      const point = event.touches[0];
      touch = { id: point.identifier, x: point.screenX, y: point.screenY, chapter: key, startedAtTop: atEdge(-1), startedAtBottom: atEdge(1), readyOffset: chapterGestureState.touchReady?.offset };
    }, { passive: true, capture: true });
    target.addEventListener("touchmove", (event) => {
      if (event.touches.length !== 1) { touch = null; chapterGestureState.touchScroll = null; return; }
      if (!touch || touch.chapter !== chapterKey()) return;
      const point = event.touches[0];
      const distance = touch.y - point.screenY;
      const offset = distance > 0 ? 1 : -1;
      if (Math.abs(distance) > Math.abs(point.screenX - touch.x) && canMove(offset)) {
        chapterGestureState.touchScroll = { chapter: touch.chapter, offset };
        const startedAtEdge = offset < 0 ? touch.startedAtTop : touch.startedAtBottom;
        if (startedAtEdge && atEdge(offset) && event.cancelable) event.preventDefault();
      }
    }, { passive: false, capture: true });
    target.addEventListener("touchend", (event) => {
      const gesture = touch;
      touch = null;
      if (!gesture || gesture.chapter !== chapterKey()) return;
      const point = Array.from(event.changedTouches).find((item) => item.identifier === gesture.id);
      if (!point) return;
      const distance = gesture.y - point.screenY;
      const offset = distance > 0 ? 1 : -1;
      if (Math.abs(distance) < 48 || Math.abs(distance) <= Math.abs(point.screenX - gesture.x) || !canMove(offset)) return;
      const scrolling = { chapter: gesture.chapter, offset };
      chapterGestureState.touchScroll = scrolling;
      if (!atEdge(offset)) return;
      const startedAtEdge = offset < 0 ? gesture.startedAtTop : gesture.startedAtBottom;
      if (startedAtEdge && gesture.readyOffset === offset) turnChapter(offset);
      else chapterGestureState.touchReady = scrolling;
    }, { passive: true, capture: true });
    target.addEventListener("touchcancel", () => { touch = null; }, { passive: true, capture: true });
  }

  function setTheme(theme, sync = true) {
    theme = ["paper", "warm", "night"].includes(theme) ? theme : "paper";
    state.activeTheme = theme;
    const stage = document.querySelector(".reader-stage");
    stage.classList.remove("theme-paper", "theme-warm", "theme-night");
    stage.classList.add(`theme-${theme}`);
    document.querySelectorAll(".settings-dialog").forEach((dialog) => {
      dialog.classList.remove("theme-paper", "theme-warm", "theme-night");
      dialog.classList.add(`theme-${theme}`);
    });
    if (!$(".reader-stage").hidden) {
      const mainArea = document.querySelector(".main-area");
      mainArea.classList.remove("theme-paper", "theme-warm", "theme-night");
      mainArea.classList.add(`theme-${theme}`);
    }
    document.querySelectorAll(".theme-swatch").forEach((button) => button.classList.toggle("selected", button.dataset.theme === theme));
    document.querySelector("meta[name='theme-color']").content = theme === "night" ? "#222623" : theme === "warm" ? "#f4f0e7" : "#f7f7f4";
    if (sync) {
      state.readers[state.activeReaderId].settings.theme = theme;
      state.readers[state.activeReaderId].settingsUpdatedAt = Date.now();
      saveReaders();
    }
    activeAdapter?.setTheme?.(theme);
  }

  function setFontSize(size, sync = true) {
    state.fontSize = Math.max(14, Math.min(28, size));
    $("#font-size-value").textContent = state.fontSize;
    if (sync) {
      state.readers[state.activeReaderId].settings.fontSize = state.fontSize;
      state.readers[state.activeReaderId].settingsUpdatedAt = Date.now();
      saveReaders();
    }
    activeAdapter?.setFontSize?.(state.fontSize);
  }

  function saveProgress({ defer = false } = {}) {
    activeAdapter?.saveProgress?.({ defer });
    if (!defer) profiles.flushReadingState();
  }

  function resetChapterGesture() {
    chapterGestureState.touchReady = chapterGestureState.touchScroll = null;
  }

  async function moveChapter(offset, options) {
    resetChapterGesture();
    await activeAdapter?.moveChapter(offset, options);
  }

  function close() {
    profiles.flushReadingState();
    readingSession += 1;
    resetChapterGesture();
    chapterGestureState.changing = false;
    activeAdapter?.close();
    activeAdapter = null;
    currentBook = null;
  }

  async function open(book) {
    close();
    const session = readingSession;
    book = isCloudContent(book) ? book : await storage.getBook(book.id);
    if (session !== readingSession) return;
    if (!book) throw new Error("这本书已不在本机，请重新下载或导入");
    currentBook = book;
    activeAdapter = book.format === "epub" ? epubReader : textReader;
    await activeAdapter.open(book);
    if (session === readingSession && window.innerWidth <= 760) $("#sidebar").classList.remove("open");
  }

  function bindEvents() {
    window.addEventListener("pagehide", () => saveProgress());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveProgress();
    });
    $("#chapter-select").addEventListener("change", async (event) => {
      resetChapterGesture();
      try { await activeAdapter?.selectChapter(event.target.value); }
      catch (error) { view.notify(error.message); }
    });
    $("#prev-chapter").addEventListener("click", () => moveChapter(-1).catch((error) => view.notify(error.message)));
    $("#next-chapter").addEventListener("click", () => moveChapter(1).catch((error) => view.notify(error.message)));
    $("#reader-scroll").addEventListener("scroll", () => saveProgress({ defer: true }), { passive: true });
    bindChapterGestures($("#reader-scroll"));
  }

  return { open, close, saveProgress, setTheme, setFontSize, bindEvents };
};
