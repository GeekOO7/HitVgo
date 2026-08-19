/**
 * Local assets (disk via Agent) + bridge to the local agent (127.0.0.1).
 * Custom RH / Comfy / LLM run via the agent — no browser CORS to third parties.
 * Blobs are stored on user-chosen disk folder via Agent HTTP endpoints.
 * Metadata stays in localStorage.
 * Exposes window.VflowLocal
 */
(() => {
  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  // ─── Legacy IndexedDB (kept for migration only) ───────────────────────────
  const DB_NAME = "vflow-local-assets";
  const LEGACY_DB_NAME = "wf-local-assets";
  const DB_VERSION = 2;
  const STORE = "blobs";
  const JOB_STORE = "jobs";
  const META_KEY = "vflow-local-asset-meta";
  const LEGACY_META_KEY = "wf-local-asset-meta";
  const AGENT_BASE_KEY = "vflow-agent-base";
  const DEFAULT_AGENT_BASE = "http://127.0.0.1:39281";

  try {
    if (!localStorage.getItem(META_KEY) && localStorage.getItem(LEGACY_META_KEY)) {
      localStorage.setItem(META_KEY, localStorage.getItem(LEGACY_META_KEY));
      localStorage.removeItem(LEGACY_META_KEY);
    }
  } catch (e) {
    /* ignore */
  }

  function getAgentBase() {
    try {
      const v = (localStorage.getItem(AGENT_BASE_KEY) || "").trim();
      if (v) return v.replace(/\/$/, "");
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_AGENT_BASE;
  }

  function setAgentBase(url) {
    const next = String(url || DEFAULT_AGENT_BASE).trim().replace(/\/$/, "");
    try {
      localStorage.setItem(AGENT_BASE_KEY, next || DEFAULT_AGENT_BASE);
    } catch (e) {
      /* ignore */
    }
    return next || DEFAULT_AGENT_BASE;
  }

  // ─── IndexedDB (jobs store only + legacy blob read for migration) ─────────

  function openNamedDb(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(JOB_STORE)) {
          const jobs = db.createObjectStore(JOB_STORE, { keyPath: "id" });
          try {
            jobs.createIndex("byStatus", "status", { unique: false });
            jobs.createIndex("byProject", "projectId", { unique: false });
          } catch (_) {}
        }
        if (ev.oldVersion < 2 && !db.objectStoreNames.contains(JOB_STORE)) {
          db.createObjectStore(JOB_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  function openDb() {
    return openNamedDb(DB_NAME);
  }

  // Jobs store (kept in IndexedDB)
  async function idbPutJob(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(JOB_STORE, "readwrite");
      tx.objectStore(JOB_STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetJob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(JOB_STORE, "readonly");
      const req = tx.objectStore(JOB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDeleteJob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(JOB_STORE, "readwrite");
      tx.objectStore(JOB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbListJobs() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(JOB_STORE, "readonly");
      const req = tx.objectStore(JOB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Disk-based blob storage via Agent ────────────────────────────────────

  async function agentPutBlob(id, blob) {
    const base = getAgentBase();
    const resp = await fetch(`${base}/v1/assets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || `Agent PUT asset failed: ${resp.status}`);
    }
    return resp.json();
  }

  async function agentDeleteBlob(id) {
    const base = getAgentBase();
    const resp = await fetch(`${base}/v1/assets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || `Agent DELETE asset failed: ${resp.status}`);
    }
  }

  function resolvePlayUrl(entry) {
    if (!entry || !entry.blobId) return Promise.resolve(entry && entry.playUrl);
    const base = getAgentBase();
    return Promise.resolve(`${base}/v1/assets/${encodeURIComponent(entry.blobId)}`);
  }

  async function blobFileFromId(blobId, filename) {
    if (!blobId) return null;
    const base = getAgentBase();
    const resp = await fetch(`${base}/v1/assets/${encodeURIComponent(blobId)}`);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const name = filename || "frame.png";
    const type = blob.type || "application/octet-stream";
    return new File([blob], name, { type });
  }

  // ─── Metadata (localStorage) ──────────────────────────────────────────────

  function loadMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveMeta(list) {
    localStorage.setItem(META_KEY, JSON.stringify(list.slice(0, 200)));
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  // ─── Public asset API ─────────────────────────────────────────────────────

  async function putBlob(blob, meta) {
    const kind = (meta && meta.kind) || "i2v";
    const filename = (meta && meta.filename) || "";
    const projectId =
      meta && meta.projectId != null && meta.projectId !== ""
        ? Number(meta.projectId)
        : null;

    // Dedup: reuse existing upload snapshot with same project + filename + size
    if (kind === "upload" && projectId != null && filename) {
      const list = loadMeta();
      const existing = list.find(
        (e) =>
          e.kind === "upload" &&
          e.projectId === projectId &&
          e.filename === filename &&
          e.size === blob.size
      );
      if (existing) {
        existing.playUrl = await resolvePlayUrl(existing);
        return existing;
      }
    }

    const id = uid("loc");
    await agentPutBlob(id, blob);
    const entry = {
      id,
      origin: "local",
      kind,
      filename: filename || `${id}.mp4`,
      promptSnapshot: (meta && meta.promptSnapshot) || "",
      projectId,
      refId: (meta && meta.refId) || null,
      segmentKind: (meta && meta.segmentKind) || null,
      size: blob.size || 0,
      createdAt: new Date().toISOString(),
      playUrl: "",
      blobId: id,
    };
    const list = loadMeta();
    list.unshift(entry);
    saveMeta(list);
    entry.playUrl = await resolvePlayUrl(entry);
    return entry;
  }

  async function listAssets() {
    const list = loadMeta();
    const out = [];
    for (const e of list) {
      const playUrl = await resolvePlayUrl(e);
      out.push({ ...e, playUrl, origin: "local" });
    }
    return out;
  }

  async function deleteAsset(id) {
    const list = loadMeta().filter((e) => e.id !== id && e.blobId !== id);
    saveMeta(list);
    try {
      await agentDeleteBlob(id);
    } catch (e) {
      /* file may already be gone */
    }
  }

  // ─── Assets directory config ──────────────────────────────────────────────

  async function getAssetsDir() {
    const base = getAgentBase();
    const resp = await fetch(`${base}/v1/assets`);
    if (!resp.ok) throw new Error("Failed to get assets dir");
    const json = await resp.json();
    return json.assetsDir || "";
  }

  async function setAssetsDir(dirPath) {
    const base = getAgentBase();
    const resp = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetsDir: dirPath }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      throw new Error(json.error || "Failed to set assets dir");
    }
    return json.config && json.config.assetsDir || dirPath;
  }

  // ─── Migration from IndexedDB to disk ─────────────────────────────────────

  const MIGRATION_KEY = "vflow-local-assets-migrated-to-disk";

  async function migrateIdbToDisk() {
    // Already migrated?
    if (localStorage.getItem(MIGRATION_KEY)) return { migrated: 0 };
    let db;
    try {
      db = await openDb();
    } catch (e) {
      localStorage.setItem(MIGRATION_KEY, "1");
      return { migrated: 0 };
    }
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (!rows.length) {
      localStorage.setItem(MIGRATION_KEY, "1");
      return { migrated: 0 };
    }
    let count = 0;
    for (const row of rows) {
      if (!row.blob) continue;
      try {
        const blob = row.blob instanceof Blob ? row.blob : new Blob([row.blob]);
        await agentPutBlob(row.id, blob);
        count++;
      } catch (e) {
        console.warn("[VflowLocal] migration skip", row.id, e);
      }
    }
    // Clear IndexedDB blobs store
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      /* ignore */
    }
    localStorage.setItem(MIGRATION_KEY, "1");
    return { migrated: count };
  }

  // ─── Agent helpers (unchanged) ────────────────────────────────────────────

  function agentOfflineHint(err) {
    const msg = (err && err.message) || String(err || "");
    if (/Failed to fetch|NetworkError|CORS|cross-origin|Load failed/i.test(msg)) {
      return t("agent.offlineHint", { msg });
    }
    return msg;
  }

  function corsHint(err) {
    return agentOfflineHint(err);
  }

  async function checkHealth(timeoutMs) {
    const base = getAgentBase();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      ctrl &&
      setTimeout(() => {
        try { ctrl.abort(); } catch (e) {}
      }, timeoutMs || 2500);
    try {
      const resp = await fetch(`${base}/health`, {
        method: "GET",
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (!resp.ok) {
        return { ok: false, base, error: t("agent.httpFailed", { status: resp.status }) };
      }
      const data = await resp.json().catch(() => ({}));
      return {
        ok: !!(data && data.ok),
        base,
        version: data.version || "",
        channels: data.channels || {},
        raw: data,
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, base, error: agentOfflineHint(e) };
    }
  }

  async function syncConfig(partial) {
    const base = getAgentBase();
    let resp;
    try {
      resp = await fetch(`${base}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial || {}),
      });
    } catch (e) {
      throw new Error(agentOfflineHint(e));
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      throw new Error(json.error || t("agent.syncFailed", { status: resp.status }));
    }
    return json;
  }

  async function getAgentConfig() {
    const base = getAgentBase();
    let resp;
    try {
      resp = await fetch(`${base}/config`);
    } catch (e) {
      throw new Error(agentOfflineHint(e));
    }
    if (!resp.ok) throw new Error(t("agent.httpFailed", { status: resp.status }));
    return resp.json();
  }

  async function ensureAgentOnline() {
    const h = await checkHealth();
    if (!h.ok) {
      throw new Error(h.error || t("agent.notConnected"));
    }
    return h;
  }

  async function runViaAgent({
    channel, adapterMode, values, imageFile, endImageFile, videoFile, audioFile,
    kind, prompt, filename, projectId, refId, segmentKind, rh, comfy,
    useDuckEncrypt, password,
  }) {
    await ensureAgentOnline();
    const base = getAgentBase();
    const fd = new FormData();
    const meta = {
      channel, adapterMode, values: { ...values },
      kind: kind || "i2v", filename: filename || "local.mp4",
      rh: rh || undefined, comfy: comfy || undefined,
      useDuckEncrypt: !!useDuckEncrypt,
      password: useDuckEncrypt ? password || "" : "",
    };
    fd.append("meta", JSON.stringify(meta));
    if (imageFile) fd.append("startImage", imageFile, imageFile.name || "start.png");
    if (endImageFile) fd.append("endImage", endImageFile, endImageFile.name || "end.png");
    if (videoFile) fd.append("inputVideo", videoFile, videoFile.name || "input.mp4");
    if (audioFile) fd.append("inputAudio", audioFile, audioFile.name || "input.mp3");
    let resp;
    try {
      resp = await fetch(`${base}/v1/video/run`, { method: "POST", body: fd });
    } catch (e) {
      throw new Error(agentOfflineHint(e));
    }
    const ct = (resp.headers.get("Content-Type") || "").toLowerCase();
    if (!resp.ok || ct.includes("application/json")) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || t("agent.videoFailed", { status: resp.status }));
    }
    const blob = await resp.blob();
    const taskId = resp.headers.get("X-Task-Id") || uid("task");
    const cd = resp.headers.get("Content-Disposition") || "";
    const starMatch = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    let outName = "";
    if (starMatch && starMatch[1]) {
      try { outName = decodeURIComponent(starMatch[1].trim()); } catch (_) { outName = starMatch[1].trim(); }
    }
    if (!outName) {
      const nameMatch = /filename="?([^";]+)"?/i.exec(cd);
      outName = (nameMatch && nameMatch[1]) || "";
    }
    outName = outName || filename || `local_${taskId}.mp4`;
    const assetKind =
      kind === "t2i" || kind === "upload"
        ? "upload"
        : kind || "i2v";
    const asset = await putBlob(blob, {
      kind: assetKind, filename: outName, promptSnapshot: prompt || "",
      projectId: projectId != null ? projectId : null,
      refId: refId || null, segmentKind: segmentKind || null,
    });
    return { asset, taskId };
  }

  function _buildAgentFormData(opts) {
    const fd = new FormData();
    const meta = {
      channel: opts.channel, adapterMode: opts.adapterMode,
      values: { ...(opts.values || {}) }, kind: opts.kind || "i2v",
      filename: opts.filename || "local.mp4",
      rh: opts.rh || undefined, comfy: opts.comfy || undefined,
      useDuckEncrypt: !!opts.useDuckEncrypt, password: opts.password || "",
    };
    fd.append("meta", JSON.stringify(meta));
    if (opts.imageFile) fd.append("startImage", opts.imageFile, opts.imageFile.name || "start.png");
    if (opts.endImageFile) fd.append("endImage", opts.endImageFile, opts.endImageFile.name || "end.png");
    if (opts.videoFile) fd.append("inputVideo", opts.videoFile, opts.videoFile.name || "input.mp4");
    if (opts.audioFile) fd.append("inputAudio", opts.audioFile, opts.audioFile.name || "input.mp3");
    return fd;
  }

  async function createViaAgent(opts) {
    await ensureAgentOnline();
    const base = getAgentBase();
    const fd = _buildAgentFormData(opts);
    let resp;
    try {
      resp = await fetch(`${base}/v1/video/create`, { method: "POST", body: fd });
    } catch (e) {
      throw new Error(agentOfflineHint(e));
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      throw new Error(json.error || t("agent.videoFailed", { status: resp.status }));
    }
    const taskId = String(json.taskId || "").trim();
    if (!taskId) throw new Error(t("local.noTaskId"));
    return { taskId, channel: opts.channel };
  }

  async function pollViaAgent(opts) {
    await ensureAgentOnline();
    const base = getAgentBase();
    const body = {
      channel: opts.channel, taskId: opts.taskId,
      filename: opts.filename || `local_${opts.taskId}.mp4`,
      useDuckEncrypt: !!opts.useDuckEncrypt, password: opts.password || "",
      rh: opts.rh || undefined, comfy: opts.comfy || undefined,
    };
    let resp;
    try {
      resp = await fetch(`${base}/v1/video/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(agentOfflineHint(e));
    }
    const ct = (resp.headers.get("Content-Type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.ok === false) {
        throw new Error(json.error || t("agent.videoFailed", { status: resp.status }));
      }
      return {
        done: !!json.done, status: String(json.status || "RUNNING").toUpperCase(),
        taskId: String(json.taskId || opts.taskId), error: json.error || null, asset: null,
      };
    }
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || t("agent.videoFailed", { status: resp.status }));
    }
    const blob = await resp.blob();
    const taskId = resp.headers.get("X-Task-Id") || opts.taskId;
    let outName = opts.filename || `local_${taskId}.mp4`;
    const assetKind =
      opts.kind === "t2i" || opts.kind === "upload"
        ? "upload"
        : opts.kind || "i2v";
    const asset = await putBlob(blob, {
      kind: assetKind, filename: outName, promptSnapshot: opts.prompt || "",
      projectId: opts.projectId != null ? opts.projectId : null,
      refId: opts.refId || null, segmentKind: opts.segmentKind || null,
    });
    return { done: true, status: "SUCCESS", taskId: String(taskId), error: null, asset };
  }

  async function runRhJob(opts) {
    return runViaAgent({
      channel: "custom_rh", adapterMode: opts.adapterMode, values: opts.values,
      imageFile: opts.imageFile, endImageFile: opts.endImageFile,
      videoFile: opts.videoFile, audioFile: opts.audioFile,
      kind: opts.kind, prompt: opts.prompt, filename: opts.filename,
      projectId: opts.projectId, refId: opts.refId, segmentKind: opts.segmentKind,
      useDuckEncrypt: opts.useDuckEncrypt, password: opts.password,
      rh: { baseUrl: opts.baseUrl, apiKey: opts.apiKey },
    });
  }

  async function runComfyJob(opts) {
    return runViaAgent({
      channel: "comfyui", adapterMode: opts.adapterMode, values: opts.values,
      imageFile: opts.imageFile, endImageFile: opts.endImageFile,
      videoFile: opts.videoFile, audioFile: opts.audioFile,
      kind: opts.kind, prompt: opts.prompt, filename: opts.filename,
      projectId: opts.projectId, refId: opts.refId, segmentKind: opts.segmentKind,
      useDuckEncrypt: opts.useDuckEncrypt, password: opts.password,
      comfy: { baseUrl: opts.baseUrl, authHeader: opts.authHeader || "" },
    });
  }

  async function llmChatViaAgent({ system, userMsg, llm, temperature }) {
    await ensureAgentOnline();
    const base = getAgentBase();
    let resp;
    try {
      resp = await fetch(`${base}/v1/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system, userMsg, llm: llm || undefined,
          temperature: temperature != null ? temperature : 0.7,
        }),
      });
    } catch (e) {
      throw new Error(agentOfflineHint(e));
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      throw new Error(json.error || t("agent.llmFailed", { status: resp.status }));
    }
    if (!json.content) throw new Error(t("errors.llmBadChoices"));
    return json.content;
  }

  // ─── Auto-migration on load ───────────────────────────────────────────────
  // Attempt migration silently in the background when agent is online
  (async () => {
    try {
      if (localStorage.getItem(MIGRATION_KEY)) return;
      const h = await checkHealth(2000);
      if (h.ok) await migrateIdbToDisk();
    } catch (e) {
      /* non-critical */
    }
  })();

  // ─── Expose ───────────────────────────────────────────────────────────────

  window.VflowLocal = {
    putBlob,
    listAssets,
    deleteAsset,
    resolvePlayUrl,
    blobFileFromId,
    putJob: idbPutJob,
    getJob: idbGetJob,
    deleteJob: idbDeleteJob,
    listJobs: idbListJobs,
    runRhJob,
    runComfyJob,
    runViaAgent,
    createViaAgent,
    pollViaAgent,
    checkHealth,
    syncConfig,
    getAgentConfig,
    ensureAgentOnline,
    llmChatViaAgent,
    getAgentBase,
    setAgentBase,
    getAssetsDir,
    setAssetsDir,
    migrateIdbToDisk,
    DEFAULT_AGENT_BASE,
    corsHint,
    agentOfflineHint,
    uid,
  };
})();
