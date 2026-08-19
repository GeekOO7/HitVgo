/**
 * vflow-adapter: workflow ingest, LLM draft finalize, bindings apply.
 * Exposes window.VflowAdapter
 */
(() => {
  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  const SEMANTIC_FIELDS = [
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

  const PARAM_VISIBILITIES = ["shown", "collapsed", "hidden"];

  let DEFAULT_PLATFORM_BINDINGS_I2V = {};
  let DEFAULT_PLATFORM_BINDINGS_FLF = {};

  function setPlatformBindings(i2vBindings, flfBindings) {
    if (i2vBindings && typeof i2vBindings === "object") {
      DEFAULT_PLATFORM_BINDINGS_I2V = { ...i2vBindings };
    }
    if (flfBindings && typeof flfBindings === "object") {
      DEFAULT_PLATFORM_BINDINGS_FLF = { ...flfBindings };
    }
  }

  function platformBuiltinAdapter(workflowIdI2v, workflowIdFlf) {
    return {
      version: 1,
      provider: "runninghub",
      name: t("adapter.platformRh"),
      modes: {
        i2v: {
          workflowId: workflowIdI2v || "",
          bindings: { ...DEFAULT_PLATFORM_BINDINGS_I2V },
        },
        flf: {
          workflowId: workflowIdFlf || "",
          bindings: { ...DEFAULT_PLATFORM_BINDINGS_FLF },
        },
      },
    };
  }

  function isComfyUiWorkflow(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) return true;
    if ("last_node_id" in raw && Array.isArray(raw.nodes)) return true;
    return false;
  }

  function normalizeWorkflowGraph(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (isComfyUiWorkflow(raw)) return null;
    if (raw.prompt && typeof raw.prompt === "object" && !Array.isArray(raw.prompt)) {
      const keys = Object.keys(raw.prompt);
      if (
        keys.length &&
        keys.every(
          (k) =>
            raw.prompt[k] &&
            typeof raw.prompt[k] === "object" &&
            raw.prompt[k].class_type
        )
      ) {
        return raw.prompt;
      }
    }
    const keys = Object.keys(raw);
    if (
      keys.length &&
      keys.every((k) => raw[k] && typeof raw[k] === "object" && raw[k].class_type)
    ) {
      return raw;
    }
    return null;
  }

  function detectWorkflowFormat(raw) {
    if (!raw || typeof raw !== "object") return "unknown";
    if (isComfyUiWorkflow(raw)) return "ui";
    if (normalizeWorkflowGraph(raw)) return "api";
    return "unknown";
  }

  function assertValidWorkflow(raw) {
    const fmt = detectWorkflowFormat(raw);
    if (fmt === "unknown") {
      throw new Error(t("local.unrecognizedComfy"));
    }
    return raw;
  }

  function buildLinkMap(links) {
    const byId = {};
    (links || []).forEach((l) => {
      if (!Array.isArray(l) || l.length < 5) return;
      byId[l[0]] = { src: String(l[1]), srcSlot: l[2], tgt: String(l[3]), tgtSlot: l[4] };
    });
    return byId;
  }

  /**
   * ComfyUI LiteGraph modes that do NOT appear as nodes in Save API Format /
   * RunningHub graphs: NEVER(2) skipped; BYPASS(4) omitted (links rewired).
   * Missing/NaN mode → ALWAYS(0).
   */
  function isUiNodeInApiPrompt(node) {
    if (!node || node.id == null) return false;
    const mode = node.mode == null ? 0 : Number(node.mode);
    if (mode === 2 || mode === 4) return false;
    return true;
  }

  function uiWorkflowToApiPrompt(ui) {
    if (!isComfyUiWorkflow(ui)) {
      throw new Error(t("adapter.needUiWorkflow"));
    }
    const linkMap = buildLinkMap(ui.links);
    const prompt = {};
    (ui.nodes || []).forEach((node) => {
      // Keep all nodes here (incl. BYPASS): skipping without link-rewire
      // breaks consumers. LLM ingest uses isUiNodeInApiPrompt instead.
      if (!node || node.id == null) return;
      const nodeId = String(node.id);
      const inputs = {};
      const wvals = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      let wIdx = 0;
      const used = new Set();
      (node.inputs || []).forEach((inp) => {
        const name = inp.name || (inp.widget && inp.widget.name);
        if (!name) return;
        const linked = inp.link != null && linkMap[inp.link];
        if (linked) {
          const lk = linkMap[inp.link];
          inputs[name] = [lk.src, lk.srcSlot];
          used.add(name);
          if (hasWidgetSlot(inp) && wIdx < wvals.length) wIdx += 1;
          return;
        }
        if (!hasWidgetSlot(inp)) return;
        used.add(name);
        if (wIdx < wvals.length) {
          inputs[name] = wvals[wIdx];
          wIdx += 1;
        }
      });
      const leftover = wvals.slice(wIdx);
      const leftoverNames = inferLeftoverWidgetNames(node, leftover, used);
      leftover.forEach((value, i) => {
        const name = leftoverNames[i] || `widget_${wIdx + i}`;
        if (inputs[name] == null) inputs[name] = value;
      });
      prompt[nodeId] = {
        class_type: node.type || "Unknown",
        inputs,
        _meta: { title: node.title || "" },
      };
    });
    if (!Object.keys(prompt).length) {
      throw new Error(t("adapter.uiConvertEmpty"));
    }
    return prompt;
  }

  function prepareWorkflowStorage(workflow) {
    assertValidWorkflow(workflow);
    if (isComfyUiWorkflow(workflow)) {
      return {
        workflowUi: workflow,
        workflow: uiWorkflowToApiPrompt(workflow),
      };
    }
    const api = normalizeWorkflowGraph(workflow);
    return { workflowUi: null, workflow: api };
  }

  function resolveApiGraph(workflowOrMode) {
    if (!workflowOrMode) return null;
    if (typeof workflowOrMode === "object" && workflowOrMode.workflow) {
      return workflowOrMode.workflow;
    }
    if (isComfyUiWorkflow(workflowOrMode)) {
      return uiWorkflowToApiPrompt(workflowOrMode);
    }
    return normalizeWorkflowGraph(workflowOrMode) || workflowOrMode;
  }

  function listNodes(graph) {
    const g = resolveApiGraph(graph);
    if (!g || typeof g !== "object" || Array.isArray(g)) return [];
    return Object.keys(g).map((id) => ({
      nodeId: String(id),
      classType: (g[id] && g[id].class_type) || "",
      inputs: (g[id] && g[id].inputs) || {},
      title: (g[id] && g[id]._meta && g[id]._meta.title) || "",
    }));
  }

  function summarizeUiWorkflowForLlm(ui) {
    if (!isComfyUiWorkflow(ui)) return [];
    return (ui.nodes || [])
      .filter((n) => isUiNodeInApiPrompt(n))
      .map((n) => {
      const widgets = [];
      collectUiWidgetFields(n).forEach((field) => {
        widgets.push({
          name: field.name,
          value: field.value,
          linked: false,
        });
      });
      const linkedInputs = (n.inputs || [])
        .filter((inp) => inp.link != null)
        .map((inp) => inp.name || (inp.widget && inp.widget.name) || "input");
      const outputTypes = (n.outputs || [])
        .map((o) => o.type)
        .filter(Boolean);
      return {
        nodeId: String(n.id),
        class_type: n.type || "",
        title: n.title || "",
        widgets,
        linkedInputs,
        outputTypes,
      };
    });
  }

  function summarizeWorkflowForLlm(workflow) {
    if (isComfyUiWorkflow(workflow)) {
      return summarizeUiWorkflowForLlm(workflow);
    }
    return listNodes(workflow).map((n) => ({
      nodeId: n.nodeId,
      class_type: n.classType,
      title: n.title || "",
      fields: Object.keys(n.inputs || {}),
      widgets: Object.entries(n.inputs || {})
        .filter(([, v]) => !Array.isArray(v))
        .map(([name, value]) => ({ name, value, linked: false })),
      linkedInputs: Object.keys(n.inputs || {}).filter((k) =>
        Array.isArray(n.inputs[k])
      ),
      outputTypes: [],
    }));
  }

  function readWorkflowFieldValue(workflow, nodeId, fieldName) {
    if (!workflow || nodeId == null || fieldName == null || fieldName === "") {
      return undefined;
    }
    const nid = String(nodeId);
    const fname = String(fieldName);

    if (isComfyUiWorkflow(workflow)) {
      const node = (workflow.nodes || []).find((n) => n && String(n.id) === nid);
      if (node) {
        const hit = collectUiWidgetFields(node).find(
          (f) => f && String(f.name) === fname
        );
        if (hit && hit.value !== undefined) return hit.value;
        if (fname === "value") {
          const wvals = Array.isArray(node.widgets_values)
            ? node.widgets_values
            : [];
          if (wvals.length) return wvals[0];
        }
      }
    }

    const graph = resolveApiGraph(workflow);
    if (graph && graph[nid] && graph[nid].inputs) {
      const v = graph[nid].inputs[fname];
      if (v !== undefined && !Array.isArray(v)) return v;
    }
    return undefined;
  }

  function fillParamDefaultsFromWorkflow(params, bindings, workflow, opts) {
    if (!Array.isArray(params) || !params.length || !workflow) {
      return Array.isArray(params) ? params : [];
    }
    const onlyEmpty = !!(opts && opts.onlyEmpty);
    const binds = bindings && typeof bindings === "object" ? bindings : {};
    return params.map((p) => {
      if (!p || typeof p !== "object") return p;
      const type = String(p.type || "").toLowerCase();
      if (type === "audio" || type === "image" || type === "video") return p;
      if (onlyEmpty) {
        const hasCached =
          p.default === 0 ||
          p.default === false ||
          (p.default != null && p.default !== "");
        if (hasCached) return p;
      }
      const nodeId =
        String(p.nodeId || "").trim() ||
        (p.bind && binds[p.bind] ? String(binds[p.bind].nodeId || "").trim() : "");
      const fieldName =
        String(p.fieldName || "").trim() ||
        (p.bind && binds[p.bind]
          ? String(binds[p.bind].fieldName || "").trim()
          : "");
      if (!nodeId || !fieldName) return p;
      let wv = readWorkflowFieldValue(workflow, nodeId, fieldName);
      if (
        (wv === undefined || wv === null) &&
        p.bind &&
        binds[p.bind] &&
        (String(binds[p.bind].nodeId) !== nodeId ||
          String(binds[p.bind].fieldName || "") !== fieldName)
      ) {
        wv = readWorkflowFieldValue(
          workflow,
          binds[p.bind].nodeId,
          binds[p.bind].fieldName
        );
      }
      if (wv === undefined || wv === null || Array.isArray(wv)) return p;
      // Prefer workflow canvas value as the runtime default
      return { ...p, default: wv };
    });
  }

  function normalizeDraftParams(raw, bindings) {
    if (!Array.isArray(raw)) return [];
    const binds = bindings && typeof bindings === "object" ? bindings : {};
    const out = [];
    const seen = new Set();
    raw.forEach((p) => {
      if (!p || typeof p !== "object") return;
      let nodeId = String(p.nodeId || "").trim();
      let fieldName = String(p.fieldName || p.field || "").trim();
      const bind = String(p.bind || "").trim();
      if ((!nodeId || !fieldName) && bind && binds[bind]) {
        nodeId = nodeId || String(binds[bind].nodeId || "").trim();
        fieldName = fieldName || String(binds[bind].fieldName || "").trim();
      }
      const id =
        String(p.id || p.bind || "").trim() ||
        (nodeId && fieldName ? `${nodeId}:${fieldName}` : "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      let type = String(p.type || "text").trim();
      if (type === "string") type = "text";
      if (bind === "prompt" || id === "prompt") type = "prompt";
      if (bind === "inputAudio" || type === "audio") type = "audio";
      let visibility = String(p.visibility || "shown").trim();
      if (!PARAM_VISIBILITIES.includes(visibility)) visibility = "shown";
      out.push({
        id,
        type,
        label: String(p.label || id).trim() || id,
        labelEn: String(p.labelEn || p.label || id).trim() || id,
        required: p.required === true,
        default: p.default != null ? p.default : "",
        placeholder: String(p.placeholder || "").trim(),
        bind,
        nodeId,
        fieldName,
        visibility,
        min: p.min != null ? Number(p.min) : null,
        max: p.max != null ? Number(p.max) : null,
        options: Array.isArray(p.options) ? p.options : [],
      });
    });
    return out;
  }

  function deriveEditorMetaFromBindings(bindings, draft) {
    const b = bindings || {};
    const input = draft && draft.input
      ? draft.input
      : b.inputVideo && !b.startImage
        ? "video"
        : "image";
    let output = (draft && draft.output) || "video";
    if (b.inputAudio && !output) output = "video";
    const needsPrompt = !!(draft && draft.needsPrompt) || !!b.prompt;
    const needsAudio = !!(draft && draft.needsAudio) || !!b.inputAudio;
    const accepts =
      draft && Array.isArray(draft.accepts) && draft.accepts.length
        ? draft.accepts
        : input === "video"
          ? ["range", "clip"]
          : ["frame", "range", "clip"];
    return { input, output, accepts, needsPrompt, needsAudio };
  }

  function validateModeBindings(mode, bindings) {
    const b = bindings || {};
    if (mode === "i2v") {
      if (!b.prompt || (!b.startImage && !b.refImage0)) {
        return { ok: false, error: t("adapter.needStartPrompt", { mode }) };
      }
    } else if (mode === "flf") {
      if (!b.startImage || !b.endImage || !b.prompt) {
        return { ok: false, error: t("adapter.needEndImage") };
      }
    } else if (mode === "editor") {
      const meta = deriveEditorMetaFromBindings(b, {});
      if (meta.input === "image" && !b.startImage) {
        return { ok: false, error: t("editor.needStartImageBinding") };
      }
      if (meta.input === "video" && !b.inputVideo && !b.startImage) {
        return { ok: false, error: t("editor.needInputVideoBinding") };
      }
      if (meta.needsAudio && !b.inputAudio) {
        return { ok: false, error: t("editor.needInputAudioBinding") };
      }
    }
    return { ok: true };
  }

  const EDITABLE_INPUT_KINDS = [
    "image",
    "video",
    "audio",
    "prompt",
    "text",
    "textarea",
    "number",
    "select",
  ];

  const MEDIA_BIND_KEYS = [
    "startImage",
    "endImage",
    "inputVideo",
    "inputAudio",
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
  ];

  const TIMING_BIND_KEYS = ["width", "height", "length", "fps", "duration"];

  const MEDIA_CLASS_RE =
    /LoadImage|LoadVideo|LoadAudio|VHS_Load|ImageLoader|VideoLoader|AudioLoader|LoadImageFrom/i;
  const IMAGE_CLASS_RE = /LoadImage|ImageLoader|Load Image/i;
  const VIDEO_CLASS_RE = /LoadVideo|VHS_LoadVideo|VideoLoader|Load Video/i;
  const AUDIO_CLASS_RE = /LoadAudio|AudioLoader|Load Audio/i;
  const PRIMITIVE_CLASS_RE = /^Primitive/i;
  const PROMPT_TITLE_RE = /提示词|prompt|negative|负向/i;
  const DURATION_TITLE_RE = /秒|duration|时长/i;
  const USER_TITLE_RE = /[?？]|例[:：]|请|秒|对口型|strength|start|lip/i;
  const SKIP_FIELD_RE =
    /^(unique_id|extra_pnginfo|dynprompt|control_after_generate)$/i;
  /** UI-only widgets (not present in API / RunningHub nodeInfo inputs). */
  const UI_ONLY_FIELD_RE = /^(upload|choose file|choose_file|open)$/i;
  const UI_ONLY_INPUT_TYPE_RE = /IMAGEUPLOAD|VIDEOUPLOAD|AUDIOUPLOAD|BUTTON/i;
  const CONTROL_FIELD_RE =
    /^(text|value|width|height|length|fps|frame_rate|duration|seed|noise_seed|image|video|audio|filename)$/i;

  function isMediaKind(kind) {
    return kind === "image" || kind === "video" || kind === "audio";
  }

  function isUiOnlyInput(inp, fieldName) {
    const name = String(fieldName || (inp && (inp.name || (inp.widget && inp.widget.name))) || "");
    if (UI_ONLY_FIELD_RE.test(name)) return true;
    const itype = String((inp && inp.type) || "");
    if (UI_ONLY_INPUT_TYPE_RE.test(itype)) return true;
    return false;
  }

  /** Map UI-only field names to the API input RunningHub accepts. */
  function sanitizeApiFieldName(fieldName) {
    const fn = String(fieldName || "").trim();
    if (UI_ONLY_FIELD_RE.test(fn)) return "image";
    return fn;
  }

  function kindFromBind(bind) {
    const key = String(bind || "");
    if (key === "prompt") return "prompt";
    if (key === "negative") return "text";
    if (key === "inputAudio" || key === "refAudio0") return "audio";
    if (key === "inputVideo" || /^refVideo\d+$/.test(key)) return "video";
    if (key === "startImage" || key === "endImage" || /^refImage\d+$/.test(key)) {
      return "image";
    }
    if (TIMING_BIND_KEYS.includes(key) || /^seed/i.test(key) || /Enable$/.test(key)) {
      return "number";
    }
    return "";
  }

  function inferKindFromNodeField(classType, fieldName, title, value) {
    const ct = String(classType || "");
    const fn = String(fieldName || "").toLowerCase();
    const ti = String(title || "");
    if (AUDIO_CLASS_RE.test(ct) || fn === "audio") return "audio";
    if (VIDEO_CLASS_RE.test(ct) || fn === "video") return "video";
    if (IMAGE_CLASS_RE.test(ct) || fn === "image") return "image";
    if (PROMPT_TITLE_RE.test(ti) || (fn === "text" && /CLIPTextEncode|PrimitiveString/i.test(ct))) {
      return /负|negative/i.test(ti) ? "text" : "prompt";
    }
    if (fn === "text" || fn === "value") {
      if (typeof value === "number" || /Primitive(Int|Float)/i.test(ct)) return "number";
      if (typeof value === "boolean" || /PrimitiveBoolean/i.test(ct)) return "select";
      if (typeof value === "string" && value.length > 40) return "textarea";
      if (/PrimitiveString/i.test(ct)) {
        return PROMPT_TITLE_RE.test(ti) ? "prompt" : "text";
      }
    }
    if (/width|height|length|fps|frame_rate|duration|seed|noise_seed/.test(fn)) {
      return "number";
    }
    return "text";
  }

  function defaultVisibilityFor(kind, bind, title, classType) {
    if (bind && /^seed/i.test(bind)) return "hidden";
    if (TIMING_BIND_KEYS.includes(bind)) return "collapsed";
    if (isMediaKind(kind) || kind === "prompt") return "shown";
    if (PRIMITIVE_CLASS_RE.test(classType || "") && USER_TITLE_RE.test(title || "")) {
      return "shown";
    }
    return "shown";
  }

  function isLikelyDimValue(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 64 && n <= 4096;
  }

  function isLikelyLengthValue(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 4000 && Number.isInteger(n);
  }

  /**
   * FLF / I2V nodes (MiniMaxH3ImageToVideo) often keep width/height/length only
   * in widgets_values after prompt is converted to a linked input. Name those
   * leftover slots instead of widget_0/widget_1.
   */
  function inferLeftoverWidgetNames(node, leftover, usedNames) {
    const used = usedNames instanceof Set ? usedNames : new Set(usedNames || []);
    const vals = Array.isArray(leftover) ? leftover : [];
    if (!vals.length) return [];
    const props = (node && node.properties) || {};
    const ue =
      (props.widget_ue_connectable && typeof props.widget_ue_connectable === "object"
        ? props.widget_ue_connectable
        : null) ||
      (props.ue_properties &&
      props.ue_properties.widget_ue_connectable &&
      typeof props.ue_properties.widget_ue_connectable === "object"
        ? props.ue_properties.widget_ue_connectable
        : null);
    if (ue) {
      const fromUe = Object.keys(ue).filter((k) => ue[k] && !used.has(k));
      if (fromUe.length >= vals.length) return fromUe.slice(0, vals.length);
    }
    let start = 0;
    if (typeof vals[0] === "string" && String(vals[0]).length > 24) start = 1;
    const slice = vals.slice(start);
    const names = [];
    if (
      slice.length >= 2 &&
      isLikelyDimValue(slice[0]) &&
      isLikelyDimValue(slice[1])
    ) {
      ["width", "height", "length"].forEach((key) => {
        if (used.has(key) || names.length >= slice.length) return;
        if (key === "length" && (slice.length < 3 || !isLikelyLengthValue(slice[2]))) {
          return;
        }
        names.push(key);
      });
    }
    const out = [];
    for (let i = 0; i < vals.length; i++) {
      if (i < start) {
        out.push(`widget_${i}`);
        continue;
      }
      const inferred = names[i - start];
      out.push(inferred || `widget_${i}`);
    }
    return out;
  }

  function hasWidgetSlot(inp) {
    return !!(inp && inp.widget);
  }

  function shouldKeepCandidateField(classType, title, fieldName, kind) {
    if (SKIP_FIELD_RE.test(fieldName) || UI_ONLY_FIELD_RE.test(fieldName)) {
      return false;
    }
    // LoadImage/Video/Audio: only the real media input is bindable (not upload buttons).
    if (MEDIA_CLASS_RE.test(classType)) {
      const fn = String(fieldName || "").toLowerCase();
      if (IMAGE_CLASS_RE.test(classType)) return fn === "image" || fn === "filename";
      if (VIDEO_CLASS_RE.test(classType)) return fn === "video" || fn === "filename";
      if (AUDIO_CLASS_RE.test(classType)) return fn === "audio" || fn === "filename";
      return fn === "image" || fn === "video" || fn === "audio" || fn === "filename";
    }
    if (isMediaKind(kind)) return true;
    if (PRIMITIVE_CLASS_RE.test(classType)) return true;
    if (CONTROL_FIELD_RE.test(fieldName)) return true;
    if (title && USER_TITLE_RE.test(title)) return true;
    if (/CLIPTextEncode/i.test(classType) && fieldName === "text") return true;
    return false;
  }

  function collectUiWidgetFields(node) {
    const fields = [];
    const wvals = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    let wIdx = 0;
    const used = new Set();
    (node.inputs || []).forEach((inp) => {
      if (!inp || typeof inp !== "object") return;
      const name = inp.name || (inp.widget && inp.widget.name) || "";
      const linked = inp.link != null;
      if (linked) {
        // Converted widgets still occupy a widgets_values slot.
        if (hasWidgetSlot(inp) && wIdx < wvals.length) wIdx += 1;
        if (name) used.add(name);
        return;
      }
      if (!name || !hasWidgetSlot(inp)) return;
      used.add(name);
      if (SKIP_FIELD_RE.test(name) || isUiOnlyInput(inp, name)) {
        if (wIdx < wvals.length) wIdx += 1;
        return;
      }
      const value = wIdx < wvals.length ? wvals[wIdx] : undefined;
      if (wIdx < wvals.length) wIdx += 1;
      fields.push({ name, value });
    });
    const leftover = wvals.slice(wIdx);
    const leftoverNames = inferLeftoverWidgetNames(node, leftover, used);
    leftover.forEach((value, i) => {
      const name = leftoverNames[i];
      if (!name || SKIP_FIELD_RE.test(name) || isUiOnlyInput({ name }, name)) return;
      used.add(name);
      fields.push({ name, value });
    });
    if (!fields.length && wvals.length && PRIMITIVE_CLASS_RE.test(node.type || "")) {
      wvals.forEach((value, i) => {
        fields.push({ name: i === 0 ? "value" : `widget_${i}`, value });
      });
    }
    return fields;
  }

  function assignHeuristicBinds(cands) {
    const used = new Set();
    (cands || []).forEach((c) => {
      const fn = String((c && c.fieldName) || "").toLowerCase();
      const ti = String((c && c.title) || "");
      const kind = (c && c.kind) || "";
      let bind = "";
      if (fn === "width" || /^(宽|width)$/i.test(ti) || (fn === "value" && /(?:^|[\s_])宽|width/i.test(ti) && !/高|height/i.test(ti))) {
        bind = "width";
      } else if (fn === "height" || /^(高|height)$/i.test(ti) || (fn === "value" && /(?:^|[\s_])高|height/i.test(ti))) {
        bind = "height";
      }
      else if (fn === "fps" || fn === "frame_rate") bind = "fps";
      else if (fn === "duration" || (fn === "length" && DURATION_TITLE_RE.test(ti))) {
        bind = "duration";
      } else if (fn === "length") bind = "length";
      else if (fn === "noise_seed" || fn === "seed") {
        bind = used.has("seedHigh") ? "seedLow" : "seedHigh";
      } else if (kind === "prompt") {
        bind = /负|negative/i.test(ti) ? "negative" : "prompt";
      } else if (kind === "audio") {
        bind = used.has("inputAudio") ? "refAudio0" : "inputAudio";
      } else if (kind === "video") {
        bind = used.has("inputVideo") ? "refVideo0" : "inputVideo";
      }
      if (bind && SEMANTIC_FIELDS.includes(bind) && !used.has(bind)) {
        c.suggestedBind = bind;
        used.add(bind);
      } else {
        c.suggestedBind = c.suggestedBind || "";
      }
    });
    const images = (cands || []).filter((c) => c && c.kind === "image");
    // One LoadImage node → one bind (ignore duplicate UI fields if any slipped through).
    const imageByNode = [];
    const seenImageNode = new Set();
    images.forEach((c) => {
      const nid = String(c.nodeId || "");
      if (!nid || seenImageNode.has(nid)) return;
      seenImageNode.add(nid);
      imageByNode.push(c);
    });
    imageByNode.forEach((c) => {
      const ti = c.title || "";
      if (/尾|end|last/i.test(ti) && !used.has("endImage")) {
        c.suggestedBind = "endImage";
        used.add("endImage");
      } else if (/首|start|first/i.test(ti) && !used.has("startImage")) {
        c.suggestedBind = "startImage";
        used.add("startImage");
      }
    });
    let refIdx = 0;
    imageByNode.forEach((c) => {
      if (c.suggestedBind) return;
      if (!used.has("startImage")) {
        c.suggestedBind = "startImage";
        used.add("startImage");
        return;
      }
      while (refIdx <= 8 && used.has("refImage" + refIdx)) refIdx += 1;
      if (refIdx <= 8) {
        c.suggestedBind = "refImage" + refIdx;
        used.add(c.suggestedBind);
        refIdx += 1;
      }
    });
    return cands;
  }

  function extractLocalCandidates(workflow) {
    if (!workflow) return [];
    const rows = [];
    if (isComfyUiWorkflow(workflow)) {
      (workflow.nodes || []).forEach((node) => {
        if (!isUiNodeInApiPrompt(node)) return;
        const classType = node.type || "";
        const title = node.title || "";
        collectUiWidgetFields(node).forEach((field) => {
          const kind = inferKindFromNodeField(
            classType,
            field.name,
            title,
            field.value
          );
          if (!shouldKeepCandidateField(classType, title, field.name, kind)) {
            return;
          }
          rows.push({
            id: `${node.id}:${field.name}`,
            nodeId: String(node.id),
            fieldName: field.name,
            classType,
            title,
            kind,
            default:
              field.value != null && !Array.isArray(field.value) ? field.value : "",
            label: title || field.name,
            labelEn: title || field.name,
          });
        });
      });
    } else {
      listNodes(workflow).forEach((n) => {
        const inputs = n.inputs || {};
        Object.keys(inputs).forEach((name) => {
          const value = inputs[name];
          if (Array.isArray(value)) return;
          const kind = inferKindFromNodeField(n.classType, name, n.title, value);
          if (!shouldKeepCandidateField(n.classType, n.title, name, kind)) return;
          rows.push({
            id: `${n.nodeId}:${name}`,
            nodeId: String(n.nodeId),
            fieldName: name,
            classType: n.classType || "",
            title: n.title || "",
            kind,
            default: value != null ? value : "",
            label: n.title || name,
            labelEn: n.title || name,
          });
        });
      });
    }
    assignHeuristicBinds(rows);
    rows.forEach((c) => {
      c.suggestedVisibility = defaultVisibilityFor(
        c.kind,
        c.suggestedBind,
        c.title,
        c.classType
      );
      c.visibility = c.suggestedVisibility;
      c.bind = c.suggestedBind || "";
      c.included = true;
    });
    return rows;
  }

  function slimSummaryForLlm(candidates) {
    const byNode = new Map();
    (candidates || []).forEach((c) => {
      if (!c || !c.nodeId) return;
      if (!byNode.has(c.nodeId)) {
        byNode.set(c.nodeId, {
          id: c.nodeId,
          t: c.classType || "",
          f: [],
        });
      }
      const row = byNode.get(c.nodeId);
      if (c.title && !row.title) row.title = c.title;
      if (c.fieldName && row.f.indexOf(c.fieldName) < 0) row.f.push(c.fieldName);
    });
    return Array.from(byNode.values());
  }

  function parseExtractItems(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== "object") return [];
    if (Array.isArray(raw.i)) return raw.i;
    if (Array.isArray(raw.inputs)) return raw.inputs;
    return [];
  }

  function expandExtractItem(item) {
    if (!item || typeof item !== "object") return null;
    const nodeId = String(item.n || item.nodeId || "").trim();
    if (!nodeId) return null;
    let fieldName = String(item.f || item.fieldName || item.field || "").trim();
    // LoadImage UI export exposes upload button; RH/API only has image.
    if (UI_ONLY_FIELD_RE.test(fieldName)) {
      fieldName = "image";
    }
    return {
      nodeId,
      fieldName,
      suggestedBind: String(
        item.b != null ? item.b : item.suggestedBind || item.bind || ""
      ).trim(),
      kind: String(item.k || item.kind || item.type || "").trim().toLowerCase(),
      label: String(item.l || item.label || item.title || "").trim(),
    };
  }

  function isHighValueCandidate(c) {
    if (!c) return false;
    if (isMediaKind(c.kind) || c.kind === "prompt") return true;
    if (c.suggestedBind) return true;
    if (PRIMITIVE_CLASS_RE.test(c.classType || "") && USER_TITLE_RE.test(c.title || "")) {
      return true;
    }
    return false;
  }

  function mergeLlmExtractWithCandidates(raw, candidates) {
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    const llmItems = parseExtractItems(raw).map(expandExtractItem).filter(Boolean);
    const bySig = new Map();
    const byNode = new Map();
    llmItems.forEach((item) => {
      if (item.fieldName) bySig.set(`${item.nodeId}:${item.fieldName}`, item);
      if (!byNode.has(item.nodeId)) byNode.set(item.nodeId, item);
    });
    const out = list.map((c) => {
      const hit =
        bySig.get(`${c.nodeId}:${c.fieldName}`) || byNode.get(c.nodeId) || null;
      let bind = c.suggestedBind || "";
      let kind = c.kind;
      let label = c.label || c.fieldName;
      let mentioned = false;
      if (hit) {
        mentioned = true;
        if (hit.suggestedBind != null) bind = hit.suggestedBind;
        if (hit.kind && EDITABLE_INPUT_KINDS.includes(hit.kind)) kind = hit.kind;
        if (hit.label) label = hit.label;
        if (
          hit.fieldName &&
          hit.fieldName !== c.fieldName &&
          bySig.get(`${c.nodeId}:${c.fieldName}`) !== hit
        ) {
          mentioned = hit.fieldName === c.fieldName;
        }
      }
      if (bind && !SEMANTIC_FIELDS.includes(bind)) bind = "";
      const visibility = defaultVisibilityFor(kind, bind, c.title, c.classType);
      return {
        ...c,
        kind,
        label,
        labelEn: label,
        bind,
        suggestedBind: bind,
        visibility,
        suggestedVisibility: visibility,
        included: mentioned || isHighValueCandidate({ ...c, kind, suggestedBind: bind }),
      };
    });
    const knownNodeIds = new Set(list.map((c) => String(c.nodeId)));
    llmItems.forEach((item) => {
      // Ignore LLM invents for nodes not in local candidates (muted/bypass UI-only).
      if (!knownNodeIds.has(String(item.nodeId))) return;
      if (!item.fieldName) {
        const matches = out.filter((c) => c.nodeId === item.nodeId);
        if (matches.length === 1) {
          matches[0].included = true;
          if (item.suggestedBind && SEMANTIC_FIELDS.includes(item.suggestedBind)) {
            matches[0].bind = item.suggestedBind;
            matches[0].suggestedBind = item.suggestedBind;
          }
        }
        return;
      }
      const sig = `${item.nodeId}:${item.fieldName}`;
      if (out.some((c) => `${c.nodeId}:${c.fieldName}` === sig)) return;
      const bind =
        item.suggestedBind && SEMANTIC_FIELDS.includes(item.suggestedBind)
          ? item.suggestedBind
          : "";
      const kind =
        item.kind && EDITABLE_INPUT_KINDS.includes(item.kind) ? item.kind : "text";
      out.push({
        id: sig,
        nodeId: item.nodeId,
        fieldName: item.fieldName,
        classType: "",
        title: item.label || "",
        kind,
        default: "",
        label: item.label || item.fieldName,
        labelEn: item.label || item.fieldName,
        bind,
        suggestedBind: bind,
        visibility: defaultVisibilityFor(kind, bind, item.label, ""),
        suggestedVisibility: defaultVisibilityFor(kind, bind, item.label, ""),
        included: true,
      });
    });
    return out.filter((c) => c.included !== false);
  }

  function splitUiSlots(config) {
    const bindings = (config && config.bindings) || {};
    const params = Array.isArray(config && config.params) ? config.params : [];
    const mediaSlots = [];
    const paramSlots = [];
    const seen = new Set();

    function pushSlot(slot) {
      if (!slot) return;
      const sig = `${slot.nodeId || ""}:${slot.fieldName || ""}:${slot.bind || slot.id || ""}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      if (isMediaKind(slot.kind || slot.type)) mediaSlots.push(slot);
      else paramSlots.push(slot);
    }

    params.forEach((p) => {
      if (!p) return;
      const kind = String(p.type || kindFromBind(p.bind) || "text").toLowerCase();
      const id = p.id || (p.nodeId && p.fieldName ? `${p.nodeId}:${p.fieldName}` : "");
      pushSlot({
        id,
        kind,
        type: kind,
        bind: p.bind || "",
        nodeId: p.nodeId ? String(p.nodeId) : "",
        fieldName: p.fieldName ? String(p.fieldName) : "",
        label: p.label || id,
        labelEn: p.labelEn || p.label || id,
        required: !!p.required,
        visibility: p.visibility || "shown",
        default: p.default,
        min: p.min,
        max: p.max,
        options: Array.isArray(p.options) ? p.options : [],
      });
    });

    Object.keys(bindings).forEach((bindKey) => {
      const b = bindings[bindKey];
      if (!b || b.nodeId == null) return;
      const nodeId = String(b.nodeId);
      const fieldName = String(b.fieldName || "");
      const dup = mediaSlots.concat(paramSlots).some(
        (s) =>
          String(s.nodeId) === nodeId &&
          String(s.fieldName || "") === fieldName
      );
      if (dup) return;
      const kind = kindFromBind(bindKey) || "text";
      pushSlot({
        id: bindKey,
        kind,
        type: kind,
        bind: bindKey,
        nodeId,
        fieldName,
        label: bindKey,
        labelEn: bindKey,
        required:
          bindKey === "startImage" ||
          bindKey === "prompt" ||
          bindKey === "inputVideo" ||
          bindKey === "endImage",
        visibility: defaultVisibilityFor(kind, bindKey, "", ""),
        default: "",
        min: null,
        max: null,
        options: [],
      });
    });

    return { mediaSlots, params: paramSlots, bindings };
  }

  function workflowExtractSystemPrompt(locale) {
    const loc =
      locale ||
      (window.VflowI18n && typeof window.VflowI18n.getLocale === "function"
        ? window.VflowI18n.getLocale()
        : "zh");
    if (loc === "en") {
      return (
        "Label Comfy candidate inputs. JSON only, no markdown.\n" +
        '{"v":1,"i":[{"n":"62","f":"image","b":"startImage"},{"n":"6","f":"text","b":"prompt"}]}\n' +
        "n=nodeId f=field b=bind or \"\". binds: startImage,endImage,inputVideo,inputAudio,prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0-8,refVideo0-2,refAudio0.\n" +
        "Seconds→duration. Multi-ref images→refImage0.. in order. Prompt: PrimitiveString titled 提示词. Only bind nodes in the list. Omit k/l."
      );
    }
    return (
      "标注候选 Comfy 输入。只输出 JSON，不要 markdown。\n" +
      '{"v":1,"i":[{"n":"62","f":"image","b":"startImage"},{"n":"6","f":"text","b":"prompt"}]}\n' +
      "n=nodeId f=字段 b=语义槽或\"\"。槽: startImage,endImage,inputVideo,inputAudio,prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0-8,refVideo0-2,refAudio0。\n" +
      "秒→duration。多参考图按序 refImage0..。提示词优先标题含「提示词」的 PrimitiveString。只绑定列表中的节点。不要输出 k/l。"
    );
  }

  function normalizeEditableInputs(raw, opts) {
    const list = Array.isArray(raw)
      ? raw
      : raw && Array.isArray(raw.inputs)
        ? raw.inputs
        : [];
    const out = [];
    const seen = new Set();
    list.forEach((item, idx) => {
      if (!item || typeof item !== "object") return;
      const nodeId = String(item.nodeId || "").trim();
      const fieldName = String(item.fieldName || item.field || "").trim();
      if (!nodeId || !fieldName) return;
      const id =
        String(item.id || "").trim() || `${nodeId}:${fieldName}`;
      if (seen.has(id)) return;
      seen.add(id);
      let kind = String(item.kind || item.type || "text").trim().toLowerCase();
      if (kind === "string") kind = "text";
      if (!EDITABLE_INPUT_KINDS.includes(kind)) kind = "text";
      let suggestedBind = String(
        item.suggestedBind || item.bind || ""
      ).trim();
      if (suggestedBind && !SEMANTIC_FIELDS.includes(suggestedBind)) {
        suggestedBind = "";
      }
      let suggestedVisibility = String(
        item.suggestedVisibility || item.visibility || "shown"
      ).trim();
      if (!PARAM_VISIBILITIES.includes(suggestedVisibility)) {
        suggestedVisibility = "shown";
      }
      const previewRaw = item.preview != null ? item.preview : item.value;
      let preview = "";
      if (previewRaw != null && previewRaw !== "") {
        preview = String(previewRaw);
        if (preview.length > 120) preview = `${preview.slice(0, 117)}…`;
      }
      out.push({
        id,
        kind,
        nodeId,
        fieldName,
        label: String(item.label || item.title || fieldName).trim() || fieldName,
        labelEn: String(
          item.labelEn || item.label || item.title || fieldName
        ).trim(),
        preview,
        suggestedBind,
        suggestedVisibility,
        included: item.included !== false,
        bind: suggestedBind,
        visibility: suggestedVisibility,
        default:
          item.default != null
            ? item.default
            : previewRaw != null && !Array.isArray(previewRaw)
              ? previewRaw
              : "",
        min: item.min != null ? Number(item.min) : null,
        max: item.max != null ? Number(item.max) : null,
        options: Array.isArray(item.options) ? item.options : [],
      });
    });
    return out;
  }

  function editableInputsFromSavedMode(modeCfg) {
    if (!modeCfg || typeof modeCfg !== "object") return [];
    const bindings = modeCfg.bindings || {};
    const params = Array.isArray(modeCfg.params) ? modeCfg.params : [];
    const bindToParam = {};
    params.forEach((p) => {
      if (p && p.bind) bindToParam[p.bind] = p;
    });
    const items = [];
    const seen = new Set();
    Object.keys(bindings).forEach((bindKey) => {
      const b = bindings[bindKey];
      if (!b || b.nodeId == null) return;
      const nodeId = String(b.nodeId);
      const fieldName = String(b.fieldName || "");
      const id = `${nodeId}:${fieldName}`;
      if (seen.has(id)) return;
      seen.add(id);
      const p = bindToParam[bindKey] || {};
      let kind = "text";
      if (bindKey === "prompt" || bindKey === "negative") kind = "prompt";
      else if (bindKey === "inputAudio") kind = "audio";
      else if (bindKey === "inputVideo") kind = "video";
      else if (
        bindKey === "startImage" ||
        bindKey === "endImage"
      ) {
        kind = "image";
      } else if (
        ["width", "height", "length", "fps", "seedHigh", "seedLow"].includes(
          bindKey
        )
      ) {
        kind = "number";
      } else if (p.type) {
        kind = p.type;
      }
      items.push({
        id,
        kind,
        nodeId,
        fieldName,
        label: p.label || bindKey,
        labelEn: p.labelEn || p.label || bindKey,
        preview: p.default != null ? String(p.default) : "",
        suggestedBind: bindKey,
        suggestedVisibility: p.visibility || "shown",
        included: true,
        bind: bindKey,
        visibility: p.visibility || "shown",
        default: p.default != null ? p.default : "",
        min: p.min != null ? p.min : null,
        max: p.max != null ? p.max : null,
        options: Array.isArray(p.options) ? p.options : [],
      });
    });
    params.forEach((p) => {
      if (!p) return;
      const bind = String(p.bind || "").trim();
      const nodeId = String(p.nodeId || "").trim();
      const fieldName = String(p.fieldName || "").trim();
      if (bind) {
        const b = bindings[bind];
        if (b) return; // already covered via bindings loop
      }
      const id =
        String(p.id || "").trim() ||
        (nodeId && fieldName
          ? `${nodeId}:${fieldName}`
          : bind
            ? `param:${bind}`
            : "");
      if (!id || seen.has(id)) return;
      if (nodeId && fieldName) {
        const sig = `${nodeId}:${fieldName}`;
        if (seen.has(sig)) return;
        seen.add(sig);
      }
      seen.add(id);
      items.push({
        id,
        kind: p.type || "text",
        nodeId,
        fieldName,
        label: p.label || p.id || fieldName || id,
        labelEn: p.labelEn || p.label || p.id || fieldName || id,
        preview: p.default != null ? String(p.default) : "",
        suggestedBind: bind,
        suggestedVisibility: p.visibility || "shown",
        included: true,
        bind,
        visibility: p.visibility || "shown",
        default: p.default != null ? p.default : "",
        min: p.min != null ? p.min : null,
        max: p.max != null ? p.max : null,
        options: Array.isArray(p.options) ? p.options : [],
      });
    });
    return items;
  }

  function editableInputsFromEditorManifest(manifest) {
    const adapter = (manifest && manifest.adapter) || {};
    return editableInputsFromSavedMode({
      bindings: adapter.bindings || {},
      params: manifest.params || [],
    });
  }

  function paramTypeFromKind(kind) {
    if (kind === "prompt") return "prompt";
    if (kind === "audio") return "audio";
    if (kind === "image") return "image";
    if (kind === "video") return "video";
    if (kind === "number") return "number";
    if (kind === "select") return "select";
    if (kind === "textarea") return "textarea";
    return "text";
  }

  function buildAdapterFromSelection(selection, opts) {
    const target = (opts && (opts.target || opts.mode)) || "i2v";
    const provider = (opts && opts.provider) || "comfyui";
    const workflowId = String((opts && opts.workflowId) || "").trim();
    const workflow = opts && opts.workflow;
    const name = String((opts && opts.name) || "").trim();
    const selected = (selection || []).filter((item) => item && item.included !== false);

    const bindings = {};
    const rawParams = [];
    const bindUsed = new Set();

    selected.forEach((item) => {
      const bind = String(item.bind || item.suggestedBind || "").trim();
      const fieldName = sanitizeApiFieldName(item.fieldName);
      if (
        bind &&
        SEMANTIC_FIELDS.includes(bind) &&
        item.nodeId &&
        fieldName
      ) {
        if (!bindUsed.has(bind)) {
          bindings[bind] = {
            nodeId: String(item.nodeId),
            fieldName,
          };
          bindUsed.add(bind);
        }
      }
      const paramId =
        String(item.id || "").trim() ||
        (bind ? bind : `${item.nodeId}_${fieldName}`.replace(/\W+/g, "_"));
      rawParams.push({
        id: paramId,
        type: paramTypeFromKind(item.kind),
        label: item.label || paramId,
        labelEn: item.labelEn || item.label || paramId,
        bind,
        nodeId: item.nodeId ? String(item.nodeId) : "",
        fieldName: fieldName || "",
        visibility: item.visibility || item.suggestedVisibility || "shown",
        default: item.default != null ? item.default : item.preview || "",
        required:
          item.required === true ||
          (bind === "prompt" && item.kind === "prompt"),
        min: item.min != null ? item.min : null,
        max: item.max != null ? item.max : null,
        options: Array.isArray(item.options) ? item.options : [],
      });
    });

    if (!bindings.startImage && bindings.refImage0) {
      bindings.startImage = { ...bindings.refImage0 };
    }

    const params = fillParamDefaultsFromWorkflow(
      normalizeDraftParams(rawParams, bindings),
      bindings,
      workflow
    );
    const stored = workflow
      ? prepareWorkflowStorage(workflow)
      : { workflowUi: null, workflow: null };
    const modeOut = {
      workflowId,
      bindings,
      params,
      workflowUi: stored.workflowUi,
      workflow: stored.workflow,
    };

    if (target === "editor") {
      const meta = deriveEditorMetaFromBindings(bindings, {
        input: opts && opts.input,
        output: opts && opts.output,
        accepts: opts && opts.accepts,
        needsPrompt: opts && opts.needsPrompt,
        needsAudio: opts && opts.needsAudio,
      });
      const check = validateModeBindings("editor", bindings);
      if (!check.ok) throw new Error(check.error);
      return {
        id: (opts && opts.editorId) || undefined,
        name: name || t("editor.customDefaultName"),
        provider,
        ...meta,
        params,
        enabled: opts && opts.enabled === false ? false : true,
        category: "custom",
        adapter: {
          workflowId: modeOut.workflowId,
          workflowUi: modeOut.workflowUi,
          workflow: modeOut.workflow,
          bindings,
        },
      };
    }

    const check = validateModeBindings(target, bindings);
    if (!check.ok) throw new Error(check.error);

    return {
      version: 1,
      provider,
      name: name || t("adapter.merged"),
      modes: {
        [target]: modeOut,
      },
    };
  }

  function workflowDraftSystemPrompt(mode, locale) {
    const loc =
      locale ||
      (window.VflowI18n && typeof window.VflowI18n.getLocale === "function"
        ? window.VflowI18n.getLocale()
        : "zh");
    if (loc === "en") {
      return (
        "You are a ComfyUI / RunningHub workflow adapter assistant.\n" +
        "The user provides a compact node list from a full canvas (UI) or API workflow.\n" +
        "Output ONLY one valid JSON object. No Markdown, no comments, no trailing commas.\n" +
        'Example:\n{"version":1,"name":"My I2V","provider":"comfyui","mode":"i2v","bindings":{"startImage":{"nodeId":"62","fieldName":"image"},"prompt":{"nodeId":"6","fieldName":"text"}},"params":[{"id":"prompt","type":"prompt","label":"Prompt","bind":"prompt","nodeId":"6","fieldName":"text","visibility":"shown"},{"id":"width","type":"number","label":"Width","bind":"width","nodeId":"63","fieldName":"width","default":720,"visibility":"collapsed"},{"id":"1776:value","type":"number","label":"Audio lip-sync start (sec)","bind":"","nodeId":"1776","fieldName":"value","default":0,"visibility":"shown"}]}\n' +
        "Rules:\n" +
        "- provider must match the user message exactly (runninghub or comfyui).\n" +
        "- mode must match the user message (i2v, flf, or editor).\n" +
        "- bindings keys only: startImage,endImage,inputVideo,inputAudio,prompt,negative,width,height,length,fps,seedHigh,seedLow,duration,refImage0..refImage8,refVideo0..refVideo2.\n" +
        '- Each binding: {"nodeId":"...","fieldName":"..."}.\n' +
        "- Prefer duration (seconds) for Duration/PrimitiveFloat second controls (MiniMax); do not bind those as length (frames).\n" +
        "- Multiple LoadImage into ReferenceToVideo: bind refImage0,refImage1,... in connection order; type image; visibility shown/collapsed.\n" +
        "- params: user-tunable fields; each needs id,type,label,bind,visibility (shown|collapsed|hidden), and MUST include nodeId+fieldName for canvas verification.\n" +
        "- Param type may be prompt,number,text,textarea,select,image,audio.\n" +
        "- MUST also list custom PrimitiveFloat/PrimitiveInt/PrimitiveBoolean/PrimitiveString* controls with user-facing titles (questions, 例:, seconds, lip-sync, strength…). Use bind \"\" and id \"nodeId:fieldName\" when no semantic key fits. Do NOT skip them.\n" +
        "- Do NOT include workflow or workflowUi in output.\n" +
        "- i2v: require prompt; startImage OR refImage0; video output; no inputAudio unless editor mode.\n" +
        "- flf: require startImage + endImage + prompt.\n" +
        "- editor: set input (image|video), output (image|video|audio), accepts, needsPrompt, needsAudio from bindings.\n" +
        "- Prefer PrimitiveString* titled 提示词 for prompt (field value), not intermediate CLIPTextEncode.\n" +
        "- Media/prompt/audio/custom titled Primitive*: visibility shown; size/fps: collapsed; seeds: hidden.\n" +
        "- Only bind nodes present in the provided list (muted/bypass UI nodes are already omitted)."
      );
    }
    return t("adapter.workflowDraftPrompt");
  }

  function adapterSystemPrompt(locale) {
    return workflowDraftSystemPrompt("i2v", locale);
  }

  function extractFlatDraft(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.bindings && typeof raw.bindings === "object") {
      return raw;
    }
    const mode = raw.mode || "i2v";
    if (raw.modes && raw.modes[mode]) {
      const m = raw.modes[mode];
      return {
        version: raw.version || 1,
        name: raw.name || "",
        provider: raw.provider || "",
        mode,
        workflowId: m.workflowId || "",
        bindings: m.bindings || {},
        params: m.params || raw.params || [],
        input: raw.input,
        output: raw.output,
        accepts: raw.accepts,
        needsPrompt: raw.needsPrompt,
        needsAudio: raw.needsAudio,
      };
    }
    return null;
  }

  function finalizeExtractToAdapter(raw, opts) {
    if (raw && raw.bindings && typeof raw.bindings === "object") {
      return finalizeLlmDraft(raw, opts);
    }
    const workflow = opts && opts.workflow;
    const candidates =
      (opts && Array.isArray(opts.candidates) && opts.candidates.length
        ? opts.candidates
        : workflow
          ? extractLocalCandidates(workflow)
          : []);
    const selection = mergeLlmExtractWithCandidates(raw, candidates);
    return buildAdapterFromSelection(selection, opts);
  }

  function finalizeLlmDraft(raw, opts) {
    const provider = (opts && opts.provider) || "comfyui";
    const mode = (opts && opts.mode) || "i2v";
    const workflow = opts && opts.workflow;
    const workflowId = String((opts && opts.workflowId) || "").trim();
    const flat = extractFlatDraft(raw);
    if (!flat) {
      throw new Error(t("errors.llmNotJson"));
    }
    const bindings =
      flat.bindings && typeof flat.bindings === "object" ? flat.bindings : {};
    const check = validateModeBindings(mode, bindings);
    if (!check.ok) throw new Error(check.error);
    const params = fillParamDefaultsFromWorkflow(
      normalizeDraftParams(flat.params, bindings),
      bindings,
      workflow
    );
    const stored = workflow ? prepareWorkflowStorage(workflow) : { workflowUi: null, workflow: null };
    const modeOut = {
      workflowId: String(flat.workflowId || workflowId || "").trim(),
      bindings,
      params,
      workflowUi: stored.workflowUi,
      workflow: stored.workflow,
    };
    if (mode === "editor") {
      const meta = deriveEditorMetaFromBindings(bindings, flat);
      return {
        version: 1,
        name: String(flat.name || "").trim() || t("editor.customDefaultName"),
        provider,
        mode: "editor",
        ...meta,
        params,
        adapter: {
          workflowId: modeOut.workflowId,
          workflowUi: modeOut.workflowUi,
          workflow: modeOut.workflow,
          bindings,
        },
      };
    }
    return {
      version: 1,
      provider,
      name: String(flat.name || "").trim() || t("adapter.merged"),
      modes: {
        [mode]: modeOut,
      },
    };
  }

  function validateAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") {
      return { ok: false, error: t("adapter.notObject") };
    }
    if (Number(adapter.version) !== 1) {
      return { ok: false, error: t("adapter.versionOnly1") };
    }
    if (!["runninghub", "comfyui"].includes(adapter.provider)) {
      return { ok: false, error: t("adapter.providerInvalid") };
    }
    if (!adapter.modes || typeof adapter.modes !== "object") {
      return { ok: false, error: t("adapter.missingModes") };
    }
    const modeIds = Object.keys(adapter.modes);
    if (!modeIds.length) {
      return { ok: false, error: t("adapter.needI2vOrFlf") };
    }
    for (const mode of modeIds) {
      const m = adapter.modes[mode];
      if (!m) continue;
      if (!m.bindings || typeof m.bindings !== "object") {
        return { ok: false, error: t("adapter.bindingsMissing", { mode }) };
      }
      const check = validateModeBindings(mode, m.bindings);
      if (!check.ok) return check;
      if (adapter.provider === "comfyui" && !m.workflow && !m.workflowUi) {
        return { ok: false, error: t("adapter.comfyNeedWorkflow", { mode }) };
      }
    }
    return { ok: true };
  }

  function mergeModeAdapters(a, b) {
    const out = {
      version: 1,
      provider: (b && b.provider) || (a && a.provider) || "comfyui",
      name: (b && b.name) || (a && a.name) || t("adapter.merged"),
      modes: {},
    };
    if (a && a.modes) Object.assign(out.modes, a.modes);
    if (b && b.modes) Object.assign(out.modes, b.modes);
    return out;
  }

  const SEED_INPUT_NAMES = new Set(["noise_seed", "seed"]);

  function freshNoiseSeeds() {
    const max = BigInt("0x7fffffffffffffff");
    const randOne = () => {
      const buf = new Uint32Array(2);
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(buf);
      } else {
        buf[0] = (Math.random() * 0x100000000) >>> 0;
        buf[1] = (Math.random() * 0x100000000) >>> 0;
      }
      let n = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
      n = (n % max) + 1n;
      return String(n);
    };
    return { seedHigh: randOne(), seedLow: randOne() };
  }

  function ensureSeedValues(values) {
    const vals = { ...(values || {}) };
    const fresh = freshNoiseSeeds();
    if (vals.seedHigh == null || vals.seedHigh === "") vals.seedHigh = fresh.seedHigh;
    if (vals.seedLow == null || vals.seedLow === "") vals.seedLow = fresh.seedLow;
    return vals;
  }

  function isSeedField(name) {
    return SEED_INPUT_NAMES.has(String(name || "").trim());
  }

  function isLinkInput(val) {
    return Array.isArray(val) && val.length >= 2;
  }

  function explicitParamSeedSigs(params, paramValues) {
    const covered = new Set();
    const pv = paramValues && typeof paramValues === "object" ? paramValues : {};
    (params || []).forEach((p) => {
      if (!p || !p.id || !(p.id in pv)) return;
      const raw = pv[p.id];
      if (raw == null || raw === "") return;
      const nodeId = String(p.nodeId || "").trim();
      const fieldName = String(p.fieldName || p.field || "").trim();
      if (nodeId && fieldName && isSeedField(fieldName)) {
        covered.add(`${nodeId}:${fieldName}`);
      }
    });
    return covered;
  }

  function seedBindingSigs(bindings, values) {
    const covered = new Set();
    const vals = values || {};
    ["seedHigh", "seedLow"].forEach((key) => {
      const b = bindings && bindings[key];
      if (!b || vals[key] == null || vals[key] === "") return;
      const nodeId = String(b.nodeId || "").trim();
      const fieldName = String(b.fieldName || "").trim();
      if (nodeId && fieldName) covered.add(`${nodeId}:${fieldName}`);
    });
    return covered;
  }

  function randomizeUnboundSeedsInGraph(
    graph,
    bindings,
    values,
    params,
    paramValues
  ) {
    const covered = new Set([
      ...seedBindingSigs(bindings, values),
      ...explicitParamSeedSigs(params, paramValues),
    ]);
    const fresh = freshNoiseSeeds();
    let flip = false;
    Object.keys(graph || {}).forEach((nodeId) => {
      const node = graph[nodeId];
      if (!node || typeof node !== "object") return;
      if (!node.inputs || typeof node.inputs !== "object") return;
      Object.keys(node.inputs).forEach((fieldName) => {
        if (!isSeedField(fieldName)) return;
        if (isLinkInput(node.inputs[fieldName])) return;
        const sig = `${nodeId}:${fieldName}`;
        if (covered.has(sig)) return;
        flip = !flip;
        node.inputs[fieldName] = flip ? fresh.seedHigh : fresh.seedLow;
      });
    });
    return graph;
  }

  function resolveParamSeedValue(p, values, pv) {
    const fieldName = String((p && (p.fieldName || p.field)) || "").trim();
    let val = p && p.id != null ? pv[p.id] : null;
    if (val != null && val !== "") return val;
    if (p && p.bind && values && values[p.bind] != null && values[p.bind] !== "") {
      return values[p.bind];
    }
    const fn = fieldName.toLowerCase();
    if (
      values &&
      (fn === "width" ||
        fn === "height" ||
        fn === "length" ||
        fn === "fps" ||
        fn === "duration") &&
      values[fn] != null &&
      values[fn] !== ""
    ) {
      return values[fn];
    }
    if (fn === "frame_rate" && values && values.fps != null && values.fps !== "") {
      return values.fps;
    }
    if (isSeedField(fieldName)) {
      return freshNoiseSeeds().seedHigh;
    }
    if (p && p.default != null && p.default !== "") return p.default;
    return null;
  }

  function applyBindingsToNodeInfoList(bindings, values, params, paramValues, workflow) {
    values = ensureSeedValues(values);
    const list = [];
    const seen = new Set();
    for (const key of SEMANTIC_FIELDS) {
      const b = bindings[key];
      if (!b || values[key] == null || values[key] === "") continue;
      const nodeId = String(b.nodeId);
      const fieldName = String(b.fieldName || "");
      const sig = `${nodeId}:${fieldName}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      list.push({
        nodeId,
        fieldName,
        fieldValue: String(values[key]),
      });
    }
    appendCustomParamNodeInfos(list, seen, params, paramValues, values);
    injectMissingSizeNodeInfos(list, seen, bindings, values, params, workflow);
    return list;
  }

  const VIDEO_SIZE_CLASS_RE =
    /MiniMaxH3(Image|Reference)ToVideo|WanImageToVideo|ImageToVideo/i;

  function collectSizeTargetNodeIds(bindings, params, workflow) {
    const ids = [];
    ["width", "height"].forEach((key) => {
      const b = bindings && bindings[key];
      if (b && b.nodeId) ids.push(String(b.nodeId));
    });
    (params || []).forEach((p) => {
      if (!p) return;
      const fn = String(p.fieldName || "").toLowerCase();
      const bind = String(p.bind || "");
      if (
        (fn === "width" ||
          fn === "height" ||
          bind === "width" ||
          bind === "height") &&
        p.nodeId
      ) {
        ids.push(String(p.nodeId));
      }
    });
    let graph = null;
    try {
      graph = workflow ? resolveApiGraph(workflow) : null;
    } catch (_) {
      graph = null;
    }
    if (graph && typeof graph === "object") {
      Object.keys(graph).forEach((nid) => {
        const node = graph[nid];
        if (!node || typeof node !== "object") return;
        const ct = String(node.class_type || "");
        const inputs =
          node.inputs && typeof node.inputs === "object" ? node.inputs : {};
        if (VIDEO_SIZE_CLASS_RE.test(ct)) {
          ids.push(String(nid));
          return;
        }
        const w = inputs.width;
        const h = inputs.height;
        if (
          w != null &&
          h != null &&
          !Array.isArray(w) &&
          !Array.isArray(h)
        ) {
          ids.push(String(nid));
        }
      });
    }
    return ids.filter((id, i, arr) => id && arr.indexOf(id) === i);
  }

  function nodeAcceptsWh(node, field) {
    if (!node || typeof node !== "object") return true;
    const ct = String(node.class_type || "");
    if (VIDEO_SIZE_CLASS_RE.test(ct)) return true;
    const inputs =
      node.inputs && typeof node.inputs === "object" ? node.inputs : {};
    const val = inputs[field];
    return val != null && !Array.isArray(val);
  }

  function injectMissingSizeNodeInfos(list, seen, bindings, values, params, workflow) {
    const width = values && values.width;
    const height = values && values.height;
    if (width == null || width === "" || height == null || height === "") return;
    let graph = null;
    try {
      graph = workflow ? resolveApiGraph(workflow) : null;
    } catch (_) {
      graph = null;
    }
    collectSizeTargetNodeIds(bindings, params, workflow).forEach((nodeId) => {
      const node = graph && graph[nodeId];
      [
        ["width", width],
        ["height", height],
      ].forEach(([fn, val]) => {
        if (node && !nodeAcceptsWh(node, fn)) return;
        const sig = `${nodeId}:${fn}`;
        if (seen.has(sig)) return;
        seen.add(sig);
        list.push({
          nodeId,
          fieldName: fn,
          fieldValue: String(val),
        });
      });
    });
  }

  function appendCustomParamNodeInfos(list, seen, params, paramValues, values) {
    const pv = paramValues && typeof paramValues === "object" ? paramValues : {};
    (params || []).forEach((p) => {
      if (!p) return;
      const nodeId = String(p.nodeId || "").trim();
      const fieldName = String(p.fieldName || "").trim();
      if (!nodeId || !fieldName) return;
      const sig = `${nodeId}:${fieldName}`;
      if (seen.has(sig)) return;
      const val = resolveParamSeedValue(p, values, pv);
      if (val == null || val === "") return;
      seen.add(sig);
      list.push({
        nodeId,
        fieldName,
        fieldValue: String(val),
      });
    });
  }

  function applyBindingsToComfyWorkflow(workflow, bindings, values, params, paramValues) {
    values = ensureSeedValues(values);
    const graph = JSON.parse(JSON.stringify(resolveApiGraph(workflow) || {}));
    for (const key of SEMANTIC_FIELDS) {
      const b = bindings[key];
      if (!b || values[key] == null || values[key] === "") continue;
      const node = graph[b.nodeId];
      if (!node) continue;
      if (!node.inputs) node.inputs = {};
      node.inputs[b.fieldName] = values[key];
    }
    const pv = paramValues && typeof paramValues === "object" ? paramValues : {};
    (params || []).forEach((p) => {
      if (!p) return;
      const nodeId = String(p.nodeId || "").trim();
      const fieldName = String(p.fieldName || "").trim();
      if (!nodeId || !fieldName) return;
      const val = resolveParamSeedValue(p, values, pv);
      if (val == null || val === "") return;
      const node = graph[nodeId];
      if (!node) return;
      if (!node.inputs) node.inputs = {};
      // Avoid overwriting a semantic binding already applied to same target
      if (
        node.inputs[fieldName] != null &&
        Object.keys(bindings || {}).some((k) => {
          const b = bindings[k];
          return (
            b &&
            String(b.nodeId) === nodeId &&
            String(b.fieldName || "") === fieldName &&
            values[k] != null &&
            values[k] !== ""
          );
        })
      ) {
        return;
      }
      node.inputs[fieldName] = val;
    });
    collectSizeTargetNodeIds(bindings, params, graph).forEach((nodeId) => {
      const node = graph[nodeId];
      if (!node) return;
      if (!node.inputs) node.inputs = {};
      if (
        values.width != null &&
        values.width !== "" &&
        nodeAcceptsWh(node, "width")
      ) {
        node.inputs.width = values.width;
      }
      if (
        values.height != null &&
        values.height !== "" &&
        nodeAcceptsWh(node, "height")
      ) {
        node.inputs.height = values.height;
      }
    });
    return randomizeUnboundSeedsInGraph(
      graph,
      bindings,
      values,
      params,
      paramValues
    );
  }

  function previewBindings(adapter) {
    if (!adapter || !adapter.modes) return "";
    const lines = [];
    for (const mode of Object.keys(adapter.modes)) {
      const m = adapter.modes[mode];
      if (!m) continue;
      lines.push(`[${mode}] workflowId=${m.workflowId || "—"}`);
      const b = m.bindings || {};
      Object.keys(b).forEach((k) => {
        lines.push(`  ${k} → node ${b[k].nodeId}.${b[k].fieldName}`);
      });
      if (Array.isArray(m.params) && m.params.length) {
        lines.push(`  params: ${m.params.length}`);
        m.params.forEach((p) => {
          if (!p) return;
          const nid = p.nodeId || (p.bind && b[p.bind] && b[p.bind].nodeId) || "";
          const fn =
            p.fieldName ||
            (p.bind && b[p.bind] && b[p.bind].fieldName) ||
            "";
          if (nid) {
            lines.push(`    ${p.id || p.label} → node ${nid}.${fn || "?"}`);
          }
        });
      }
    }
    return lines.join("\n");
  }

  function paramValuesFromBindings(bindings, params, projectDefaults) {
    const vals = { ...(projectDefaults || {}) };
    (params || []).forEach((p) => {
      if (!p) return;
      if (p.visibility === "hidden" && p.default != null && p.default !== "") {
        if (p.bind) vals[p.bind] = p.default;
      }
    });
    return vals;
  }

  window.VflowAdapter = {
    SEMANTIC_FIELDS,
    EDITABLE_INPUT_KINDS,
    MEDIA_BIND_KEYS,
    TIMING_BIND_KEYS,
    PARAM_VISIBILITIES,
    platformBuiltinAdapter,
    setPlatformBindings,
    isComfyUiWorkflow,
    detectWorkflowFormat,
    assertValidWorkflow,
    normalizeWorkflowGraph,
    uiWorkflowToApiPrompt,
    prepareWorkflowStorage,
    resolveApiGraph,
    listNodes,
    summarizeUiWorkflowForLlm,
    summarizeWorkflowForLlm,
    isUiNodeInApiPrompt,
    normalizeDraftParams,
    readWorkflowFieldValue,
    fillParamDefaultsFromWorkflow,
    deriveEditorMetaFromBindings,
    validateModeBindings,
    workflowDraftSystemPrompt,
    workflowExtractSystemPrompt,
    normalizeEditableInputs,
    editableInputsFromSavedMode,
    editableInputsFromEditorManifest,
    extractLocalCandidates,
    slimSummaryForLlm,
    parseExtractItems,
    mergeLlmExtractWithCandidates,
    splitUiSlots,
    kindFromBind,
    isMediaKind,
    buildAdapterFromSelection,
    finalizeExtractToAdapter,
    finalizeLlmDraft,
    validateAdapter,
    mergeModeAdapters,
    applyBindingsToNodeInfoList,
    applyBindingsToComfyWorkflow,
    ensureSeedValues,
    freshNoiseSeeds,
    randomizeUnboundSeedsInGraph,
    previewBindings,
    adapterSystemPrompt,
    paramValuesFromBindings,
  };
})();
