window.YeJian.createSync = function ({ state, storage, profiles, view, reading, onSelectBook }) {
  const { cloudContent, isCloudContent, isLegacyDemoBook, isLegacyDemoDescriptor, contentHash, bookContentHash, bookMetadata, GITHUB_MANIFEST_PATH, GITHUB_BOOKS_BRANCH, READER_BRANCHES, READER_DEFAULTS } = window.YeJian.model;
  const { mergeTombstones, planBookSync, planLibrarySync, mergeLibraryResults, mergeReaderState, readerChanged, planReaderCleanup, createManifest, manifestChanged, localChanges } = window.YeJian.syncModel;
  const activeBook = () => window.YeJian.model.activeBook(state);
  const cloudDescriptor = (id) => window.YeJian.model.cloudDescriptor(state, id);
  const isLocalBook = (id) => window.YeJian.model.isLocalBook(state, id);
  const saveReaders = () => profiles.saveReaders();
  const saveCloudCatalog = () => storage.saveCloudCatalog(state.cloudCatalog);
  const SYNC_LOCK_TTL = 30000;
  const SYNC_CONFLICT_RETRIES = 4;
  const syncOwner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let syncInProgress = false;
  let syncPending = false;
  let manifestConflictRetries = 0;
  let syncRunId = 0;
  let syncLockTimer = null;

  function acquireSyncLock() {
    const now = Date.now();
    try {
      const current = storage.loadSyncLock();
      if (current?.owner !== syncOwner && current?.updatedAt && now - current.updatedAt < SYNC_LOCK_TTL) return false;
      storage.saveSyncLock({ owner: syncOwner, updatedAt: now });
      return true;
    } catch {
      return true;
    }
  }

  function refreshSyncLock() {
    try {
      const current = storage.loadSyncLock();
      if (current?.owner === syncOwner) storage.saveSyncLock({ owner: syncOwner, updatedAt: Date.now() });
    } catch {
      // A failed heartbeat must not interrupt an active sync.
    }
  }

  function releaseSyncLock() {
    clearInterval(syncLockTimer);
    syncLockTimer = null;
    try {
      const current = storage.loadSyncLock();
      if (current?.owner === syncOwner) storage.saveSyncLock(null);
    } catch {
      // The TTL will release a lock if localStorage is unavailable.
    }
  }

  async function downloadCloudBook(id) {
    const { repository, token, sourceBranch } = storage.loadGitHubConfig();
    const client = window.YeJian.createGithub({ repository, token, storage });
    const branch = GITHUB_BOOKS_BRANCH;
    if (!repository || !token) throw new Error("请先在同步设置中连接 GitHub");
    await client.ensureGitHubBranch(branch, sourceBranch);
    let descriptor = cloudDescriptor(id);
    if (!descriptor) throw new Error("云端书籍目录中没有这本书");
    if (isLegacyDemoDescriptor(descriptor)) throw new Error("这本遗留演示书已停用，请重新同步目录");
    if (isLocalBook(id)) {
      await onSelectBook(id);
      return;
    }
    view.setLocalStatus(`正在下载《${descriptor.title}》`);
    view.setCloudDownloadProgress(id, 0);
    try {
      const manifestRead = await client.readGitHubJson(GITHUB_MANIFEST_PATH, branch);
      const freshDescriptor = manifestRead?.value?.books?.find((book) => book.id === id);
      if (manifestRead?.value && !freshDescriptor) throw new Error(`《${descriptor.title}》已从云端书库删除，请重新同步目录`);
      if (freshDescriptor) {
        descriptor = freshDescriptor;
        if (isLegacyDemoDescriptor(descriptor)) throw new Error("这本遗留演示书已停用，请重新同步目录");
        state.cloudCatalog = { ...state.cloudCatalog, ...manifestRead.value };
        saveCloudCatalog();
        view.renderCloudCollection();
        view.setCloudDownloadProgress(id, 0);
      }
      const contentRead = await client.readGitHubJson(`sync/books/${id}.json`, branch, { onProgress: (progress) => view.setCloudDownloadProgress(id, progress) });
      if (!contentRead) throw new Error(`云端缺少《${descriptor.title}》的书籍文件`);
      const actualHash = await contentHash(contentRead.value);
      if (actualHash !== descriptor.contentHash) {
        if (!isCloudContent(contentRead.value)) throw new Error(`《${descriptor.title}》的云端内容校验失败`);
        descriptor = { ...descriptor, contentHash: actualHash };
        state.cloudCatalog = { ...state.cloudCatalog, books: state.cloudCatalog.books.map((book) => book.id === id ? descriptor : book) };
        saveCloudCatalog();
        if (manifestRead?.value && manifestRead.sha) {
          const repairedManifest = { ...manifestRead.value, books: manifestRead.value.books.map((book) => book.id === id ? { ...book, contentHash: actualHash } : book) };
          try {
            await client.writeGitHubJson(GITHUB_MANIFEST_PATH, repairedManifest, branch, manifestRead.sha);
          } catch (error) {
            if (!error.isConflict) throw error;
          }
        }
      }
      const book = { ...descriptor, ...contentRead.value, fileSha: contentRead.sha };
      if (isLegacyDemoBook(book)) throw new Error("这本遗留演示书已停用，请重新同步目录");
      delete book.fileSha;
      await storage.saveBook(book);
      state.libraryRevision += 1;
      state.books = await storage.allBooks();
      view.renderShelf();
      view.renderCollection();
      view.renderCloudCollection();
      view.notify(`《${descriptor.title}》已下载到本机`);
      await onSelectBook(id);
    } finally {
      view.setLocalStatus("已连接 GitHub");
      view.renderCloudCollection();
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
    if (!storage.loadGitHubConfig().repository || !storage.loadGitHubConfig().token) throw new Error("请先在同步设置中连接 GitHub");
    const deleted = storage.loadDeletedBooks();
    storage.saveDeletedBooks([...new Set([...deleted, id])]);
    view.notify(`正在从云端删除《${descriptor.title}》…`);
    await waitForSyncIdle();
    const synced = await syncToGitHub({ automatic: true });
    view.setView("cloud");
    if (!synced || state.cloudCatalog.books.some((book) => book.id === id)) throw new Error("云端删除未完成，请稍后重试");
    view.notify(`《${descriptor.title}》已从云端删除`);
  }

  async function syncReader(client, readerId, branch, remote, revision, removedIds) {
    const snapshot = JSON.parse(JSON.stringify(mergeReaderState(state.readers[readerId], remote?.value, removedIds)));
    if (readerChanged(snapshot, remote?.value)) {
      await client.writeGitHubJson(`sync/readers/${readerId}.json`, snapshot, branch, remote?.sha || null);
    }
    if (revision !== state.libraryRevision) { syncPending = true; return; }
    reading.saveProgress();
    const book = activeBook();
    const before = JSON.stringify(profiles.readingState(book));
    state.readers[readerId] = mergeReaderState(state.readers[readerId], snapshot, removedIds);
    saveReaders();
    if (book && before !== JSON.stringify(profiles.readingState(book)) && view.isReading() && !removedIds.has(book.id)) {
      await reading.open(book);
    }
  }

  async function removeDeletedReaderStates(client, readerId, removedIds) {
    if (!removedIds.size) return;
    const branch = READER_BRANCHES[readerId];
    const remote = await client.readGitHubJson(`sync/readers/${readerId}.json`, branch);
    if (!remote) return;
    const { reader: snapshot, changed } = planReaderCleanup(state.readers[readerId], remote.value, removedIds);
    if (changed) await client.writeGitHubJson(`sync/readers/${readerId}.json`, snapshot, branch, remote.sha);
    state.readers[readerId] = snapshot;
  }

  async function transferBooks(client, plan) {
    const results = [];
    const steps = [];
    for (let step of plan.steps) {
      let body = null;
      const loadBody = async () => {
        body ||= await storage.getBook(step.local.id);
        if (!body) throw new Error(`本机缺少《${step.local.title}》的正文，请重新下载或导入`);
        return body;
      };
      if (step.action === "hash") {
        const local = { ...step.local, contentHash: await bookContentHash(await loadBody()) };
        step = planBookSync(local, step.remote, plan.tombstones);
      }
      steps.push(step);
      const { action, local, remote } = step;
      if (action === "merge" || action === "delete") { await new Promise((resolve) => setTimeout(resolve, 0)); continue; }
      const path = `sync/books/${local.id}.json`;
      let fileSha = remote?.fileSha || null;
      if (action === "download") {
        const read = await client.readGitHubJson(path, GITHUB_BOOKS_BRANCH);
        if (!read) throw new Error(`云端缺少《${remote.title}》的书籍文件`);
        const hash = await contentHash(read.value);
        if (hash !== remote.contentHash && !isCloudContent(read.value)) throw new Error(`《${remote.title}》的云端内容校验失败`);
        results.push({ id: local.id, content: read.value, contentHash: hash, fileSha: read.sha });
        continue;
      }
      const existing = action === "publish" ? await client.readGitHubJson(path, GITHUB_BOOKS_BRANCH) : null;
      if (existing && await contentHash(existing.value) === local.contentHash) fileSha = existing.sha;
      else {
        const book = await loadBody();
        const saved = await client.putCloudFile(path, cloudContent(book), GITHUB_BOOKS_BRANCH, action === "publish" ? existing?.sha || null : undefined);
        fileSha = saved.content.sha;
      }
      results.push({ id: local.id, fileSha });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { plan: { ...plan, steps }, results };
  }

  async function syncToGitHub({ automatic = false } = {}) {
    if (syncInProgress) { syncPending = syncPending || automatic; return false; }
    const { repository, token, sourceBranch } = automatic ? storage.loadGitHubConfig() : view.readGitHubConfig();
    const client = window.YeJian.createGithub({ repository, token, storage });
    const branch = GITHUB_BOOKS_BRANCH;
    const readerId = state.activeReaderId;
    const readerBranch = READER_BRANCHES[readerId];
    if (!repository || !token) {
      if (!automatic) view.notify("请填写 GitHub 仓库和访问令牌");
      return false;
    }
    if (!/^[^/]+\/[^/]+$/.test(repository)) {
      if (!automatic) view.notify("仓库格式应为 owner/repository");
      return false;
    }
    if (!acquireSyncLock()) {
      syncPending = true;
      view.setSyncFeedback("本机另一个页面正在同步…");
      setTimeout(() => syncToGitHub({ automatic: true }), 2000);
      return false;
    }
    syncInProgress = true;
    syncLockTimer = setInterval(refreshSyncLock, 5000);
    const runId = ++syncRunId;
    storage.saveGitHubConfig({ repository, token, sourceBranch });
    view.setSyncFeedback(automatic ? "正在自动同步…" : "正在连接 GitHub…");
    try {
      await reading.saveProgress();
      if (runId !== syncRunId) return false;
      await Promise.all([
        client.ensureGitHubBranch(GITHUB_BOOKS_BRANCH, sourceBranch),
        ...READER_DEFAULTS.map(({ id }) => client.ensureGitHubBranch(READER_BRANCHES[id], sourceBranch))
      ]);
      view.setSyncFeedback("正在核对书架…");
      const manifestRead = await client.readGitHubJson(GITHUB_MANIFEST_PATH, branch);
      let cloudManifest = manifestRead?.value || null;
      if (cloudManifest && (cloudManifest.version || 1) < 3) {
        cloudManifest = { ...cloudManifest, books: profiles.migrateLegacyData(cloudManifest.books || [], cloudManifest.settings, cloudManifest.settingsUpdatedAt) };
      }
      const revision = state.libraryRevision;
      const localDeleted = storage.loadDeletedBooks();
      const tombstones = mergeTombstones(cloudManifest, localDeleted, Date.now());
      const initialPlan = planLibrarySync(state.books, cloudManifest, tombstones);
      const { plan, results } = await transferBooks(client, initialPlan);
      const { books: syncedBooks, localBooks: syncedLocalBooks, removedIds } = mergeLibraryResults(plan, results);
      if (revision !== state.libraryRevision) { syncPending = true; return false; }
      for (const remote of plan.remoteBooks) {
        if (!tombstones.has(remote.id)) continue;
        const id = remote.id;
        await client.deleteCloudFile(`sync/books/${id}.json`, branch);
      }
      const remoteReader = await client.readGitHubJson(`sync/readers/${readerId}.json`, readerBranch);
      await syncReader(client, readerId, readerBranch, remoteReader, revision, removedIds);
      for (const { id } of READER_DEFAULTS) {
        if (id !== readerId) await removeDeletedReaderStates(client, id, removedIds);
      }
      if (revision !== state.libraryRevision) { syncPending = true; return false; }
      for (const reader of Object.values(state.readers)) {
        for (const id of removedIds) delete reader.books[id];
      }
      saveReaders();
      const currentReader = state.readers[state.activeReaderId];
      reading.setTheme(currentReader.settings.theme, false);
      reading.setFontSize(Number(currentReader.settings.fontSize) || 18, false);
      view.renderReaders();
      const manifest = createManifest(syncedBooks, tombstones, cloudManifest?.updatedAt || 0);
      if (manifestChanged(manifest, cloudManifest)) {
        const latestManifestSha = await client.readGitHubFileSha(GITHUB_MANIFEST_PATH, branch);
        if ((latestManifestSha || null) !== (manifestRead?.sha || null)) { syncPending = true; return false; }
        manifest.updatedAt = Date.now();
        await client.writeGitHubJson(GITHUB_MANIFEST_PATH, manifest, branch, latestManifestSha);
      }
      state.cloudCatalog = { ...manifest, updatedAt: manifest.updatedAt || cloudManifest?.updatedAt || Date.now() };
      saveCloudCatalog();
      if (revision !== state.libraryRevision) { syncPending = true; return false; }
      const previousBook = activeBook();
      const changes = localChanges(state.books, syncedLocalBooks);
      if (changes.books.length || changes.deletedIds.length) await storage.applyBookChanges(changes.books, changes.deletedIds);
      if (revision !== state.libraryRevision) { syncPending = true; return; }
      state.books = syncedLocalBooks.map(bookMetadata);
      const currentBook = state.books.find((book) => book.id === state.activeBookId);
      if (!currentBook && view.isReading()) {
        reading.close();
        state.activeBookId = "";
        view.setView("library");
      } else if (currentBook && view.isReading() && (!previousBook || previousBook.id !== currentBook.id || previousBook.contentUpdatedAt !== currentBook.contentUpdatedAt || previousBook.metadataUpdatedAt !== currentBook.metadataUpdatedAt)) {
        state.activeBookId = currentBook.id;
        await reading.open(currentBook);
      }
      view.renderCloudCollection();
      const pendingDeleted = storage.loadDeletedBooks();
      const syncedDeleted = new Set(localDeleted);
      const remainingDeleted = pendingDeleted.filter((id) => !syncedDeleted.has(id));
      storage.saveDeletedBooks(remainingDeleted);
      manifestConflictRetries = 0;
      view.setSyncFeedback(`已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
      view.setLocalStatus("已连接 GitHub");
      view.renderShelf();
      if (view.isLibrary()) view.renderCollection();
      if (!automatic) {
        view.closeSettings();
        view.setView("library");
        view.renderCollection();
        view.notify("书架已同步到 GitHub");
      }
      return true;
    } catch (error) {
      if (runId !== syncRunId) return false;
      const isConflict = Boolean(error.isConflict);
      manifestConflictRetries = isConflict ? manifestConflictRetries + 1 : 0;
      const willRetry = isConflict && manifestConflictRetries <= SYNC_CONFLICT_RETRIES;
      if (willRetry) {
        syncPending = true;
      } else {
        syncPending = false;
      }
      const reason = isConflict && !willRetry ? `与云端连续冲突 ${manifestConflictRetries} 次，已暂停重试，请稍后手动同步` : error.message;
      view.setSyncFeedback(willRetry ? `检测到云端更新，2 秒后重新合并（第 ${manifestConflictRetries} 次）` : reason);
      if (willRetry) {
        view.setLocalStatus("正在重新同步到 GitHub");
      } else if (automatic) {
        view.setLocalStatus("自动同步未完成，请在设置中手动连接");
      } else {
        view.notify(reason);
      }
      if (!willRetry) manifestConflictRetries = 0;
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

  return { run: syncToGitHub, downloadCloudBook, removeCloudBook };
};
