window.YeJian.createProfiles = function ({ state, storage }) {
  const { emptyReader, mergeReader, READER_DEFAULTS, READING_FIELDS } = window.YeJian.model;
  let saveTimer = null;
  let progressDirty = false;

  function saveReaders() {
    storage.saveReaders(state.readers);
    clearTimeout(saveTimer);
    saveTimer = null;
    progressDirty = false;
  }

  function flushReadingState() {
    if (progressDirty) saveReaders();
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
    state.readers[legacy.id] = mergeReader(state.readers[legacy.id], legacy);
    saveReaders();
    return cleaned;
  }

  function readingState(book, readerId = state.activeReaderId) {
    if (!book) return {};
    const progressState = state.readers[readerId].books[book.id];
    if (!progressState || (progressState.contentUpdatedAt || 0) < (book.contentUpdatedAt || book.addedAt || 0)) return {};
    return progressState;
  }

  function updateReadingState(book, changes, { defer = false } = {}) {
    state.readers[state.activeReaderId].books[book.id] = { ...readingState(book), ...changes, contentUpdatedAt: book.contentUpdatedAt || book.addedAt || 0 };
    progressDirty = true;
    if (!defer) saveReaders();
    else if (saveTimer === null) saveTimer = setTimeout(() => { saveTimer = null; flushReadingState(); }, 500);
  }

  return { migrateLegacyData, readingState, updateReadingState, saveReaders, flushReadingState };
};
