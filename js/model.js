window.YeJian = { model: (() => {
  const GITHUB_MANIFEST_PATH = "sync/library-manifest.json";
  const GITHUB_BOOKS_BRANCH = "sync-books";
  const READER_BRANCHES = { "reader-a": "sync-reader-a", "reader-b": "sync-reader-b" };
  const DEMO_BOOK_ID = "sample-mist-port";
  const READER_DEFAULTS = [{ id: "reader-a", name: "纨絔" }, { id: "reader-b", name: "澪" }];
  const READING_FIELDS = ["progress", "scrollProgress", "cfi", "progressUpdatedAt", "lastOpenedAt"];

  function emptyReader({ id, name }) {
    return { id, name, nameUpdatedAt: 0, settings: { fontSize: 18, theme: "paper" }, settingsUpdatedAt: 0, activeBookId: "", activeBookUpdatedAt: 0, books: {} };
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

  function activeBook(state) {
    return state.books.find((book) => book.id === state.activeBookId) || state.books[0] || null;
  }

  function cloudDescriptor(state, id) {
    return state.cloudCatalog.books.find((book) => book.id === id) || null;
  }

  function isLocalBook(state, id) {
    return state.books.some((book) => book.id === id);
  }

  function bookMetadata(book) {
    const { chapters, data, locations, ...metadata } = book;
    return { ...metadata, chapterCount: book.format === "text" ? (chapters?.length ?? book.chapterCount ?? 0) : (book.chapterCount || 0) };
  }

  function normalizeTextChapters(chapters) {
    if (!Array.isArray(chapters)) return [];
    return chapters.map((chapter) => {
      const item = chapter && typeof chapter === "object" ? chapter : {};
      const paragraphs = Array.isArray(item.paragraphs) ? item.paragraphs.map((line) => String(line).trim()).filter(Boolean) : [];
      return { ...item, title: String(item.title || "正文").trim() || "正文", subtitle: String(item.subtitle || "").trim(), paragraphs };
    }).filter((chapter) => chapter.paragraphs.length);
  }

  function flattenToc(items, result = []) {
    for (const item of items || []) {
      if (item.href) result.push({ href: item.href, label: item.label || item.href });
      flattenToc(item.subitems, result);
    }
    return result;
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

  function bookDescriptor(book, contentHash, fileSha) {
    const addedAt = Number(book.addedAt || 0);
    const updatedAt = Number(book.updatedAt || addedAt);
    return {
      id: book.id, title: book.title, author: book.author || "", format: book.format,
      addedAt, updatedAt,
      metadataUpdatedAt: book.metadataUpdatedAt || addedAt || updatedAt,
      contentUpdatedAt: book.contentUpdatedAt || addedAt || updatedAt,
      chapterCount: book.chapters?.length ?? book.chapterCount ?? 0,
      contentHash, fileSha
    };
  }

  function mergeDescriptor(local, remote) {
    const metadata = (remote.metadataUpdatedAt || 0) > (local.metadataUpdatedAt || 0) ? remote : local;
    return { ...local, title: metadata.title, author: metadata.author, addedAt: Math.min(local.addedAt || local.updatedAt || 0, remote.addedAt || remote.updatedAt || 0), metadataUpdatedAt: metadata.metadataUpdatedAt };
  }

  return { GITHUB_MANIFEST_PATH, GITHUB_BOOKS_BRANCH, READER_BRANCHES, DEMO_BOOK_ID, READER_DEFAULTS, READING_FIELDS, emptyReader, mergeReader, activeBook, cloudDescriptor, isLocalBook, bookMetadata, normalizeTextChapters, flattenToc, decodeTextFile, splitIntoChapters, encodeBackup, decodeBackup, cloudContent, isCloudContent, contentHash, bookContentHash, bookDescriptor, mergeDescriptor };
})() };
