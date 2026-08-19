/**
 * User-owned storyboard generation engines (localStorage).
 * Exposes window.VflowUserEngines
 */
(() => {
  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  const STORAGE_KEY = "vflow-user-engines";
  const MIGRATED_KEY = "vflow-user-engines-migrated";
  const PROVIDERS = ["runninghub", "comfyui"];
  const ID_PREFIX = "user.engine.";

  function uid() {
    return (
      ID_PREFIX +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function num(raw, fallback, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    let out = n;
    if (min != null && out < min) out = min;
    if (max != null && out > max) out = max;
    return out;
  }

  function parseDurationChoices(raw) {
    if (Array.isArray(raw)) {
      const list = raw
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0);
      return list.length ? list : null;
    }
    if (typeof raw === "string" && raw.trim()) {
      const list = raw
        .split(/[,，\s]+/)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0);
      return list.length ? list : null;
    }
    return null;
  }

  function emptySlot() {
    return {
      workflowId: "",
      workflowUi: null,
      workflow: null,
      bindings: {},
      params: [],
    };
  }

  function normalizeSlot(raw) {
    if (!raw || typeof raw !== "object") return emptySlot();
    const bindingsIn =
      raw.bindings && typeof raw.bindings === "object" ? raw.bindings : {};
    const bindings = {};
    Object.keys(bindingsIn).forEach((key) => {
      const b = bindingsIn[key];
      if (!b || typeof b !== "object") return;
      let fieldName = String(b.fieldName || "").trim();
      if (/^(upload|choose file|choose_file|open)$/i.test(fieldName)) {
        fieldName = "image";
      }
      bindings[key] = {
        nodeId: String(b.nodeId || "").trim(),
        fieldName,
      };
    });
    const params = (Array.isArray(raw.params) ? raw.params : []).map((p) => {
      if (!p || typeof p !== "object") return p;
      let fieldName = String(p.fieldName || p.field || "").trim();
      if (/^(upload|choose file|choose_file|open)$/i.test(fieldName)) {
        fieldName = "image";
      }
      return { ...p, fieldName };
    });
    return {
      workflowId: String(raw.workflowId || "").trim(),
      workflowUi:
        raw.workflowUi && typeof raw.workflowUi === "object"
          ? raw.workflowUi
          : null,
      workflow:
        raw.workflow && typeof raw.workflow === "object" ? raw.workflow : null,
      bindings,
      params,
      name: String(raw.name || "").trim(),
    };
  }

  const TIMING_MODE_FRAMES = "frames";
  const TIMING_MODE_DURATION = "duration";

  /** Wan-like vs MiniMax-like capability presets for user engines. */
  function capsForTimingMode(mode) {
    if (mode === TIMING_MODE_DURATION) {
      return {
        timingMode: TIMING_MODE_DURATION,
        mainMinSec: 10,
        mainMaxSec: 15,
        mainDefaultSec: 10,
        bridgeMinSec: 10,
        bridgeMaxSec: 15,
        bridgeDefaultSec: 10,
        durationChoices: [10, 15],
        softChainUnitSec: 22,
        supportsMultiRef: true,
        allowAudioInPrompt: true,
        allowTimedBeats: true,
        nativeFps: 24,
        defaultFps: 24,
        defaultLength: 243,
        usesDurationSeconds: true,
        maxRefImages: 5,
        maxRefVideos: 0,
        maxRefAudios: 0,
      };
    }
    return {
      timingMode: TIMING_MODE_FRAMES,
      mainMinSec: 2,
      mainMaxSec: 7,
      mainDefaultSec: 5,
      bridgeMinSec: 3.4,
      bridgeMaxSec: 12,
      bridgeDefaultSec: 7,
      durationChoices: null,
      softChainUnitSec: 21,
      supportsMultiRef: false,
      allowAudioInPrompt: false,
      allowTimedBeats: false,
      nativeFps: null,
      defaultFps: 16,
      defaultLength: null,
      usesDurationSeconds: false,
      maxRefImages: 0,
      maxRefVideos: 0,
      maxRefAudios: 0,
    };
  }

  function detectTimingMode(engine) {
    if (!engine) return TIMING_MODE_FRAMES;
    if (
      engine.timingMode === TIMING_MODE_DURATION ||
      engine.timingMode === TIMING_MODE_FRAMES
    ) {
      return engine.timingMode;
    }
    if (engine.usesDurationSeconds || engine.nativeFps != null) {
      return TIMING_MODE_DURATION;
    }
    return TIMING_MODE_FRAMES;
  }

  function defaultCaps() {
    return capsForTimingMode(TIMING_MODE_FRAMES);
  }

  function normalizeEngine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim() || uid();
    if (!id.startsWith(ID_PREFIX)) return null;
    const caps = defaultCaps();
    const durationChoices = parseDurationChoices(raw.durationChoices);
    const mainMin = num(raw.mainMinSec, caps.mainMinSec, 0.5, 120);
    const mainMax = num(raw.mainMaxSec, caps.mainMaxSec, mainMin, 180);
    const bridgeMin = num(raw.bridgeMinSec, caps.bridgeMinSec, 0.5, 120);
    const bridgeMax = num(raw.bridgeMaxSec, caps.bridgeMaxSec, bridgeMin, 180);
    return {
      id,
      source: "user",
      name: String(raw.name || "").trim() || t("engine.customDefaultName"),
      enabled: raw.enabled !== false,
      provider: PROVIDERS.includes(raw.provider) ? raw.provider : "runninghub",
      timingMode: detectTimingMode({
        timingMode: raw.timingMode,
        usesDurationSeconds: raw.usesDurationSeconds,
        nativeFps: raw.nativeFps,
      }),
      mainMinSec: mainMin,
      mainMaxSec: mainMax,
      mainDefaultSec: num(
        raw.mainDefaultSec,
        Math.min(mainMax, Math.max(mainMin, caps.mainDefaultSec)),
        mainMin,
        mainMax
      ),
      bridgeMinSec: bridgeMin,
      bridgeMaxSec: bridgeMax,
      bridgeDefaultSec: num(
        raw.bridgeDefaultSec,
        Math.min(bridgeMax, Math.max(bridgeMin, caps.bridgeDefaultSec)),
        bridgeMin,
        bridgeMax
      ),
      durationChoices,
      softChainUnitSec: num(raw.softChainUnitSec, caps.softChainUnitSec, 1, 300),
      supportsMultiRef: !!raw.supportsMultiRef,
      allowAudioInPrompt: !!raw.allowAudioInPrompt,
      allowTimedBeats: !!raw.allowTimedBeats,
      nativeFps:
        raw.nativeFps == null || raw.nativeFps === ""
          ? null
          : num(raw.nativeFps, 24, 1, 120),
      defaultFps: num(raw.defaultFps, caps.defaultFps, 1, 120),
      defaultLength:
        raw.defaultLength == null || raw.defaultLength === ""
          ? null
          : num(raw.defaultLength, 81, 1, 2000),
      usesDurationSeconds: !!raw.usesDurationSeconds,
      maxRefImages: Math.round(num(raw.maxRefImages, 0, 0, 8)),
      maxRefVideos: Math.round(num(raw.maxRefVideos, 0, 0, 3)),
      maxRefAudios: Math.round(num(raw.maxRefAudios, 0, 0, 2)),
      main: normalizeSlot(raw.main),
      bridge: normalizeSlot(raw.bridge),
    };
  }

  function slotConfigured(slot, provider) {
    if (!slot || typeof slot !== "object") return false;
    const bindings = slot.bindings;
    if (!bindings || typeof bindings !== "object" || !Object.keys(bindings).length) {
      return false;
    }
    if (provider === "runninghub") {
      return !!String(slot.workflowId || "").trim();
    }
    if (provider === "comfyui") {
      return !!(slot.workflow || slot.workflowUi);
    }
    return true;
  }

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeEngine).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function saveAll(list) {
    const next = (Array.isArray(list) ? list : []).slice(0, 40);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function list() {
    return loadAll();
  }

  function get(id) {
    const sid = String(id || "").trim();
    if (!sid) return null;
    return loadAll().find((e) => e.id === sid) || null;
  }

  function validate(engine) {
    if (!engine || typeof engine !== "object") {
      return { ok: false, error: t("engine.invalid") };
    }
    if (!String(engine.name || "").trim()) {
      return { ok: false, error: t("engine.needName") };
    }
    if (!PROVIDERS.includes(engine.provider)) {
      return { ok: false, error: t("engine.needProvider") };
    }
    if (engine.mainMinSec > engine.mainMaxSec) {
      return { ok: false, error: t("engine.badMainRange") };
    }
    if (engine.bridgeMinSec > engine.bridgeMaxSec) {
      return { ok: false, error: t("engine.badBridgeRange") };
    }
    return { ok: true };
  }

  function upsert(raw) {
    const normalized = normalizeEngine({
      ...raw,
      id: raw && raw.id ? raw.id : uid(),
      source: "user",
    });
    const check = validate(normalized);
    if (!check.ok) throw new Error(check.error);
    const all = loadAll();
    const idx = all.findIndex((e) => e.id === normalized.id);
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    saveAll(all);
    return normalized;
  }

  function remove(id) {
    const next = loadAll().filter((e) => e.id !== id);
    saveAll(next);
    return next;
  }

  function setEnabled(id, enabled) {
    const all = loadAll();
    const hit = all.find((e) => e.id === id);
    if (!hit) return null;
    hit.enabled = !!enabled;
    saveAll(all);
    return hit;
  }

  function setSlot(id, role, slot) {
    const all = loadAll();
    const hit = all.find((e) => e.id === id);
    if (!hit) return null;
    const key = role === "bridge" ? "bridge" : "main";
    hit[key] = normalizeSlot(slot);
    saveAll(all);
    return hit;
  }

  function clearSlot(id, role) {
    return setSlot(id, role, emptySlot());
  }

  function isSelectable(engine) {
    if (!engine || engine.enabled === false) return false;
    return slotConfigured(engine.main, engine.provider);
  }

  function listSelectable() {
    return loadAll().filter(isSelectable);
  }

  function capabilitySummary(engine) {
    if (!engine) return "";
    const mode =
      detectTimingMode(engine) === TIMING_MODE_DURATION
        ? t("engine.timingModeDuration")
        : t("engine.timingModeFrames");
    const main = engine.mainMinSec + "–" + engine.mainMaxSec + "s";
    const refs = engine.supportsMultiRef
      ? t("engine.summaryMultiRef", { n: engine.maxRefImages || 0 })
      : t("engine.summaryNoRef");
    return mode + " · " + main + " · " + refs;
  }

  function dockStatus(engine) {
    if (!engine) {
      return { main: false, bridge: false };
    }
    return {
      main: slotConfigured(engine.main, engine.provider),
      bridge: slotConfigured(engine.bridge, engine.provider),
    };
  }

  function toRuntimeEnvelope(engine) {
    if (!engine) return null;
    return {
      id: engine.id,
      source: "user",
      name: engine.name,
      provider: engine.provider,
      enabled: engine.enabled !== false,
      configured: slotConfigured(engine.main, engine.provider),
      mainMinSec: engine.mainMinSec,
      mainMaxSec: engine.mainMaxSec,
      mainDefaultSec: engine.mainDefaultSec,
      bridgeMinSec: engine.bridgeMinSec,
      bridgeMaxSec: engine.bridgeMaxSec,
      bridgeDefaultSec: engine.bridgeDefaultSec,
      durationChoices: engine.durationChoices,
      softChainUnitSec: engine.softChainUnitSec,
      supportsMultiRef: !!engine.supportsMultiRef,
      allowAudioInPrompt: !!engine.allowAudioInPrompt,
      allowTimedBeats: !!engine.allowTimedBeats,
      nativeFps: engine.nativeFps,
      defaultFps: engine.defaultFps,
      defaultLength: engine.defaultLength,
      usesDurationSeconds: !!engine.usesDurationSeconds,
      maxRefImages: engine.maxRefImages || 0,
      maxRefVideos: engine.maxRefVideos || 0,
      maxRefAudios: engine.maxRefAudios || 0,
      mainFeatureId: "i2v",
      bridgeFeatureId: "flf",
      main: engine.main,
      bridge: engine.bridge,
    };
  }

  function adapterModeFromSlot(engine, role) {
    if (!engine) return null;
    const slot = role === "bridge" || role === "flf" ? engine.bridge : engine.main;
    if (!slotConfigured(slot, engine.provider)) return null;
    const W = window.VflowAdapter;
    const modeCfg = {
      workflowId: slot.workflowId || "",
      workflowUi: slot.workflowUi || null,
      workflow: slot.workflow || null,
      bindings: { ...(slot.bindings || {}) },
      params: Array.isArray(slot.params) ? slot.params.slice() : [],
      name: slot.name || "",
    };
    if (W && !modeCfg.workflow && modeCfg.workflowUi) {
      try {
        modeCfg.workflow = W.uiWorkflowToApiPrompt(modeCfg.workflowUi);
      } catch (e) {
        /* keep ui graph */
      }
    }
    return modeCfg;
  }

  function migrateFromChannelConfig(cfg) {
    try {
      if (localStorage.getItem(MIGRATED_KEY) === "1") return [];
    } catch (e) {
      /* ignore */
    }
    const created = [];
    const c = cfg && typeof cfg === "object" ? cfg : {};

    function importFrom(provider, adapter, name) {
      if (!adapter || !adapter.modes) return;
      const main = adapter.modes.i2v || adapter.modes.minimax_i2v || null;
      const bridge = adapter.modes.flf || adapter.modes.minimax_flf || null;
      if (!main && !bridge) return;
      const engine = upsert({
        name: name,
        provider: provider,
        enabled: true,
        main: normalizeSlot(main),
        bridge: normalizeSlot(bridge),
      });
      created.push(engine);
    }

    const rhAdapter = c.rh && c.rh.adapter;
    const comfyAdapter = c.comfy && c.comfy.adapter;
    importFrom(
      "runninghub",
      rhAdapter,
      t("engine.migratedRhName")
    );
    importFrom("comfyui", comfyAdapter, t("engine.migratedComfyName"));
    try {
      localStorage.setItem(MIGRATED_KEY, "1");
    } catch (e) {
      /* ignore */
    }
    return created;
  }

  window.VflowUserEngines = {
    STORAGE_KEY,
    ID_PREFIX,
    PROVIDERS,
    TIMING_MODE_FRAMES,
    TIMING_MODE_DURATION,
    list,
    get,
    upsert,
    remove,
    setEnabled,
    setSlot,
    clearSlot,
    validate,
    normalizeEngine,
    normalizeSlot,
    emptySlot,
    slotConfigured,
    isSelectable,
    listSelectable,
    capabilitySummary,
    dockStatus,
    toRuntimeEnvelope,
    adapterModeFromSlot,
    migrateFromChannelConfig,
    defaultCaps,
    capsForTimingMode,
    detectTimingMode,
    parseDurationChoices,
    uid,
  };
})();
