window.YeJian.createLibrary = function ({ state, storage, profiles, view, reading, onReaderChanged }) {
  const { emptyReader, decodeTextFile, splitIntoChapters, encodeBackup, decodeBackup, isCloudContent, READER_DEFAULTS } = window.YeJian.model;
  const saveReaders = () => profiles.saveReaders();
  const $ = (selector) => document.querySelector(selector);

  async function selectBook(id, { persistCurrent = true } = {}) {
    if (persistCurrent) await reading.saveProgress();
    const book = state.books.find((item) => item.id === id);
    if (!book) return;
    state.activeBookId = id;
    state.readers[state.activeReaderId].activeBookId = book.id;
    state.readers[state.activeReaderId].activeBookUpdatedAt = Date.now();
    profiles.updateReadingState(book, { lastOpenedAt: Date.now() });
    view.renderShelf();
    view.setView("reader");
    await reading.open(book);
  }

  async function removeBook(id) {
    const book = state.books.find((item) => item.id === id);
    if (!book || !confirm(`从此设备移出《${book.title}》？云端书库和两位读者的阅读记录会保留。`)) return;
    if (id === state.activeBookId) await reading.saveProgress();
    state.libraryRevision += 1;
    await storage.deleteBook(id);
    state.books = state.books.filter((item) => item.id !== id);
    if (id === state.activeBookId) {
      reading.close();
      state.activeBookId = state.books[0]?.id || "";
      if (state.activeBookId) await selectBook(state.activeBookId, { persistCurrent: false });
      else view.setView("library");
    }
    view.renderShelf();
    view.renderCollection();
    view.renderCloudCollection();
    view.notify("书籍已移出此设备");
  }

  async function updateBook(event) {
    event.preventDefault();
    const id = $("#edit-book-id").value;
    const book = state.books.find((item) => item.id === id);
    if (!book) return;
    const title = $("#edit-book-title").value.trim();
    if (!title) { view.notify("书名不能为空"); return; }
    const file = $("#replace-book-file").files[0];
    let replacement = null;
    if (file) {
      if (/\.epub$/i.test(file.name)) replacement = { format: "epub", data: await file.arrayBuffer() };
      else if (/\.(txt|md|markdown)$/i.test(file.name)) replacement = { format: "text", chapters: await splitIntoChapters(decodeTextFile(await file.arrayBuffer())) };
      else { view.notify("请选择 TXT、Markdown 或 EPUB 文件"); return; }
      if (!replacement.chapters?.length && replacement.format === "text") { view.notify("文件中没有可导入的正文"); return; }
    }
    if (id === state.activeBookId) await reading.saveProgress();
    state.libraryRevision += 1;
    book.title = title;
    book.author = $("#edit-book-author").value.trim();
    book.updatedAt = Date.now();
    book.metadataUpdatedAt = book.updatedAt;
    if (replacement) {
      if (id === state.activeBookId) {
        reading.close();
        view.setView("library");
      }
      Object.assign(book, replacement, { contentUpdatedAt: book.updatedAt });
      for (const reader of Object.values(state.readers)) {
        reader.books[id] = { progress: 0, scrollProgress: 0, cfi: "", progressUpdatedAt: book.updatedAt, lastOpenedAt: 0, contentUpdatedAt: book.contentUpdatedAt };
      }
      saveReaders();
      delete book.contentHash;
      delete book.cfi;
      delete book.locations;
    }
    if (replacement) await storage.saveBook(book);
    else await storage.saveBookMetadata(book);
    state.books = await storage.allBooks();
    view.closeBookEditor();
    view.renderShelf();
    view.renderCollection();
    if (id === state.activeBookId) await selectBook(id, { persistCurrent: false });
    view.notify(replacement ? "书籍信息和文件已更新" : "书籍信息已更新");
  }

  async function importFiles(fileList) {
    await reading.saveProgress();
    state.libraryRevision += 1;
    reading.close();
    view.setView("library");
    for (const file of fileList) {
      const title = file.name.replace(/\.(txt|md|markdown|epub)$/i, "");
      const id = crypto.randomUUID();
      if (/\.epub$/i.test(file.name)) {
        const data = await file.arrayBuffer();
        const book = { id, title, author: "", format: "epub", data, addedAt: Date.now(), updatedAt: Date.now(), contentUpdatedAt: Date.now() };
        await storage.saveBook(book);
        state.activeBookId = id;
        continue;
      }
      const content = decodeTextFile(await file.arrayBuffer());
      const chapters = await splitIntoChapters(content);
      await storage.saveBook({ id, title, author: "", format: "text", chapters, addedAt: Date.now(), updatedAt: Date.now(), contentUpdatedAt: Date.now() });
      state.activeBookId = id;
    }
    state.books = await storage.allBooks();
    view.renderShelf();
    await selectBook(state.activeBookId, { persistCurrent: false });
    if (fileList.length) view.notify(`已导入 ${fileList.length} 本书`);
  }

  async function downloadBackup() {
    await reading.saveProgress();
    const payload = { version: 2, exportedAt: new Date().toISOString(), books: await storage.exportBooks(), readers: state.readers };
    const blob = new Blob([encodeBackup(payload)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "yejian-reader-backup.json";
    link.click();
    URL.revokeObjectURL(link.href);
    view.notify("备份已导出");
  }

  async function importBackup(file) {
    const data = decodeBackup(await file.text());
    if (!Array.isArray(data.books) || !data.books.every((book) => book.id && book.title && isCloudContent(book))) throw new Error("备份文件格式不正确");
    if (data.version >= 2 && !READER_DEFAULTS.every(({ id }) => data.readers?.[id]?.id === id && typeof data.readers[id].name === "string" && data.readers[id].name.trim() && data.readers[id].settings && data.readers[id].books && typeof data.readers[id].books === "object" && !Array.isArray(data.readers[id].books))) throw new Error("备份中的读者档案格式不正确");
    await reading.saveProgress();
    state.libraryRevision += 1;
    reading.close();
    view.setView("library");
    for (const defaults of READER_DEFAULTS) state.readers[defaults.id] = data.readers?.[defaults.id] || emptyReader(defaults);
    const sharedBooks = profiles.migrateLegacyData(data.books, data.settings, 1);
    await storage.replaceBooks(sharedBooks);
    state.books = await storage.allBooks();
    onReaderChanged();
    view.renderShelf();
    view.renderCollection();
    view.notify("备份已导入");
  }

  async function clearLocalBooks() {
    if (!confirm("移出此设备上的全部已下载书籍？云端书库和两位读者的阅读记录会保留。")) return;
    reading.saveProgress();
    state.libraryRevision += 1;
    reading.close();
    view.setView("library");
    await storage.replaceBooks([]);
    state.books = [];
    state.activeBookId = "";
    view.renderShelf();
    view.setView("library");
    view.closeSettings();
    view.renderCloudCollection();
    view.notify("已移出此设备上的书籍");
  }

  return { selectBook, removeBook, updateBook, importFiles, downloadBackup, importBackup, clearLocalBooks };
};
