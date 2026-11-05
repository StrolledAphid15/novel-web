window.YeJian.createGithub = function ({ repository, token, storage }) {
  const { encodeBackup, decodeBackup } = window.YeJian.model;

  function githubFileUrl(path, branch) {
    const [owner, name] = repository.split("/");
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}${query}`;
  }

  function githubRefUrl(ref) {
    const [owner, name] = repository.split("/");
    const encodedRef = ["heads", ...ref.split("/")].map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/${encodedRef}`;
  }

  async function ensureGitHubBranch(branch, sourceBranch) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    };
    let response = await fetch(githubRefUrl(branch), { headers });
    if (response.ok) return;
    if (response.status !== 404) throw new Error(`读取 GitHub 分支失败 (${response.status})`);
    const sourceResponse = await fetch(githubRefUrl(sourceBranch), { headers });
    if (!sourceResponse.ok) throw new Error(`找不到用于初始化同步分支的基准分支“${sourceBranch}”`);
    const source = await sourceResponse.json();
    const [owner, name] = repository.split("/");
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.object.sha })
    });
    if (response.ok) return;
    if (response.status === 422) {
      const existing = await fetch(githubRefUrl(branch), { headers });
      if (existing.ok) return;
    }
    const detail = await response.text();
    throw new Error(`创建 GitHub 分支“${branch}”失败 (${response.status})${detail ? `：${detail.slice(0, 180)}` : ""}`);
  }

  async function githubRequest(path, branch, options = {}) {
    const { raw = false, allowMissing = false, ...requestOptions } = options;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...requestOptions.headers
    };
    const url = githubFileUrl(path, ["PUT", "DELETE"].includes(requestOptions.method) ? "" : branch);
    const response = await fetch(url, { ...requestOptions, headers });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) {
      if (response.status === 401) storage.clearGitHubToken(token);
      const detail = await response.text();
      const isConflict = response.status === 409 || (response.status === 422 && /sha|conflict|reference|fast.forward/i.test(detail));
      const error = new Error(isConflict
        ? "GitHub 仓库刚被另一台设备更新，请重新同步"
        : `GitHub 请求失败 (${response.status})${detail ? `：${detail.slice(0, 180)}` : ""}`);
      error.status = response.status;
      error.isConflict = isConflict;
      throw error;
    }
    return response;
  }

  function encodeGitHubContent(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  function decodeGitHubContent(content) {
    const binary = atob(content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function readResponseText(response, onProgress) {
    if (!response.body?.getReader) {
      const text = await response.text();
      onProgress?.(1);
      return text;
    }
    const reader = response.body.getReader();
    const total = Number(response.headers.get("content-length")) || 0;
    const decoder = new TextDecoder();
    let text = "";
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      onProgress?.(total ? received / total : null);
    }
    text += decoder.decode();
    onProgress?.(1);
    return text;
  }

  async function readGitHubJson(path, branch, { onProgress } = {}) {
    let response = await githubRequest(path, branch, { allowMissing: true });
    if (!response) return null;
    let file = JSON.parse(await readResponseText(response, onProgress));
    if (file.encoding === "base64" && file.content) {
      return { value: decodeBackup(decodeGitHubContent(file.content)), sha: file.sha };
    }
    if (file.git_url) {
      const blobResponse = await fetch(file.git_url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!blobResponse.ok) throw new Error(`GitHub 请求失败 (${blobResponse.status})`);
      const blob = JSON.parse(await readResponseText(blobResponse, onProgress));
      if (blob.encoding === "base64" && blob.content) {
        return { value: decodeBackup(decodeGitHubContent(blob.content)), sha: file.sha };
      }
    }
    response = await githubRequest(path, branch, { raw: true });
    const rawText = await readResponseText(response, onProgress);
    try {
      const rawFile = JSON.parse(rawText);
      if (rawFile.encoding === "base64" && rawFile.content) {
        return { value: decodeBackup(decodeGitHubContent(rawFile.content)), sha: file.sha };
      }
    } catch {
      // The raw endpoint normally returns the JSON document directly.
    }
    return { value: decodeBackup(rawText), sha: file.sha };
  }

  async function writeGitHubJson(path, value, branch, sha = null) {
    const response = await githubRequest(path, branch, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Sync novel-web data: ${path.split("/").at(-1)}`, content: encodeGitHubContent(encodeBackup(value)), branch, ...(sha ? { sha } : {}) })
    });
    return response.json();
  }

  async function deleteGitHubFile(path, branch, sha) {
    const response = await githubRequest(path, branch, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Delete novel-web data: ${path.split("/").at(-1)}`, sha, branch }),
      allowMissing: true
    });
    return response?.json();
  }

  return { ensureGitHubBranch, readGitHubJson, writeGitHubJson, deleteGitHubFile };
};
