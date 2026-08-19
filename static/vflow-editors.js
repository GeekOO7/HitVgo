/**
 * Editor workflow registry: merge platform + user EditorManifest catalogs,
 * filter by TimelineSelection, validate user manifests.
 * Exposes window.VflowEditors
 */
(() => {
  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  const USER_EDITORS_KEY = "vflow-user-editors";
  const ACCEPTS = ["frame", "range", "clip"];
  const INPUTS = ["image", "video"];
  const OUTPUTS = ["image", "video", "audio"];
  const PROVIDERS = ["runninghub", "comfyui"];
  const CATEGORIES = [
    "upscale",
    "interpolate",
    "restyle",
    "inpaint",
    "image_edit",
    "custom",
  ];
  const PARAM_TYPES = [
    "prompt",
    "audio",
    "image",
    "video",
    "text",
    "textarea",
    "number",
    "select",
  ];

  function normalizeParams(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.id || "").trim();
      const type = String(raw.type || "text").trim();
      if (!id || !PARAM_TYPES.includes(type) || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        type,
        label: String(raw.label || id).trim() || id,
        labelEn: String(raw.labelEn || raw.label || id).trim() || id,
        required: raw.required === true,
        default: raw.default != null ? raw.default : "",
        placeholder: String(raw.placeholder || "").trim(),
        placeholderEn: String(raw.placeholderEn || raw.placeholder || "").trim(),
        bind: String(raw.bind || "").trim(),
        nodeId: String(raw.nodeId || "").trim(),
        fieldName: String(raw.fieldName || raw.field || "").trim(),
        visibility: ["shown", "collapsed", "hidden"].includes(raw.visibility)
          ? raw.visibility
          : "shown",
        min: raw.min != null ? Number(raw.min) : null,
        max: raw.max != null ? Number(raw.max) : null,
        accept: String(raw.accept || "").trim(),
        options: Array.isArray(raw.options) ? raw.options : [],
      });
    }
    return out;
  }

  /** @type {object[]} */
  let platformEditors = [];

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function loadUserEditors() {
    try {
      const raw = localStorage.getItem(USER_EDITORS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveUserEditors(list) {
    const next = Array.isArray(list) ? list : [];
    localStorage.setItem(USER_EDITORS_KEY, JSON.stringify(next.slice(0, 50)));
    return next;
  }

  function normalizeManifest(raw, source) {
    if (!raw || typeof raw !== "object") return null;
    const id =
      String(raw.id || "").trim() ||
      (source === "user" ? uid("user.editor") : "");
    if (!id) return null;
    const accepts = Array.isArray(raw.accepts)
      ? raw.accepts.filter((a) => ACCEPTS.includes(a))
      : ["frame"];
    const adapter =
      raw.adapter && typeof raw.adapter === "object" ? raw.adapter : {};
    const bindings =
      adapter.bindings && typeof adapter.bindings === "object"
        ? adapter.bindings
        : {};
    return {
      id,
      source: source === "platform" ? "platform" : "user",
      name: String(raw.name || id).trim() || id,
      nameEn: String(raw.nameEn || raw.name || id).trim() || id,
      description: String(raw.description || "").trim(),
      descriptionEn: String(
        raw.descriptionEn || raw.description || ""
      ).trim(),
      category: CATEGORIES.includes(raw.category) ? raw.category : "custom",
      enabled: raw.enabled !== false,
      configured:
        source === "platform"
          ? !!raw.configured
          : !!(
              String(adapter.workflowId || "").trim() ||
              (adapter.workflow && typeof adapter.workflow === "object") ||
              (adapter.workflowUi && typeof adapter.workflowUi === "object")
            ),
      provider: PROVIDERS.includes(raw.provider) ? raw.provider : "runninghub",
      input: INPUTS.includes(raw.input) ? raw.input : "image",
      output: OUTPUTS.includes(raw.output) ? raw.output : "video",
      accepts: accepts.length ? accepts : ["frame"],
      needsPrompt: !!raw.needsPrompt,
      needsAudio: !!raw.needsAudio,
      defaultPrompt: String(raw.defaultPrompt || "").trim(),
      params: normalizeParams(raw.params),
      placement: "editOverlay",
      adapter: {
        workflowId: String(adapter.workflowId || "").trim(),
        workflowUi:
          adapter.workflowUi && typeof adapter.workflowUi === "object"
            ? adapter.workflowUi
            : null,
        workflow:
          adapter.workflow && typeof adapter.workflow === "object"
            ? adapter.workflow
            : null,
        bindings,
      },
    };
  }

  function validateUserManifest(manifest) {
    if (!manifest || typeof manifest !== "object") {
      return { ok: false, error: t("editor.manifestInvalid") };
    }
    if (!String(manifest.name || "").trim()) {
      return { ok: false, error: t("editor.needName") };
    }
    if (!INPUTS.includes(manifest.input)) {
      return { ok: false, error: t("editor.needInput") };
    }
    if (!OUTPUTS.includes(manifest.output)) {
      return { ok: false, error: t("editor.needOutput") };
    }
    if (
      !Array.isArray(manifest.accepts) ||
      !manifest.accepts.some((a) => ACCEPTS.includes(a))
    ) {
      return { ok: false, error: t("editor.needAccepts") };
    }
    if (!PROVIDERS.includes(manifest.provider)) {
      return { ok: false, error: t("editor.needProvider") };
    }
    const adapter = manifest.adapter || {};
    const bindings = adapter.bindings || {};
    // Pure text-to-image (output image, no startImage) is allowed for image_edit.
    const pureT2i =
      manifest.output === "image" && !bindings.startImage && !bindings.inputVideo;
    if (manifest.input === "image" && !bindings.startImage && !pureT2i) {
      return { ok: false, error: t("editor.needStartImageBinding") };
    }
    if (manifest.input === "video" && !bindings.inputVideo && !bindings.startImage) {
      return { ok: false, error: t("editor.needInputVideoBinding") };
    }
    if (manifest.needsAudio && !bindings.inputAudio) {
      return { ok: false, error: t("editor.needInputAudioBinding") };
    }
    if (Array.isArray(manifest.params)) {
      const M = window.VflowEditorInputModal;
      if (M && typeof M.validateParams === "function") {
        const check = M.validateParams(manifest.params);
        if (!check.ok) return check;
      }
    }
    if (manifest.provider === "runninghub" && !String(adapter.workflowId || "").trim()) {
      return { ok: false, error: t("editor.needWorkflowId") };
    }
    if (manifest.provider === "comfyui" && !adapter.workflow && !adapter.workflowUi) {
      return { ok: false, error: t("editor.needComfyWorkflow") };
    }
    return { ok: true };
  }

  function setPlatformEditors(list) {
    platformEditors = Array.isArray(list)
      ? list
          .map((e) => normalizeManifest(e, "platform"))
          .filter(Boolean)
      : [];
    return platformEditors;
  }

  function getPlatformEditors() {
    return platformEditors.slice();
  }

  function getUserEditors() {
    return loadUserEditors()
      .map((e) => normalizeManifest(e, "user"))
      .filter(Boolean);
  }

  function upsertUserEditor(manifest) {
    const normalized = normalizeManifest(
      { ...manifest, source: "user" },
      "user"
    );
    const check = validateUserManifest(normalized);
    if (!check.ok) throw new Error(check.error);
    const list = getUserEditors();
    const idx = list.findIndex((e) => e.id === normalized.id);
    if (idx >= 0) list[idx] = normalized;
    else list.push(normalized);
    saveUserEditors(list);
    return normalized;
  }

  function removeUserEditor(id) {
    const next = getUserEditors().filter((e) => e.id !== id);
    saveUserEditors(next);
    return next;
  }

  function setUserEditorEnabled(id, enabled) {
    const list = getUserEditors();
    const hit = list.find((e) => e.id === id);
    if (!hit) return null;
    hit.enabled = !!enabled;
    saveUserEditors(list);
    return hit;
  }

  function mergeAll() {
    return [...getPlatformEditors(), ...getUserEditors()];
  }

  function displayName(editor, locale) {
    if (!editor) return "";
    const loc =
      locale ||
      (window.VflowI18n && typeof window.VflowI18n.getLocale === "function"
        ? window.VflowI18n.getLocale()
        : "zh");
    if (loc === "en" && editor.nameEn) return editor.nameEn;
    return editor.name || editor.id;
  }

  function displayDescription(editor, locale) {
    if (!editor) return "";
    const loc =
      locale ||
      (window.VflowI18n && typeof window.VflowI18n.getLocale === "function"
        ? window.VflowI18n.getLocale()
        : "zh");
    if (loc === "en" && editor.descriptionEn) return editor.descriptionEn;
    return editor.description || "";
  }

  /**
   * @param {{ kind: string }|null} selection
   * @param {{ platformRh?: boolean, agentOnline?: boolean, videoChannel?: string }} channelReady
   */
  function isPureT2iEditor(editor) {
    if (!editor || editor.output !== "image") return false;
    const bindings =
      (editor.adapter && editor.adapter.bindings) || {};
    if (bindings.startImage || bindings.inputVideo) return false;
    // Platform manifests strip bindings; empty accepts marks generator-only.
    if (editor.source === "platform") {
      return !Array.isArray(editor.accepts) || editor.accepts.length === 0;
    }
    return true;
  }

  function listEditorsForSelection(selection, channelReady) {
    const kind = selection && selection.kind;
    const ready = channelReady || {};
    return mergeAll()
      .filter((e) => e.enabled)
      .filter((e) => !isPureT2iEditor(e))
      .filter((e) => !kind || (e.accepts || []).includes(kind))
      .filter((e) => {
        if (e.source === "platform") {
          return !!ready.platformRh && !!e.configured;
        }
        // User editors need local agent + matching provider channel readiness
        if (!ready.agentOnline) return false;
        if (e.provider === "runninghub") {
          return (
            ready.videoChannel === "custom_rh" ||
            ready.videoChannel === "comfyui" ||
            !!ready.agentOnline
          );
        }
        return !!ready.agentOnline;
      });
  }

  function groupEditors(editors) {
    const platform = [];
    const user = [];
    (editors || []).forEach((e) => {
      if (e.source === "platform") platform.push(e);
      else user.push(e);
    });
    return { platform, user };
  }

  /**
   * Build EditorManifest from LLM finalizeLlmDraft output (mode editor).
   */
  function manifestFromLlmDraft(draft, opts) {
    if (!draft || typeof draft !== "object") {
      throw new Error(t("editor.manifestInvalid"));
    }
    const adapter = draft.adapter || {};
    return normalizeManifest(
      {
        id: (opts && opts.id) || uid("user.editor"),
        source: "user",
        name: draft.name || (opts && opts.name) || t("editor.customDefaultName"),
        category: (opts && opts.category) || "custom",
        provider: draft.provider || (opts && opts.provider) || "comfyui",
        input: draft.input || "image",
        output: draft.output || "video",
        accepts: draft.accepts || ["frame", "range", "clip"],
        needsPrompt: !!draft.needsPrompt,
        needsAudio: !!draft.needsAudio,
        params: draft.params || [],
        enabled: true,
        adapter: {
          workflowId:
            adapter.workflowId || (opts && opts.workflowId) || "",
          workflowUi: adapter.workflowUi || null,
          workflow: adapter.workflow || null,
          bindings: adapter.bindings || {},
        },
      },
      "user"
    );
  }

  function listManagedWorkflows(videoChannelConfig) {
    const items = [];
    const cfg = videoChannelConfig && typeof videoChannelConfig === "object"
      ? videoChannelConfig
      : {};

    function pushChannelMode(target, provider, channelKey, modeCfg, workflowId) {
      if (!modeCfg || typeof modeCfg !== "object") return;
      const bindings = modeCfg.bindings || {};
      const params = Array.isArray(modeCfg.params) ? modeCfg.params : [];
      const shownCount = params.filter((p) => p.visibility === "shown").length;
      items.push({
        id: `${channelKey}:${target}`,
        target,
        provider,
        channelKey,
        name:
          modeCfg.name ||
          (target === "i2v"
            ? t("workflow.targetI2v")
            : target === "flf"
              ? t("workflow.targetFlf")
              : target),
        workflowId: String(workflowId || modeCfg.workflowId || "").trim(),
        params,
        bindings,
        adapterMode: modeCfg,
        shownCount,
        kindSummary: summarizeParamKinds(params),
        enabled: true,
        source: "channel",
      });
    }

    function summarizeParamKinds(params) {
      const kinds = new Set();
      (params || []).forEach((p) => {
        if (!p) return;
        if (p.type === "prompt") kinds.add("prompt");
        else if (p.type === "audio" || p.bind === "inputAudio") kinds.add("audio");
        else if (
          p.type === "image" ||
          p.bind === "startImage" ||
          p.bind === "endImage" ||
          /^refImage\d+$/.test(p.bind || "")
        ) {
          kinds.add("image");
        } else if (
          p.type === "video" ||
          p.bind === "inputVideo" ||
          /^refVideo\d+$/.test(p.bind || "")
        ) {
          kinds.add("video");
        } else kinds.add(p.type || "text");
      });
      return Array.from(kinds);
    }

    const rh = cfg.rh || {};
    const rhAdapter = rh.adapter || {};
    const rhModes = rhAdapter.modes || {};
    if (rhModes.i2v) {
      pushChannelMode("i2v", "runninghub", "rh", rhModes.i2v, rh.workflowIdI2v);
    }
    if (rhModes.flf) {
      pushChannelMode("flf", "runninghub", "rh", rhModes.flf, rh.workflowIdFlf);
    }

    const comfy = cfg.comfy || {};
    const comfyAdapter = comfy.adapter || {};
    const comfyModes = comfyAdapter.modes || {};
    if (comfyModes.i2v) {
      pushChannelMode("i2v", "comfyui", "comfy", comfyModes.i2v, "");
    }
    if (comfyModes.flf) {
      pushChannelMode("flf", "comfyui", "comfy", comfyModes.flf, "");
    }

    getUserEditors().forEach((ed) => {
      const params = Array.isArray(ed.params) ? ed.params : [];
      items.push({
        id: ed.id,
        target: "editor",
        provider: ed.provider || "runninghub",
        channelKey: "editor",
        name: ed.name || ed.id,
        workflowId: String((ed.adapter && ed.adapter.workflowId) || "").trim(),
        params,
        bindings: (ed.adapter && ed.adapter.bindings) || {},
        adapterMode: ed.adapter || {},
        manifest: ed,
        shownCount: params.filter((p) => p.visibility === "shown").length,
        kindSummary: summarizeParamKinds(params),
        enabled: ed.enabled !== false,
        source: "editor",
      });
    });

    return items;
  }

  function removeChannelWorkflowMode(videoChannelConfig, channelKey, target) {
    const cfg = JSON.parse(JSON.stringify(videoChannelConfig || {}));
    const ch = channelKey === "comfy" ? cfg.comfy : cfg.rh;
    if (!ch || !ch.adapter || !ch.adapter.modes) return cfg;
    delete ch.adapter.modes[target];
    if (!Object.keys(ch.adapter.modes).length) {
      ch.adapter = null;
    }
    return cfg;
  }

  window.VflowEditors = {
    USER_EDITORS_KEY,
    ACCEPTS,
    setPlatformEditors,
    getPlatformEditors,
    getUserEditors,
    upsertUserEditor,
    removeUserEditor,
    setUserEditorEnabled,
    mergeAll,
    listEditorsForSelection,
    groupEditors,
    isPureT2iEditor,
    displayName,
    displayDescription,
    validateUserManifest,
    normalizeManifest,
    manifestFromLlmDraft,
    listManagedWorkflows,
    removeChannelWorkflowMode,
  };
})();
