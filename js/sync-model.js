window.YeJian.syncModel = (() => {
  const { emptyReader, mergeReader, bookDescriptor, bookMetadata, mergeDescriptor, isCloudContent, READER_DEFAULTS } = window.YeJian.model;

  function mergeTombstones(manifest, localDeleted, now) {
    const remoteBooks = new Map((manifest?.books || []).map((book) => [book.id, book]));
    const deleted = new Map((manifest?.deleted || []).map((item) => [item.id, item.deletedAt]));
    for (const id of localDeleted) {
      const remote = remoteBooks.get(id);
      deleted.set(id, Math.max(deleted.get(id) || 0, now, (remote?.updatedAt || remote?.addedAt || 0) + 1));
    }
    return deleted;
  }

  function isBookDeleted(book, tombstones) {
    return (tombstones.get(book.id) || 0) >= (book.updatedAt || book.addedAt || 0);
  }

  function planBookSync(local, remote, tombstones) {
    let action;
    if (isBookDeleted(local, tombstones)) action = "delete";
    else if (!local.contentHash) action = "hash";
    else if (!remote) action = "publish";
    else if (remote.contentHash === local.contentHash) action = "merge";
    else action = (local.contentUpdatedAt || local.addedAt || local.updatedAt || 0) >= (remote.contentUpdatedAt || 0) ? "upload" : "download";
    return { action, local, remote };
  }

  function planLibrarySync(localBooks, manifest, tombstones) {
    const remoteBooks = new Map((manifest?.books || []).map((book) => [book.id, book]));
    const steps = localBooks.map((local) => planBookSync({ ...local }, remoteBooks.get(local.id), tombstones));
    return { steps, remoteBooks: [...remoteBooks.values()], tombstones };
  }

  function mergeLibraryResults(plan, transfers) {
    const books = new Map(plan.remoteBooks.map((book) => [book.id, book]));
    const localBooks = new Map(plan.steps.map(({ local }) => [local.id, { ...local }]));
    const results = new Map(transfers.map((result) => [result.id, result]));
    for (const { action, local, remote } of plan.steps) {
      if (action === "delete") {
        localBooks.delete(local.id);
      } else if (action === "merge") {
        const merged = mergeDescriptor(local, remote);
        books.set(local.id, bookDescriptor(merged, local.contentHash, remote.fileSha || null));
        localBooks.set(local.id, { ...local, title: merged.title, author: merged.author, metadataUpdatedAt: merged.metadataUpdatedAt });
      } else {
        const result = results.get(local.id);
        if (action === "download") {
          const chosen = { ...local, ...result.content, contentHash: result.contentHash, contentUpdatedAt: remote.contentUpdatedAt };
          delete chosen.locations;
          localBooks.set(local.id, chosen);
          books.set(local.id, { ...remote, contentHash: result.contentHash, fileSha: result.fileSha });
        } else {
          books.set(local.id, bookDescriptor(local, local.contentHash, result.fileSha));
        }
      }
    }
    for (const remote of plan.remoteBooks) {
      if (isBookDeleted(remote, plan.tombstones)) books.delete(remote.id);
    }
    return {
      books: [...books.values()], localBooks: [...localBooks.values()],
      removedIds: new Set([...plan.tombstones.keys()].filter((id) => !books.has(id)))
    };
  }

  function mergeReaderState(local, remote, removedIds) {
    const merged = mergeReader(local, remote);
    const books = { ...merged.books };
    for (const id of removedIds) delete books[id];
    return { ...merged, books };
  }

  function readerChanged(reader, remote) {
    const defaults = emptyReader(READER_DEFAULTS.find(({ id }) => id === reader.id));
    return !remote || JSON.stringify(reader) !== JSON.stringify(mergeReader(defaults, remote));
  }

  function planReaderCleanup(local, remote, removedIds) {
    const merged = mergeReader(local, remote);
    return { reader: mergeReaderState(merged, null, removedIds), changed: [...removedIds].some((id) => Object.hasOwn(merged.books, id)) };
  }

  function createManifest(books, tombstones, updatedAt = 0) {
    return { version: 3, updatedAt, books: books.map((book) => bookDescriptor(book, book.contentHash, book.fileSha)), deleted: [...tombstones].map(([id, deletedAt]) => ({ id, deletedAt })) };
  }

  function manifestChanged(manifest, remote) {
    const { updatedAt, ...next } = manifest;
    const { updatedAt: remoteUpdatedAt, ...previous } = remote || {};
    return !remote || JSON.stringify(next) !== JSON.stringify(previous);
  }

  function localChanges(previous, next) {
    const previousById = new Map(previous.map((book) => [book.id, book]));
    const nextIds = new Set(next.map((book) => book.id));
    return {
      books: next.filter((book) => isCloudContent(book) || JSON.stringify(bookMetadata(book)) !== JSON.stringify(previousById.get(book.id))),
      deletedIds: previous.filter((book) => !nextIds.has(book.id)).map((book) => book.id)
    };
  }

  return { mergeTombstones, planBookSync, planLibrarySync, mergeLibraryResults, mergeReaderState, readerChanged, planReaderCleanup, createManifest, manifestChanged, localChanges };
})();
