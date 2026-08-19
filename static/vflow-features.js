/**
 * Platform feature workflow registry (i2v/flf + user-extensible modes).
 * Syncs custom feature metadata with localStorage; mode payloads live in
 * channel adapter.modes[featureId].
 * Exposes window.VflowFeatures
 */
(() => {
  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  const CUSTOM_FEATURES_KEY = "vflow-custom-features";
  const SEMANTIC = [
    "startImage",
    "endImage",
    "inputVideo",
    "inputAudio",
    "prompt",
    "negative",
    "width",
    "height",
    "length",
    "fps",
    "seedHigh",
    "seedLow",
    "duration",
    "refImage0",
    "refImage1",
    "refImage2",
    "refImage3",
    "refImage4",
    "refImage5",
    "refImage6",
    "refImage7",
    "refImage8",
    "refVideo0",
    "refVideo1",
    "refVideo2",
    "refAudio0",
    "refImage1Enable",
    "refImage2Enable",
    "refImage3Enable",
    "refVideo0Enable",
    "refVideoAudio0Enable",
    "refAudio0Enable",
  ];

  const BUILTIN = [
    {
      id: "i2v",
      nameKey: "workflow.featureI2v",
      descKey: "workflow.featureI2vDesc",
      builtin: true,
      role: "storyboard_main",
      engine: "wan",
      requiredBindings: ["startImage", "prompt"],
    },
    {
      id: "flf",
      nameKey: "workflow.featureFlf",
      descKey: "workflow.featureFlfDesc",
      builtin: true,
      role: "storyboard_bridge",
      engine: "wan",
      requiredBindings: ["startImage", "endImage", "prompt"],
    },
    {
      id: "minimax_i2v",
      nameKey: "workflow.featureMinimaxI2v",
      descKey: "workflow.featureMinimaxI2vDesc",
      builtin: true,
      role: "storyboard_main",
      engine: "minimax",
      requiredBindings: ["prompt", "duration"],
    },
    {
      id: "minimax_flf",
      nameKey: "workflow.featureMinimaxFlf",
      descKey: "workflow.featureMinimaxFlfDesc",
      builtin: true,
      role: "storyboard_bridge",
      engine: "minimax",
      requiredBindings: ["startImage", "endImage", "prompt", "duration"],
    },
    {
      id: "t2i",
      nameKey: "workflow.featureT2i",
      descKey: "workflow.featureT2iDesc",
      builtin: true,
      role: "first_frame",
      requiredBindings: ["prompt"],
    },
  ];

  function loadCustomFeatures() {
    try {
      const raw = localStorage.getItem(CUSTOM_FEATURES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveCustomFeatures(list) {
    try {
      localStorage.setItem(CUSTOM_FEATURES_KEY, JSON.stringify(list || []));
    } catch (e) {
      console.warn("save custom features failed", e);
    }
  }

  function normalizeCustom(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    if (
      !id ||
      id === "i2v" ||
      id === "flf" ||
      id === "t2i" ||
      id === "editor" ||
      id === "minimax_i2v" ||
      id === "minimax_flf"
    )
      return null;
    const requiredBindings = Array.isArray(raw.requiredBindings)
      ? raw.requiredBindings.filter((k) => SEMANTIC.includes(k))
      : ["startImage", "prompt"];
    return {
      id,
      name: String(raw.name || id).trim() || id,
      description: String(raw.description || "").trim(),
      builtin: false,
      role: "custom",
      requiredBindings: requiredBindings.length
        ? requiredBindings
        : ["startImage", "prompt"],
    };
  }

  function listFeatures() {
    const customs = loadCustomFeatures()
      .map(normalizeCustom)
      .filter(Boolean);
    return BUILTIN.concat(customs);
  }

  function getFeature(id) {
    const sid = String(id || "").trim();
    return listFeatures().find((f) => f.id === sid) || null;
  }

  function displayName(feature) {
    if (!feature) return "";
    if (feature.builtin && feature.nameKey) return t(feature.nameKey);
    return feature.name || feature.id;
  }

  function displayDescription(feature) {
    if (!feature) return "";
    if (feature.builtin && feature.descKey) return t(feature.descKey);
    return feature.description || "";
  }

  function upsertCustomFeature(raw) {
    const next = normalizeCustom(raw);
    if (!next) throw new Error(t("workflow.featureIdInvalid"));
    const list = loadCustomFeatures()
      .map(normalizeCustom)
      .filter(Boolean)
      .filter((f) => f.id !== next.id);
    list.push(next);
    saveCustomFeatures(list);
    return next;
  }

  function removeCustomFeature(id) {
    const sid = String(id || "").trim();
    if (
      !sid ||
      sid === "i2v" ||
      sid === "flf" ||
      sid === "t2i" ||
      sid === "minimax_i2v" ||
      sid === "minimax_flf"
    )
      return false;
    const list = loadCustomFeatures()
      .map(normalizeCustom)
      .filter(Boolean)
      .filter((f) => f.id !== sid);
    saveCustomFeatures(list);
    return true;
  }

  function modeConfigured(modeCfg, provider) {
    if (!modeCfg || typeof modeCfg !== "object") return false;
    const bindings = modeCfg.bindings;
    if (!bindings || typeof bindings !== "object") return false;
    if (!Object.keys(bindings).length) return false;
    if (provider === "runninghub" || provider === "custom_rh") {
      return !!(modeCfg.workflowId && String(modeCfg.workflowId).trim());
    }
    if (provider === "comfyui") {
      return !!(modeCfg.workflow || modeCfg.workflowUi);
    }
    return true;
  }

  function featureStatus(feature, channel, adapter) {
    if (!feature) return { key: "workflow.statusUnknown", className: "is-warn" };
    const provider = channel === "comfyui" ? "comfyui" : "runninghub";
    const mode =
      adapter && adapter.modes && adapter.modes[feature.id]
        ? adapter.modes[feature.id]
        : null;
    if (modeConfigured(mode, provider)) {
      return { key: "workflow.statusDocked", className: "is-ok" };
    }
    return { key: "workflow.statusUndocked", className: "is-warn" };
  }

  function llmModeForFeature(feature) {
    if (!feature) return "i2v";
    if (feature.id === "i2v" || feature.id === "flf") return feature.id;
    if (feature.id === "minimax_i2v") return "i2v";
    if (feature.id === "minimax_flf") return "flf";
    if (feature.id === "t2i") return "editor";
    const req = feature.requiredBindings || [];
    if (req.includes("endImage")) return "flf";
    if (req.includes("startImage") && req.includes("prompt")) return "i2v";
    if (req.includes("duration") || req.some((k) => String(k).indexOf("refImage") === 0))
      return "i2v";
    return "editor";
  }

  function featuresForEngine(engineId) {
    const eid = String(engineId || "wan").trim().toLowerCase();
    return listFeatures().filter((f) => {
      if (!f.engine) return true;
      return f.engine === eid;
    });
  }

  function providerLabel(channel) {
    if (channel === "comfyui") return t("settings.channelComfy");
    if (channel === "custom_rh") return t("settings.channelRh");
    return t("settings.channelPlatform");
  }

  window.VflowFeatures = {
    SEMANTIC,
    BUILTIN,
    listFeatures,
    getFeature,
    displayName,
    displayDescription,
    upsertCustomFeature,
    removeCustomFeature,
    modeConfigured,
    featureStatus,
    llmModeForFeature,
    featuresForEngine,
    providerLabel,
    loadCustomFeatures,
  };
})();
