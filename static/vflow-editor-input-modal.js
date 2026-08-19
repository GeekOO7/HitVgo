/**
 * Generic editor run-input UI: media slots + params[].
 * Modal is the primary editor surface (media upload + parameter form).
 * mount() remains for storyboard inspector param fields.
 * Exposes window.VflowEditorInputModal
 */
(() => {
  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  function locale() {
    if (window.VflowI18n && typeof window.VflowI18n.getLocale === "function") {
      return window.VflowI18n.getLocale();
    }
    return "zh";
  }

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
  const BIND_KEYS = [
    "prompt",
    "negative",
    "width",
    "height",
    "length",
    "fps",
    "duration",
    "seedHigh",
    "seedLow",
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
  const AUDIO_ACCEPT = "audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac";
  const IMAGE_ACCEPT = "image/*,.png,.jpg,.jpeg,.webp,.gif";
  const VIDEO_ACCEPT = "video/*,.mp4,.webm,.mov,.mkv,.m4v";

  function isMediaFieldType(type) {
    return type === "image" || type === "video" || type === "audio";
  }
  const LAST_INPUTS_KEY = "vflow-editor-last-inputs";
  const MODAL_ID_PREFIX = "editorInput_";
  const SLOT_ID_PREFIX = "editorSlot_";

  /**
   * @typedef {{
   *   container: HTMLElement,
   *   idPrefix: string,
   *   audioFiles: Map<string, File>,
   *   fields: object[],
   *   editorId: string,
   *   mountKey?: string,
   *   onChange?: Function|null,
   * }} FieldSession
   */

  /** @type {{ resolve: Function, reject: Function, fields: object[], editorId?: string, session?: FieldSession }|null} */
  let pending = null;
  /** @type {FieldSession|null} */
  let inspectorSession = null;

  function loadLastInputs(editorId) {
    const id = String(editorId || "").trim();
    if (!id) return null;
    try {
      const raw = localStorage.getItem(LAST_INPUTS_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const hit = map && typeof map === "object" ? map[id] : null;
      return hit && typeof hit === "object" ? hit : null;
    } catch (_) {
      return null;
    }
  }

  function saveLastInputs(editorId, values) {
    const id = String(editorId || "").trim();
    if (!id || !values || typeof values !== "object") return;
    try {
      const raw = localStorage.getItem(LAST_INPUTS_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const next = map && typeof map === "object" ? map : {};
      const clean = {};
      Object.keys(values).forEach((k) => {
        const v = values[k];
        if (v == null || v === "") return;
        if (typeof File !== "undefined" && v instanceof File) return;
        clean[k] = v;
      });
      next[id] = clean;
      const keys = Object.keys(next);
      if (keys.length > 40) {
        keys.slice(0, keys.length - 40).forEach((k) => delete next[k]);
      }
      localStorage.setItem(LAST_INPUTS_KEY, JSON.stringify(next));
    } catch (_) {
      /* ignore quota */
    }
  }

  /**
   * Prefer explicit initialValues, then last-used inputs, then field.default.
   * @param {object[]} fields
   * @param {object|null} initialValues
   * @param {object|null} lastValues
   */
  function applyInitialValues(fields, initialValues, lastValues) {
    const init = initialValues && typeof initialValues === "object" ? initialValues : {};
    const last = lastValues && typeof lastValues === "object" ? lastValues : {};
    return (fields || []).map((field) => {
      if (!field || field.type === "audio" || field.type === "image" || field.type === "video") {
        return field;
      }
      const fromInit =
        init[field.id] != null && init[field.id] !== ""
          ? init[field.id]
          : field.bind === "prompt" && init.prompt != null && init.prompt !== ""
            ? init.prompt
            : field.bind && init[field.bind] != null && init[field.bind] !== ""
              ? init[field.bind]
              : undefined;
      const fromLast =
        last[field.id] != null && last[field.id] !== ""
          ? last[field.id]
          : field.bind === "prompt" && last.prompt != null && last.prompt !== ""
            ? last.prompt
            : field.bind && last[field.bind] != null && last[field.bind] !== ""
              ? last[field.bind]
              : undefined;
      const chosen =
        fromInit !== undefined
          ? fromInit
          : fromLast !== undefined
            ? fromLast
            : field.default;
      return { ...field, default: chosen != null ? chosen : field.default };
    });
  }

  function els() {
    return {
      modal: document.getElementById("editorInputModal"),
      title: document.getElementById("editorInputTitle"),
      desc: document.getElementById("editorInputDesc"),
      form: document.getElementById("editorInputForm"),
      fields: document.getElementById("editorInputFields"),
      submit: document.getElementById("editorInputSubmit"),
      cancel: document.getElementById("editorInputCancel"),
    };
  }

  function otherModalsOpen() {
    const ids = ["framePickerModal", "settingsModal", "storyboardModal"];
    return ids.some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains("hidden");
    });
  }

  function fieldDomId(session, fieldId, suffix) {
    const base = (session.idPrefix || MODAL_ID_PREFIX) + fieldId;
    return suffix ? base + suffix : base;
  }

  function normalizeParam(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim();
    const type = String(raw.type || "text").trim();
    if (!id || !PARAM_TYPES.includes(type)) return null;
    const bind = String(raw.bind || "").trim();
    return {
      id,
      type,
      label: String(raw.label || id).trim() || id,
      labelEn: String(raw.labelEn || raw.label || id).trim() || id,
      required: raw.required === true,
      default: raw.default != null ? raw.default : type === "number" ? "" : "",
      placeholder: String(raw.placeholder || "").trim(),
      placeholderEn: String(raw.placeholderEn || raw.placeholder || "").trim(),
      bind: BIND_KEYS.includes(bind) ? bind : "",
      nodeId: String(raw.nodeId || "").trim(),
      fieldName: String(raw.fieldName || raw.field || "").trim(),
      visibility: ["shown", "collapsed", "hidden"].includes(raw.visibility)
        ? raw.visibility
        : "shown",
      min: raw.min != null ? Number(raw.min) : null,
      max: raw.max != null ? Number(raw.max) : null,
      accept:
        String(raw.accept || "").trim() ||
        (type === "audio" ? AUDIO_ACCEPT : ""),
      options: Array.isArray(raw.options)
        ? raw.options
            .map((o) => {
              if (o == null) return null;
              if (typeof o === "string" || typeof o === "number") {
                return { value: String(o), label: String(o) };
              }
              if (typeof o === "object" && o.value != null) {
                return {
                  value: String(o.value),
                  label: String(o.label != null ? o.label : o.value),
                  labelEn: String(
                    o.labelEn != null
                      ? o.labelEn
                      : o.label != null
                        ? o.label
                        : o.value
                  ),
                };
              }
              return null;
            })
            .filter(Boolean)
        : [],
    };
  }

  function validateParams(list) {
    if (list == null) return { ok: true, params: [] };
    if (!Array.isArray(list)) {
      return { ok: false, error: t("editor.paramsInvalid") };
    }
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const p = normalizeParam(item);
      if (!p) {
        return { ok: false, error: t("editor.paramsInvalid") };
      }
      if (seen.has(p.id)) {
        return {
          ok: false,
          error: t("editor.paramsDuplicateId", { id: p.id }),
        };
      }
      seen.add(p.id);
      if (p.type === "select" && !p.options.length) {
        return {
          ok: false,
          error: t("editor.paramsSelectNeedOptions", { id: p.id }),
        };
      }
      out.push(p);
    }
    return { ok: true, params: out };
  }

  function fieldLabel(field) {
    return locale() === "en" ? field.labelEn || field.label : field.label;
  }

  function fieldPlaceholder(field) {
    return locale() === "en"
      ? field.placeholderEn || field.placeholder
      : field.placeholder;
  }

  function formatFileSize(bytes) {
    if (bytes == null || bytes < 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function resolveEditorWorkflow(editor) {
    const adapter = (editor && editor.adapter) || {};
    return adapter.workflowUi || adapter.workflow || null;
  }

  /**
   * Merge needsPrompt / needsAudio flags with explicit params[].
   * Fields from flags are tagged _builtin so we can insert a separator.
   */
  function buildFields(editor) {
    const ed = editor || {};
    const validated = validateParams(ed.params || []);
    let params = validated.ok ? validated.params : [];
    const bindings = (ed.adapter && ed.adapter.bindings) || {};
    const workflow = resolveEditorWorkflow(ed);
    const W = window.VflowAdapter;
    if (
      workflow &&
      W &&
      typeof W.fillParamDefaultsFromWorkflow === "function"
    ) {
      // Prefer defaults cached at recognize-time; only backfill empties from stored workflow
      params = W.fillParamDefaultsFromWorkflow(params, bindings, workflow, {
        onlyEmpty: true,
      });
    }
    // Enrich nodeId/fieldName from bindings when missing
    params = params.map((p) => {
      if (!p) return p;
      const bind = String(p.bind || "").trim();
      const b = bind && bindings[bind] ? bindings[bind] : null;
      if (!b) return p;
      return {
        ...p,
        nodeId: p.nodeId || String(b.nodeId || "").trim(),
        fieldName: p.fieldName || String(b.fieldName || "").trim(),
      };
    });

    const fields = [];
    const hasPromptParam = params.some((p) => p.type === "prompt");
    const hasAudioParam = params.some((p) => p.type === "audio");

    if (ed.needsPrompt && !hasPromptParam) {
      let defaultPrompt = ed.defaultPrompt || "";
      if (
        !defaultPrompt &&
        workflow &&
        bindings.prompt &&
        W &&
        typeof W.readWorkflowFieldValue === "function"
      ) {
        const wv = W.readWorkflowFieldValue(
          workflow,
          bindings.prompt.nodeId,
          bindings.prompt.fieldName
        );
        if (wv != null && wv !== "") defaultPrompt = String(wv);
      }
      fields.push({
        id: "prompt",
        type: "prompt",
        label: t("editor.inputModal.promptLabel"),
        labelEn: t("editor.inputModal.promptLabel"),
        required: true,
        default: defaultPrompt || t("editor.talkingPromptDefault"),
        placeholder: "",
        placeholderEn: "",
        bind: "prompt",
        nodeId: bindings.prompt
          ? String(bindings.prompt.nodeId || "").trim()
          : "",
        fieldName: bindings.prompt
          ? String(bindings.prompt.fieldName || "").trim()
          : "",
        min: null,
        max: null,
        accept: "",
        options: [],
        _builtin: true,
      });
    }
    if (ed.needsAudio && !hasAudioParam) {
      fields.push({
        id: "inputAudio",
        type: "audio",
        label: t("editor.inputModal.audioLabel"),
        labelEn: t("editor.inputModal.audioLabel"),
        required: true,
        default: "",
        placeholder: "",
        placeholderEn: "",
        bind: "",
        nodeId: bindings.inputAudio
          ? String(bindings.inputAudio.nodeId || "").trim()
          : "",
        fieldName: bindings.inputAudio
          ? String(bindings.inputAudio.fieldName || "").trim()
          : "",
        min: null,
        max: null,
        accept: AUDIO_ACCEPT,
        options: [],
        _builtin: true,
      });
    }
    params.forEach((p) => {
      if (p.type === "prompt" && !p.bind) p.bind = "prompt";
      if (p.visibility === "hidden") return;
      if (
        isMediaFieldType(p.type) &&
        (p.bind === "startImage" || p.bind === "inputVideo")
      ) {
        return;
      }
      fields.push(p);
    });

    if (W && typeof W.splitUiSlots === "function") {
      const slots = W.splitUiSlots({
        bindings,
        params: ed.params || [],
      });
      const have = new Set(
        fields.map((f) => `${f.bind || ""}:${f.nodeId}:${f.fieldName}`)
      );
      (slots.mediaSlots || []).forEach((slot) => {
        if (!slot || slot.visibility === "hidden") return;
        if (slot.bind === "startImage" || slot.bind === "inputVideo") return;
        const sig = `${slot.bind || ""}:${slot.nodeId}:${slot.fieldName}`;
        if (have.has(sig)) return;
        have.add(sig);
        fields.push({
          id: slot.id || slot.bind || `${slot.nodeId}:${slot.fieldName}`,
          type: slot.kind || slot.type || "image",
          label: slot.label || slot.bind || slot.id,
          labelEn: slot.labelEn || slot.label || slot.bind || slot.id,
          required: !!slot.required,
          default: "",
          placeholder: "",
          placeholderEn: "",
          bind: slot.bind || "",
          nodeId: slot.nodeId || "",
          fieldName: slot.fieldName || "",
          visibility: slot.visibility || "shown",
          min: null,
          max: null,
          accept:
            slot.kind === "audio"
              ? AUDIO_ACCEPT
              : slot.kind === "video"
                ? VIDEO_ACCEPT
                : IMAGE_ACCEPT,
          options: [],
        });
      });
    }
    return fields;
  }

  function partitionFieldsByVisibility(fields) {
    const shown = [];
    const collapsed = [];
    fields.forEach((f) => {
      if (f.visibility === "collapsed") collapsed.push(f);
      else shown.push(f);
    });
    return { shown, collapsed };
  }

  function mergeBoundResult(fields, result) {
    const merged = {
      prompt: (result && result.prompt) || "",
      audioFile: (result && result.audioFile) || null,
      videoFile: (result && result.videoFile) || null,
      imageFiles: (result && result.imageFiles) || {},
      videoFiles: (result && result.videoFiles) || {},
      paramValues: (result && result.paramValues) || {},
    };
    for (const field of fields || []) {
      if (!field.bind || field.type === "audio") continue;
      const v = merged.paramValues[field.id];
      if (v == null || v === "") continue;
      if (field.bind === "prompt" && !merged.prompt) {
        merged.prompt = String(v);
      } else if (field.bind !== "prompt") {
        merged[field.bind] = v;
      }
    }
    return merged;
  }

  function notifyChange(session) {
    if (!session || typeof session.onChange !== "function") return;
    const raw = readValues(session, session.fields, { validate: false });
    if (!raw) return;
    try {
      session.onChange(mergeBoundResult(session.fields, raw));
    } catch (e) {
      console.warn("editor input onChange failed", e);
    }
  }

  // ── Rendering ──

  /**
   * @param {FieldSession} session
   * @param {object[]} fields
   */
  function appendSectionLabel(parent, text) {
    const secLabel = document.createElement("p");
    secLabel.className = "editor-input-section-label";
    secLabel.textContent = text;
    parent.appendChild(secLabel);
  }

  function renderFields(session, fields) {
    const container = session && session.container;
    if (!container) return;
    session.audioFiles.clear();
    if (session.imageFiles) session.imageFiles.clear();
    else session.imageFiles = new Map();
    if (session.videoFiles) session.videoFiles.clear();
    else session.videoFiles = new Map();
    container.innerHTML = "";
    session.fields = fields || [];

    const mediaFields = (fields || []).filter((f) => isMediaFieldType(f.type));
    const paramFields = (fields || []).filter((f) => !isMediaFieldType(f.type));

    const renderList = (list, parent) => {
      const hasBuiltin = list.some((f) => f._builtin);
      const hasCustom = list.some((f) => !f._builtin);
      let insertedSeparator = false;
      list.forEach((field) => {
        if (
          hasBuiltin &&
          hasCustom &&
          !insertedSeparator &&
          !field._builtin
        ) {
          insertedSeparator = true;
          const sep = document.createElement("hr");
          sep.className = "editor-input-separator";
          parent.appendChild(sep);
          const secLabel = document.createElement("p");
          secLabel.className = "editor-input-section-label";
          secLabel.textContent = t("editor.inputModal.extraParams");
          parent.appendChild(secLabel);
        }
        const wrap = document.createElement("div");
        wrap.className = "editor-input-field";
        wrap.dataset.fieldId = field.id;
        wrap.dataset.fieldType = field.type;

        const labelEl = document.createElement("label");
        labelEl.className = "field-label muted";
        labelEl.setAttribute("for", fieldDomId(session, field.id));
        const labelText = fieldLabel(field);
        labelEl.textContent = labelText + (field.required ? " *" : "");
        wrap.appendChild(labelEl);

        const nodeId = String(field.nodeId || "").trim();
        const fieldName = String(field.fieldName || "").trim();
        if (nodeId) {
          const ref = document.createElement("code");
          ref.className = "editor-input-node-ref muted";
          ref.textContent = t("settings.paramsNodeRef", {
            nodeId,
            field: fieldName || "?",
          });
          wrap.appendChild(ref);
        }

        const ph = fieldPlaceholder(field);

        if (field.type === "audio") {
          renderAudioField(session, wrap, field);
        } else if (field.type === "image") {
          renderImageField(session, wrap, field);
        } else if (field.type === "video") {
          renderVideoField(session, wrap, field);
        } else if (field.type === "prompt" || field.type === "textarea") {
          renderTextareaField(session, wrap, field, ph);
        } else if (field.type === "number") {
          renderNumberField(session, wrap, field, ph);
        } else if (field.type === "select") {
          renderSelectField(session, wrap, field);
        } else {
          renderTextField(session, wrap, field, ph);
        }

        appendError(wrap, field.id);
        parent.appendChild(wrap);
      });
    };

    if (mediaFields.length) {
      appendSectionLabel(container, t("editor.inputModal.mediaSection"));
      const mediaParts = partitionFieldsByVisibility(mediaFields);
      renderList(mediaParts.shown, container);
      if (mediaParts.collapsed.length) {
        const details = document.createElement("details");
        details.className = "editor-input-more";
        const summary = document.createElement("summary");
        summary.className = "editor-input-more-toggle muted";
        summary.textContent = t("editor.inputModal.moreMedia");
        details.appendChild(summary);
        const inner = document.createElement("div");
        inner.className = "editor-input-more-body";
        renderList(mediaParts.collapsed, inner);
        details.appendChild(inner);
        container.appendChild(details);
      }
    }
    if (paramFields.length) {
      if (mediaFields.length) {
        const sep = document.createElement("hr");
        sep.className = "editor-input-separator";
        container.appendChild(sep);
      }
      appendSectionLabel(container, t("editor.inputModal.paramsSection"));
      const paramParts = partitionFieldsByVisibility(paramFields);
      renderList(paramParts.shown, container);
      if (paramParts.collapsed.length) {
        const details = document.createElement("details");
        details.className = "editor-input-more";
        details.open = false;
        const summary = document.createElement("summary");
        summary.className = "editor-input-more-toggle muted";
        summary.textContent = t("editor.inputModal.moreParams");
        details.appendChild(summary);
        const inner = document.createElement("div");
        inner.className = "editor-input-more-body";
        renderList(paramParts.collapsed, inner);
        details.appendChild(inner);
        container.appendChild(details);
      }
    }
  }

  function appendError(wrap, fieldId) {
    const err = document.createElement("div");
    err.className = "editor-input-error hidden";
    err.dataset.errorFor = fieldId;
    wrap.appendChild(err);
  }

  function renderTextareaField(session, wrap, field, ph) {
    const ta = document.createElement("textarea");
    ta.className = "llm-config-input editor-input-textarea";
    ta.id = fieldDomId(session, field.id);
    ta.dataset.fieldId = field.id;
    ta.rows = field.type === "prompt" ? 4 : 3;
    ta.value =
      field.default != null && field.default !== ""
        ? String(field.default)
        : "";
    if (ph) ta.placeholder = ph;
    wrap.appendChild(ta);

    const counter = document.createElement("div");
    counter.className = "editor-input-char-count";
    counter.textContent = String(ta.value.length);
    wrap.appendChild(counter);

    ta.addEventListener("input", () => {
      counter.textContent = String(ta.value.length);
      clearFieldError(wrap);
      notifyChange(session);
    });
  }

  function renderNumberField(session, wrap, field, ph) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "llm-config-input";
    input.id = fieldDomId(session, field.id);
    input.dataset.fieldId = field.id;
    if (field.min != null && !Number.isNaN(field.min))
      input.min = String(field.min);
    if (field.max != null && !Number.isNaN(field.max))
      input.max = String(field.max);
    if (field.default !== "" && field.default != null)
      input.value = String(field.default);
    if (ph) input.placeholder = ph;
    wrap.appendChild(input);

    if (field.min != null || field.max != null) {
      const hint = document.createElement("p");
      hint.className = "field-hint";
      const parts = [];
      if (field.min != null) parts.push("min: " + field.min);
      if (field.max != null) parts.push("max: " + field.max);
      hint.textContent = parts.join("  ·  ");
      wrap.appendChild(hint);
    }

    input.addEventListener("input", () => {
      clearFieldError(wrap);
      notifyChange(session);
    });
  }

  function renderSelectField(session, wrap, field) {
    const sel = document.createElement("select");
    sel.className = "llm-config-input";
    sel.id = fieldDomId(session, field.id);
    sel.dataset.fieldId = field.id;

    if (!field.required) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "— " + t("editor.inputModal.selectNone") + " —";
      sel.appendChild(empty);
    }

    field.options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent =
        locale() === "en" ? opt.labelEn || opt.label : opt.label;
      if (String(field.default) === String(opt.value)) o.selected = true;
      sel.appendChild(o);
    });
    wrap.appendChild(sel);
    sel.addEventListener("change", () => {
      clearFieldError(wrap);
      notifyChange(session);
    });
  }

  function renderTextField(session, wrap, field, ph) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "llm-config-input";
    input.id = fieldDomId(session, field.id);
    input.dataset.fieldId = field.id;
    input.value = field.default != null ? String(field.default) : "";
    if (ph) input.placeholder = ph;
    wrap.appendChild(input);
    input.addEventListener("input", () => {
      clearFieldError(wrap);
      notifyChange(session);
    });
  }

  function renderImageField(session, wrap, field) {
    if (!session.imageFiles) session.imageFiles = new Map();
    const row = document.createElement("div");
    row.className = "editor-input-file-row";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.id = fieldDomId(session, field.id);
    input.dataset.fieldId = field.id;
    input.className = "editor-input-file";
    const nameEl = document.createElement("span");
    nameEl.className = "muted editor-input-file-name";
    nameEl.textContent = t("editor.inputModal.pickImage");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) {
        session.imageFiles.set(field.id, f);
        nameEl.textContent = f.name + " (" + formatFileSize(f.size) + ")";
      } else {
        session.imageFiles.delete(field.id);
        nameEl.textContent = t("editor.inputModal.pickImage");
      }
      clearFieldError(wrap);
      notifyChange(session);
    });
    row.appendChild(input);
    row.appendChild(nameEl);
    wrap.appendChild(row);
  }

  function renderVideoField(session, wrap, field) {
    if (!session.videoFiles) session.videoFiles = new Map();
    const row = document.createElement("div");
    row.className = "editor-input-file-row";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = field.accept || VIDEO_ACCEPT;
    input.id = fieldDomId(session, field.id);
    input.dataset.fieldId = field.id;
    input.className = "editor-input-file";
    const nameEl = document.createElement("span");
    nameEl.className = "muted editor-input-file-name";
    nameEl.textContent = t("editor.inputModal.pickVideo");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) {
        session.videoFiles.set(field.id, f);
        nameEl.textContent = f.name + " (" + formatFileSize(f.size) + ")";
      } else {
        session.videoFiles.delete(field.id);
        nameEl.textContent = t("editor.inputModal.pickVideo");
      }
      clearFieldError(wrap);
      notifyChange(session);
    });
    row.appendChild(input);
    row.appendChild(nameEl);
    wrap.appendChild(row);
  }

  function renderAudioField(session, wrap, field) {
    const row = document.createElement("div");
    row.className = "editor-input-file-row";

    const icon = document.createElement("span");
    icon.className = "editor-input-file-icon";
    icon.textContent = "\uD83C\uDFB5";
    row.appendChild(icon);

    const info = document.createElement("div");
    info.className = "editor-input-file-info";
    const nameSpan = document.createElement("div");
    nameSpan.className = "editor-input-file-name muted";
    nameSpan.id = fieldDomId(session, field.id, "_name");
    nameSpan.textContent = t("editor.inputModal.audioNone");
    info.appendChild(nameSpan);
    const sizeSpan = document.createElement("div");
    sizeSpan.className = "editor-input-file-size";
    sizeSpan.id = fieldDomId(session, field.id, "_size");
    info.appendChild(sizeSpan);
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "editor-input-file-actions";

    const fileBtn = document.createElement("label");
    fileBtn.className = "file-btn btn btn-ghost btn-sm";
    const fileSpan = document.createElement("span");
    fileSpan.textContent = t("editor.inputModal.audioPick");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = field.accept || AUDIO_ACCEPT;
    fileInput.hidden = true;
    fileInput.id = fieldDomId(session, field.id);
    fileBtn.appendChild(fileSpan);
    fileBtn.appendChild(fileInput);
    actions.appendChild(fileBtn);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-ghost btn-sm hidden";
    clearBtn.textContent = "\u00D7";
    clearBtn.title = t("editor.inputModal.audioClear");
    clearBtn.id = fieldDomId(session, field.id, "_clear");
    actions.appendChild(clearBtn);

    row.appendChild(actions);
    wrap.appendChild(row);

    function applyFile(file) {
      if (!file) return;
      session.audioFiles.set(field.id, file);
      nameSpan.classList.remove("muted");
      nameSpan.textContent = file.name;
      sizeSpan.textContent = formatFileSize(file.size);
      row.classList.add("has-file");
      clearBtn.classList.remove("hidden");
      clearFieldError(wrap);
      notifyChange(session);
    }

    function removeFile() {
      session.audioFiles.delete(field.id);
      nameSpan.classList.add("muted");
      nameSpan.textContent = t("editor.inputModal.audioNone");
      sizeSpan.textContent = "";
      row.classList.remove("has-file");
      clearBtn.classList.add("hidden");
      fileInput.value = "";
      notifyChange(session);
    }

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) applyFile(file);
      else removeFile();
    });

    clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      removeFile();
    });

    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("is-drag-over");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drag-over");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("is-drag-over");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) applyFile(file);
    });
  }

  // ── Errors ──

  function clearFieldError(wrap) {
    const err = wrap.querySelector(".editor-input-error");
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
  }

  function setFieldError(session, fieldId, message) {
    if (!session || !session.container) return;
    const wrap = session.container.querySelector(
      `.editor-input-field[data-field-id="${CSS.escape(fieldId)}"]`
    );
    if (!wrap) return;
    const err = wrap.querySelector(".editor-input-error");
    if (err) {
      err.textContent = message;
      err.classList.remove("hidden");
    }
  }

  function clearAllErrors(session) {
    if (!session || !session.container) return;
    session.container.querySelectorAll(".editor-input-error").forEach((err) => {
      err.textContent = "";
      err.classList.add("hidden");
    });
  }

  // ── Read / validate ──

  /**
   * @param {FieldSession} session
   * @param {object[]} fields
   * @param {{ validate?: boolean }} [opts]
   */
  function readValues(session, fields, opts) {
    const validate = !opts || opts.validate !== false;
    if (validate) clearAllErrors(session);
    const paramValues = {};
    let prompt = "";
    let audioFile = null;
    let videoFile = null;
    const imageFiles = {};
    const videoFiles = {};
    let ok = true;
    let firstErrorId = null;
    const audioStore = (session && session.audioFiles) || new Map();
    const imageStore = (session && session.imageFiles) || new Map();
    const videoStore = (session && session.videoFiles) || new Map();

    for (const field of fields || []) {
      if (field.type === "audio") {
        const file = audioStore.get(field.id) || null;
        if (validate && field.required && !file) {
          setFieldError(session, field.id, t("editor.inputModal.required"));
          if (!firstErrorId) firstErrorId = field.id;
          ok = false;
          continue;
        }
        if (file) {
          if (field.id === "inputAudio" || !audioFile) audioFile = file;
          paramValues[field.id] = file.name;
        }
        continue;
      }
      if (field.type === "image") {
        const file = imageStore.get(field.id) || null;
        if (validate && field.required && !file) {
          setFieldError(session, field.id, t("editor.inputModal.required"));
          if (!firstErrorId) firstErrorId = field.id;
          ok = false;
          continue;
        }
        if (file) {
          imageFiles[field.id] = file;
          if (field.bind) imageFiles[field.bind] = file;
          paramValues[field.id] = file.name;
        }
        continue;
      }
      if (field.type === "video") {
        const file = videoStore.get(field.id) || null;
        if (validate && field.required && !file) {
          setFieldError(session, field.id, t("editor.inputModal.required"));
          if (!firstErrorId) firstErrorId = field.id;
          ok = false;
          continue;
        }
        if (file) {
          videoFiles[field.id] = file;
          if (field.bind) videoFiles[field.bind] = file;
          if (field.bind === "inputVideo" || !videoFile) videoFile = file;
          paramValues[field.id] = file.name;
        }
        continue;
      }

      const el = document.getElementById(fieldDomId(session, field.id));
      let raw = el ? String(el.value || "") : "";

      if (field.type === "number") {
        raw = raw.trim();
        if (validate && field.required && raw === "") {
          setFieldError(session, field.id, t("editor.inputModal.required"));
          if (!firstErrorId) firstErrorId = field.id;
          ok = false;
          continue;
        }
        if (raw !== "") {
          const num = Number(raw);
          if (validate && Number.isNaN(num)) {
            setFieldError(
              session,
              field.id,
              t("editor.inputModal.invalidNumber")
            );
            if (!firstErrorId) firstErrorId = field.id;
            ok = false;
            continue;
          }
          if (
            validate &&
            field.min != null &&
            !Number.isNaN(field.min) &&
            num < field.min
          ) {
            setFieldError(
              session,
              field.id,
              t("editor.inputModal.numberRange", {
                min: field.min,
                max: field.max != null ? field.max : "∞",
              })
            );
            if (!firstErrorId) firstErrorId = field.id;
            ok = false;
            continue;
          }
          if (
            validate &&
            field.max != null &&
            !Number.isNaN(field.max) &&
            num > field.max
          ) {
            setFieldError(
              session,
              field.id,
              t("editor.inputModal.numberRange", {
                min: field.min != null ? field.min : "-∞",
                max: field.max,
              })
            );
            if (!firstErrorId) firstErrorId = field.id;
            ok = false;
            continue;
          }
          if (!Number.isNaN(num)) {
            paramValues[field.id] = num;
            if (field.bind === "prompt") prompt = String(num);
          }
        }
        continue;
      }

      raw = raw.trim();
      if (validate && field.required && !raw) {
        setFieldError(session, field.id, t("editor.inputModal.required"));
        if (!firstErrorId) firstErrorId = field.id;
        ok = false;
        continue;
      }
      if (raw) {
        paramValues[field.id] = raw;
        if (field.type === "prompt" || field.bind === "prompt") {
          prompt = raw;
        }
      }
    }

    if (validate && !ok) {
      if (firstErrorId) {
        const errEl = document.getElementById(
          fieldDomId(session, firstErrorId)
        );
        if (errEl && typeof errEl.focus === "function") errEl.focus();
      }
      return null;
    }
    return { prompt, audioFile, videoFile, paramValues, imageFiles, videoFiles };
  }

  // ── Open / close (modal) ──

  function openUi(editor, fields) {
    const { modal, title, desc, form, submit, cancel, fields: container } =
      els();
    if (!modal || !form || !container) {
      throw new Error(t("editor.inputModal.missingShell"));
    }
    const E = window.VflowEditors;
    const name = E
      ? E.displayName(editor)
      : (editor && (editor.name || editor.id)) || "";
    const description = E
      ? E.displayDescription(editor)
      : (editor && editor.description) || "";
    if (title) {
      title.textContent = t("editor.inputModal.title", { name });
    }
    if (desc) {
      desc.textContent = description || "";
      desc.classList.toggle("hidden", !description);
    }
    if (submit) submit.textContent = t("editor.inputModal.submit");
    if (cancel) cancel.textContent = t("editor.inputModal.cancel");
    const session = {
      container,
      idPrefix: MODAL_ID_PREFIX,
      audioFiles: new Map(),
      imageFiles: new Map(),
      videoFiles: new Map(),
      fields: fields || [],
      editorId: editor && editor.id ? String(editor.id) : "",
      onChange: null,
    };
    if (pending) pending.session = session;
    renderFields(session, fields);
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    const first =
      form.querySelector("textarea, input:not([type=file]), select") || null;
    if (first && typeof first.focus === "function") {
      setTimeout(() => first.focus(), 60);
    }
  }

  function hideUi() {
    const { modal, fields } = els();
    if (modal) modal.classList.add("hidden");
    if (fields) fields.innerHTML = "";
    if (pending && pending.session) pending.session.audioFiles.clear();
    if (!otherModalsOpen()) {
      document.body.classList.remove("modal-open");
    }
  }

  function finishReject(err) {
    const p = pending;
    pending = null;
    hideUi();
    if (p) p.reject(err || new Error(t("editor.inputModal.canceled")));
  }

  function finishResolve(value) {
    const p = pending;
    pending = null;
    hideUi();
    if (p) p.resolve(value || {});
  }

  function close() {
    if (!pending) {
      hideUi();
      return;
    }
    finishReject(new Error(t("editor.inputModal.canceled")));
  }

  function isOpen() {
    const { modal } = els();
    return !!(modal && !modal.classList.contains("hidden"));
  }

  /**
   * @param {object} editor EditorManifest
   * @param {{ initialValues?: object }} [options]
   * @returns {Promise<{ prompt?: string, audioFile?: File|null, paramValues?: object }>}
   */
  function collect(editor, options) {
    if (pending) {
      return Promise.reject(new Error(t("editor.inputModal.busy")));
    }
    const opts = options && typeof options === "object" ? options : {};
    let fields = buildFields(editor);
    if (!fields.length) {
      return Promise.resolve({});
    }
    const editorId = editor && editor.id ? String(editor.id) : "";
    fields = applyInitialValues(
      fields,
      opts.initialValues || null,
      loadLastInputs(editorId)
    );
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, fields, editorId };
      try {
        openUi(editor, fields);
      } catch (e) {
        pending = null;
        reject(e);
      }
    });
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (!pending) return;
    const fields = pending.fields || [];
    const session =
      pending.session ||
      ({
        container: els().fields,
        idPrefix: MODAL_ID_PREFIX,
        audioFiles: new Map(),
        fields,
        editorId: pending.editorId || "",
      });
    const result = readValues(session, fields, { validate: true });
    if (!result) return;
    const merged = mergeBoundResult(fields, result);
    if (pending.editorId) {
      saveLastInputs(pending.editorId, {
        prompt: merged.prompt || "",
        ...(merged.paramValues || {}),
        ...Object.fromEntries(
          Object.keys(merged)
            .filter((k) => !["prompt", "audioFile", "paramValues"].includes(k))
            .map((k) => [k, merged[k]])
        ),
      });
    }
    finishResolve(merged);
  }

  // ── Inspector mount (editor video slot) ──

  /**
   * Mount editor property fields into a host (right inspector).
   * @param {HTMLElement} host
   * @param {object} editor
   * @param {{
   *   initialValues?: object,
   *   mountKey?: string,
   *   onChange?: Function,
   *   preferLastInputs?: boolean,
   * }} [options]
   * @returns {{ fields: object[], editorId: string, mountKey: string }|null}
   */
  function mount(host, editor, options) {
    if (!host || !editor) return null;
    const opts = options && typeof options === "object" ? options : {};
    const editorId = editor && editor.id ? String(editor.id) : "";
    const mountKey = String(opts.mountKey || editorId || "");
    if (
      inspectorSession &&
      inspectorSession.container === host &&
      inspectorSession.editorId === editorId &&
      String(inspectorSession.mountKey || "") === mountKey
    ) {
      return {
        fields: inspectorSession.fields || [],
        editorId,
        mountKey,
      };
    }
    unmount();
    let fields = buildFields(editor);
    const last =
      opts.preferLastInputs === false ? null : loadLastInputs(editorId);
    fields = applyInitialValues(fields, opts.initialValues || null, last);
    inspectorSession = {
      container: host,
      idPrefix: SLOT_ID_PREFIX,
      audioFiles: new Map(),
      imageFiles: new Map(),
      videoFiles: new Map(),
      fields,
      editorId,
      mountKey,
      onChange: typeof opts.onChange === "function" ? opts.onChange : null,
    };
    renderFields(inspectorSession, fields);
    return { fields, editorId, mountKey };
  }

  function unmount() {
    if (!inspectorSession) return;
    if (inspectorSession.container) {
      inspectorSession.container.innerHTML = "";
    }
    inspectorSession.audioFiles.clear();
    inspectorSession = null;
  }

  function isMounted() {
    return !!inspectorSession;
  }

  /**
   * @param {string} [editorId]
   * @param {string} [mountKey]
   */
  function isMountedFor(editorId, mountKey) {
    if (!inspectorSession) return false;
    if (editorId != null && String(inspectorSession.editorId) !== String(editorId)) {
      return false;
    }
    if (
      mountKey != null &&
      String(inspectorSession.mountKey || "") !== String(mountKey)
    ) {
      return false;
    }
    return true;
  }

  function getMountedEditorId() {
    return inspectorSession ? inspectorSession.editorId : null;
  }

  function getMountedFields() {
    return inspectorSession ? inspectorSession.fields || [] : [];
  }

  /**
   * Read + validate currently mounted inspector fields.
   * @returns {object|null} null when validation fails
   */
  function readMounted() {
    if (!inspectorSession) return null;
    const result = readValues(inspectorSession, inspectorSession.fields, {
      validate: true,
    });
    if (!result) return null;
    const merged = mergeBoundResult(inspectorSession.fields, result);
    if (inspectorSession.editorId) {
      saveLastInputs(inspectorSession.editorId, {
        prompt: merged.prompt || "",
        ...(merged.paramValues || {}),
        ...Object.fromEntries(
          Object.keys(merged)
            .filter((k) => !["prompt", "audioFile", "paramValues"].includes(k))
            .map((k) => [k, merged[k]])
        ),
      });
    }
    return merged;
  }

  function wire() {
    const { modal, form } = els();
    if (!modal || modal.dataset.wired === "1") return;
    modal.dataset.wired = "1";
    modal.querySelectorAll("[data-close-editor-input]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        close();
      });
    });
    if (form) {
      form.addEventListener("submit", onSubmit);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  window.VflowEditorInputModal = {
    PARAM_TYPES,
    BIND_KEYS,
    buildFields,
    validateParams,
    normalizeParam,
    applyInitialValues,
    collect,
    close,
    isOpen,
    mount,
    unmount,
    isMounted,
    isMountedFor,
    getMountedEditorId,
    getMountedFields,
    readMounted,
    loadLastInputs,
    saveLastInputs,
  };
})();
