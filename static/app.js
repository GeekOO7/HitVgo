(() => {
  const POLL_MS = 4000;
  const PROJECT_KEY = "vflow-current-project-id";
  const ASSET_ORIGIN_KEY = "vflow-asset-origin";
  const ASSET_VIDEO_THUMB_KEY = "vflow-asset-video-thumb-preview";
  const LLM_CFG_KEY = "vflow-llm-config";
  const LLM_CHANNEL_KEY = "vflow-llm-channel";
  const LLM_CUSTOM_MODELS_KEY = "vflow-llm-custom-models";
  const VIDEO_CHANNEL_KEY = "vflow-video-channel-config";
  const DUCK_ENCRYPT_KEY = "vflow-use-duck-encrypt";
  const CONCURRENCY_KEY = "vflow-submit-concurrency";
  const USER_EDITORS_KEY = "vflow-user-editors";
  const LLM_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
  const LLM_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
  const LLM_PICKER_LIMIT = 8;
  const LLM_PROVIDERS_MAX = 16;
  const LLM_MODELS_PER_PROVIDER = 40;
  const RH_DEFAULT_BASE = "https://www.runninghub.ai";
  const COMFY_DEFAULT_BASE = "http://127.0.0.1:8188";
  const SAVE_DEBOUNCE_MS = 400;
  /** Bridge overlaps last N sec of prev main + first N sec of next main on the upper track. */
  const BRIDGE_OVERLAP_SEC = 1.7;
  /** Soft-bridge clip must cover both overlaps (seconds). */
  let BRIDGE_MIN_SEC = Math.round(2 * BRIDGE_OVERLAP_SEC * 10) / 10;
  /** I2V main clip duration cap (seconds) — refreshed from engine profile. */
  let MAIN_MAX_SEC = 7;
  let MAIN_MIN_SEC = 2;
  let MAIN_DEFAULT_SEC = 5;
  /** Soft-bridge default clip duration — same as main cap (soft-chain unit ≈ 21s). */
  let BRIDGE_DEFAULT_SEC = MAIN_MAX_SEC;
  /** Soft-bridge clip duration cap (seconds). */
  let BRIDGE_MAX_SEC = 12;
  /**
   * Soft-chain planning unit ≈ main + soft bridge + main (~21s wall clock).
   * Longer continuous action must append bridge+main (I2V re-anchor), not bridge-only.
   */
  let SOFT_CHAIN_UNIT_SEC = 21;

  /** @type {string} */
  let storyboardEngineProfile = "";
  let storyboardUseMultiRef = false;
  /** @type {Array<{id:string,kind:'image'|'video'|'audio',rhFileName?:string|null,playUrl?:string|null,mediaId?:number|null,content:string,purpose:string,note?:string,localFile?:File|null}>} */
  let storyboardRefAssets = [];
  let storyboardRefPickKind = "image";
  /** Extra workflow media uploads keyed by semantic bind. */
  let storyboardMediaByBind = {};

  function normalizeRefAssetFields(raw, index) {
    const a = raw && typeof raw === "object" ? raw : {};
    const kind =
      a.kind === "video" ? "video" : a.kind === "audio" ? "audio" : "image";
    const content = String(
      a.content != null && String(a.content).trim()
        ? a.content
        : a.note || ""
    ).trim();
    const purpose = String(a.purpose || "").trim();
    return {
      id: String(a.id || `r${(index != null ? index : 0) + 1}`),
      kind,
      rhFileName: a.rhFileName || null,
      playUrl: a.playUrl || null,
      mediaId: a.mediaId || null,
      content,
      purpose,
      note: content,
      localFile: a.localFile || null,
    };
  }

  function refAssetPayload(a) {
    return {
      id: a.id,
      kind: a.kind,
      rhFileName: a.rhFileName || null,
      playUrl: persistablePlayUrl(a.playUrl),
      mediaId: a.mediaId || null,
      content: a.content || "",
      purpose: a.purpose || "",
      note: a.content || a.note || "",
    };
  }

  function refAssetLlmPayload(a) {
    return {
      id: a.id,
      kind: a.kind,
      content: a.content || "",
      purpose: a.purpose || "",
      note: a.content || a.note || "",
    };
  }

  function normalizeEngineId(profile) {
    const E = window.VflowStoryboardEngines;
    if (E && typeof E.normalizeEngineId === "function") {
      return E.normalizeEngineId(profile);
    }
    const next = String(profile || "").trim();
    if (next.indexOf("user.engine.") === 0) return next;
    return "";
  }

  function isUserEngineId(id) {
    const E = window.VflowStoryboardEngines;
    if (E && typeof E.isUserEngineId === "function") {
      return E.isUserEngineId(id);
    }
    return String(id || "").indexOf("user.engine.") === 0;
  }

  function isPlatformEngine() {
    return false;
  }

  function engineDisplayName(eng) {
    if (!eng || !eng.id) return t("engine.none");
    return eng.name || eng.id;
  }

  function fillEngineSelects() {
    const E = window.VflowStoryboardEngines;
    const list =
      E && typeof E.listSelectableEngines === "function"
        ? E.listSelectableEngines()
        : [];
    const ids = list.map((e) => e.id);
    const fallback = ids[0] || "";
    ["storyboardEngine", "inspectorEngine"].forEach((domId) => {
      const el = document.getElementById(domId);
      if (!el) return;
      const prev = el.value || storyboardEngineProfile;
      if (!list.length) {
        el.innerHTML = `<option value="">${escapeHtml(t("engine.none"))}</option>`;
        el.value = "";
        return;
      }
      el.innerHTML = list
        .map(
          (e) =>
            `<option value="${escapeHtml(e.id)}">${escapeHtml(
              engineDisplayName(e)
            )}</option>`
        )
        .join("");
      el.value = ids.includes(prev) ? prev : fallback;
    });
    if (!ids.includes(storyboardEngineProfile)) {
      storyboardEngineProfile = fallback;
    }
  }

  function getStoryboardEngine(profile) {
    const id =
      profile != null && String(profile).trim()
        ? normalizeEngineId(profile)
        : storyboardEngineProfile;
    const E = window.VflowStoryboardEngines;
    if (E && typeof E.getEngine === "function") {
      return E.getEngine(id);
    }
    return {
      id: id || "",
      source: "user",
      configured: false,
      name: "",
      mainMinSec: 2,
      mainMaxSec: 7,
      mainDefaultSec: 5,
      durationChoices: null,
      bridgeMinSec: 3.4,
      bridgeMaxSec: 12,
      bridgeDefaultSec: 7,
      softChainUnitSec: 21,
      supportsMultiRef: false,
      allowAudioInPrompt: false,
      allowTimedBeats: false,
      usesDurationSeconds: false,
      nativeFps: null,
      defaultFps: 16,
      defaultLength: null,
      maxRefImages: 0,
      maxRefVideos: 0,
      maxRefAudios: 0,
    };
  }

  function usesTimedStoryboardEngine() {
    const e = getStoryboardEngine();
    return !!(e && (e.allowTimedBeats || e.usesDurationSeconds));
  }

  function buildEngineCapsPayload(eng) {
    const e = eng || getStoryboardEngine();
    if (!e || e.source !== "user") return null;
    return {
      id: e.id,
      name: e.name || "",
      mainMinSec: e.mainMinSec,
      mainMaxSec: e.mainMaxSec,
      mainDefaultSec: e.mainDefaultSec,
      bridgeMinSec: e.bridgeMinSec,
      bridgeMaxSec: e.bridgeMaxSec,
      bridgeDefaultSec: e.bridgeDefaultSec,
      softChainUnitSec: e.softChainUnitSec,
      supportsMultiRef: !!e.supportsMultiRef,
      allowAudioInPrompt: !!e.allowAudioInPrompt,
      allowTimedBeats: !!e.allowTimedBeats,
      usesDurationSeconds: !!e.usesDurationSeconds,
      nativeFps: e.nativeFps,
      defaultFps: e.defaultFps,
      defaultLength: e.defaultLength,
      maxRefImages: e.maxRefImages || 0,
      maxRefVideos: e.maxRefVideos || 0,
      maxRefAudios: e.maxRefAudios || 0,
      durationChoices: e.durationChoices || null,
    };
  }

  /** Clip engine if set, else global storyboard engine, else wan. */
  function resolveClipEngineId(clip) {
    if (clip && clip.engineProfile) {
      return normalizeEngineId(clip.engineProfile);
    }
    return normalizeEngineId(storyboardEngineProfile);
  }

  function stampClipEngine(clip, engineId) {
    if (!clip) return;
    clip.engineProfile = normalizeEngineId(engineId);
  }

  function commitClipEngineAfterEnqueue(clip, engineId) {
    const id = normalizeEngineId(engineId);
    stampClipEngine(clip, id);
    if (storyboardEngineProfile !== id) {
      applyStoryboardEngineProfile(id);
    } else {
      syncInspectorEngineUi();
    }
    try {
      scheduleSaveDraft();
    } catch (_) {
      /* scheduleSaveDraft may not exist yet during early init */
    }
  }

  function syncInspectorEngineUi() {
    // Look up DOM each time — helpers are defined before the const bindings.
    const engineEl = document.getElementById("inspectorEngine");
    const wrap = document.getElementById("inspectorEngineWrap");
    if (!engineEl) return;
    let show = true;
    let value = storyboardEngineProfile;
    try {
      if (
        selectedClip &&
        (selectedClip.kind === "edit" || selectedClip.kind === "audio")
      ) {
        show = false;
      } else if (selectedClip && selectedClip.kind === "main") {
        value = resolveClipEngineId(findMain(selectedClip.id));
      } else if (selectedClip && selectedClip.kind === "bridge") {
        value = resolveClipEngineId(
          bridges.find((x) => x.id === selectedClip.id)
        );
      }
    } catch (_) {
      /* selectedClip / bridges / findMain not ready yet during early init */
    }
    if (wrap) {
      wrap.hidden = !show;
    }
    fillEngineSelects();
    engineEl.value = normalizeEngineId(value);
  }

  function refreshEngineTimingConstants() {
    const e = getStoryboardEngine();
    MAIN_MIN_SEC = e.mainMinSec;
    MAIN_MAX_SEC = e.mainMaxSec;
    MAIN_DEFAULT_SEC = e.mainDefaultSec;
    BRIDGE_MAX_SEC = e.bridgeMaxSec;
    BRIDGE_DEFAULT_SEC = e.bridgeDefaultSec;
    BRIDGE_MIN_SEC = Math.max(
      Math.round(2 * BRIDGE_OVERLAP_SEC * 10) / 10,
      e.bridgeMinSec
    );
    SOFT_CHAIN_UNIT_SEC = e.softChainUnitSec;
  }
  refreshEngineTimingConstants();

  function applyStoryboardEngineProfile(profile) {
    storyboardEngineProfile = normalizeEngineId(profile);
    refreshEngineTimingConstants();
    const eng = getStoryboardEngine();
    if (!eng.supportsMultiRef) {
      storyboardUseMultiRef = false;
    }
    if (storyboardMainDurationEl) {
      storyboardMainDurationEl.min = String(eng.mainMinSec);
      storyboardMainDurationEl.max = String(eng.mainMaxSec);
      const cur = Number(storyboardMainDurationEl.value);
      if (
        !Number.isFinite(cur) ||
        cur < eng.mainMinSec ||
        cur > eng.mainMaxSec
      ) {
        storyboardMainDurationEl.value = String(eng.mainDefaultSec);
      }
    }
    // Clamp existing clip durations to new envelope + stamp engine on all clips
    // so a prior Wan enqueue cannot leave sticky engineProfile that overrides UI.
    const E = window.VflowStoryboardEngines;
    mains.forEach((m) => {
      stampClipEngine(m, eng.id);
      if (m.durationSec != null && Number(m.durationSec) > 0) {
        m.durationSec =
          E && typeof E.clampMainSec === "function"
            ? E.clampMainSec(m.durationSec, eng.id)
            : Math.max(MAIN_MIN_SEC, Math.min(MAIN_MAX_SEC, Number(m.durationSec)));
      } else {
        m.durationSec = MAIN_DEFAULT_SEC;
      }
    });
    bridges.forEach((b) => {
      stampClipEngine(b, eng.id);
      if (b.needBridge === false) return;
      if (b.durationSec != null && Number(b.durationSec) > 0) {
        b.durationSec =
          E && typeof E.clampBridgeSec === "function"
            ? E.clampBridgeSec(b.durationSec, eng.id, false)
            : Math.max(
                BRIDGE_MIN_SEC,
                Math.min(BRIDGE_MAX_SEC, Number(b.durationSec))
              );
      }
    });
    applyEngineTimingDefaults(eng, { writeProject: true });
    if (eng.usesDurationSeconds && storyboardMainDurationEl) {
      storyboardMainDurationEl.value = String(
        E && typeof E.clampMainSec === "function"
          ? E.clampMainSec(storyboardMainDurationEl.value, eng.id)
          : eng.mainDefaultSec
      );
    }
    fillEngineSelects();
    syncStoryboardEngineUi();
    syncInspectorEngineUi();
    syncVflowEngineTimingMode();
    syncMediaBinMultiRefPanel();
    updateChannelSummary();
  }

  function syncStoryboardEngineUi() {
    fillEngineSelects();
    const eng = getStoryboardEngine();
    const engineEl = document.getElementById("storyboardEngine");
    const capsEl = document.getElementById("storyboardEngineCaps");
    const multiPanel = document.getElementById("storyboardMultiRefPanel");
    const useMultiEl = document.getElementById("storyboardUseMultiRef");
    const hintsBody = document.getElementById("storyboardWritingHintsBody");
    if (engineEl) engineEl.value = storyboardEngineProfile;
    if (capsEl) {
      capsEl.textContent = t("storyboard.engineCaps", {
        mainMin: eng.mainMinSec,
        mainMax: eng.mainMaxSec,
        bridgeMax: eng.bridgeMaxSec,
      });
    }
    if (storyboardMainDurationEl) {
      storyboardMainDurationEl.min = String(eng.mainMinSec);
      storyboardMainDurationEl.max = String(eng.mainMaxSec);
      storyboardMainDurationEl.step = "0.5";
      // Sync to engine default when empty/out of range or after engine switch
      const cur = Number(storyboardMainDurationEl.value);
      if (
        !Number.isFinite(cur) ||
        cur < eng.mainMinSec ||
        cur > eng.mainMaxSec
      ) {
        storyboardMainDurationEl.value = String(eng.mainDefaultSec);
      }
    }
    if (multiPanel) {
      multiPanel.classList.toggle("hidden", !eng.supportsMultiRef);
    }
    if (useMultiEl) {
      useMultiEl.checked = !!storyboardUseMultiRef && !!eng.supportsMultiRef;
      useMultiEl.disabled = !eng.supportsMultiRef;
    }
    const btnVid = document.getElementById("btnAddStoryboardRefVideo");
    const btnAud = document.getElementById("btnAddStoryboardRefAudio");
    if (btnVid) {
      btnVid.classList.toggle("hidden", !(eng.maxRefVideos > 0));
    }
    if (btnAud) {
      btnAud.classList.toggle("hidden", !(eng.maxRefAudios > 0));
    }
    renderStoryboardRefList();
    syncMediaBinMultiRefPanel();
    if (typeof syncLlmCountUi === "function") syncLlmCountUi();
    if (hintsBody) {
      const E = window.VflowStoryboardEngines;
      const hints = E
        ? E.writingHints(storyboardEngineProfile, storyboardUseMultiRef)
        : null;
      if (hints) {
        const bullets = (hints.bullets || [])
          .map((k) => `<li>${escapeHtml(t(k))}</li>`)
          .join("");
        hintsBody.innerHTML =
          `<p><strong>${escapeHtml(t(hints.titleKey))}</strong></p><ul>${bullets}</ul>` +
          `<p class="storyboard-skeleton-preview"><code>${escapeHtml(
            String(hints.skeleton || "")
              .replace("{duration}", String(getStoryboardMainDurationSec()))
              .replace(
                "{beats}",
                E && typeof E.buildMinimaxBeatSkeleton === "function"
                  ? E.buildMinimaxBeatSkeleton(
                      getStoryboardMainDurationSec(),
                      currentLocale()
                    )
                  : ""
              )
          )}</code></p>`;
      } else {
        hintsBody.textContent = "";
      }
    }
  }

  function renderRefListInto(listEl) {
    if (!listEl) return;
    if (!storyboardUseMultiRef || !getStoryboardEngine().supportsMultiRef) {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = "";
    // Fixed: 首帧 = <Picture 1> (shared start); list refs continue Picture 2+
    const zeroRow = document.createElement("div");
    zeroRow.className = "storyboard-ref-row storyboard-ref-row-start";
    const zeroPreview = sharedStartPlayUrl
      ? `<img src="${escapeAttr(sharedStartPlayUrl)}" alt="" />`
      : escapeHtml(
          sharedStartRhName || t("storyboard.image0Pending")
        );
    zeroRow.innerHTML = `
      <span class="storyboard-ref-tag">${escapeHtml("<Picture 1>")}</span>
      <span class="storyboard-ref-preview muted">${zeroPreview}</span>
      <span class="storyboard-ref-note muted">${escapeHtml(
        t("storyboard.image0Label")
      )}</span>
    `;
    listEl.appendChild(zeroRow);

    let imgN = 1; // Picture 1 = shared start
    let vidN = 0;
    let audN = 0;
    storyboardRefAssets.forEach((asset, idx) => {
      const tag =
        asset.kind === "video"
          ? `<Video ${++vidN}>`
          : asset.kind === "audio"
            ? `<Audio ${++audN}>`
            : `<Picture ${++imgN}>`;
      const row = document.createElement("div");
      row.className = "storyboard-ref-row";
      const preview =
        asset.kind === "audio"
          ? escapeHtml(asset.rhFileName || t("storyboard.refPending"))
          : asset.playUrl
            ? asset.kind === "video"
              ? `<video src="${escapeAttr(asset.playUrl)}" muted></video>`
              : `<img src="${escapeAttr(asset.playUrl)}" alt="" />`
            : escapeHtml(asset.rhFileName || t("storyboard.refPending"));
      row.innerHTML = `
        <span class="storyboard-ref-tag">${escapeHtml(tag)}</span>
        <span class="storyboard-ref-preview muted">${preview}</span>
        <div class="storyboard-ref-fields">
          <input type="text" class="storyboard-ref-content" data-idx="${idx}" value="${escapeAttr(
        asset.content || ""
      )}" placeholder="${escapeAttr(t("storyboard.refContentPlaceholder"))}" title="${escapeAttr(
        t("storyboard.refContentLabel")
      )}" />
          <input type="text" class="storyboard-ref-purpose" data-idx="${idx}" value="${escapeAttr(
        asset.purpose || ""
      )}" placeholder="${escapeAttr(t("storyboard.refPurposePlaceholder"))}" title="${escapeAttr(
        t("storyboard.refPurposeLabel")
      )}" />
        </div>
        <button type="button" class="btn btn-ghost btn-sm storyboard-ref-remove" data-idx="${idx}">${t(
        "common.delete"
      )}</button>
      `;
      listEl.appendChild(row);
    });
    listEl.querySelectorAll(".storyboard-ref-content").forEach((inp) => {
      inp.addEventListener("change", () => {
        const i = Number(inp.getAttribute("data-idx"));
        if (storyboardRefAssets[i]) {
          const v = inp.value.trim();
          storyboardRefAssets[i].content = v;
          storyboardRefAssets[i].note = v;
          scheduleSaveDraft();
        }
      });
    });
    listEl.querySelectorAll(".storyboard-ref-purpose").forEach((inp) => {
      inp.addEventListener("change", () => {
        const i = Number(inp.getAttribute("data-idx"));
        if (storyboardRefAssets[i]) {
          storyboardRefAssets[i].purpose = inp.value.trim();
          scheduleSaveDraft();
        }
      });
    });
    listEl.querySelectorAll(".storyboard-ref-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-idx"));
        storyboardRefAssets.splice(i, 1);
        renderStoryboardRefList();
        scheduleSaveDraft();
      });
    });
  }

  function renderStoryboardRefList() {
    renderRefListInto(document.getElementById("storyboardRefList"));
    renderRefListInto(document.getElementById("mediaBinRefList"));
  }

  /**
   * Show left-bin multi-ref controls when active engine supports them and
   * shared-start (imagePanel) context is visible — same state as storyboard modal.
   */
  function syncMediaBinMultiRefPanel() {
    const panel = document.getElementById("mediaBinMultiRefPanel");
    if (!panel) return;
    let eng;
    try {
      eng = getStoryboardEngine(
        typeof resolveActiveInspectorEngineId === "function"
          ? resolveActiveInspectorEngineId()
          : storyboardEngineProfile
      );
    } catch (_) {
      eng = getStoryboardEngine(storyboardEngineProfile);
    }
    // Always query DOM — avoid TDZ if called before const imagePanel init.
    const imgPanel = document.getElementById("imagePanel");
    const sharedVisible = !!(
      imgPanel && !imgPanel.classList.contains("hidden")
    );
    const show = !!(eng.supportsMultiRef && sharedVisible);
    panel.classList.toggle("hidden", !show);
    const useMultiEl = document.getElementById("mediaBinUseMultiRef");
    if (useMultiEl) {
      useMultiEl.checked = !!storyboardUseMultiRef && !!eng.supportsMultiRef;
      useMultiEl.disabled = !eng.supportsMultiRef;
    }
    const btnVid = document.getElementById("btnAddMediaBinRefVideo");
    const btnAud = document.getElementById("btnAddMediaBinRefAudio");
    if (btnVid) {
      btnVid.classList.toggle("hidden", !(eng.maxRefVideos > 0));
    }
    if (btnAud) {
      btnAud.classList.toggle("hidden", !(eng.maxRefAudios > 0));
    }
    if (show) {
      renderRefListInto(document.getElementById("mediaBinRefList"));
    } else {
      const listEl = document.getElementById("mediaBinRefList");
      if (listEl) listEl.innerHTML = "";
    }
  }

  const STORYBOARD_BUILTIN_PARAM_BINDS = new Set([
    "width",
    "height",
    "length",
    "fps",
    "duration",
    "prompt",
    "negative",
    "seedHigh",
    "seedLow",
  ]);

  function peekStoryboardModeCfg(mode) {
    const cfg = getVideoChannelConfig();
    const W = window.VflowAdapter;
    const E = window.VflowStoryboardEngines;
    const U = window.VflowUserEngines;
    try {
      const eng = getStoryboardEngine();
      if (eng.source === "user" && U && typeof U.adapterModeFromSlot === "function") {
        return U.adapterModeFromSlot(eng, mode === "flf" ? "bridge" : "main");
      }
      return resolveAdapterMode(cfg, mode, {
        engineProfile: storyboardEngineProfile,
      });
    } catch (_) {
      const adapter = getActiveChannelAdapter(cfg);
      if (adapter && adapter.modes) {
        return (
          adapter.modes[mode] ||
          adapter.modes.i2v ||
          Object.values(adapter.modes)[0] ||
          null
        );
      }
      return null;
    }
  }

  function selectedStoryboardClip() {
    if (!selectedClip) return null;
    if (selectedClip.kind === "main") return findMain(selectedClip.id);
    if (selectedClip.kind === "bridge") {
      return bridges.find((x) => x.id === selectedClip.id) || null;
    }
    return null;
  }

  function storyboardAcceptForKind(kind) {
    if (kind === "video") return "video/*,.mp4,.webm,.mov,.mkv,.m4v";
    if (kind === "audio") return "audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac";
    return "image/jpeg,image/png,image/webp,image/jpg";
  }

  async function onStoryboardSlotFile(bind, kind, file) {
    if (!file || !bind) return;
    const entry = {
      bind,
      kind: kind || "image",
      file,
      fileName: file.name,
      rhFileName: null,
      playUrl: null,
    };
    try {
      if (isPlatformEngine(getStoryboardEngine())) {
        const up = await uploadImage(file);
        entry.rhFileName = up.fileName || up.fileName;
        entry.playUrl = up.playUrl || null;
      }
    } catch (e) {
      alert((e && e.message) || String(e));
      return;
    }
    storyboardMediaByBind[bind] = entry;
    scheduleSaveDraft();
    syncStoryboardDynamicUi();
  }

  function extraStoryboardMediaSlots(modeCfg, mode) {
    const W = window.VflowAdapter;
    if (!W || typeof W.splitUiSlots !== "function" || !modeCfg) return [];
    const slots = W.splitUiSlots(modeCfg);
    let eng;
    try {
      eng = getStoryboardEngine();
    } catch (_) {
      eng = { supportsMultiRef: false };
    }
    return (slots.mediaSlots || []).filter((s) => {
      if (!s || s.visibility === "hidden") return false;
      if (s.bind === "startImage" || s.bind === "refImage0") return false;
      if (s.bind === "endImage") return false;
      if (eng.supportsMultiRef && /^ref(Image|Video|Audio)\d+$/.test(s.bind || "")) {
        return false;
      }
      return true;
    });
  }

  function extraStoryboardParamSlots(modeCfg) {
    const W = window.VflowAdapter;
    if (!W || typeof W.splitUiSlots !== "function" || !modeCfg) return [];
    const slots = W.splitUiSlots(modeCfg);
    return (slots.params || []).filter((p) => {
      if (!p || p.visibility === "hidden") return false;
      if (STORYBOARD_BUILTIN_PARAM_BINDS.has(p.bind)) return false;
      if (p.kind === "image" || p.kind === "video" || p.kind === "audio") return false;
      if (p.type === "image" || p.type === "video" || p.type === "audio") return false;
      return true;
    });
  }

  function renderStoryboardMediaSlots(slots) {
    const panel = document.getElementById("mediaBinWorkflowSlots");
    const list = document.getElementById("mediaBinWorkflowSlotList");
    if (!panel || !list) return;
    if (!slots.length) {
      panel.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    panel.classList.remove("hidden");
    list.innerHTML = "";
    slots.forEach((slot) => {
      const row = document.createElement("div");
      row.className = "workflow-slot-row";
      const label = document.createElement("label");
      label.className = "field-label muted";
      label.textContent = slot.label || slot.bind || slot.id;
      row.appendChild(label);
      const input = document.createElement("input");
      input.type = "file";
      input.accept = storyboardAcceptForKind(slot.kind);
      input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        if (f) onStoryboardSlotFile(slot.bind || slot.id, slot.kind, f);
      });
      row.appendChild(input);
      const prev = storyboardMediaByBind[slot.bind || slot.id];
      const hint = document.createElement("span");
      hint.className = "muted workflow-slot-preview";
      hint.textContent = prev
        ? prev.fileName || prev.rhFileName || t("bins.notSelected")
        : t("bins.notSelected");
      row.appendChild(hint);
      list.appendChild(row);
    });
  }

  function syncStoryboardDynamicUi() {
    const host = document.getElementById("workflowParamFields");
    const isEdit = !!(selectedClip && selectedClip.kind === "edit");
    const clip = selectedStoryboardClip();
    const mode =
      selectedClip && selectedClip.kind === "bridge" ? "flf" : "i2v";
    if (isEdit || !clip) {
      renderStoryboardMediaSlots([]);
      if (host) {
        const Modal = window.VflowEditorInputModal;
        if (Modal && typeof Modal.unmount === "function") {
          // Only unmount if we mounted storyboard params here
          if (host.dataset.storyboardMounted === "1") {
            Modal.unmount();
            host.dataset.storyboardMounted = "";
          }
        }
        host.innerHTML = "";
        host.classList.add("hidden");
      }
      return;
    }
    const modeCfg = peekStoryboardModeCfg(mode);
    renderStoryboardMediaSlots(extraStoryboardMediaSlots(modeCfg, mode));
    const params = extraStoryboardParamSlots(modeCfg);
    if (!host) return;
    if (!params.length) {
      host.innerHTML = "";
      host.classList.add("hidden");
      host.dataset.storyboardMounted = "";
      return;
    }
    const Modal = window.VflowEditorInputModal;
    if (!Modal || typeof Modal.mount !== "function") {
      host.classList.add("hidden");
      return;
    }
    host.classList.remove("hidden");
    if (!clip.workflowParams || typeof clip.workflowParams !== "object") {
      clip.workflowParams = {};
    }
    Modal.mount(host, {
      id: `storyboard-${mode}`,
      name: "",
      needsPrompt: false,
      needsAudio: false,
      params,
      adapter: { bindings: (modeCfg && modeCfg.bindings) || {} },
    }, {
      initialValues: clip.workflowParams,
      mountKey: `sb-${mode}-${clip.id}`,
      preferLastInputs: false,
      onChange: (values) => {
        const cur = selectedStoryboardClip();
        if (!cur || cur.id !== clip.id) return;
        cur.workflowParams =
          values && values.paramValues && typeof values.paramValues === "object"
            ? { ...values.paramValues }
            : {};
        cur.dirty = true;
        scheduleSaveDraft();
      },
    });
    host.dataset.storyboardMounted = "1";
  }

  async function uploadStoryboardRefFile(file, kind) {
    if (!file) return;
    const eng = getStoryboardEngine();
    const k =
      kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
    if (k === "image") {
      const nImg = storyboardRefAssets.filter((a) => a && a.kind === "image").length;
      // Slot 0 = shared start (Picture 1); list refs are Picture 2.. (maxRefImages - 1)
      const maxImg = Math.max(0, (eng.maxRefImages || 5) - 1);
      if (nImg >= maxImg) {
        if (llmStatus) {
          llmStatus.textContent = t("storyboard.refImageLimit", { max: maxImg });
        }
        return;
      }
    } else if (k === "video") {
      const nVid = storyboardRefAssets.filter((a) => a && a.kind === "video").length;
      const maxVid = eng.maxRefVideos || 0;
      if (nVid >= maxVid) {
        if (llmStatus) {
          llmStatus.textContent = t("storyboard.refVideoLimit", { max: maxVid });
        }
        return;
      }
    } else if (k === "audio") {
      const nAud = storyboardRefAssets.filter((a) => a && a.kind === "audio").length;
      const maxAud = eng.maxRefAudios || 0;
      if (nAud >= maxAud) {
        if (llmStatus) {
          llmStatus.textContent = t("storyboard.refAudioLimit", { max: maxAud });
        }
        return;
      }
    }
    const id = `r${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const localUrl = URL.createObjectURL(file);
    const asset = {
      id,
      kind: k,
      rhFileName: null,
      playUrl: k === "audio" ? null : localUrl,
      mediaId: null,
      content: "",
      purpose: "",
      note: "",
      localFile: file,
    };
    storyboardRefAssets.push(asset);
    renderStoryboardRefList();
    try {
      if (typeof uploadImage === "function") {
        const uploaded = await uploadImage(file);
        if (uploaded) {
          asset.rhFileName = uploaded.fileName || uploaded.rhFileName || null;
          asset.mediaId = uploaded.mediaFileId || uploaded.id || null;
          if (uploaded.playUrl) asset.playUrl = uploaded.playUrl;
        }
      }
    } catch (e) {
      console.warn("ref upload", e);
      if (llmStatus) llmStatus.textContent = e.message || String(e);
    }
    scheduleSaveDraft();
    renderStoryboardRefList();
  }

  function migrateLsKey(newKey, oldKey) {
    try {
      let v = localStorage.getItem(newKey);
      if (v == null) {
        v = localStorage.getItem(oldKey);
        if (v != null) {
          localStorage.setItem(newKey, v);
          localStorage.removeItem(oldKey);
        }
      }
      return v;
    } catch (e) {
      return null;
    }
  }
  migrateLsKey(PROJECT_KEY, "wf-current-project-id");
  migrateLsKey(LLM_CFG_KEY, "wf-llm-config");
  migrateLsKey(LLM_CHANNEL_KEY, "wf-llm-channel");
  migrateLsKey(VIDEO_CHANNEL_KEY, "wf-video-channel-config");

  function t(key, vars) {
    if (window.VflowI18n && typeof window.VflowI18n.t === "function") {
      return window.VflowI18n.t(key, vars);
    }
    return key;
  }

  function currentLocale() {
    if (window.VflowI18n && typeof window.VflowI18n.getLocale === "function") {
      return window.VflowI18n.getLocale();
    }
    return "zh";
  }

  /** Translate known persisted zh/en labels (and task.* keys) to the current locale. */
  function localizeStoredLabel(text) {
    const raw = text == null ? "" : String(text);
    if (!raw) return raw;
    const paramKey = raw.match(/^([a-z]+(?:\.[a-z0-9_]+)+):(.+)$/i);
    if (paramKey) {
      const key = paramKey[1];
      const arg = paramKey[2];
      if (key === "task.timeout") return t(key, { seconds: arg });
      if (key === "task.bad_status") return t(key, { status: arg });
      if (key === "task.create_failed") return t(key, { error: arg });
      const translated = t(key);
      if (translated !== key) return `${translated}: ${arg}`;
    }
    if (/^[a-z]+(?:\.[a-z0-9_]+)+$/i.test(raw)) {
      const translated = t(raw);
      if (translated !== raw) return translated;
    }
    const ALIASES = {
      "待生成": "status.pendingGen",
      Pending: "status.pendingGen",
      "提示词已改": "status.promptChanged",
      "Prompt changed": "status.promptChanged",
      "帧已更新·可重抽": "status.frameUpdated",
      "Frames updated · rerun": "status.frameUpdated",
      "需重生成": "status.needsRegen",
      "Needs regen": "status.needsRegen",
      "等待提交": "status.pending",
      "Waiting to submit": "status.pending",
      "远端排队": "status.queued",
      "Queued remotely": "status.queued",
      "运行中": "status.running",
      Running: "status.running",
      "成功": "status.success",
      Success: "status.success",
      "失败": "status.failed",
      Failed: "status.failed",
      "已取消": "status.canceled",
      Canceled: "status.canceled",
      "未知": "status.unknown",
      Unknown: "status.unknown",
      "衔接已变化·未生成": "timeline.staleChip",
      "建议重选帧": "timeline.suggestReselect",
      "已节选": "bins.flfClipped",
      "待节选": "bridge.waitingClip",
      "手动上传": "bins.flfMetaManualUpload",
      "前后无相邻槽": "bins.flfMetaNoNeighbor",
      "结果已删除·需重生成": "asset.resultDeleted",
      "共用首帧": "asset.sharedStart",
      "主段结果": "asset.mainResult",
      "桥段结果": "asset.bridgeResult",
      "桥段首帧": "asset.bridgeStart",
      "桥段尾帧": "asset.bridgeEnd",
      "已提交": "task.submitted",
      "排队中": "status.queuing",
      "黑屏": "preview.blackFrame",
      "（黑屏）": "preview.blackFrameParen",
    };
    const key = ALIASES[raw];
    if (key) return t(key);
    return raw;
  }

  const loginGate = document.getElementById("loginGate");
  const editorShell = document.getElementById("editorShell");
  const loginForm = document.getElementById("loginForm");
  const loginCard = document.querySelector(".login-card");
  const loginUsername = document.getElementById("loginUsername");
  const loginPassword = document.getElementById("loginPassword");
  const loginPasswordConfirm = document.getElementById("loginPasswordConfirm");
  const registerOnlyFields = document.getElementById("registerOnlyFields");
  const btnLogin = document.getElementById("btnLogin");
  const btnRegister = document.getElementById("btnRegister");
  const loginError = document.getElementById("loginError");
  const authSubtitle = document.getElementById("authSubtitle");
  const authModeSwitch = document.getElementById("authModeSwitch");
  const authModeLoginHint = document.getElementById("authModeLoginHint");
  const authModeRegisterHint = document.getElementById("authModeRegisterHint");
  const btnShowLogin = document.getElementById("btnShowLogin");
  const btnShowRegister = document.getElementById("btnShowRegister");
  const btnLogout = document.getElementById("btnLogout");
  const btnOpenSettings = document.getElementById("btnOpenSettings");
  const btnOpenAdmin = document.getElementById("btnOpenAdmin");
  const settingsModal = document.getElementById("settingsModal");
  const channelSummaryEl = document.getElementById("channelSummary");
  const userBadge = document.getElementById("userBadge");
  const btnNewProject = document.getElementById("btnNewProject");
  const assetLibraryList = document.getElementById("assetLibraryList");
  const assetLibraryEmpty = document.getElementById("assetLibraryEmpty");
  const assetUsageBar = document.getElementById("assetUsageBar");
  const assetUsageFill = document.getElementById("assetUsageFill");
  const assetUsageText = document.getElementById("assetUsageText");
  const assetUsageHint = document.getElementById("assetUsageHint");
  const assetOriginTabs = document.getElementById("assetOriginTabs");
  const btnImportAssets = document.getElementById("btnImportAssets");
  const importAssetsInput = document.getElementById("importAssetsInput");
  const btnVideoThumbPreview = document.getElementById("btnVideoThumbPreview");
  const assetLocalHint = document.getElementById("assetLocalHint");
  const assetFolderNav = document.getElementById("assetFolderNav");
  const assetFolderUpPrefix = document.getElementById("assetFolderUpPrefix");
  const assetFolderLabel = document.getElementById("assetFolderLabel");
  const btnAssetFolderUp = document.getElementById("btnAssetFolderUp");
  const assetBrowseBar = document.getElementById("assetBrowseBar");
  const assetBrowseHint = document.getElementById("assetBrowseHint");
  const btnApplyAsset = document.getElementById("btnApplyAsset");
  const btnSetSharedFromBrowse = document.getElementById("btnSetSharedFromBrowse");
  const firstFrameGenBar = document.getElementById("firstFrameGenBar");
  const firstFramePrompt = document.getElementById("firstFramePrompt");
  const firstFrameSizeHint = document.getElementById("firstFrameSizeHint");
  const firstFrameGenStatus = document.getElementById("firstFrameGenStatus");
  const btnGenerateFirstFrame = document.getElementById("btnGenerateFirstFrame");
  const btnExpandFirstFramePrompt = document.getElementById(
    "btnExpandFirstFramePrompt"
  );
  const btnGoFirstFrameGen = document.getElementById("btnGoFirstFrameGen");
  const assetLibrarySection = document.getElementById("assetLibrarySection");
  const assetFramePickHint = document.getElementById("assetFramePickHint");
  const btnPickSharedFromLibrary = document.getElementById(
    "btnPickSharedFromLibrary"
  );
  const btnFlfLibStart = document.getElementById("btnFlfLibStart");
  const btnFlfLibEnd = document.getElementById("btnFlfLibEnd");

  const imageInput = document.getElementById("imageInput");
  const imageName = document.getElementById("imageName");
  const imagePreview = document.getElementById("imagePreview");
  const imagePreviewWrap = document.getElementById("imagePreviewWrap");
  const dropZone = document.getElementById("dropZone");
  const negativeInput = document.getElementById("negativeInput");
  const promptListEl = document.getElementById("promptList");
  const promptEmptyHint = document.getElementById("promptEmptyHint");
  const jobListEl = document.getElementById("jobList");
  const timelineBody = document.getElementById("timelineBody");
  const timelineLabels = document.getElementById("timelineLabels");
  const timelineScroll = document.getElementById("timelineScroll");
  const timelineCanvas = document.getElementById("timelineCanvas");
  const timelineRuler = document.getElementById("timelineRuler");
  const timelineTracks = document.getElementById("timelineTracks");
  const timelinePlayhead = document.getElementById("timelinePlayhead");
  const tlZoomLabel = document.getElementById("tlZoomLabel");
  const tlPlayheadTime = document.getElementById("tlPlayheadTime");
  const btnTlZoomIn = document.getElementById("btnTlZoomIn");
  const btnTlZoomOut = document.getElementById("btnTlZoomOut");
  const btnTlFit = document.getElementById("btnTlFit");
  const btnTlAddVideoTrack = document.getElementById("btnTlAddVideoTrack");
  const btnTlAddAudioTrack = document.getElementById("btnTlAddAudioTrack");
  const concurrencyEl = document.getElementById("concurrency");

  function normalizeConcurrency(value) {
    return String(value) === "2" ? "2" : "1";
  }

  function readConcurrencyPref() {
    try {
      const stored = localStorage.getItem(CONCURRENCY_KEY);
      if (stored === "1" || stored === "2") return stored;
    } catch (_) {}
    return normalizeConcurrency(concurrencyEl && concurrencyEl.value);
  }

  function persistConcurrencyPref(value) {
    const v = normalizeConcurrency(value);
    try {
      localStorage.setItem(CONCURRENCY_KEY, v);
    } catch (_) {}
    if (concurrencyEl) concurrencyEl.value = v;
    return v;
  }

  try {
    const stored = localStorage.getItem(CONCURRENCY_KEY);
    if (stored === "1" || stored === "2") persistConcurrencyPref(stored);
  } catch (_) {}
  const globalStatus = document.getElementById("globalStatus");
  const draftStatus = document.getElementById("draftStatus");
  const btnStart = document.getElementById("btnStart");
  const btnStartBridges = document.getElementById("btnStartBridges");
  const btnStop = document.getElementById("btnStop");
  const btnAddPrompt = document.getElementById("btnAddPrompt");
  const btnImport = document.getElementById("btnImport");
  const importBox = document.getElementById("importBox");
  const jobsDropdown = document.getElementById("jobsDropdown");
  const jobsDropdownPanel = document.getElementById("jobsDropdownPanel");
  const btnJobsToggle = document.getElementById("btnJobsToggle");
  const jobsBadge = document.getElementById("jobsBadge");
  const jobsListEl = document.getElementById("jobsList");
  const jobsEmpty = document.getElementById("jobsEmpty");
  const jobsPanelHint = document.getElementById("jobsPanelHint");
  const btnJobsRefresh = document.getElementById("btnJobsRefresh");
  const btnJobsStopWaiting = document.getElementById("btnJobsStopWaiting");
  const btnJobsClearFinished = document.getElementById("btnJobsClearFinished");
  const btnJobsForceAll = document.getElementById("btnJobsForceAll");
  const importActions = document.getElementById("importActions");
  const btnConfirmImport = document.getElementById("btnConfirmImport");
  const btnCancelImport = document.getElementById("btnCancelImport");
  const sceneDescriptionEl = document.getElementById("sceneDescription");
  const plotDirectionEl = document.getElementById("plotDirection");
  const segmentCountEl = document.getElementById("segmentCount");
  const storyboardTargetDurationEl = document.getElementById(
    "storyboardTargetDuration"
  );
  const storyboardMainDurationEl = document.getElementById(
    "storyboardMainDuration"
  );
  const llmPickCountEl = document.getElementById("llmPickCount");
  const llmAutoBridgeEl = document.getElementById("llmAutoBridge");
  const btnLlmGenerate = document.getElementById("btnLlmGenerate");
  const btnRegenBridges = document.getElementById("btnRegenBridges");
  const llmStatus = document.getElementById("llmStatus");
  const llmHint = document.getElementById("llmHint");
  const storyboardSynopsisEl = document.getElementById("storyboardSynopsis");
  const storyboardPolishInputEl = document.getElementById("storyboardPolishInput");
  const btnStoryboardPolish = document.getElementById("btnStoryboardPolish");
  const btnStoryboardApplyPatch = document.getElementById("btnStoryboardApplyPatch");
  const storyboardPolishStatusEl = document.getElementById("storyboardPolishStatus");
  const storyboardPolishDiffEl = document.getElementById("storyboardPolishDiff");
  const storyboardPolishScopeEl = document.getElementById("storyboardPolishScope");
  const LLM_LAYOUT_HINT =
    t("storyboard.layoutHint");
  const llmActiveSelectEl = document.getElementById("llmActiveSelect");
  const llmProvidersListEl = document.getElementById("llmProvidersList");
  const llmAddProviderFormEl = document.getElementById("llmAddProviderForm");
  const llmNewProviderNameEl = document.getElementById("llmNewProviderName");
  const llmNewProviderUrlEl = document.getElementById("llmNewProviderUrl");
  const llmNewProviderKeyEl = document.getElementById("llmNewProviderKey");
  const llmNewProviderModelEl = document.getElementById("llmNewProviderModel");
  const btnLlmAddProvider = document.getElementById("btnLlmAddProvider");
  const btnLlmSaveProvider = document.getElementById("btnLlmSaveProvider");
  const btnLlmCancelProvider = document.getElementById("btnLlmCancelProvider");
  const storyboardLlmModelEl = document.getElementById("storyboardLlmModel");
  const scriptLlmModelEl = document.getElementById("scriptLlmModel");
  const scriptTitleEl = document.getElementById("scriptTitle");
  const scriptSceneBibleEl = document.getElementById("scriptSceneBible");
  const scriptPlotDirectionEl = document.getElementById("scriptPlotDirection");
  const scriptEpisodeCountEl = document.getElementById("scriptEpisodeCount");
  const scriptLlmPickCountEl = document.getElementById("scriptLlmPickCount");
  const scriptSeriesCountRow = document.getElementById("scriptSeriesCountRow");
  const scriptLibraryList = document.getElementById("scriptLibraryList");
  const scriptLibraryEmpty = document.getElementById("scriptLibraryEmpty");
  const scriptEpisodeNav = document.getElementById("scriptEpisodeNav");
  const scriptEpisodeTitleEl = document.getElementById("scriptEpisodeTitle");
  const scriptEpisodeBodyEl = document.getElementById("scriptEpisodeBody");
  const scriptEpisodeBeatsEl = document.getElementById("scriptEpisodeBeats");
  const scriptLlmStatus = document.getElementById("scriptLlmStatus");
  const scriptPolishInputEl = document.getElementById("scriptPolishInput");
  const scriptPolishStatusEl = document.getElementById("scriptPolishStatus");
  const scriptPolishDiffEl = document.getElementById("scriptPolishDiff");
  const btnScriptApplyPatch = document.getElementById("btnScriptApplyPatch");
  const storyboardBoundHint = document.getElementById("storyboardBoundHint");
  const storyboardStepScriptEl = document.getElementById("storyboardStepScript");
  const storyboardStepPromptsEl = document.getElementById("storyboardStepPrompts");
  let llmEditingProviderId = "";
  const duckPasswordEl = document.getElementById("duckPassword");
  const useDuckEncryptEl = document.getElementById("useDuckEncrypt");
  const duckPasswordRow = document.getElementById("duckPasswordRow");
  const playlistPanel = document.getElementById("playlistPanel");
  const playlistVideoA = document.getElementById("playlistVideo");
  const playlistVideoB = document.getElementById("playlistVideoB");
  let playlistVideo = playlistVideoA;
  const playlistImage = document.getElementById("playlistImage");
  const playlistMeta = document.getElementById("playlistMeta");
  const playlistPrompt = document.getElementById("playlistPrompt");
  const previewEmpty = document.getElementById("previewEmpty");
  const mediaBridgeList = document.getElementById("mediaBridgeList");
  const mediaBridgeEmpty = document.getElementById("mediaBridgeEmpty");
  const mediaMainEmpty = document.getElementById("mediaMainEmpty");
  const btnPlaylistPlay = document.getElementById("btnPlaylistPlay");
  const btnPlaylistPrev = document.getElementById("btnPlaylistPrev");
  const btnPlaylistNext = document.getElementById("btnPlaylistNext");
  const btnExportVideo = document.getElementById("btnExportVideo");
  const chkComposePlay = document.getElementById("chkComposePlay");
  const presetListEl = document.getElementById("presetList");
  const presetEmpty = document.getElementById("presetEmpty");
  const btnSavePreset = document.getElementById("btnSavePreset");
  const startCompact = document.getElementById("startCompact");
  const startCompactThumb = document.getElementById("startCompactThumb");
  const startCompactName = document.getElementById("startCompactName");
  const btnReplaceStart = document.getElementById("btnReplaceStart");
  const clipMetaTitle = document.getElementById("clipMetaTitle");
  const clipMetaBadge = document.getElementById("clipMetaBadge");
  const clipMetaHint = document.getElementById("clipMetaHint");
  const clipMetaSeed = document.getElementById("clipMetaSeed");
  const selectedPromptEl = document.getElementById("selectedPrompt");
  const selectionPromptWrap = document.getElementById("selectionPromptWrap");
  const editorSlotPanel = document.getElementById("editorSlotPanel");
  const editorSlotTitle = document.getElementById("editorSlotTitle");
  const editorSlotDesc = document.getElementById("editorSlotDesc");
  const editorSlotFields = document.getElementById("editorSlotFields");
  const selectionActions = document.getElementById("selectionActions");
  const inspectorEngineWrap = document.getElementById("inspectorEngineWrap");
  const inspectorEngineEl = document.getElementById("inspectorEngine");
  const vflowWidthEl = document.getElementById("vflowWidth");
  const vflowHeightEl = document.getElementById("vflowHeight");
  const vflowLengthEl = document.getElementById("vflowLength");
  const vflowDurationSecEl = document.getElementById("vflowDurationSec");
  const vflowLengthField = document.getElementById("vflowLengthField");
  const vflowDurationField = document.getElementById("vflowDurationField");
  const vflowLengthPresets = document.getElementById("vflowLengthPresets");
  const vflowDurationPresets = document.getElementById("vflowDurationPresets");
  const vflowParamsHint = document.getElementById("vflowParamsHint");
  const vflowFpsEl = document.getElementById("vflowFps");
  const vflowTimingGlobalEl = document.getElementById("vflowTimingGlobal");
  const btnOrientLandscape = document.getElementById("btnOrientLandscape");
  const btnOrientPortrait = document.getElementById("btnOrientPortrait");
  const btnWfReset = document.getElementById("btnWfReset");

  const editorInputModal = document.getElementById("editorInputModal");
  const framePickerModal = document.getElementById("framePickerModal");
  const framePickerTitle = document.getElementById("framePickerTitle");
  const framePickerHint = document.getElementById("framePickerHint");
  const pickerVideo = document.getElementById("pickerVideo");
  const pickerCanvas = document.getElementById("pickerCanvas");
  const pickerThumb = document.getElementById("pickerThumb");
  const pickerTime = document.getElementById("pickerTime");
  const btnCaptureFrame = document.getElementById("btnCaptureFrame");
  const btnPickerBack = document.getElementById("btnPickerBack");
  const btnPickerFwd = document.getElementById("btnPickerFwd");

  const imagePanel = document.getElementById("imagePanel");
  const editFramePanel = document.getElementById("editFramePanel");
  const editFramePanelTitle = document.getElementById("editFramePanelTitle");
  const editFramePreview = document.getElementById("editFramePreview");
  const editFrameMeta = document.getElementById("editFrameMeta");
  const flfFramePanel = document.getElementById("flfFramePanel");
  const flfFramePanelTitle = document.getElementById("flfFramePanelTitle");
  const flfStartPreview = document.getElementById("flfStartPreview");
  const flfEndPreview = document.getElementById("flfEndPreview");
  const flfStartMeta = document.getElementById("flfStartMeta");
  const flfEndMeta = document.getElementById("flfEndMeta");
  const btnFlfPickStart = document.getElementById("btnFlfPickStart");
  const btnFlfPickEnd = document.getElementById("btnFlfPickEnd");
  const flfStartUpload = document.getElementById("flfStartUpload");
  const flfEndUpload = document.getElementById("flfEndUpload");
  const flfStaleBanner = document.getElementById("flfStaleBanner");

  const storyboardModal = document.getElementById("storyboardModal");
  const btnOpenStoryboard = document.getElementById("btnOpenStoryboard");

  const presetDropdown = document.getElementById("presetDropdown");
  const btnPresetToggle = document.getElementById("btnPresetToggle");
  const presetDropdownPanel = document.getElementById("presetDropdownPanel");

  const defaultNegative = negativeInput.value;

  /** Workflow size defaults (from /api/config or hardcoded fallback) */
  let vflowDefaults = {
    length: 113,
    fps: 16,
    landscape: { width: 960, height: 544 },
    portrait: { width: 544, height: 960 },
  };
  let vflowOrient = "landscape";
  /** Suppress timing-input feedback while syncing inspector from selection. */
  let timingUiSyncing = false;
  /** Project-level frame count / fps (inspector may temporarily show per-clip overrides). */
  let projectTiming = { length: 113, fps: 16 };

  /** @type {File|null} */
  let selectedFile = null;
  let previewObjectUrl = null;
  /** @type {string|null} cached RH upload name for shared start */
  let sharedStartRhName = null;
  /** @type {string|null} */
  let sharedStartPlayUrl = null;
  /** @type {number|null} */
  let sharedStartMediaId = null;
  let batchRunning = false;
  let suppressSave = false;
  let saveTimer = null;
  let jobPollTimer = null;
  /** @type {Array<object>} */
  let userJobsCache = [];
  /** Client-side jobs for local/custom editors (not tracked by /api/jobs). */
  let localJobsCache = [];
  let localDrainActive = false;
  let localDrainWakeResolve = null;
  const LOCAL_POLL_MS = 2500;
  let jobsPanelMeta = {
    staleSeconds: 2700,
    perUserMaxRunning: 2,
    globalMaxRunning: 2,
    pendingCount: 0,
    runningCount: 0,
  };
  /** @type {{id:number, username:string, isAdmin?:boolean}|null} */
  let currentUser = null;
  /** @type {number|null} */
  let currentProjectId = null;
  let currentProjectName = t("project.defaultName");
  let storyboardState = {
    scriptSynopsis: "",
    totalDurationSec: 30,
    shots: [],
    bridges: [],
    lastPolishSummary: "",
    engineProfile: "wan",
    useMultiRef: false,
    refAssets: [],
  };
  let storyboardPolishDraft = null;
  let storyboardPolishBusy = false;
  /** @type {'script'|'prompts'} */
  let storyboardStep = "script";
  /** @type {Array<any>} */
  let userScripts = [];
  let currentScript = null;
  let currentEpisodeId = "";
  let boundScriptAssetId = null;
  let boundEpisodeId = "";
  let scriptPolishDraft = null;
  let scriptDirty = false;
  /** @type {Array<{id:number,name:string,updatedAt?:string,updated_at?:string}>} */
  let projectList = [];
  /** @type {Array<{id:number, playUrl:string, promptSnapshot?:string, kind?:string, createdAt?:string, origin?:string, projectId?:number|null, filename?:string}>} */
  let assetLibrary = [];
  /** @type {'root'|{type:'project', projectId:number}|{type:'slot', projectId:number, kind:string, refId:string}|{type:'uncategorized'}} */
  let assetLibraryFolder = "root";
  /** When true, auto-enter-slot is suppressed until user selects a clip or opens a project. */
  let assetLibraryUserBrowsing = false;
  let assetLibrarySelectionKey = "";
  /** @type {'all'|'cloud'|'local'|'script'} */
  let assetLibraryOrigin = (() => {
    const v = localStorage.getItem(ASSET_ORIGIN_KEY) || "local";
    return v === "script" ? "script" : "local";
  })();
  /** When true, video thumbs in「我的素材」show first frame; when false, blur. Default on. */
  let assetVideoThumbPreview = (() => {
    const v = localStorage.getItem(ASSET_VIDEO_THUMB_KEY);
    return v !== "0";
  })();
  let storageUsage = {
    bytes: 0,
    quota: 200 * 1024 * 1024,
    ratio: 0,
    warn: false,
    exceeded: false,
  };
  /** @type {number|string|null} */
  let browsingAssetId = null;
  /** Last T2I-generated asset shown in the first-frame generator. */
  let lastT2iAssetId = null;
  /**
   * Last UI-applied status per T2I job id. Prevents poll from re-running
   * success side effects (browseAsset) on every historical completed job.
   * @type {Map<string, string>}
   */
  const t2iJobUiStatus = new Map();
  /** Active first-frame gen job ref (stable so re-queue updates pending). */
  const FIRST_FRAME_JOB_REF = "first_frame_gen";
  let firstFrameGenBusy = false;
  let firstFrameExpandBusy = false;

  /**
   * @typedef {{
   *   id: string,
   *   kind: 'video'|'audio',
   *   name: string,
   *   hidden: boolean,
   *   muteAudio?: boolean,
   *   role?: string|null,
   * }} Track
   */

  /**
   * @typedef {{
   *   id: string,
   *   title?: string,
   *   beat?: string,
   *   camera?: string,
   *   cutToNext?: 'hard'|'soft',
   *   prompt: string,
   *   status: string,
   *   label: string,
   *   meta: string,
   *   playUrl: string|null,
   *   results: object[],
   *   seedHigh: string|null,
   *   seedLow: string|null,
   *   dirty: boolean,
   *   taskId: string|null,
   *   mediaFileId: number|null,
   *   trackId: string|null,
   *   startSec: number,
   *   inSec: number,
   *   outSec: number|null,
   *   durationSec: number|null,
   *   useGlobalTiming: boolean,
   *   length: number|null,
   *   fps: number|null,
   *   engineProfile?: 'wan'|'minimax'|null,
   *   muteAudio?: boolean,
   * }} MainSeg
   */

  /**
   * @typedef {{
   *   blobUrl: string|null,
   *   playUrl: string|null,
   *   mediaFileId: number|null,
   *   rhFileName: string|null,
   *   sourceMainId: string|null,
   *   timeSec: number|null,
   *   source: 'auto'|'manual'|null,
   *   previewUrl: string|null,
   *   linkSig: string|null,
   * }} FrameRef
   */

  /**
   * @typedef {{
   *   clipKind: 'main'|'bridge',
   *   clipId: string,
   *   srcTimeSec: number,
   *   playUrl: string,
   * }} BridgeLink
   */

  /**
   * @typedef {{
   *   id: string,
   *   afterShot?: string|null,
   *   needBridge?: boolean,
   *   leftMainId: string|null,
   *   rightMainId: string|null,
   *   prompt: string,
   *   startFrame: FrameRef|null,
   *   endFrame: FrameRef|null,
   *   status: string,
   *   label: string,
   *   meta: string,
   *   playUrl: string|null,
   *   results: object[],
   *   seedHigh: string|null,
   *   seedLow: string|null,
   *   dirty: boolean,
   *   needsReselect: boolean,
   *   connectionStale: boolean,
   *   linkedSig: { start: string, end: string },
   *   startLink: BridgeLink|null,
   *   endLink: BridgeLink|null,
   *   taskId: string|null,
   *   mediaFileId: number|null,
   *   trackId: string|null,
   *   startSec: number,
   *   inSec: number,
   *   outSec: number|null,
   *   durationSec: number|null,
   *   useGlobalTiming: boolean,
   *   length: number|null,
   *   fps: number|null,
   *   engineProfile?: 'wan'|'minimax'|null,
   *   muteAudio?: boolean,
   * }} BridgeSeg
   */

  /**
   * @typedef {{
   *   kind: 'frame'|'range'|'clip',
   *   inSec: number,
   *   outSec: number,
   *   sourceClip?: { kind: string, id: string },
   * }} TimelineSelection
   */

  /**
   * Editor video slot: clips produced by platform/user editors (edit track).
   * @typedef {{
   *   id: string,
   *   clipKind: 'edit',
   *   editorId: string,
   *   editorSource: 'platform'|'user',
   *   editorName: string,
   *   sourceSelection: TimelineSelection|null,
   *   prompt: string,
   *   editorParams: Object.<string, *>,
   *   status: string,
   *   label: string,
   *   meta: string,
   *   playUrl: string|null,
   *   results: object[],
   *   seedHigh: string|null,
   *   seedLow: string|null,
   *   dirty: boolean,
   *   taskId: string|null,
   *   mediaFileId: number|null,
   *   trackId: string|null,
   *   startSec: number,
   *   inSec: number,
   *   outSec: number|null,
   *   durationSec: number|null,
   *   useGlobalTiming: boolean,
   *   length: number|null,
   *   fps: number|null,
   *   muteAudio?: boolean,
   * }} EditSeg
   */

  /**
   * @typedef {{
   *   id: string,
   *   trackId: string|null,
   *   startSec: number,
   *   inSec: number,
   *   outSec: number|null,
   *   durationSec: number|null,
   *   playUrl: string|null,
   *   mediaFileId: number|null,
   *   status: string,
   *   label: string,
   *   name?: string,
   *   volume?: number,
   *   linkedFrom?: { kind: 'main'|'bridge'|'edit', id: string }|null,
   * }} AudioSeg
   */

  /** @type {MainSeg[]} */
  let mains = [];
  /** @type {BridgeSeg[]} */
  let bridges = [];
  /** @type {EditSeg[]} */
  let edits = [];
  /** @type {AudioSeg[]} */
  let audios = [];
  /** @type {Track[]} tracks[0]=bottom(lowest priority), last=top(highest) */
  let tracks = [];
  /** @type {TimelineSelection|null} */
  let timelineSelection = null;
  /** @type {{ dragging: boolean, startSec: number, endSec: number }|null} */
  let rangeDragState = null;
  /** Cached platform editors from /api/editors */
  let platformEditorsCache = [];
  let platformEditorsLoaded = false;

  /** Flattened topmost-wins playback schedule */
  let schedule = [];
  let scheduleIndex = -1;
  /**
   * Snapshot (by value) of the segment currently driving #playlistVideo.
   * Playback reads this instead of schedule[scheduleIndex] so that any
   * schedule rebuild (zoom re-render, duration probe, edits) mid-playback
   * cannot corrupt the in-flight segment or drop lower-layer fallback.
   * @type {{ kind:string, sourceId:string|null, gStart:number, gEnd:number, srcIn:number, playUrl:string|null, prompt:string }|null}
   */
  let activeSegment = null;
  let playheadSec = 0;
  let pxPerSec = 40;
  const PX_PER_SEC_MIN = 8;
  const PX_PER_SEC_MAX = 160;
  let timelinePlaying = false;
  /**
   * When false (default), transport plays the selected slot only.
   * When true (「全局（图层）」), playback uses topmost-wins layer schedule.
   */
  function isComposePlayMode() {
    return !!(chkComposePlay && chkComposePlay.checked);
  }
  /** @type {number|null} */
  let playbackRaf = null;
  /**
   * Active timeline export session (browser MediaRecorder).
   * @type {{ abort: AbortController, meta: string }|null}
   */
  let exportState = null;
  /** Bumped on every seek/load so stale loadedmetadata handlers are ignored. */
  let playbackGen = 0;
  /** Last URL loaded into the active preview video (relative playUrl), for source reuse. */
  let previewLoadedUrl = null;
  const PREVIEW_PRELOAD_LEAD_SEC = 0.8;
  const PREVIEW_SEAMLESS_SEEK_EPS = 0.08;
  /** @type {HTMLVideoElement|null} */
  let previewStandbyEl = null;
  /** @type {{ playUrl: string, srcIn: number, kind: string, sourceId: string|null, gStart: number, gEnd: number, prompt: string, scheduleIdx?: number }|null} */
  let previewStandbySeg = null;
  let previewStandbyReady = false;
  let previewStandbyGen = 0;
  let playbackDeferredUi = false;
  /** @type {{ kind: string, id: string, el: HTMLElement, originStart: number, originTrackId: string, pointerId: number, grabOffsetX: number, moved: boolean }|null} */
  let dragState = null;
  /** @type {{ kind: string, id: string, el: HTMLElement, edge: 'left'|'right', originStart: number, originIn: number, originOut: number, originDur: number, mediaDur: number|null, pointerId: number, moved: boolean, _pendingStart?: number, _pendingIn?: number, _pendingOut?: number }|null} */
  let trimState = null;
  /** In-app clipboard for timeline slots (not system clipboard). */
  /** @type {{ kind: 'main'|'bridge'|'edit'|'audio', payload: object }|null} */
  let clipClipboard = null;
  const MIN_CLIP_TRIM_SEC = 0.05;
  const TIMELINE_UNDO_MAX = 40;
  /** @type {{ tracks: object[], mains: object[], bridges: object[], edits: object[], audios: object[], selectedClip: {kind:string,id:string}|null }[]} */
  let timelineUndoStack = [];
  /** @type {{ tracks: object[], mains: object[], bridges: object[], edits: object[], audios: object[], selectedClip: {kind:string,id:string}|null }[]} */
  let timelineRedoStack = [];
  /** @type {HTMLElement|null} */
  let clipCtxMenuEl = null;
  /** @type {((ev: Event) => void)|null} */
  let clipCtxMenuCloser = null;
  /** @type {{ kind: string, id: string, x: number, y: number, pointerId: number }|null} */
  let longPressState = null;
  let longPressTimer = null;
  let suppressClipClickUntil = 0;
  /** @type {WeakMap<object, Promise<number|null>>} */
  const durationProbeCache = new WeakMap();

  /** @type {{ kind: 'main'|'bridge', id: string }|null} */
  let selectedClip = null;
  /** @type {'shared'|{bridgeId:string,side:'start'|'end'}|null} */
  let frameAssetPickTarget = null;
  /** User-selected inspector phase (1|2|3) */
  let activePhase = 1;
  let llmConfigured = false;
  let serverLlmConfigured = false;
  let platformRhAvailable = false;
  let allowSelfRegister = true;
  let llmGenerating = false;
  let llmBaseUrlDefault = LLM_DEFAULT_BASE_URL;
  let llmModelDefault = LLM_DEFAULT_MODEL;
  /** @type {'platform'|'custom'} */
  let llmChannel = "custom";
  /** @type {'platform'|'custom_rh'|'comfyui'} */
  let videoChannel = "custom_rh";
  /** @type {{ id: string, name: string }[]} */
  let llmFreeModels = [];
  /** @type {Array<object>} */
  let localAssetLibrary = [];
  /** Last uploaded workflow JSON per mode for adapter generation */
  const pendingRhWorkflowByMode = { i2v: null, flf: null };
  const pendingComfyWorkflowByMode = { i2v: null, flf: null };
  const pendingRhParamsByMode = { i2v: [], flf: [] };
  const pendingComfyParamsByMode = { i2v: [], flf: [] };
  let pendingEditorParams = [];
  let pendingEditorBindings = {};

  /** @type {{ bridgeId: string, side: 'start'|'end', mainId: string }|null} */
  let pickerContext = null;

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function emptyTrack(kind = "video", name) {
    const n = tracks.filter((t) => t.kind === kind).length + 1;
    return {
      id: uid(kind === "audio" ? "atr" : "vtr"),
      kind,
      name: name || (kind === "audio" ? t("timeline.trackAudio", { n }) : t("timeline.trackVideo", { n })),
      hidden: false,
      muteAudio: false,
    };
  }

  function audioTrackCount() {
    return tracks.filter((t) => t.kind === "audio").length;
  }

  function videoTrackCount() {
    return tracks.filter((t) => t.kind === "video").length;
  }

  function defaultAudioTrackId() {
    const audio = tracks.find((tr) => tr.kind === "audio");
    return audio ? audio.id : null;
  }

  function addAudioTrack() {
    const tr = emptyTrack("audio");
    tracks.push(tr);
    renderTimelineTrack();
    scheduleSaveDraft();
    return tr;
  }

  function ensureAudioTrack() {
    const existing = tracks.find((tr) => tr.kind === "audio");
    if (existing) return existing.id;
    return addAudioTrack().id;
  }

  function removeAudioTrack(trackId) {
    const track = tracks.find((x) => x.id === trackId);
    if (!track || track.kind !== "audio") return;
    const clipCount = audios.filter((a) => a.trackId === trackId).length;
    const msg =
      clipCount > 0
        ? t("timeline.confirmDeleteTrackClips", {
            name: track.name,
            count: clipCount,
          })
        : t("timeline.confirmDeleteTrack", { name: track.name });
    if (!confirm(msg)) return;
    audios = audios.filter((a) => a.trackId !== trackId);
    if (
      selectedClip &&
      selectedClip.kind === "audio" &&
      !findClip("audio", selectedClip.id)
    ) {
      selectedClip = null;
    }
    tracks = tracks.filter((x) => x.id !== trackId);
    stopTimelinePlayback();
    renderAll();
    scheduleSaveDraft();
  }

  function toggleTrackHidden(trackId) {
    const tr = tracks.find((x) => x.id === trackId);
    if (!tr) return;
    if (tr.kind === "video" || tr.kind === "audio") {
      tr.hidden = !tr.hidden;
      rebuildTimeline();
      scheduleSaveDraft();
    }
  }

  function toggleTrackMuteAudio(trackId) {
    const tr = tracks.find((x) => x.id === trackId);
    if (!tr || tr.kind !== "video") return;
    tr.muteAudio = !tr.muteAudio;
    rebuildTimeline();
    scheduleSaveDraft();
  }

  function clipTrackKind(clipKind) {
    return clipKind === "audio" ? "audio" : "video";
  }

  function trackAllowsClipKind(track, clipKind) {
    if (!track) return false;
    if (clipKind === "audio") return track.kind === "audio";
    return track.kind === "video";
  }

  function emptyAudio(placement) {
    const trackId =
      (placement && placement.trackId) || ensureAudioTrack();
    const startSec =
      placement && placement.startSec != null
        ? Number(placement.startSec)
        : nextStartOnTrack(trackId);
    return {
      id: uid("a"),
      trackId,
      startSec,
      inSec: 0,
      outSec: null,
      durationSec: null,
      playUrl: null,
      mediaFileId: null,
      status: "pending",
      label: t("timeline.pendingGen"),
      name: "",
      volume: 1,
      linkedFrom: null,
    };
  }

  function findAudio(id) {
    return audios.find((a) => a.id === id) || null;
  }

  function removeAudioById(audioId) {
    const idx = audios.findIndex((a) => a.id === audioId);
    if (idx < 0) return;
    pushTimelineUndo("deleteAudio");
    audios.splice(idx, 1);
    if (selectedClip && selectedClip.kind === "audio" && selectedClip.id === audioId) {
      selectedClip = null;
    }
    renderAll();
    scheduleSaveDraft();
  }

  function audioLabel(a) {
    const idx = audios.indexOf(a);
    const name = (a && (a.name || a.label)) || "";
    return t("timeline.audioClipLabel", {
      n: idx >= 0 ? idx + 1 : "?",
      name: name || t("timeline.audioClipDefault"),
    });
  }

  function isAudioMediaUrl(url) {
    return /\.(mp3|wav|m4a|flac|ogg|aac)(\?|$)/i.test(String(url || ""));
  }

  function clipUsesAudioProbe(clip) {
    if (!clip) return false;
    if (findAudio(clip.id)) return true;
    return isAudioMediaUrl(clip.playUrl);
  }

  function videoClipHasAudibleEmbed(clip, trackId) {
    if (!clip || !clip.playUrl || clip.muteAudio) return false;
    const track = tracks.find((tr) => tr.id === trackId);
    if (!track || track.kind !== "video" || track.hidden || track.muteAudio) {
      return false;
    }
    return true;
  }

  /** @type {AudioContext|null} */
  let audioMixCtx = null;
  /** @type {GainNode|null} */
  let audioMixMaster = null;
  /** @type {Map<string, { el: HTMLMediaElement, gain: GainNode, connected: boolean }>} */
  const audioMixPool = new Map();
  /** @type {Array<{ playUrl: string, gStart: number, gEnd: number, srcIn: number, label: string, sourceKind: string, sourceId: string }>|null} */
  let audioScheduleCache = null;

  function ensureAudioMixContext() {
    if (audioMixCtx) return audioMixCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioMixCtx = new Ctx();
    audioMixMaster = audioMixCtx.createGain();
    audioMixMaster.gain.value = 1;
    audioMixMaster.connect(audioMixCtx.destination);
    return audioMixCtx;
  }

  function connectAudioElementToMix(el, url) {
    const ctx = ensureAudioMixContext();
    if (!ctx || !audioMixMaster) return null;
    let pool = audioMixPool.get(url);
    if (!pool) {
      pool = { el, gain: ctx.createGain(), connected: false };
      audioMixPool.set(url, pool);
    }
    if (!pool.connected) {
      try {
        const src = ctx.createMediaElementSource(el);
        src.connect(pool.gain);
        pool.gain.connect(audioMixMaster);
        pool.connected = true;
      } catch (e) {
        console.warn("audio mix connect failed", e);
      }
    }
    return pool;
  }

  function stopAudioMix() {
    audioScheduleCache = null;
    audioMixPool.forEach(({ el }) => {
      try {
        el.pause();
      } catch (_) {}
    });
  }

  function invalidateAudioScheduleCache() {
    audioScheduleCache = null;
  }

  function getAudioSchedule() {
    if (!audioScheduleCache) audioScheduleCache = buildAudioSchedule();
    return audioScheduleCache;
  }

  function ensureAudioPoolEntry(playUrl) {
    if (!playUrl) return null;
    let pool = audioMixPool.get(playUrl);
    if (pool) return pool;
    const el = document.createElement(
      isAudioMediaUrl(playUrl) ? "audio" : "video"
    );
    el.preload = "auto";
    el.muted = false;
    applyMediaCors(el, playUrl);
    el.src = playUrl;
    pool = connectAudioElementToMix(el, playUrl);
    if (!pool) return null;
    pool.el = el;
    return pool;
  }

  function warmUpcomingAudio(globalSec) {
    const segs = getAudioSchedule();
    const lead = PREVIEW_PRELOAD_LEAD_SEC + 1.5;
    for (const seg of segs) {
      if (seg.gEnd < globalSec - 0.05) continue;
      if (seg.gStart > globalSec + lead) continue;
      const pool = ensureAudioPoolEntry(seg.playUrl);
      if (!pool || !pool.el) continue;
      if (globalSec < seg.gStart) {
        const target = Math.max(0, seg.srcIn);
        if (Math.abs((pool.el.currentTime || 0) - target) > 0.12) {
          try {
            pool.el.currentTime = target;
          } catch (_) {}
        }
      }
    }
  }

  function warmAudioMixForPlayback(globalSec) {
    invalidateAudioScheduleCache();
    ensureAudioMixContext();
    warmUpcomingAudio(globalSec);
  }

  function buildAudioSchedule() {
    ensureDefaultTrack();
    /** @type {Array<{ playUrl: string, gStart: number, gEnd: number, srcIn: number, label: string, sourceKind: string, sourceId: string }>} */
    const segs = [];
    tracks.forEach((track) => {
      if (track.kind === "audio" && !track.hidden) {
        audios.forEach((a) => {
          if (a.trackId !== track.id || !a.playUrl) return;
          const dur = clipDuration(a);
          const start = Number(a.startSec) || 0;
          segs.push({
            playUrl: a.playUrl,
            gStart: start,
            gEnd: start + dur,
            srcIn: Number(a.inSec) || 0,
            label: audioLabel(a),
            sourceKind: "audio",
            sourceId: a.id,
          });
        });
      }
    });
    allPlacedClips().forEach((c) => {
      if (c.kind === "audio" || !c.playUrl) return;
      if (!videoClipHasAudibleEmbed(c.clip, c.trackId)) return;
      segs.push({
        playUrl: c.playUrl,
        gStart: c.start,
        gEnd: c.end,
        srcIn: c.inSec,
        label: c.label,
        sourceKind: c.kind,
        sourceId: c.id,
      });
    });
    segs.sort((a, b) => a.gStart - b.gStart);
    return segs;
  }

  function syncAudioMix(globalSec, playing) {
    const ctx = ensureAudioMixContext();
    if (!ctx || !audioMixMaster) return;
    if (playing && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const segs = getAudioSchedule();
    const activeUrls = new Set();
    for (const seg of segs) {
      if (globalSec < seg.gStart - 0.03 || globalSec >= seg.gEnd - 0.01) {
        continue;
      }
      activeUrls.add(seg.playUrl);
      const pool = ensureAudioPoolEntry(seg.playUrl);
      if (!pool) continue;
      const localT = seg.srcIn + (globalSec - seg.gStart);
      const { el } = pool;
      if (Math.abs((el.currentTime || 0) - localT) > 0.12) {
        try {
          el.currentTime = Math.max(0, localT);
        } catch (_) {}
      }
      if (playing) {
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    }
    audioMixPool.forEach((pool, url) => {
      if (!activeUrls.has(url) && pool.el && !pool.el.paused) {
        pool.el.pause();
      }
    });
  }

  function detachAudioFromClip(kind, id) {
    const clip = findClip(kind, id);
    if (!clip || !clip.playUrl) return false;
    if (kind === "audio") return false;
    pushTimelineUndo("detachAudio");
    const trackId = ensureAudioTrack();
    const dur = clipDuration(clip);
    const start = Number(clip.startSec) || 0;
    const audio = emptyAudio({
      trackId,
      startSec: start,
    });
    audio.playUrl = clip.playUrl;
    audio.mediaFileId = clip.mediaFileId || null;
    audio.inSec = Number(clip.inSec) || 0;
    audio.outSec = clip.outSec != null ? Number(clip.outSec) : null;
    audio.durationSec = dur;
    audio.status = "success";
    audio.label = t("timeline.detachedAudio");
    audio.linkedFrom = { kind, id };
    clip.muteAudio = true;
    audios.push(audio);
    selectedClip = { kind: "audio", id: audio.id };
    rebuildTimeline();
    scheduleSaveDraft();
    return true;
  }

  function toggleClipMuteAudio(kind, id) {
    const clip = findClip(kind, id);
    if (!clip || kind === "audio" || !clip.playUrl) return false;
    pushTimelineUndo("muteClip");
    clip.muteAudio = !clip.muteAudio;
    rebuildTimeline();
    scheduleSaveDraft();
    return true;
  }

  function removeVideoTrack(trackId) {
    const track = tracks.find((x) => x.id === trackId);
    if (!track || track.kind !== "video") return;
    if (videoTrackCount() <= 1) {
      alert(t("timeline.keepOneVideoTrack"));
      return;
    }
    const clipCount =
      mains.filter((m) => (m.trackId || layer1VideoTrackId()) === trackId)
        .length +
      bridges.filter((b) => (b.trackId || layer1VideoTrackId()) === trackId)
        .length;
    const msg =
      clipCount > 0
        ? t("timeline.confirmDeleteTrackClips", {
            name: track.name,
            count: clipCount,
          })
        : t("timeline.confirmDeleteTrack", { name: track.name });
    if (!confirm(msg)) return;
    clearClipsOnTracks(new Set([trackId]));
    if (
      selectedClip &&
      !findClip(selectedClip.kind, selectedClip.id)
    ) {
      selectedClip = null;
    }
    tracks = tracks.filter((x) => x.id !== trackId);
    ensureDefaultTrack();
    stopTimelinePlayback();
    renderAll();
    scheduleSaveDraft();
  }

  function ensureDefaultTrack() {
    if (!tracks.length) {
      tracks = [emptyTrack("video", t("timeline.videoTrackN", { n: 1 }))];
    }
    return tracks[0];
  }

  function defaultVideoTrackId() {
    ensureDefaultTrack();
    const video = tracks.find((t) => t.kind === "video");
    return (video || tracks[0]).id;
  }

  /** Bottom-most video track (层1). */
  function layer1VideoTrackId() {
    return defaultVideoTrackId();
  }

  /** Second video track id if present (层2), else null. */
  function layer2VideoTrackId() {
    const videoIdxs = [];
    tracks.forEach((t, i) => {
      if (t.kind === "video") videoIdxs.push(i);
    });
    if (videoIdxs.length < 2) return null;
    return tracks[videoIdxs[1]].id;
  }

  /** Ensure a video track above 层1; returns its id. */
  function ensureBridgeTrack() {
    ensureDefaultTrack();
    const existing = layer2VideoTrackId();
    if (existing) return existing;
    const track = emptyTrack("video", t("timeline.videoTrackN", { n: 2 }));
    // Insert as second video track (above 层1, below any higher layers).
    const videoIdxs = [];
    tracks.forEach((t0, i) => {
      if (t0.kind === "video") videoIdxs.push(i);
    });
    const insertAt = videoIdxs.length ? videoIdxs[0] + 1 : tracks.length;
    tracks.splice(insertAt, 0, track);
    return track.id;
  }

  /** Ensure a topmost "Edit" video track for EditSeg overlays. */
  function ensureEditTrack() {
    ensureDefaultTrack();
    const existing = tracks.find(
      (tr) =>
        tr.kind === "video" &&
        (tr.role === "edit" ||
          tr.name === t("timeline.editTrack") ||
          /^编辑|Edit/i.test(tr.name || ""))
    );
    if (existing) {
      existing.role = "edit";
      return existing.id;
    }
    while (videoTrackCount() < 3) {
      const n = videoTrackCount() + 1;
      const tr = emptyTrack(
        "video",
        n === 3 ? t("timeline.editTrack") : t("timeline.videoTrackN", { n })
      );
      if (n === 3) tr.role = "edit";
      tracks.push(tr);
    }
    const top = tracks.filter((tr) => tr.kind === "video").slice(-1)[0];
    if (top) {
      top.role = "edit";
      if (!top.name || /^视频|Video/i.test(top.name)) {
        top.name = t("timeline.editTrack");
      }
      return top.id;
    }
    return defaultVideoTrackId();
  }

  function editTrackId() {
    return ensureEditTrack();
  }

  /** Track ids for 层1 + 层2 (creates 层2 only when createLayer2). */
  function storyboardLayerTrackIds(createLayer2) {
    const layer1Id = layer1VideoTrackId();
    const ids = new Set([layer1Id]);
    const layer2Id = createLayer2 ? ensureBridgeTrack() : layer2VideoTrackId();
    if (layer2Id) ids.add(layer2Id);
    return ids;
  }

  /** Layer-1 mains sorted by timeline start. */
  function mainsOnLayer1() {
    const tid = layer1VideoTrackId();
    return mains
      .filter((m) => (m.trackId || tid) === tid)
      .slice()
      .sort((a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0));
  }

  function findBridgeBetween(leftMainId, rightMainId) {
    return (
      bridges.find(
        (b) => b.leftMainId === leftMainId && b.rightMainId === rightMainId
      ) || null
    );
  }

  /** Prefer linked pair; else a layer-2 bridge overlapping the seam (manual slots). */
  function findPhysicalBridgeForSeam(left, right, usedIds) {
    const linked = findBridgeBetween(left.id, right.id);
    if (linked && !(usedIds && usedIds.has(linked.id))) return linked;
    const seam = clipTimelineEnd(left);
    const nextStart = Number(right.startSec) || seam;
    const candidates = bridgesOnLayer2()
      .filter((b) => !(usedIds && usedIds.has(b.id)))
      .filter((b) => {
        const s = Number(b.startSec) || 0;
        const e = clipTimelineEnd(b);
        return s <= seam + 0.05 && e >= Math.min(seam, nextStart) - 0.05;
      });
    if (candidates.length) {
      candidates.sort(
        (a, b) =>
          Math.abs((Number(a.startSec) || 0) - seam) -
          Math.abs((Number(b.startSec) || 0) - seam)
      );
      return candidates[0];
    }
    return null;
  }

  function isAutoBridgeEnabled() {
    return !llmAutoBridgeEl || !!llmAutoBridgeEl.checked;
  }

  function formatBridgeLlmError(err) {
    const msg =
      (err && err.message) ||
      (typeof err === "string" ? err : null) ||
      t("common.unknownError");
    const status = err && err.status;
    if (status === 404 || /404|Not Found/i.test(msg)) {
      return `${msg}\n（接口不存在或未加载：请重启后端服务使 /api/llm/bridges 生效）`;
    }
    return msg;
  }

  /** Drop clips whose trackId is in clearIds (mains without trackId count as 层1). */
  function clearClipsOnTracks(clearIds) {
    const layer1Id = layer1VideoTrackId();
    mains = mains.filter((m) => !clearIds.has(m.trackId || layer1Id));
    bridges = bridges.filter((b) => {
      const tid = b.trackId || layer1Id;
      return !clearIds.has(tid);
    });
    audios = audios.filter((a) => !clearIds.has(a.trackId));
    // EditSeg on edit track should survive storyboard regenerations
  }

  /** Layer-2 bridges sorted by timeline start (empty when 层2 missing). */
  function bridgesOnLayer2() {
    const layer2Id = layer2VideoTrackId();
    if (!layer2Id) return [];
    return bridges
      .filter((b) => b.trackId === layer2Id)
      .slice()
      .sort((a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0));
  }

  /** 1 = 层1, 2 = 层2, 0 = other (edit track etc). Mains without trackId count as 层1. */
  function clipStoryboardLayer(clip) {
    const l1 = layer1VideoTrackId();
    const l2 = layer2VideoTrackId();
    const tid = clip && clip.trackId ? clip.trackId : l1;
    if (tid === l1) return 1;
    if (l2 && tid === l2) return 2;
    return 0;
  }

  /**
   * All video slots on 层1 + 层2 (LLM-generated or manually added),
   * timeline order; same start prefers 层1.
   */
  function collectLayer12Clips() {
    const items = [];
    mains.forEach((m) => {
      const layer = clipStoryboardLayer(m);
      if (layer !== 1 && layer !== 2) return;
      items.push({
        id: m.id,
        kind: "main",
        layer,
        startSec: Number(m.startSec) || 0,
        durationSec: Math.round(clipDuration(m) * 10) / 10,
        prompt: String(m.prompt || "").trim(),
        title: String(m.title || "").trim(),
        beat: String(m.beat || m.prompt || "").trim(),
        camera: String(m.camera || "").trim(),
        cutToNext: String(m.cutToNext || "hard"),
        usedRefs: Array.isArray(m.usedRefs) ? m.usedRefs.slice() : [],
      });
    });
    bridges.forEach((b) => {
      const layer = clipStoryboardLayer(b);
      if (layer !== 1 && layer !== 2) return;
      items.push({
        id: b.id,
        kind: "bridge",
        layer,
        startSec: Number(b.startSec) || 0,
        durationSec: Math.round(clipDuration(b) * 10) / 10,
        prompt: String(b.prompt || "").trim(),
        afterShot: b.afterShot || b.leftMainId || null,
        leftMainId: b.leftMainId || null,
        rightMainId: b.rightMainId || null,
        needBridge: b.needBridge !== false,
      });
    });
    items.sort((a, b) => {
      const ds = a.startSec - b.startSec;
      if (ds !== 0) return ds;
      return a.layer - b.layer;
    });
    return items;
  }

  let polishScopeMode = "all";
  let polishSelectedIds = new Set();
  let polishSeenIds = new Set();

  function reconcilePolishSelection(clips) {
    const ids = (clips || []).map((c) => c.id);
    const idSet = new Set(ids);
    for (const id of [...polishSelectedIds]) {
      if (!idSet.has(id)) polishSelectedIds.delete(id);
    }
    ids.forEach((id) => {
      if (!polishSeenIds.has(id)) {
        polishSelectedIds.add(id);
        polishSeenIds.add(id);
      }
    });
    for (const id of [...polishSeenIds]) {
      if (!idSet.has(id)) polishSeenIds.delete(id);
    }
  }

  function getPolishTargetIds(clips) {
    const list = clips || collectLayer12Clips();
    if (polishScopeMode === "all") return list.map((c) => c.id);
    return list.filter((c) => polishSelectedIds.has(c.id)).map((c) => c.id);
  }

  function updatePolishScopeUi(clips) {
    const list = clips || collectLayer12Clips();
    reconcilePolishSelection(list);
    const targets = getPolishTargetIds(list);
    const targetSet = new Set(targets);
    const scoped = list.filter((c) => targetSet.has(c.id));
    const l1 = scoped.filter((c) => c.layer === 1).length;
    const l2 = scoped.filter((c) => c.layer === 2).length;
    const allBtn = document.getElementById("btnPolishScopeAll");
    const selBtn = document.getElementById("btnPolishScopeSelected");
    if (allBtn) allBtn.classList.toggle("is-active", polishScopeMode === "all");
    if (selBtn) selBtn.classList.toggle("is-active", polishScopeMode === "selected");
    if (storyboardPolishScopeEl) {
      storyboardPolishScopeEl.textContent = t("storyboard.polishScopeSummary", {
        n: scoped.length,
        l1,
        l2,
      });
    }
  }

  /** Pack 层1 mains end-to-end; clips on other tracks keep their startSec. */
  function packLayer1MainsEndToEnd() {
    const layerMains = mainsOnLayer1();
    let cursor = 0;
    layerMains.forEach((m) => {
      m.startSec = cursor;
      cursor = clipTimelineEnd(m);
    });
  }

  /**
   * Storyboard geometry for 层1 mains + 层2 bridges. Each seam covered by a
   * bridge gets gap = max(0, bridgeDur - 2*BRIDGE_OVERLAP_SEC) so the bridge
   * overlaps BRIDGE_OVERLAP_SEC of each neighbor; seams without a bridge stay
   * end-to-end. 层3+ and clips of the wrong kind are never repositioned.
   */
  function layoutLayer1UnderLayer2Bridges() {
    const layerMains = mainsOnLayer1();
    if (!layerMains.length) return;
    const layerBridges = bridgesOnLayer2();
    const seamBridges = new Array(Math.max(0, layerMains.length - 1)).fill(
      null
    );
    const used = new Set();
    // Pass 1: bridges explicitly linked to an adjacent main pair.
    for (let i = 0; i < layerMains.length - 1; i++) {
      const hit = layerBridges.find(
        (b) =>
          !used.has(b.id) &&
          b.leftMainId === layerMains[i].id &&
          b.rightMainId === layerMains[i + 1].id
      );
      if (hit) {
        seamBridges[i] = hit;
        used.add(hit.id);
      }
    }
    // Pass 2: remaining bridges fill open seams in timeline order.
    let seam = 0;
    layerBridges.forEach((b) => {
      if (used.has(b.id)) return;
      while (seam < seamBridges.length && seamBridges[seam]) seam++;
      if (seam >= seamBridges.length) return;
      seamBridges[seam] = b;
      used.add(b.id);
    });
    let cursor = 0;
    for (let i = 0; i < layerMains.length; i++) {
      const m = layerMains[i];
      m.startSec = cursor;
      const end = clipTimelineEnd(m);
      if (i >= layerMains.length - 1) break;
      const b = seamBridges[i];
      if (b) {
        b.leftMainId = layerMains[i].id;
        b.rightMainId = layerMains[i + 1].id;
        b.startSec = Math.max(0, end - BRIDGE_OVERLAP_SEC);
        cursor = end + Math.max(0, clipDuration(b) - 2 * BRIDGE_OVERLAP_SEC);
      } else {
        cursor = end;
      }
    }
  }

  /**
   * After a global length/fps edit: resize global-bound placeholder slots,
   * then re-run the 层1/层2 storyboard geometry. 层3+ positions untouched.
   */
  function relayoutAfterGlobalTimingChange() {
    syncPendingTimingForGlobalClips();
    relayoutStoryboardTracks(false);
  }

  function relayoutStoryboardTracks(render) {
    if (bridgesOnLayer2().length) {
      layoutLayer1UnderLayer2Bridges();
    } else {
      packLayer1MainsEndToEnd();
    }
    if (render) {
      renderTimelineTrack();
      buildSchedule();
      updatePlaylistMeta();
    }
  }

  /**
   * Re-space 层1 mains with gap so a full-length bridge (≈主段时长) can
   * overlap last BRIDGE_OVERLAP_SEC of prev + first BRIDGE_OVERLAP_SEC of next.
   * Rebuilds 层2 bridge slots; preserves bridges on other tracks.
   * Timeline duration locked via outSec so probe won't expand the slot.
   */
  function layoutStoryboardBridges(bridgePrompts) {
    const layerMains = mainsOnLayer1();
    const bridgeTrackId = ensureBridgeTrack();
    // Keep bridges not on 层2
    bridges = bridges.filter((b) => b.trackId && b.trackId !== bridgeTrackId);
    if (layerMains.length < 2) {
      return [];
    }
    const created = [];
    for (let i = 0; i < layerMains.length - 1; i++) {
      const left = layerMains[i];
      const right = layerMains[i + 1];
      const raw =
        bridgePrompts && bridgePrompts[i] != null ? bridgePrompts[i] : null;
      const spec =
        raw && typeof raw === "object"
          ? raw
          : {
              needBridge: true,
              durationSec: estimatedDurationSec(),
              prompt: raw != null ? String(raw) : "",
            };
      if (!spec.needBridge) continue;
      const b = emptyBridge(left.id, right.id, {
        trackId: bridgeTrackId,
        startSec: 0,
      });
      const bridgeDur = clampStoryboardDurationSec(
        spec.durationSec,
        getStoryboardBridgeDurationSec(),
        false,
        BRIDGE_MAX_SEC,
        BRIDGE_MIN_SEC
      );
      b.afterShot = left.id;
      b.needBridge = true;
      b.prompt = String(spec.prompt || "");
      b.inSec = 0;
      b.outSec = bridgeDur;
      b.durationSec = null;
      b.useGlobalTiming = true;
      b.length = null;
      b.fps = null;
      b.dirty = true;
      b.status = "pending";
      b.label = t("timeline.pendingGen");
      bridges.push(b);
      created.push(b);
    }
    layoutLayer1UnderLayer2Bridges();
    return created;
  }

  async function fetchBridgePromptsForMains(layerMains) {
    const pairs = [];
    const seams = [];
    for (let i = 0; i < layerMains.length - 1; i++) {
      const left = layerMains[i];
      const bridgeSpec = findStoryboardBridgeSpec(left.id);
      if (bridgeSpec && bridgeSpec.needBridge === false) continue;
      pairs.push({
        leftPrompt: (layerMains[i].prompt || "").trim(),
        rightPrompt: (layerMains[i + 1].prompt || "").trim(),
      });
      seams.push(left.id);
    }
    if (!pairs.length) return [];
    if (pairs.some((p) => !p.leftPrompt || !p.rightPrompt)) {
      throw new Error(t("main.adjacentPromptsEmpty"));
    }
    const prompts = await callLlmBridges(pairs);
    return seams.map((afterShot, i) => ({
      afterShot,
      needBridge: true,
      durationSec:
        (findStoryboardBridgeSpec(afterShot) || {}).durationSec ||
        getStoryboardBridgeDurationSec(),
      prompt: prompts[i] || "",
    }));
  }

  /**
   * Place auto bridges after mains are laid out.
   * @param {{ withLlm?: boolean }} opts
   * @returns {Promise<{ bridgeCount: number, llmOk: boolean, llmError: string|null }>}
   */
  async function applyAutoBridges(opts) {
    const withLlm = !!(opts && opts.withLlm);
    const layerMains = mainsOnLayer1();
    if (layerMains.length < 2) {
      const layer2Id = layer2VideoTrackId();
      if (layer2Id) {
        bridges = bridges.filter((b) => b.trackId !== layer2Id);
      }
      return { bridgeCount: 0, llmOk: true, llmError: null };
    }
    let prompts = [];
    let llmOk = true;
    let llmError = null;
    if (withLlm) {
      try {
        prompts = await fetchBridgePromptsForMains(layerMains);
      } catch (e) {
        llmOk = false;
        llmError = formatBridgeLlmError(e);
        prompts = [];
      }
    }
    const bridgeSpecs = [];
    for (let i = 0; i < layerMains.length - 1; i++) {
      const left = layerMains[i];
      const existing = findStoryboardBridgeSpec(left.id);
      // cutToNext on the main is the soft/hard source of truth (not a stale
      // storyboardState.needBridge wiped before bridge slots were laid out).
      if (left.cutToNext === "hard") {
        bridgeSpecs.push({
          afterShot: left.id,
          needBridge: false,
          durationSec: 0,
          prompt: "",
        });
        continue;
      }
      const llmSpec = Array.isArray(prompts)
        ? prompts.find((item) => item && item.afterShot === left.id)
        : null;
      bridgeSpecs.push({
        afterShot: left.id,
        needBridge: true,
        durationSec:
          (llmSpec && llmSpec.durationSec) ||
          (existing && existing.durationSec) ||
          getStoryboardBridgeDurationSec(),
        prompt:
          (llmSpec && llmSpec.prompt) || (existing && existing.prompt) || "",
      });
    }
    const created = layoutStoryboardBridges(bridgeSpecs);
    storyboardState = {
      ...storyboardState,
      bridges: bridgeSpecs.map((bridge) => ({ ...bridge })),
    };
    if (typeof refreshBridgeLinks === "function") {
      refreshBridgeLinks();
    }
    return { bridgeCount: created.length, llmOk, llmError };
  }

  function estimatedDurationSec(clip) {
    const frames = resolveClipLength(clip);
    const fps = resolveClipFps(clip);
    return Math.max(0.5, frames / fps);
  }

  function clipHasGeneratedMedia(clip) {
    return !!(clip && clip.playUrl);
  }

  function clipUsesGlobalTiming(clip) {
    return !clip || clip.useGlobalTiming !== false;
  }

  function getGlobalLength() {
    return snapLength(projectTiming.length, vflowDefaults.length);
  }

  function getGlobalFps() {
    return clampFps(projectTiming.fps, vflowDefaults.fps || 16);
  }

  function resolveClipLength(clip) {
    if (
      clip &&
      clip.useGlobalTiming === false &&
      clip.length != null &&
      Number.isFinite(Number(clip.length))
    ) {
      return snapLength(clip.length, vflowDefaults.length);
    }
    return getGlobalLength();
  }

  function resolveClipFps(clip) {
    if (
      clip &&
      clip.useGlobalTiming === false &&
      clip.fps != null &&
      Number.isFinite(Number(clip.fps))
    ) {
      return clampFps(clip.fps, vflowDefaults.fps);
    }
    return getGlobalFps();
  }

  function clipDuration(clip) {
    if (clipHasGeneratedMedia(clip)) {
      if (
        clip.outSec != null &&
        clip.inSec != null &&
        Number(clip.outSec) > Number(clip.inSec)
      ) {
        return Number(clip.outSec) - Number(clip.inSec);
      }
      if (clip.durationSec != null && Number(clip.durationSec) > 0) {
        return Number(clip.durationSec);
      }
    }
    if (
      clip &&
      clip.outSec != null &&
      clip.inSec != null &&
      Number(clip.outSec) > Number(clip.inSec)
    ) {
      return Number(clip.outSec) - Number(clip.inSec);
    }
    if (clip && clip.durationSec != null && Number(clip.durationSec) > 0) {
      return Number(clip.durationSec);
    }
    // Prefer engine/user main default over frames/fps estimate (Wan ~7s trap for MiniMax)
    if (getStoryboardEngine().usesDurationSeconds) {
      return getStoryboardMainDurationSec();
    }
    return estimatedDurationSec(clip);
  }

  function clipTimelineEnd(clip) {
    return (Number(clip.startSec) || 0) + clipDuration(clip);
  }

  /** Sync placeholder outSec for pending (no media) clips to length/fps. */
  function syncPendingClipOutSec(clip) {
    if (!clip || clipHasGeneratedMedia(clip)) return false;
    const dur =
      clip.durationSec != null && Number(clip.durationSec) > 0
        ? Number(clip.durationSec)
        : getStoryboardEngine().usesDurationSeconds
          ? getStoryboardMainDurationSec()
          : estimatedDurationSec(clip);
    const inSec = Number(clip.inSec) || 0;
    const nextOut = inSec + dur;
    if (clip.outSec == null || Math.abs(Number(clip.outSec) - nextOut) > 0.001) {
      clip.inSec = inSec;
      clip.outSec = nextOut;
      return true;
    }
    return false;
  }

  function syncPendingTimingForGlobalClips() {
    let changed = false;
    mains.forEach((m) => {
      if (clipUsesGlobalTiming(m) && syncPendingClipOutSec(m)) changed = true;
    });
    bridges.forEach((b) => {
      if (clipUsesGlobalTiming(b) && syncPendingClipOutSec(b)) changed = true;
    });
    edits.forEach((ed) => {
      if (clipUsesGlobalTiming(ed) && syncPendingClipOutSec(ed)) changed = true;
    });
    return changed;
  }

  function getSelectedTimingClip() {
    if (!selectedClip) return null;
    if (selectedClip.kind === "main") return findMain(selectedClip.id);
    if (selectedClip.kind === "bridge") {
      return bridges.find((x) => x.id === selectedClip.id) || null;
    }
    if (selectedClip.kind === "edit") {
      return edits.find((x) => x.id === selectedClip.id) || null;
    }
    return null;
  }

  /** Whether inspector length/fps currently edit project globals. */
  function inspectorEditsGlobalTiming() {
    const clip = getSelectedTimingClip();
    return !clip || clipUsesGlobalTiming(clip);
  }

  /** Engine driving the right-sidebar timing controls. */
  function resolveActiveInspectorEngineId() {
    const clip = getSelectedTimingClip();
    if (
      selectedClip &&
      (selectedClip.kind === "main" || selectedClip.kind === "bridge") &&
      clip
    ) {
      return resolveClipEngineId(clip);
    }
    return normalizeEngineId(storyboardEngineProfile);
  }

  function snapInspectorDurationSec(sec, engineId) {
    const E = window.VflowStoryboardEngines;
    const id = engineId || resolveActiveInspectorEngineId();
    if (E && typeof E.snapDurationChoice === "function") {
      return E.snapDurationChoice(sec, id);
    }
    if (E && typeof E.clampMainSec === "function") {
      return E.clampMainSec(sec, id);
    }
    const n = Number(sec);
    if (!Number.isFinite(n)) return 10;
    return Math.abs(n - 15) < Math.abs(n - 10) ? 15 : 10;
  }

  function getInspectorDurationSec() {
    const clip = getSelectedTimingClip();
    if (clip && !clipUsesGlobalTiming(clip) && clip.durationSec != null) {
      return snapInspectorDurationSec(clip.durationSec);
    }
    return snapInspectorDurationSec(getStoryboardMainDurationSec());
  }

  function syncDurationPresetActive() {
    const cur = getInspectorDurationSec();
    if (vflowDurationSecEl) vflowDurationSecEl.value = String(cur);
    document.querySelectorAll("[data-vflow-duration]").forEach((btn) => {
      const n = Number(btn.dataset.vflowDuration);
      btn.classList.toggle("is-active", n === cur);
    });
  }

  /**
   * Resolve inspector fps/length defaults from an engine profile.
   * Duration / nativeFps engines use ≡5 mod 17 lattice (no 241 cap).
   */
  function resolveEngineTimingDefaults(eng) {
    const e = eng || getStoryboardEngine();
    const lockFps = e.nativeFps != null || !!e.usesDurationSeconds;
    const fpsFallback = e.usesDurationSeconds ? 24 : vflowDefaults.fps || 16;
    const rawFps =
      e.nativeFps != null
        ? e.nativeFps
        : e.defaultFps != null
          ? e.defaultFps
          : fpsFallback;
    const fps = clampFps(rawFps, fpsFallback);
    let length;
    if (e.usesDurationSeconds) {
      const sec =
        typeof getInspectorDurationSec === "function"
          ? getInspectorDurationSec()
          : e.mainDefaultSec || 10;
      length = framesFromDurationSec(sec, e.nativeFps || e.defaultFps || 24);
    } else if (engineUsesLengthLattice(e)) {
      length = snapLengthLattice(
        e.defaultLength != null ? e.defaultLength : 243,
        e.defaultLength || 243
      );
    } else if (e.defaultLength != null && Number.isFinite(Number(e.defaultLength))) {
      length = snapLength(e.defaultLength, vflowDefaults.length || 113, e);
    } else {
      length = snapLength(vflowDefaults.length, vflowDefaults.length || 113, e);
    }
    return { fps, length, lockFps };
  }

  /**
   * Apply engine timing defaults into projectTiming / inspector inputs.
   * @param {object} eng
   * @param {{ writeProject?: boolean, syncInputs?: boolean }} [opts]
   *   writeProject defaults to inspectorEditsGlobalTiming(); syncInputs defaults true.
   */
  function applyEngineTimingDefaults(eng, opts) {
    const o = opts || {};
    const timing = resolveEngineTimingDefaults(eng);
    const writeProject =
      o.writeProject != null ? !!o.writeProject : inspectorEditsGlobalTiming();
    const syncInputs = o.syncInputs !== false;
    if (writeProject) {
      projectTiming.fps = timing.fps;
      projectTiming.length = timing.length;
    }
    if (syncInputs) {
      if (vflowFpsEl) vflowFpsEl.value = String(timing.fps);
      if (vflowLengthEl) vflowLengthEl.value = String(timing.length);
    }
    return timing;
  }

  /** Lock/unlock FPS input from engine nativeFps / duration mode. */
  function applyInspectorFpsLockFromEngine(eng) {
    if (!vflowFpsEl) return;
    const timing = resolveEngineTimingDefaults(eng);
    if (timing.lockFps) {
      vflowFpsEl.value = String(timing.fps);
      vflowFpsEl.readOnly = true;
      vflowFpsEl.disabled = true;
      if (eng && eng.usesDurationSeconds) {
        vflowFpsEl.title = t("inspector.paramsHintMinimax");
      } else {
        vflowFpsEl.removeAttribute("title");
      }
    } else {
      vflowFpsEl.readOnly = false;
      vflowFpsEl.disabled = false;
      vflowFpsEl.removeAttribute("title");
    }
  }

  /**
   * After user-engine caps change: if that engine is active/global, refresh sidebar.
   */
  function refreshTimingAfterEngineCapsChange(engineId) {
    const id = normalizeEngineId(engineId);
    const isGlobal = id === normalizeEngineId(storyboardEngineProfile);
    const isActive = id === resolveActiveInspectorEngineId();
    if (!isGlobal && !isActive) return;
    applyEngineTimingDefaults(getStoryboardEngine(id), {
      writeProject: isGlobal || inspectorEditsGlobalTiming(),
      syncInputs: true,
    });
    syncTimingInspectorUI();
    if (isGlobal && typeof relayoutAfterGlobalTimingChange === "function") {
      relayoutAfterGlobalTimingChange();
    }
  }

  /** Keep the video inspector timing controls consistent across engines. */
  function syncVflowEngineTimingMode() {
    const engId = resolveActiveInspectorEngineId();
    const eng = getStoryboardEngine(engId);
    const isMinimax = !!eng.usesDurationSeconds;
    const timing = resolveEngineTimingDefaults(eng);
    syncVflowLengthInputBounds(eng);
    if (vflowLengthField) vflowLengthField.hidden = isMinimax;
    if (vflowDurationField) vflowDurationField.hidden = !isMinimax;
    if (vflowLengthPresets) vflowLengthPresets.hidden = isMinimax;
    if (vflowDurationPresets) vflowDurationPresets.hidden = !isMinimax;
    if (vflowParamsHint) {
      vflowParamsHint.setAttribute(
        "data-i18n",
        isMinimax ? "inspector.paramsHintMinimax" : "inspector.paramsHint"
      );
      vflowParamsHint.textContent = isMinimax
        ? t("inspector.paramsHintMinimax")
        : t("inspector.paramsHint");
    }
    applyInspectorFpsLockFromEngine(eng);
    if (timing.lockFps || isMinimax) {
      if (inspectorEditsGlobalTiming()) {
        projectTiming.fps = timing.fps;
        if (isMinimax) {
          projectTiming.length = timing.length;
        }
      }
      if (vflowFpsEl) vflowFpsEl.value = String(timing.fps);
      if (isMinimax && vflowLengthEl) {
        vflowLengthEl.value = String(timing.length);
      }
    }
    if (isMinimax) {
      syncDurationPresetActive();
    } else {
      syncLengthPresetActive();
    }
  }

  function applyDurationInputsFromUI(rawSec) {
    if (timingUiSyncing) return;
    const eng = getStoryboardEngine(resolveActiveInspectorEngineId());
    const sec = snapInspectorDurationSec(rawSec);
    if (vflowDurationSecEl) vflowDurationSecEl.value = String(sec);
    if (storyboardMainDurationEl && inspectorEditsGlobalTiming()) {
      storyboardMainDurationEl.value = String(sec);
      if (typeof syncLlmCountUi === "function") syncLlmCountUi();
    }
    const clip = getSelectedTimingClip();
    if (clip && clip.useGlobalTiming === false) {
      clip.durationSec = sec;
      syncPendingClipOutSec(clip);
    } else {
      mains.forEach((m) => {
        if (!m || !clipUsesGlobalTiming(m)) return;
        m.durationSec = sec;
        syncPendingClipOutSec(m);
      });
      bridges.forEach((b) => {
        if (!b || b.needBridge === false || !clipUsesGlobalTiming(b)) return;
        b.durationSec = sec;
        syncPendingClipOutSec(b);
      });
    }
    if (eng.usesDurationSeconds || engineUsesLengthLattice(eng)) {
      const frames = framesFromDurationSec(
        sec,
        eng.nativeFps || eng.defaultFps || 24
      );
      if (inspectorEditsGlobalTiming()) {
        projectTiming.fps = clampFps(
          eng.nativeFps || eng.defaultFps || 24,
          24
        );
        projectTiming.length = frames;
      }
      if (vflowFpsEl) {
        vflowFpsEl.value = String(
          clampFps(eng.nativeFps || eng.defaultFps || 24, 24)
        );
      }
      if (vflowLengthEl) vflowLengthEl.value = String(frames);
    }
    syncDurationPresetActive();
    if (typeof rebuildTimeline === "function") rebuildTimeline();
    else if (typeof renderTimelineTrack === "function") renderTimelineTrack();
  }

  function syncTimingInspectorUI() {
    timingUiSyncing = true;
    try {
      const clip = getSelectedTimingClip();
      const useGlobal = !clip || clipUsesGlobalTiming(clip);
      if (vflowTimingGlobalEl) {
        vflowTimingGlobalEl.checked = useGlobal;
        vflowTimingGlobalEl.disabled = !clip;
      }
      if (useGlobal) {
        if (vflowLengthEl) vflowLengthEl.value = String(getGlobalLength());
        if (vflowFpsEl) vflowFpsEl.value = String(getGlobalFps());
      } else if (clip) {
        if (vflowLengthEl) {
          vflowLengthEl.value = String(
            snapLength(
              clip.length != null ? clip.length : getGlobalLength(),
              vflowDefaults.length
            )
          );
        }
        if (vflowFpsEl) {
          vflowFpsEl.value = String(
            clampFps(
              clip.fps != null ? clip.fps : getGlobalFps(),
              vflowDefaults.fps || 16
            )
          );
        }
      }
      syncVflowEngineTimingMode();
      syncLengthPresetActive();
      syncDurationPresetActive();
    } finally {
      timingUiSyncing = false;
    }
  }

  function applyTimingInputsFromUI() {
    if (timingUiSyncing) return;
    const eng = getStoryboardEngine(resolveActiveInspectorEngineId());
    const length = snapLength(
      vflowLengthEl && vflowLengthEl.value,
      vflowDefaults.length
    );
    const fps = clampFps(
      vflowFpsEl && vflowFpsEl.value,
      vflowDefaults.fps || 16
    );
    if (vflowLengthEl) vflowLengthEl.value = String(length);
    if (vflowFpsEl) vflowFpsEl.value = String(fps);
    const clip = getSelectedTimingClip();
    if (clip && clip.useGlobalTiming === false) {
      clip.length = length;
      clip.fps = fps;
      syncPendingClipOutSec(clip);
    } else {
      projectTiming.length = length;
      projectTiming.fps = fps;
      relayoutAfterGlobalTimingChange();
    }
    syncLengthPresetActive();
  }

  function onTimingGlobalToggle() {
    if (timingUiSyncing || !vflowTimingGlobalEl) return;
    const clip = getSelectedTimingClip();
    if (!clip) {
      vflowTimingGlobalEl.checked = true;
      return;
    }
    const wantGlobal = !!vflowTimingGlobalEl.checked;
    if (wantGlobal) {
      clip.useGlobalTiming = true;
      clip.length = null;
      clip.fps = null;
      syncPendingClipOutSec(clip);
      // Slot re-joins global timing: re-run 层1/层2 storyboard geometry.
      relayoutAfterGlobalTimingChange();
    } else {
      clip.useGlobalTiming = false;
      clip.length = getGlobalLength();
      clip.fps = getGlobalFps();
      syncPendingClipOutSec(clip);
    }
    syncTimingInspectorUI();
    if (wantGlobal && typeof rebuildTimeline === "function") {
      rebuildTimeline();
    } else if (typeof renderTimelineTrack === "function") {
      renderTimelineTrack();
    }
    renderSelectionUI();
    scheduleSaveDraft();
  }

  function nextStartOnTrack(trackId) {
    let end = 0;
    mains.forEach((m) => {
      if (m.trackId === trackId) end = Math.max(end, clipTimelineEnd(m));
    });
    bridges.forEach((b) => {
      if (b.trackId === trackId) end = Math.max(end, clipTimelineEnd(b));
    });
    edits.forEach((ed) => {
      if (ed.trackId === trackId) end = Math.max(end, clipTimelineEnd(ed));
    });
    audios.forEach((a) => {
      if (a.trackId === trackId) end = Math.max(end, clipTimelineEnd(a));
    });
    return end;
  }

  function emptyMain(prompt = "", placement) {
    const trackId =
      (placement && placement.trackId) || defaultVideoTrackId();
    const startSec =
      placement && placement.startSec != null
        ? Number(placement.startSec)
        : nextStartOnTrack(trackId);
    const defaultDur = getStoryboardMainDurationSec();
    return {
      id: uid("m"),
      title: "",
      beat: "",
      camera: "",
      cutToNext: "hard",
      prompt,
      status: "pending",
      label: t("timeline.pendingGen"),
      meta: "",
      playUrl: null,
      results: [],
      seedHigh: null,
      seedLow: null,
      dirty: true,
      taskId: null,
      mediaFileId: null,
      trackId,
      startSec,
      inSec: 0,
      outSec: null,
      durationSec: defaultDur,
      useGlobalTiming: true,
      length: null,
      fps: null,
      engineProfile: null,
      workflowParams: {},
    };
  }

  function emptyBridge(leftMainId, rightMainId, placement) {
    const trackId =
      (placement && placement.trackId) || defaultVideoTrackId();
    const startSec =
      placement && placement.startSec != null
        ? Number(placement.startSec)
        : nextStartOnTrack(trackId);
    return {
      id: uid("b"),
      afterShot: leftMainId || null,
      needBridge: true,
      leftMainId: leftMainId || null,
      rightMainId: rightMainId || null,
      prompt: "",
      startFrame: null,
      endFrame: null,
      status: "pending",
      label: t("bridge.waitingClip"),
      meta: "",
      playUrl: null,
      results: [],
      seedHigh: null,
      seedLow: null,
      dirty: true,
      needsReselect: false,
      connectionStale: false,
      linkedSig: { start: "∅", end: "∅" },
      startLink: null,
      endLink: null,
      taskId: null,
      mediaFileId: null,
      trackId,
      startSec,
      inSec: 0,
      outSec: null,
      durationSec: null,
      useGlobalTiming: true,
      length: null,
      fps: null,
      engineProfile: null,
      workflowParams: {},
    };
  }

  /**
   * @param {object} editor EditorManifest
   * @param {TimelineSelection} selection
   * @param {{ trackId?: string, startSec?: number, durationSec?: number }} placement
   */
  function emptyEdit(editor, selection, placement) {
    const trackId =
      (placement && placement.trackId) || editTrackId();
    const inSec = selection ? Number(selection.inSec) || 0 : 0;
    const outSec = selection ? Number(selection.outSec) || inSec : inSec;
    const dur =
      placement && placement.durationSec != null
        ? Number(placement.durationSec)
        : Math.max(0.5, outSec - inSec || estimatedDurationSec(null));
    const startSec =
      placement && placement.startSec != null
        ? Number(placement.startSec)
        : inSec;
    return {
      id: uid("e"),
      clipKind: "edit",
      editorId: (editor && editor.id) || "",
      editorSource: (editor && editor.source) || "platform",
      editorName: (editor && (editor.name || editor.id)) || "",
      sourceSelection: selection
        ? {
            kind: selection.kind,
            inSec,
            outSec,
            sourceClip: selection.sourceClip
              ? { ...selection.sourceClip }
              : undefined,
          }
        : null,
      prompt: "",
      editorParams: {},
      status: "pending",
      label: t("timeline.pendingGen"),
      meta: "",
      playUrl: null,
      results: [],
      seedHigh: null,
      seedLow: null,
      dirty: true,
      taskId: null,
      mediaFileId: null,
      trackId,
      startSec,
      inSec: 0,
      outSec: dur,
      durationSec: dur,
      useGlobalTiming: false,
      length: null,
      fps: null,
    };
  }

  function normalizePlacementFields(obj, fallbackTrackId, fallbackStart) {
    obj.trackId = obj.trackId || fallbackTrackId || defaultVideoTrackId();
    obj.startSec =
      obj.startSec != null && !Number.isNaN(Number(obj.startSec))
        ? Math.max(0, Number(obj.startSec))
        : fallbackStart != null
          ? fallbackStart
          : 0;
    obj.inSec =
      obj.inSec != null && !Number.isNaN(Number(obj.inSec))
        ? Math.max(0, Number(obj.inSec))
        : 0;
    obj.outSec =
      obj.outSec != null && !Number.isNaN(Number(obj.outSec))
        ? Number(obj.outSec)
        : null;
    obj.durationSec =
      obj.durationSec != null && Number(obj.durationSec) > 0
        ? Number(obj.durationSec)
        : null;
    obj.useGlobalTiming = obj.useGlobalTiming !== false;
    if (obj.useGlobalTiming) {
      obj.length = null;
      obj.fps = null;
    } else {
      obj.length =
        obj.length != null && Number.isFinite(Number(obj.length))
          ? snapLength(obj.length, vflowDefaults.length)
          : getGlobalLength();
      obj.fps =
        obj.fps != null && Number.isFinite(Number(obj.fps))
          ? clampFps(obj.fps, vflowDefaults.fps || 16)
          : getGlobalFps();
    }
    return obj;
  }

  // —— Server project persistence ——

  function setDraftStatus(text) {
    if (draftStatus) draftStatus.textContent = text || "";
  }

  let authModeApplied = null;

  function setAuthMode(mode) {
    const resolved = mode === "register" && allowSelfRegister ? "register" : "login";
    const isRegister = resolved === "register";
    if (authModeApplied === resolved) return;
    authModeApplied = resolved;
    if (loginCard) loginCard.dataset.authMode = resolved;
    if (registerOnlyFields) registerOnlyFields.classList.toggle("hidden", !isRegister);
    if (btnLogin) btnLogin.classList.toggle("hidden", isRegister);
    if (btnRegister) btnRegister.classList.toggle("hidden", !isRegister);
    if (authSubtitle) {
      authSubtitle.textContent = isRegister
        ? t("auth.subtitleRegister")
        : t("auth.subtitleLogin");
    }
    if (authModeLoginHint) authModeLoginHint.classList.toggle("hidden", !isRegister);
    if (authModeRegisterHint) {
      authModeRegisterHint.classList.toggle("hidden", isRegister || !allowSelfRegister);
    }
    if (authModeSwitch) {
      authModeSwitch.classList.toggle("hidden", !allowSelfRegister);
    }
    if (loginPassword) {
      loginPassword.autocomplete = isRegister ? "new-password" : "current-password";
    }
    if (loginPasswordConfirm) {
      loginPasswordConfirm.disabled = !isRegister;
      loginPasswordConfirm.tabIndex = isRegister ? 0 : -1;
      if (!isRegister) loginPasswordConfirm.value = "";
    }
  }

  function showLogin(message) {
    if (message) console.warn(message);
  }

  function showEditor() {
    document.documentElement.classList.remove("is-login");
    document.body.classList.remove("is-login");
    if (editorShell) {
      editorShell.classList.remove("hidden");
      editorShell.removeAttribute("inert");
      editorShell.removeAttribute("aria-hidden");
    }
  }

  function isLocalMediaId(id) {
    return id != null && String(id).startsWith("loc_");
  }

  /** RunningHub upload names look like `api/<hash>.ext` — never treat display filenames as uploaded. */
  function isPlatformRhFileName(name) {
    const n = String(name || "").trim();
    return n.startsWith("api/") && n.length > 8;
  }

  /** Never persist ephemeral blob: URLs; local clips keep mediaFileId only. */
  function persistablePlayUrl(playUrl) {
    if (!playUrl) return null;
    if (String(playUrl).startsWith("blob:")) return null;
    return playUrl;
  }

  function collectDraftPayload() {
    return {
      version: 6,
      imageName: selectedFile ? selectedFile.name : (sharedStartPlayUrl ? t("project.savedStartFrame") : ""),
      imageType: selectedFile ? selectedFile.type || "application/octet-stream" : "",
      sharedStartRhName,
      sharedStartPlayUrl: persistablePlayUrl(sharedStartPlayUrl),
      sharedStartMediaId,
      negative: negativeInput.value,
      concurrency: concurrencyEl.value,
      password: duckPasswordEl ? duckPasswordEl.value : "",
      sceneDescription: sceneDescriptionEl ? sceneDescriptionEl.value : "",
      plotDirection: plotDirectionEl ? plotDirectionEl.value : "",
      segmentCount: segmentCountEl ? segmentCountEl.value : "3",
      storyboardTargetDuration: String(getStoryboardTargetDurationSec()),
      storyboardMainDuration: String(getStoryboardMainDurationSec()),
      llmPickCount: llmPickCountEl ? !!llmPickCountEl.checked : false,
      llmAutoBridge: llmAutoBridgeEl ? !!llmAutoBridgeEl.checked : true,
      scriptAssetId: boundScriptAssetId,
      episodeId: boundEpisodeId,
      storyboardState: storyboardStateToPayload(storyboardState),
      storyboardEngineProfile,
      storyboardUseMultiRef,
      vflowOrient,
      vflowWidth: vflowWidthEl ? vflowWidthEl.value : "",
      vflowHeight: vflowHeightEl ? vflowHeightEl.value : "",
      vflowLength: String(getGlobalLength()),
      vflowFps: String(getGlobalFps()),
      tracks: tracks.map((tr) => ({
        id: tr.id,
        kind: tr.kind,
        name: tr.name,
        hidden: !!tr.hidden,
        muteAudio: !!tr.muteAudio,
        role: tr.role || null,
      })),
      mains: mains.map((m) => ({
        id: m.id,
        title: m.title || "",
        beat: m.beat || "",
        camera: m.camera || "",
        cutToNext: m.cutToNext || "hard",
        prompt: m.prompt,
        status: m.status,
        label: m.label,
        meta: m.meta,
        playUrl: persistablePlayUrl(m.playUrl),
        mediaFileId: m.mediaFileId || null,
        results: m.results,
        seedHigh: m.seedHigh,
        seedLow: m.seedLow,
        dirty: m.dirty,
        taskId: m.taskId,
        trackId: m.trackId || null,
        startSec: Number(m.startSec) || 0,
        inSec: Number(m.inSec) || 0,
        outSec: m.outSec != null ? Number(m.outSec) : null,
        durationSec: m.durationSec != null ? Number(m.durationSec) : null,
        useGlobalTiming: m.useGlobalTiming !== false,
        length: m.useGlobalTiming === false && m.length != null ? Number(m.length) : null,
        fps: m.useGlobalTiming === false && m.fps != null ? Number(m.fps) : null,
        engineProfile: m.engineProfile
          ? normalizeEngineId(m.engineProfile)
          : null,
        muteAudio: !!m.muteAudio,
      })),
      bridges: bridges.map((b) => ({
        id: b.id,
        afterShot: b.afterShot || null,
        needBridge: b.needBridge !== false,
        leftMainId: b.leftMainId,
        rightMainId: b.rightMainId,
        prompt: b.prompt,
        startFrame: b.startFrame
          ? {
              rhFileName: b.startFrame.rhFileName,
              playUrl: persistablePlayUrl(b.startFrame.playUrl),
              mediaFileId: b.startFrame.mediaFileId || null,
              sourceMainId: b.startFrame.sourceMainId,
              timeSec: b.startFrame.timeSec,
              source: b.startFrame.source || null,
              linkSig: b.startFrame.linkSig || null,
            }
          : null,
        endFrame: b.endFrame
          ? {
              rhFileName: b.endFrame.rhFileName,
              playUrl: persistablePlayUrl(b.endFrame.playUrl),
              mediaFileId: b.endFrame.mediaFileId || null,
              sourceMainId: b.endFrame.sourceMainId,
              timeSec: b.endFrame.timeSec,
              source: b.endFrame.source || null,
              linkSig: b.endFrame.linkSig || null,
            }
          : null,
        status: b.status,
        label: b.label,
        meta: b.meta,
        playUrl: persistablePlayUrl(b.playUrl),
        mediaFileId: b.mediaFileId || null,
        results: b.results,
        seedHigh: b.seedHigh,
        seedLow: b.seedLow,
        dirty: b.dirty,
        needsReselect: b.needsReselect,
        linkedSig: b.linkedSig
          ? { start: b.linkedSig.start || "∅", end: b.linkedSig.end || "∅" }
          : { start: "∅", end: "∅" },
        taskId: b.taskId,
        trackId: b.trackId || null,
        startSec: Number(b.startSec) || 0,
        inSec: Number(b.inSec) || 0,
        outSec: b.outSec != null ? Number(b.outSec) : null,
        durationSec: b.durationSec != null ? Number(b.durationSec) : null,
        useGlobalTiming: b.useGlobalTiming !== false,
        length: b.useGlobalTiming === false && b.length != null ? Number(b.length) : null,
        fps: b.useGlobalTiming === false && b.fps != null ? Number(b.fps) : null,
        engineProfile: b.engineProfile
          ? normalizeEngineId(b.engineProfile)
          : null,
        muteAudio: !!b.muteAudio,
      })),
      edits: edits.map((ed) => ({
        id: ed.id,
        clipKind: "edit",
        editorId: ed.editorId || "",
        editorSource: ed.editorSource || "platform",
        editorName: ed.editorName || "",
        sourceSelection: ed.sourceSelection || null,
        prompt: ed.prompt || "",
        editorParams:
          ed.editorParams && typeof ed.editorParams === "object"
            ? ed.editorParams
            : {},
        status: ed.status,
        label: ed.label,
        meta: ed.meta,
        playUrl: persistablePlayUrl(ed.playUrl),
        mediaFileId: ed.mediaFileId || null,
        results: ed.results || [],
        seedHigh: ed.seedHigh,
        seedLow: ed.seedLow,
        dirty: ed.dirty,
        taskId: ed.taskId,
        trackId: ed.trackId || null,
        startSec: Number(ed.startSec) || 0,
        inSec: Number(ed.inSec) || 0,
        outSec: ed.outSec != null ? Number(ed.outSec) : null,
        durationSec: ed.durationSec != null ? Number(ed.durationSec) : null,
        useGlobalTiming: ed.useGlobalTiming !== false,
        length: ed.useGlobalTiming === false && ed.length != null ? Number(ed.length) : null,
        fps: ed.useGlobalTiming === false && ed.fps != null ? Number(ed.fps) : null,
        muteAudio: !!ed.muteAudio,
      })),
      audios: audios.map((a) => ({
        id: a.id,
        trackId: a.trackId || null,
        startSec: Number(a.startSec) || 0,
        inSec: Number(a.inSec) || 0,
        outSec: a.outSec != null ? Number(a.outSec) : null,
        durationSec: a.durationSec != null ? Number(a.durationSec) : null,
        playUrl: persistablePlayUrl(a.playUrl),
        mediaFileId: a.mediaFileId || null,
        status: a.status || "pending",
        label: a.label || "",
        name: a.name || "",
        volume: a.volume != null ? Number(a.volume) : 1,
        linkedFrom: a.linkedFrom || null,
      })),
      savedAt: Date.now(),
    };
  }

  async function saveDraftImmediate() {
    if (suppressSave || !currentProjectId) return;
    try {
      const name = currentProjectName || t("project.unnamedProject");
      const data = await apiJson(`/api/projects/${currentProjectId}`, {
        method: "PUT",
        body: { name, payload: collectDraftPayload() },
      });
      currentProjectName = data.project.name;
      setDraftStatus(t("topbar.draftSaved", { name: currentProjectName }));
      await refreshProjectList();
    } catch (e) {
      console.warn("saveDraft failed", e);
      setDraftStatus(t("topbar.draftSaveFailed"));
    }
  }

  function scheduleSaveDraft() {
    if (suppressSave || !currentProjectId) return;
    setDraftStatus(t("topbar.draftSaving"));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveDraftImmediate();
    }, SAVE_DEBOUNCE_MS);
  }

    function revokePreviewUrl() {
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
  }

  function setImageFile(file) {
    selectedFile = file || null;
    sharedStartRhName = null;
    sharedStartPlayUrl = null;
    sharedStartMediaId = null;
    revokePreviewUrl();
    if (!file) {
      imageName.textContent = t("bins.notSelected");
      imagePreviewWrap.classList.add("hidden");
      imagePreview.removeAttribute("src");
      dropZone.classList.remove("has-image", "hidden");
      if (startCompact) startCompact.classList.add("hidden");
      if (!suppressSave) scheduleSaveDraft();
      return;
    }
    imageName.textContent = file.name;
    previewObjectUrl = URL.createObjectURL(file);
    imagePreview.src = previewObjectUrl;
    imagePreviewWrap.classList.remove("hidden");
    dropZone.classList.add("has-image", "hidden");
    if (startCompact) {
      startCompact.classList.remove("hidden");
      if (startCompactThumb) startCompactThumb.src = previewObjectUrl;
      if (startCompactName) startCompactName.textContent = file.name;
    }
    applyStartFrameOrientDefault(previewObjectUrl).catch((err) => {
      console.warn("detect shared-start orientation failed", err);
    });
    // New shared start → mark all mains dirty
    if (!suppressSave) {
      mains.forEach((m) => {
        m.dirty = true;
        if (m.status === "success") {
          m.label = t("status.needsRegen");
        }
      });
      markBridgesNeedReselectForAll();
      renderAll();
      saveDraftImmediate();
    }
  }

  /** Wan size prefers multiples of 16. */
  function snapDim(n, fallback) {
    let v = Number(n);
    if (!Number.isFinite(v)) v = fallback;
    v = Math.max(256, Math.min(1920, Math.round(v)));
    v = Math.round(v / 16) * 16;
    return Math.max(256, Math.min(1920, v));
  }

  /**
   * Positive modulo (JS % is sign-of-dividend).
   */
  function positiveMod(n, m) {
    const mod = Number(m) || 1;
    return ((Number(n) % mod) + mod) % mod;
  }

  /**
   * MiniMax / 24fps length lattice:
   * max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
   * Result ≡ 5 (mod 17), e.g. 10s → 243, 15s → 362.
   */
  function framesFromDurationSec(durationSec, fps) {
    const a = Number(durationSec);
    const rate = Number(fps);
    const mul = Number.isFinite(rate) && rate > 0 ? rate : 24;
    const x = Math.max(5, Math.round((Number.isFinite(a) ? a : 0) * mul));
    return x + positiveMod(5 - (x % 17), 17);
  }

  /** Engines that use ≡5 mod 17 length (not Wan 4n+1 / 17..241). */
  function engineUsesLengthLattice(eng) {
    const e = eng || getStoryboardEngine(resolveActiveInspectorEngineId());
    return !!(e && (e.usesDurationSeconds || e.nativeFps != null));
  }

  /**
   * Snap a raw frame count onto the ≡5 mod 17 lattice (no 241 cap).
   */
  function snapLengthLattice(n, fallback) {
    let v = Number(n);
    if (!Number.isFinite(v)) v = Number(fallback);
    if (!Number.isFinite(v)) v = 243;
    v = Math.max(5, Math.round(v));
    return v + positiveMod(5 - (v % 17), 17);
  }

  /**
   * Wan length prefers 4n+1 (e.g. 49 / 81 / 113) within 17..241.
   * Lattice engines (MiniMax / nativeFps): duration formula or ≡5 mod 17, no 241 cap.
   */
  function snapLength(n, fallback, engOverride) {
    const eng =
      engOverride || getStoryboardEngine(resolveActiveInspectorEngineId());
    if (engineUsesLengthLattice(eng)) {
      if (eng.usesDurationSeconds) {
        const sec =
          typeof getInspectorDurationSec === "function"
            ? getInspectorDurationSec()
            : eng.mainDefaultSec || 10;
        return framesFromDurationSec(
          sec,
          eng.nativeFps || eng.defaultFps || 24
        );
      }
      return snapLengthLattice(
        n,
        fallback != null ? fallback : eng.defaultLength || 243
      );
    }
    let v = Number(n);
    if (!Number.isFinite(v)) v = fallback;
    v = Math.max(17, Math.min(241, Math.round(v)));
    const base = Math.round((v - 1) / 4) * 4 + 1;
    return Math.max(17, Math.min(241, base));
  }

  /** Sync #vflowLength min/max/step for Wan vs length-lattice engines. */
  function syncVflowLengthInputBounds(eng) {
    if (!vflowLengthEl) return;
    if (engineUsesLengthLattice(eng)) {
      vflowLengthEl.min = "5";
      vflowLengthEl.max = "2000";
      vflowLengthEl.step = "17";
    } else {
      vflowLengthEl.min = "17";
      vflowLengthEl.max = "241";
      vflowLengthEl.step = "4";
    }
  }

  /** Video fps for timeline estimate and workflow frame_rate. */
  function clampFps(n, fallback) {
    let v = Number(n);
    if (!Number.isFinite(v)) v = fallback;
    return Math.max(8, Math.min(30, Math.round(v)));
  }

  function detectOrientFromSize(width, height) {
    return Number(height) > Number(width) ? "portrait" : "landscape";
  }

  async function readImageSizeFromSource(source) {
    if (!source) return null;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: Number(img.naturalWidth) || 0,
          height: Number(img.naturalHeight) || 0,
        });
      };
      img.onerror = () => resolve(null);
      img.src = source;
    });
  }

  async function applyStartFrameOrientDefault(source) {
    const size = await readImageSizeFromSource(source);
    if (!size || !size.width || !size.height) return false;
    applyOrientPreset(detectOrientFromSize(size.width, size.height));
    return true;
  }

  function getWfSizePayload() {
    const lw = vflowDefaults.landscape.width;
    const lh = vflowDefaults.landscape.height;
    const width = snapDim(vflowWidthEl && vflowWidthEl.value, lw);
    const height = snapDim(vflowHeightEl && vflowHeightEl.value, lh);
    const length = getGlobalLength();
    const fps = getGlobalFps();
    return { width, height, length, fps };
  }

  /** Write clamped values back into inputs (after blur / before create). */
  function commitWfSizeInputs() {
    const lw = vflowDefaults.landscape.width;
    const lh = vflowDefaults.landscape.height;
    const width = snapDim(vflowWidthEl && vflowWidthEl.value, lw);
    const height = snapDim(vflowHeightEl && vflowHeightEl.value, lh);
    if (vflowWidthEl) vflowWidthEl.value = String(width);
    if (vflowHeightEl) vflowHeightEl.value = String(height);
    const eng = getStoryboardEngine(resolveActiveInspectorEngineId());
    const lattice = engineUsesLengthLattice(eng);
    const lockedFps = lattice
      ? clampFps(eng.nativeFps || eng.defaultFps || 24, 24)
      : null;
    const lockedLength = eng.usesDurationSeconds
      ? framesFromDurationSec(
          typeof getInspectorDurationSec === "function"
            ? getInspectorDurationSec()
            : eng.mainDefaultSec || 10,
          eng.nativeFps || eng.defaultFps || 24
        )
      : lattice
        ? snapLengthLattice(
            vflowLengthEl && vflowLengthEl.value,
            eng.defaultLength || 243
          )
        : null;
    // Length/fps: commit into projectTiming only when editing globals;
    // otherwise keep projectTiming and leave clip overrides to applyTimingInputsFromUI.
    if (inspectorEditsGlobalTiming()) {
      const length =
        lockedLength != null
          ? lockedLength
          : snapLength(
              vflowLengthEl && vflowLengthEl.value,
              vflowDefaults.length,
              eng
            );
      const fps =
        lockedFps != null
          ? lockedFps
          : clampFps(vflowFpsEl && vflowFpsEl.value, vflowDefaults.fps || 16);
      projectTiming.length = length;
      projectTiming.fps = fps;
      if (vflowLengthEl) vflowLengthEl.value = String(length);
      if (vflowFpsEl) vflowFpsEl.value = String(fps);
    } else {
      if (vflowLengthEl) {
        vflowLengthEl.value = String(
          lockedLength != null
            ? lockedLength
            : snapLength(vflowLengthEl.value, vflowDefaults.length, eng)
        );
      }
      if (vflowFpsEl) {
        vflowFpsEl.value = String(
          lockedFps != null
            ? lockedFps
            : clampFps(vflowFpsEl.value, vflowDefaults.fps || 16)
        );
      }
    }
    syncOrientButtonsFromSize();
    syncLengthPresetActive();
    return {
      width,
      height,
      length: getGlobalLength(),
      fps: getGlobalFps(),
    };
  }

  function syncInspectorLocaleLabels() {
    const lw = vflowDefaults.landscape.width;
    const lh = vflowDefaults.landscape.height;
    const pw = vflowDefaults.portrait.width;
    const ph = vflowDefaults.portrait.height;
    if (btnOrientLandscape) {
      btnOrientLandscape.textContent = t("inspector.landscape", { w: lw, h: lh });
    }
    if (btnOrientPortrait) {
      btnOrientPortrait.textContent = t("inspector.portrait", { w: pw, h: ph });
    }
    document.querySelectorAll("[data-vflow-length]").forEach((btn) => {
      const n = Number(btn.dataset.vflowLength);
      if (!Number.isFinite(n)) return;
      if (n === 49) btn.textContent = t("inspector.lengthShort");
      else if (n === 81) btn.textContent = t("inspector.lengthMid");
      else if (n === 161) btn.textContent = t("inspector.lengthLong");
      else btn.textContent = t("inspector.lengthDefault", { n });
    });
    document.querySelectorAll("[data-vflow-duration]").forEach((btn) => {
      const n = Number(btn.dataset.vflowDuration);
      if (!Number.isFinite(n)) return;
      btn.textContent = t("inspector.durationSecLabel", { n });
    });
    syncVflowEngineTimingMode();
  }

  function applyOrientPreset(orient, persist) {
    vflowOrient = orient === "portrait" ? "portrait" : "landscape";
    const pair =
      vflowOrient === "portrait" ? vflowDefaults.portrait : vflowDefaults.landscape;
    if (vflowWidthEl) vflowWidthEl.value = String(pair.width);
    if (vflowHeightEl) vflowHeightEl.value = String(pair.height);
    if (btnOrientLandscape) {
      btnOrientLandscape.classList.toggle("is-active", vflowOrient === "landscape");
    }
    if (btnOrientPortrait) {
      btnOrientPortrait.classList.toggle("is-active", vflowOrient === "portrait");
    }
    syncInspectorLocaleLabels();
    syncLengthPresetActive();
    if (persist !== false) scheduleSaveDraft();
  }

  function resetWfToDefaults(persist) {
    applyOrientPreset(vflowOrient || "landscape", false);
    const eng = getStoryboardEngine(resolveActiveInspectorEngineId());
    applyEngineTimingDefaults(eng, { writeProject: true, syncInputs: true });
    relayoutAfterGlobalTimingChange();
    syncTimingInspectorUI();
    syncLengthPresetActive();
    if (typeof rebuildTimeline === "function") rebuildTimeline();
    else if (typeof renderTimelineTrack === "function") renderTimelineTrack();
    if (persist !== false) scheduleSaveDraft();
  }

  function syncOrientButtonsFromSize() {
    const w = Number(vflowWidthEl && vflowWidthEl.value);
    const h = Number(vflowHeightEl && vflowHeightEl.value);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      vflowOrient = h > w ? "portrait" : "landscape";
    }
    if (btnOrientLandscape) {
      btnOrientLandscape.classList.toggle("is-active", vflowOrient === "landscape");
    }
    if (btnOrientPortrait) {
      btnOrientPortrait.classList.toggle("is-active", vflowOrient === "portrait");
    }
    syncInspectorLocaleLabels();
  }

  function relocalizeDefaultTrackNames() {
    const videoRe = /^(?:视频|Video)\s+(\d+)$/i;
    const audioRe = /^(?:音频|Audio)\s+(\d+)$/i;
    tracks.forEach((track) => {
      const name = String(track.name || "");
      let m = name.match(videoRe);
      if (m && track.kind === "video") {
        track.name = t("timeline.trackVideo", { n: m[1] });
        return;
      }
      m = name.match(audioRe);
      if (m && track.kind === "audio") {
        track.name = t("timeline.trackAudio", { n: m[1] });
      }
    });
  }

  function syncLengthPresetActive() {
    const cur = snapLength(vflowLengthEl && vflowLengthEl.value, vflowDefaults.length);
    document.querySelectorAll("[data-vflow-length]").forEach((btn) => {
      const n = Number(btn.dataset.vflowLength);
      btn.classList.toggle("is-active", n === cur);
    });
  }

  // —— Prompt / main list UI ——

  function syncPromptsFromDom() {
    promptListEl.querySelectorAll(".prompt-item[data-main-id]").forEach((el) => {
      const ta = el.querySelector(".prompt-card-prompt-input");
      const text = ta ? ta.value : "";
      const m = mains.find((x) => x.id === el.dataset.mainId);
      if (!m) return;
      const titleInput = el.querySelector(".prompt-card-title-input");
      const beatInput = el.querySelector(".prompt-card-beat-input");
      const cameraInput = el.querySelector(".prompt-card-camera-input");
      if (titleInput) m.title = titleInput.value.trim();
      if (beatInput) m.beat = beatInput.value.trim();
      if (cameraInput) m.camera = cameraInput.value.trim();
      if (m.prompt !== text) {
        m.prompt = text;
        if (m.status === "success") {
          m.dirty = true;
          m.label = t("status.promptChanged");
        } else {
          m.dirty = true;
        }
      }
    });
    promptListEl.querySelectorAll(".prompt-item[data-bridge-id]").forEach((el) => {
      const ta = el.querySelector(".prompt-card-prompt-input");
      const text = ta ? ta.value : "";
      const b = bridges.find((x) => x.id === el.dataset.bridgeId);
      if (!b) return;
      const mode = el.querySelector(".prompt-card-bridge-mode");
      if (mode) b.needBridge = mode.value !== "hard";
      if (b.prompt !== text) {
        b.prompt = text;
        b.dirty = true;
        if (b.status === "success") b.label = t("status.promptChanged");
      }
    });
    storyboardState = buildStoryboardStateFromClips();
  }

  function updatePromptEmptyHint() {
    const hasRows = promptListEl.querySelectorAll(".prompt-item").length > 0;
    const hasText = mains.some((m) => (m.prompt || "").trim());
    if (!hasRows) {
      promptEmptyHint.textContent =
        t("storyboard.emptyHint");
      promptEmptyHint.classList.remove("hidden");
    } else if (!hasText) {
      promptEmptyHint.textContent = t("storyboard.needOnePrompt");
      promptEmptyHint.classList.remove("hidden");
    } else {
      promptEmptyHint.classList.add("hidden");
    }
    if (typeof updateLlmButtonState === "function") {
      updateLlmButtonState();
    }
  }

  function addMain(prompt = "", persist = true) {
    const m = emptyMain(prompt);
    mains.push(m);
    storyboardState = buildStoryboardStateFromClips();
    renderPromptList();
    renderJobList();
    renderBridges();
    rebuildTimeline();
    updatePromptEmptyHint();
    updatePhaseSteps();
    if (persist) scheduleSaveDraft();
    return m;
  }

  function addBridgeClip(trackId, startSec) {
    const tid = trackId || defaultVideoTrackId();
    const b = emptyBridge(null, null, {
      trackId: tid,
      startSec: startSec != null ? startSec : nextStartOnTrack(tid),
    });
    bridges.push(b);
    storyboardState = buildStoryboardStateFromClips();
    selectedClip = { kind: "bridge", id: b.id };
    renderAll();
    scheduleSaveDraft();
    return b;
  }

  function addVideoTrack() {
    ensureDefaultTrack();
    const t = emptyTrack("video");
    tracks.push(t); // topmost = highest priority
    renderTimelineTrack();
    scheduleSaveDraft();
    return t;
  }

  function removeMainAt(index) {
    if (index < 0 || index >= mains.length) return;
    pushTimelineUndo("deleteMain");
    const removed = mains[index];
    mains.splice(index, 1);
    bridges.forEach((b) => {
      if (b.leftMainId === removed.id) b.leftMainId = null;
      if (b.rightMainId === removed.id) b.rightMainId = null;
      if (
        b.startFrame &&
        b.startFrame.sourceMainId === removed.id
      ) {
        b.needsReselect = true;
      }
      if (b.endFrame && b.endFrame.sourceMainId === removed.id) {
        b.needsReselect = true;
      }
    });
    if (selectedClip && selectedClip.kind === "main" && selectedClip.id === removed.id) {
      selectedClip = null;
    }
    storyboardState = buildStoryboardStateFromClips();
    renderAll();
    scheduleSaveDraft();
  }

  function removeBridgeById(bridgeId) {
    const idx = bridges.findIndex((b) => b.id === bridgeId);
    if (idx < 0) return;
    pushTimelineUndo("deleteBridge");
    const removed = bridges[idx];
    bridges.splice(idx, 1);
    const bridgeTrackId = layer2VideoTrackId();
    if (removed && removed.trackId && bridgeTrackId && removed.trackId === bridgeTrackId) {
      layoutLayer1UnderLayer2Bridges();
    }
    if (selectedClip && selectedClip.kind === "bridge" && selectedClip.id === bridgeId) {
      selectedClip = null;
    }
    storyboardState = buildStoryboardStateFromClips();
    renderAll();
    scheduleSaveDraft();
  }

  function removeEditById(editId) {
    const idx = edits.findIndex((e) => e.id === editId);
    if (idx < 0) return;
    pushTimelineUndo("deleteEdit");
    edits.splice(idx, 1);
    if (selectedClip && selectedClip.kind === "edit" && selectedClip.id === editId) {
      selectedClip = null;
    }
    renderAll();
    scheduleSaveDraft();
  }

  function findEdit(id) {
    return edits.find((e) => e.id === id) || null;
  }

  function deleteTimelineClip(kind, id) {
    closeClipContextMenu();
    if (kind === "main") {
      const idx = mains.findIndex((m) => m.id === id);
      if (idx < 0) return;
      if (!confirm(t("main.confirmDeleteSlot"))) return;
      removeMainAt(idx);
      return;
    }
    if (kind === "bridge") {
      if (!bridges.some((b) => b.id === id)) return;
      if (!confirm(t("bridge.confirmDelete"))) return;
      removeBridgeById(id);
      return;
    }
    if (kind === "edit") {
      if (!edits.some((e) => e.id === id)) return;
      if (!confirm(t("editor.confirmDelete"))) return;
      removeEditById(id);
      return;
    }
    if (kind === "audio") {
      if (!findAudio(id)) return;
      if (!confirm(t("timeline.confirmDeleteAudio"))) return;
      removeAudioById(id);
    }
  }

  function deleteSelectedTimelineClip() {
    if (!selectedClip) return;
    deleteTimelineClip(selectedClip.kind, selectedClip.id);
  }

  function deepCloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function captureTimelineSlice() {
    return {
      tracks: deepCloneJson(tracks),
      mains: deepCloneJson(mains),
      bridges: deepCloneJson(bridges),
      edits: deepCloneJson(edits),
      audios: deepCloneJson(audios),
      selectedClip: selectedClip
        ? { kind: selectedClip.kind, id: selectedClip.id }
        : null,
    };
  }

  function clearTimelineUndoHistory() {
    timelineUndoStack = [];
    timelineRedoStack = [];
  }

  function restoreTimelineSlice(slice) {
    if (!slice) return;
    const prevSuppress = suppressSave;
    suppressSave = true;
    tracks = Array.isArray(slice.tracks) ? deepCloneJson(slice.tracks) : tracks;
    mains = Array.isArray(slice.mains) ? deepCloneJson(slice.mains) : [];
    bridges = Array.isArray(slice.bridges) ? deepCloneJson(slice.bridges) : [];
    edits = Array.isArray(slice.edits) ? deepCloneJson(slice.edits) : [];
    audios = Array.isArray(slice.audios) ? deepCloneJson(slice.audios) : [];
    ensureDefaultTrack();
    const sel = slice.selectedClip;
    if (sel && findClip(sel.kind, sel.id)) {
      selectedClip = { kind: sel.kind, id: sel.id };
    } else {
      selectedClip = null;
    }
    if (typeof buildStoryboardStateFromClips === "function") {
      storyboardState = buildStoryboardStateFromClips();
    }
    rebuildTimeline();
    renderAll();
    suppressSave = prevSuppress;
    scheduleSaveDraft();
  }

  /** Push current timeline state before a user mutation. Clears redo. */
  function pushTimelineUndo(_label) {
    timelineUndoStack.push(captureTimelineSlice());
    if (timelineUndoStack.length > TIMELINE_UNDO_MAX) {
      timelineUndoStack.shift();
    }
    timelineRedoStack = [];
  }

  function undoTimeline() {
    if (!timelineUndoStack.length) return false;
    const prev = timelineUndoStack.pop();
    timelineRedoStack.push(captureTimelineSlice());
    if (timelineRedoStack.length > TIMELINE_UNDO_MAX) {
      timelineRedoStack.shift();
    }
    restoreTimelineSlice(prev);
    return true;
  }

  function redoTimeline() {
    if (!timelineRedoStack.length) return false;
    const next = timelineRedoStack.pop();
    timelineUndoStack.push(captureTimelineSlice());
    if (timelineUndoStack.length > TIMELINE_UNDO_MAX) {
      timelineUndoStack.shift();
    }
    restoreTimelineSlice(next);
    return true;
  }

  /**
   * Deep-clone a timeline clip into a new slot object with a fresh id.
   * Clears taskId so the clone is not bound to the source job.
   * @param {'main'|'bridge'|'edit'|'audio'} kind
   * @param {object} clip
   * @param {object} [overrides]
   */
  function cloneClipPayload(kind, clip, overrides) {
    const prefix =
      kind === "main"
        ? "m"
        : kind === "bridge"
          ? "b"
          : kind === "audio"
            ? "a"
            : "e";
    const raw = JSON.parse(JSON.stringify(clip || {}));
    raw.id = uid(prefix);
    if (kind !== "audio") raw.taskId = null;
    if (overrides && typeof overrides === "object") {
      Object.assign(raw, overrides);
    }
    if (kind !== "audio" && raw.taskId === undefined) raw.taskId = null;
    return raw;
  }

  function pushClonedClip(kind, clipObj) {
    if (kind === "main") mains.push(clipObj);
    else if (kind === "bridge") bridges.push(clipObj);
    else if (kind === "edit") edits.push(clipObj);
    else if (kind === "audio") audios.push(clipObj);
  }

  function clipResolvedOutSec(clip) {
    const inSec = Number(clip.inSec) || 0;
    if (clip.outSec != null && Number(clip.outSec) > inSec) {
      return Number(clip.outSec);
    }
    return inSec + clipDuration(clip);
  }

  function canSplitClipAtPlayhead(kind, id) {
    const clip = findClip(kind, id);
    if (!clip) return false;
    const start = Number(clip.startSec) || 0;
    const end = start + clipDuration(clip);
    return (
      playheadSec > start + MIN_CLIP_TRIM_SEC &&
      playheadSec < end - MIN_CLIP_TRIM_SEC
    );
  }

  /** Split selected/target slot at playhead into two soft-trimmed halves. */
  function splitClipAtPlayhead(kind, id) {
    const clip = findClip(kind, id);
    if (!clip || !canSplitClipAtPlayhead(kind, id)) return false;
    pushTimelineUndo("split");
    const start = Number(clip.startSec) || 0;
    const inSec = Number(clip.inSec) || 0;
    const originOut = clipResolvedOutSec(clip);
    const splitSrc = inSec + (playheadSec - start);
    const snapshot = JSON.parse(JSON.stringify(clip));
    snapshot.outSec = originOut;
    const right = cloneClipPayload(kind, snapshot, {
      inSec: splitSrc,
      outSec: originOut,
      startSec: playheadSec,
      trackId: clip.trackId,
      taskId: null,
      linkedFrom: null,
    });
    clip.inSec = inSec;
    clip.outSec = splitSrc;
    pushClonedClip(kind, right);
    selectedClip = { kind, id: right.id };
    closeClipContextMenu();
    rebuildTimeline();
    syncClipSelectionHighlight();
    renderSelectionUI();
    scheduleSaveDraft();
    return true;
  }

  function copyTimelineClip(kind, id) {
    const clip = findClip(kind, id);
    if (!clip) return false;
    const payload = JSON.parse(JSON.stringify(clip));
    payload.taskId = null;
    clipClipboard = { kind, payload };
    return true;
  }

  function pasteTimelineClip() {
    if (!clipClipboard || !clipClipboard.payload) return false;
    pushTimelineUndo("paste");
    const kind = clipClipboard.kind;
    let trackId;
    if (kind === "audio") {
      trackId = ensureAudioTrack();
    } else if (kind === "edit") {
      trackId = editTrackId();
    } else {
      trackId = defaultVideoTrackId();
    }
    if (selectedClip) {
      const sel = findClip(selectedClip.kind, selectedClip.id);
      if (sel && sel.trackId) {
        const selTrack = tracks.find((tr) => tr.id === sel.trackId);
        if (selTrack && trackAllowsClipKind(selTrack, kind)) {
          trackId = sel.trackId;
        }
      }
    }
    const start = snapStartSec(Math.max(0, playheadSec), null, null);
    const pasted = cloneClipPayload(kind, clipClipboard.payload, {
      startSec: start,
      trackId,
      taskId: null,
    });
    pushClonedClip(kind, pasted);
    selectedClip = { kind, id: pasted.id };
    closeClipContextMenu();
    rebuildTimeline();
    syncClipSelectionHighlight();
    renderSelectionUI();
    scheduleSaveDraft();
    return true;
  }

  function closeClipContextMenu() {
    if (clipCtxMenuEl) {
      clipCtxMenuEl.remove();
      clipCtxMenuEl = null;
    }
    if (clipCtxMenuCloser) {
      document.removeEventListener("pointerdown", clipCtxMenuCloser, true);
      clipCtxMenuCloser = null;
    }
  }

  function editorChannelReady() {
    const cfg = getVideoChannelConfig();
    return {
      platformRh: !!platformRhAvailable,
      agentOnline: !!agentConnected,
      videoChannel: cfg.channel,
    };
  }

  function setTimelineSelection(sel) {
    timelineSelection = sel;
    renderTimelineTrack();
  }

  function clearTimelineSelection() {
    timelineSelection = null;
    renderTimelineTrack();
  }

  function timelineSecFromClientX(clientX) {
    if (!timelineScroll) return 0;
    const rect = timelineScroll.getBoundingClientRect();
    return Math.max(
      0,
      (clientX - rect.left + timelineScroll.scrollLeft) / pxPerSec
    );
  }

  /** Whether sec falls inside the current ruler frame/range selection. */
  function isSecInsideTimelineSelection(sec) {
    if (!timelineSelection) return false;
    if (timelineSelection.kind === "range") {
      const a = Math.min(timelineSelection.inSec, timelineSelection.outSec);
      const b = Math.max(timelineSelection.inSec, timelineSelection.outSec);
      return sec >= a && sec <= b;
    }
    if (timelineSelection.kind === "frame") {
      return Math.abs(sec - timelineSelection.inSec) <= 0.05;
    }
    return false;
  }

  /** Clear frame/range selection when click time is outside the box. */
  function clearTimelineSelectionIfOutsideSec(sec) {
    if (!timelineSelection) return false;
    if (
      timelineSelection.kind !== "range" &&
      timelineSelection.kind !== "frame"
    ) {
      return false;
    }
    if (isSecInsideTimelineSelection(sec)) return false;
    clearTimelineSelection();
    return true;
  }

  function selectionFromClip(kind, id) {
    const clip = findClip(kind, id);
    if (!clip) return null;
    const start = Number(clip.startSec) || 0;
    const end = start + clipDuration(clip);
    return {
      kind: "clip",
      inSec: start,
      outSec: end,
      sourceClip: { kind, id },
    };
  }

  function selectionFromPlayhead() {
    const tSec = Math.max(0, playheadSec);
    return { kind: "frame", inSec: tSec, outSec: tSec };
  }

  function selectionFromRange(a, b) {
    const inSec = Math.min(a, b);
    const outSec = Math.max(a, b);
    if (outSec - inSec < 0.05) {
      return { kind: "frame", inSec, outSec: inSec };
    }
    return { kind: "range", inSec, outSec };
  }

  function resolveActiveSelection(kind, id) {
    if (kind && id) {
      const clipSel = selectionFromClip(kind, id);
      if (clipSel) return clipSel;
    }
    if (
      timelineSelection &&
      (timelineSelection.kind === "range" || timelineSelection.kind === "frame")
    ) {
      return timelineSelection;
    }
    return selectionFromPlayhead();
  }

  function positionCtxMenu(menu, clientX, clientY) {
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(clientX, window.innerWidth - rect.width - 8);
    const top = Math.min(clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    clipCtxMenuEl = menu;
    setTimeout(() => {
      if (clipCtxMenuEl !== menu) return;
      clipCtxMenuCloser = (ev) => {
        if (clipCtxMenuEl && clipCtxMenuEl.contains(ev.target)) return;
        closeClipContextMenu();
      };
      document.addEventListener("pointerdown", clipCtxMenuCloser, true);
    }, 0);
  }

  function openClipContextMenu(clientX, clientY, kind, id) {
    openTimelineContextMenu(clientX, clientY, { clipKind: kind, clipId: id });
  }

  function openTimelineContextMenu(clientX, clientY, opts) {
    closeClipContextMenu();
    const clipKind = opts && opts.clipKind;
    const clipId = opts && opts.clipId;
    const selection = resolveActiveSelection(clipKind, clipId);
    if (!selection) return;

    if (clipKind && clipId && findClip(clipKind, clipId)) {
      selectedClip = { kind: clipKind, id: clipId };
      syncClipSelectionHighlight();
      renderSelectionUI();
    }

    const E = window.VflowEditors;
    const ready = editorChannelReady();
    const editors = E
      ? E.listEditorsForSelection(selection, ready)
      : [];
    const grouped = E ? E.groupEditors(editors) : { platform: [], user: [] };
    const allUser = E ? E.getUserEditors() : [];

    const menu = document.createElement("div");
    menu.className = "tl-ctx-menu tl-ctx-menu-wide";
    menu.setAttribute("role", "menu");

    const parts = [];
    parts.push(
      `<div class="tl-ctx-section">${escapeHtml(t("editor.menuMine"))}</div>`
    );
    if (grouped.user.length) {
      grouped.user.forEach((ed) => {
        const name = E.displayName(ed);
        parts.push(
          `<button type="button" role="menuitem" data-editor-id="${escapeHtml(
            ed.id
          )}" data-editor-source="user">${escapeHtml(name)}</button>`
        );
      });
    } else if (allUser.length && !ready.agentOnline) {
      parts.push(
        `<button type="button" role="menuitem" data-act="open-settings-editors">${escapeHtml(
          t("editor.menuNeedAgent")
        )}</button>`
      );
    } else {
      parts.push(
        `<button type="button" role="menuitem" data-act="open-settings-editors">${escapeHtml(
          t("editor.menuAddCustom")
        )}</button>`
      );
    }

    if (clipKind && clipId) {
      parts.push(`<div class="tl-ctx-sep"></div>`);
      const ctxClip = findClip(clipKind, clipId);
      const hasMedia = !!(ctxClip && ctxClip.playUrl);
      if (
        hasMedia &&
        (clipKind === "main" || clipKind === "bridge" || clipKind === "edit")
      ) {
        parts.push(
          `<button type="button" role="menuitem" data-act="detach-audio">${escapeHtml(
            t("timeline.detachAudio")
          )}</button>`
        );
        parts.push(
          `<button type="button" role="menuitem" data-act="toggle-mute">${escapeHtml(
            ctxClip.muteAudio
              ? t("timeline.unmuteClip")
              : t("timeline.muteClip")
          )}</button>`
        );
      }
      const canSplit = canSplitClipAtPlayhead(clipKind, clipId);
      parts.push(
        `<button type="button" role="menuitem" data-act="split"${
          canSplit ? "" : " disabled"
        } title="${escapeHtml(
          canSplit ? t("timeline.splitAtPlayhead") : t("timeline.splitDisabled")
        )}">${escapeHtml(t("timeline.splitAtPlayhead"))}</button>`
      );
      parts.push(
        `<button type="button" role="menuitem" data-act="copy">${escapeHtml(
          t("timeline.copySlot")
        )}</button>`
      );
      const canPaste = !!(clipClipboard && clipClipboard.payload);
      parts.push(
        `<button type="button" role="menuitem" data-act="paste"${
          canPaste ? "" : " disabled"
        } title="${escapeHtml(
          canPaste ? t("timeline.pasteSlot") : t("timeline.pasteEmpty")
        )}">${escapeHtml(t("timeline.pasteSlot"))}</button>`
      );
      const delLabel =
        clipKind === "bridge"
          ? t("bridge.deleteSlot")
          : clipKind === "edit"
            ? t("editor.deleteSlot")
            : clipKind === "audio"
              ? t("timeline.deleteAudio")
              : t("main.deleteSlot");
      parts.push(
        `<button type="button" role="menuitem" data-act="delete">${escapeHtml(
          delLabel
        )}</button>`
      );
    }

    menu.innerHTML = parts.join("");
    positionCtxMenu(menu, clientX, clientY);

    menu.querySelectorAll("[data-editor-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const editorId = btn.getAttribute("data-editor-id");
        closeClipContextMenu();
        runEditorOnSelection(editorId, selection).catch((err) => {
          console.error(err);
          alert(err.message || String(err));
        });
      });
    });
    const splitBtn = menu.querySelector('[data-act="split"]');
    if (splitBtn) {
      splitBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (splitBtn.disabled) return;
        if (!splitClipAtPlayhead(clipKind, clipId)) {
          alert(t("timeline.splitDisabled"));
        }
      });
    }
    const detachBtn = menu.querySelector('[data-act="detach-audio"]');
    if (detachBtn) {
      detachBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeClipContextMenu();
        detachAudioFromClip(clipKind, clipId);
      });
    }
    const muteBtn = menu.querySelector('[data-act="toggle-mute"]');
    if (muteBtn) {
      muteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeClipContextMenu();
        toggleClipMuteAudio(clipKind, clipId);
      });
    }
    const copyBtn = menu.querySelector('[data-act="copy"]');
    if (copyBtn) {
      copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeClipContextMenu();
        copyTimelineClip(clipKind, clipId);
      });
    }
    const pasteBtn = menu.querySelector('[data-act="paste"]');
    if (pasteBtn) {
      pasteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pasteBtn.disabled) return;
        if (!pasteTimelineClip()) {
          alert(t("timeline.pasteEmpty"));
        }
      });
    }
    const delBtn = menu.querySelector('[data-act="delete"]');
    if (delBtn) {
      delBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteTimelineClip(clipKind, clipId);
      });
    }
    const settingsBtn = menu.querySelector('[data-act="open-settings-editors"]');
    if (settingsBtn) {
      settingsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeClipContextMenu();
        openSettingsModal("workflows");
      });
    }
  }

  async function fetchPlatformEditors(force) {
    if (platformEditorsLoaded && !force) return platformEditorsCache;
    try {
      const data = await apiJson("/api/editors");
      platformEditorsCache = data.editors || [];
      platformEditorsLoaded = true;
      if (data.platformRhAvailable != null) {
        platformRhAvailable = !!data.platformRhAvailable;
      }
      if (window.VflowEditors) {
        window.VflowEditors.setPlatformEditors(platformEditorsCache);
      }
    } catch (e) {
      console.warn("fetch /api/editors failed", e);
      platformEditorsCache = [];
    }
    return platformEditorsCache;
  }

  /**
   * Compose the visible frame at timelineSec onto a canvas and return a JPEG File.
   */
  async function materializeFrameAt(timelineSec) {
    const placed = clipVisibleAt(timelineSec);
    if (!placed || !placed.playUrl) {
      throw new Error(t("editor.noFrameAtPlayhead"));
    }
    const srcIn =
      (Number(placed.inSec) || 0) +
      ((Number(timelineSec) || 0) - (Number(placed.start) || 0));
    const { blob } = await extractFrameBlobFromUrl(placed.playUrl, srcIn);
    return new File([blob], `frame_${Math.round(timelineSec * 100)}.jpg`, {
      type: blob.type || "image/jpeg",
    });
  }

  /**
   * Capture [inSec, outSec] from the composited timeline as a WebM Blob.
   * Prefers offline WebCodecs export (background-safe); falls back to MediaRecorder.
   */
  async function materializeRangeVideo(inSec, outSec) {
    const offlineApi = getOfflineExportApi();
    if (offlineApi && offlineApi.canOfflineExport()) {
      const plan = buildRangeExportPlan(inSec, outSec);
      const hasContent =
        plan.videoSegments.some((s) => s.playUrl && s.kind !== "gap") ||
        (plan.audioSegments && plan.audioSegments.length);
      if (!hasContent) throw new Error(t("editor.noRangeContent"));
      const abort = new AbortController();
      const blob = await offlineApi.encodeTimelineWebm(plan, {
        signal: abort.signal,
        loadVideo: loadExportVideo,
        seekVideo: seekExportVideo,
        drawFrame: drawVideoContain,
      });
      return new File(
        [blob],
        `range_${Math.round(inSec * 100)}_${Math.round(outSec * 100)}.webm`,
        { type: "video/webm" }
      );
    }

    const size = getWfSizePayload();
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error(t("common.canvasCreateFailed"));

    const mime = pickRecorderMime();
    if (!mime) throw new Error(t("common.webmUnsupported"));

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);

    const stream = canvas.captureStream(getGlobalFps());
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    recorder.start(200);

    const abort = new AbortController();
    try {
      const segs = buildSchedule().filter(
        (s) => s.gEnd > inSec && s.gStart < outSec
      );
      if (!segs.length) throw new Error(t("editor.noRangeContent"));
      for (const seg of segs) {
        const clipStart = Math.max(seg.gStart, inSec);
        const clipEnd = Math.min(seg.gEnd, outSec);
        const dur = clipEnd - clipStart;
        if (dur < 0.02) continue;
        if (seg.kind === "gap" || !seg.playUrl) {
          await holdBlackOnCanvas(ctx, canvas, dur, abort.signal, null);
          continue;
        }
        const srcIn = (Number(seg.srcIn) || 0) + (clipStart - seg.gStart);
        await loadExportVideo(video, seg.playUrl, abort.signal);
        await playSegmentToCanvas(
          video,
          ctx,
          canvas,
          { srcIn, duration: dur },
          abort.signal,
          null
        );
      }
      await flushAndStopRecorder(recorder, getGlobalFps());
      await stopped;
      if (!chunks.length) throw new Error(t("editor.rangeCaptureEmpty"));
      return new File(
        [new Blob(chunks, { type: mime.split(";")[0] || "video/webm" })],
        `range_${Math.round(inSec * 100)}_${Math.round(outSec * 100)}.webm`,
        { type: mime.split(";")[0] || "video/webm" }
      );
    } finally {
      try {
        video.pause();
      } catch (_) {}
      video.removeAttribute("src");
      try {
        video.load();
      } catch (_) {}
      video.remove();
      stream.getTracks().forEach((tr) => tr.stop());
    }
  }

  function findEditorManifest(editorId) {
    const E = window.VflowEditors;
    if (!E) return null;
    return (
      E.mergeAll().find((e) => e.id === editorId) ||
      null
    );
  }

  function clearEditorSlotInspector() {
    const Modal = window.VflowEditorInputModal;
    if (Modal && typeof Modal.unmount === "function") {
      Modal.unmount();
    }
    if (editorSlotPanel) editorSlotPanel.classList.add("hidden");
    if (editorSlotFields) editorSlotFields.innerHTML = "";
    if (editorSlotDesc) {
      editorSlotDesc.textContent = "";
      editorSlotDesc.classList.add("hidden");
    }
    if (selectionPromptWrap) selectionPromptWrap.classList.remove("hidden");
  }

  /**
   * Editor clips use the generic modal for media + params.
   * Right inspector only shows a summary and a button to open that modal.
   * @param {EditSeg|null} ed
   */
  function syncEditorSlotInspector(ed) {
    const Modal = window.VflowEditorInputModal;
    if (Modal && typeof Modal.unmount === "function") {
      Modal.unmount();
    }
    if (editorSlotFields) editorSlotFields.innerHTML = "";
    if (!ed || !editorSlotPanel) {
      clearEditorSlotInspector();
      return;
    }
    const editor = findEditorManifest(ed.editorId);
    if (!editor) {
      clearEditorSlotInspector();
      if (selectionPromptWrap) selectionPromptWrap.classList.remove("hidden");
      return;
    }

    if (selectionPromptWrap) selectionPromptWrap.classList.add("hidden");
    editorSlotPanel.classList.remove("hidden");

    const E = window.VflowEditors;
    const name = E
      ? E.displayName(editor)
      : ed.editorName || editor.name || editor.id || "";
    if (editorSlotTitle) {
      editorSlotTitle.textContent = t("inspector.editorParamsNamed", {
        name: name || t("inspector.editorParams"),
      });
    }
    const description = E
      ? E.displayDescription(editor)
      : (editor && editor.description) || "";
    if (editorSlotDesc) {
      editorSlotDesc.textContent =
        description || t("inspector.editorModalHint");
      editorSlotDesc.classList.remove("hidden");
    }
    const openBtn = document.getElementById("btnOpenEditorParams");
    if (openBtn) {
      openBtn.textContent = t("inspector.openEditorModal");
      openBtn.onclick = () => {
        rerunEditClip(ed).catch((err) => {
          if (err && /canceled|取消/i.test(String(err.message || err))) return;
          alert((err && err.message) || String(err));
        });
      };
    }
  }

  function mergedJobsList() {
    const server = userJobsCache || [];
    const local = localJobsCache || [];
    return [...local, ...server].sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
      const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
      return tb - ta;
    });
  }

  function upsertLocalJob(partial) {
    if (!partial || !partial.id) return null;
    const now = new Date().toISOString();
    const idx = localJobsCache.findIndex((j) => j.id === partial.id);
    const prev = idx >= 0 ? localJobsCache[idx] : null;
    const next = {
      ...(prev || {}),
      ...partial,
      local: true,
      updatedAt: now,
      createdAt: (prev && prev.createdAt) || partial.createdAt || now,
      submittedAt:
        (prev && prev.submittedAt) || partial.submittedAt || null,
    };
    if (idx >= 0) localJobsCache[idx] = next;
    else localJobsCache.unshift(next);
    localJobsCache = localJobsCache.slice(0, 40);
    renderJobsPanel();
    return next;
  }

  function removeLocalJob(jobId) {
    localJobsCache = localJobsCache.filter((j) => j.id !== jobId);
    renderJobsPanel();
  }

  function rememberUserEditorDefaults(editor, paramValues, prompt) {
    if (!editor || editor.source !== "user") return;
    const E = window.VflowEditors;
    if (!E || typeof E.upsertUserEditor !== "function") return;
    try {
      const params = Array.isArray(editor.params)
        ? editor.params.map((p) => {
            if (!p || !p.id) return p;
            if (p.type === "audio") return p;
            const v =
              paramValues && paramValues[p.id] != null && paramValues[p.id] !== ""
                ? paramValues[p.id]
                : p.bind === "prompt" && prompt
                  ? prompt
                  : undefined;
            if (v === undefined) return p;
            return { ...p, default: v };
          })
        : editor.params;
      const next = {
        ...editor,
        params,
        defaultPrompt:
          prompt != null && prompt !== ""
            ? prompt
            : editor.defaultPrompt || "",
      };
      E.upsertUserEditor(next);
    } catch (e) {
      console.warn("rememberUserEditorDefaults failed", e);
    }
  }

  /**
   * @param {string} editorId
   * @param {object} selection
   * @param {{ existingEdit?: object, input?: object }} [opts]
   */
  async function runEditorOnSelection(editorId, selection, opts) {
    const editor = findEditorManifest(editorId);
    if (!editor) throw new Error(t("editor.notFound"));
    if (!currentProjectId) throw new Error(t("jobs.openProjectFirst"));
    const existingEdit = opts && opts.existingEdit ? opts.existingEdit : null;

    if (globalStatus) {
      globalStatus.textContent = t("editor.preparing", {
        name: editor.name || editorId,
      });
    }

    const Modal = window.VflowEditorInputModal;
    if (!Modal || typeof Modal.collect !== "function") {
      throw new Error(t("common.localModuleMissing"));
    }
    let input = opts && opts.input && typeof opts.input === "object" ? opts.input : null;
    if (!input) {
      const initialValues = {};
      if (existingEdit) {
        if (existingEdit.prompt) initialValues.prompt = existingEdit.prompt;
        if (
          existingEdit.editorParams &&
          typeof existingEdit.editorParams === "object"
        ) {
          Object.assign(initialValues, existingEdit.editorParams);
        }
      }
      input = await Modal.collect(editor, { initialValues });
    }
    const collectedPrompt = (input && input.prompt) || "";
    const audioFile = (input && input.audioFile) || null;
    const paramValues =
      (input && input.paramValues && typeof input.paramValues === "object"
        ? input.paramValues
        : {}) || {};
    // Semantic overrides from params bind (negative/width/…)
    const boundValues = {};
    ["negative", "width", "height", "length", "fps", "seedHigh", "seedLow"].forEach(
      (k) => {
        if (input && input[k] != null && input[k] !== "") boundValues[k] = input[k];
      }
    );
    rememberUserEditorDefaults(editor, paramValues, collectedPrompt);

    let uploadedAudioName = null;
    if (audioFile && editor.source === "platform") {
      const up = await uploadImage(audioFile);
      uploadedAudioName = up.fileName;
    }

    let imageFile = null;
    let videoFile = null;
    let uploadedImageName = null;
    let uploadedVideoName = null;
    const extraImageFiles =
      input && input.imageFiles && typeof input.imageFiles === "object"
        ? input.imageFiles
        : {};
    const extraVideoFile =
      (input && input.videoFile) ||
      (input && input.videoFiles && input.videoFiles.inputVideo) ||
      null;

    if (editor.input === "image") {
      const frameSec = selection.inSec;
      imageFile = await materializeFrameAt(frameSec);
      if (editor.source === "platform") {
        const up = await uploadImage(imageFile);
        uploadedImageName = up.fileName;
      }
    } else {
      const inSec = selection.inSec;
      const outSec =
        selection.kind === "frame"
          ? selection.inSec + Math.max(0.5, estimatedDurationSec(null))
          : selection.outSec;
      videoFile = await materializeRangeVideo(inSec, outSec);
      if (editor.source === "platform") {
        const up = await uploadImage(videoFile);
        uploadedVideoName = up.fileName;
      }
    }

    if (extraVideoFile && editor.input === "image") {
      videoFile = extraVideoFile;
      if (editor.source === "platform") {
        const up = await uploadImage(extraVideoFile);
        boundValues.inputVideo = up.fileName;
      }
    }
    for (const key of Object.keys(extraImageFiles)) {
      const f = extraImageFiles[key];
      if (!f || typeof File === "undefined" || !(f instanceof File)) continue;
      if (editor.source === "platform") {
        const up = await uploadImage(f);
        boundValues[key] = up.fileName;
      }
    }

    const dur =
      selection.kind === "frame"
        ? estimatedDurationSec(null)
        : Math.max(0.5, selection.outSec - selection.inSec);
    let ed = existingEdit;
    if (ed) {
      ed.editorId = editor.id;
      ed.editorSource = editor.source || ed.editorSource;
      ed.editorName = editor.name || editor.id || ed.editorName;
      ed.sourceSelection = selection
        ? {
            kind: selection.kind,
            inSec: selection.inSec,
            outSec: selection.outSec,
            sourceClip: selection.sourceClip
              ? { ...selection.sourceClip }
              : null,
          }
        : ed.sourceSelection;
      ed.playUrl = null;
      ed.mediaFileId = null;
      ed.results = [];
      ed.taskId = null;
      ed.dirty = true;
      ed.durationSec = dur;
      ed.startSec =
        ed.startSec != null ? ed.startSec : selection.inSec;
    } else {
      ed = emptyEdit(editor, selection, {
        trackId: editTrackId(),
        startSec: selection.inSec,
        durationSec: dur,
      });
      edits.push(ed);
    }
    if (collectedPrompt) ed.prompt = collectedPrompt;
    ed.editorParams = paramValues;
    selectedClip = { kind: "edit", id: ed.id };
    renderAll();
    scheduleSaveDraft();

    if (editor.source === "platform") {
      const size = commitWfSizeInputs();
      const useDuck = isUseDuckEncrypt();
      const request = {
        mode: "edit",
        editorId: editor.id,
        editorSource: "platform",
        prompt: ed.prompt || editor.name || "",
        negative:
          boundValues.negative != null
            ? String(boundValues.negative)
            : negativeInput.value.trim(),
        startImageFileName: uploadedImageName || undefined,
        imageFileName: uploadedImageName || undefined,
        inputVideoFileName: uploadedVideoName || undefined,
        inputAudioFileName: uploadedAudioName || undefined,
        width:
          boundValues.width != null ? Number(boundValues.width) : size.width,
        height:
          boundValues.height != null ? Number(boundValues.height) : size.height,
        length:
          boundValues.length != null
            ? Number(boundValues.length)
            : resolveClipLength(ed),
        fps:
          boundValues.fps != null
            ? Number(boundValues.fps)
            : resolveClipFps(ed),
        frame_rate:
          boundValues.fps != null
            ? Number(boundValues.fps)
            : resolveClipFps(ed),
        paramValues,
        useDuckEncrypt: useDuck,
        password: useDuck && duckPasswordEl ? duckPasswordEl.value : "",
      };
      const editSeeds = freshNoiseSeeds();
      request.seedHigh =
        boundValues.seedHigh != null && boundValues.seedHigh !== ""
          ? boundValues.seedHigh
          : editSeeds.seedHigh;
      request.seedLow =
        boundValues.seedLow != null && boundValues.seedLow !== ""
          ? boundValues.seedLow
          : editSeeds.seedLow;
      ed.status = "queued";
      ed.label = t("status.queuing");
      await enqueueJobs([
        { kind: "edit", refId: ed.id, request },
      ]);
      return;
    }

    // User custom → local agent queue (snapshot + concurrent drain)
    const adapterMode = {
      workflowId: (editor.adapter && editor.adapter.workflowId) || "",
      workflow:
        (editor.adapter && editor.adapter.workflow) ||
        (editor.adapter &&
          editor.adapter.workflowUi &&
          window.VflowAdapter &&
          window.VflowAdapter.uiWorkflowToApiPrompt(
            editor.adapter.workflowUi
          )) ||
        null,
      bindings: (editor.adapter && editor.adapter.bindings) || {},
      params: editor.params || [],
    };
    ed.status = "pending";
    ed.label = t("status.pending");
    const customEditSeeds = freshNoiseSeeds();
    await enqueueLocalJobSpec({
      kind: "edit",
      refId: ed.id,
      request: {
        mode: "edit",
        editorId: editor.id,
        editorSource: "user",
        prompt: ed.prompt || editor.name || "",
        negative:
          boundValues.negative != null
            ? String(boundValues.negative)
            : negativeInput.value.trim(),
        width:
          boundValues.width != null ? Number(boundValues.width) : undefined,
        height:
          boundValues.height != null ? Number(boundValues.height) : undefined,
        length:
          boundValues.length != null ? Number(boundValues.length) : undefined,
        fps: boundValues.fps != null ? Number(boundValues.fps) : undefined,
        seedHigh:
          boundValues.seedHigh != null && boundValues.seedHigh !== ""
            ? boundValues.seedHigh
            : customEditSeeds.seedHigh,
        seedLow:
          boundValues.seedLow != null && boundValues.seedLow !== ""
            ? boundValues.seedLow
            : customEditSeeds.seedLow,
        paramValues,
      },
      files: {
        imageFile,
        videoFile,
        audioFile,
        boundValues,
        paramValues,
        editorId: editor.id,
        provider: editor.provider || "comfyui",
        adapterMode,
      },
    });
  }

  async function rerunEditClip(ed) {
    if (!ed) throw new Error(t("editor.notFound"));
    const editorId = ed.editorId;
    if (!editorId) throw new Error(t("editor.notFound"));
    const sel = ed.sourceSelection;
    if (!sel || sel.inSec == null) {
      throw new Error(t("editor.rerunNeedSelection"));
    }
    const selection = {
      kind: sel.kind || "range",
      inSec: Number(sel.inSec) || 0,
      outSec:
        sel.outSec != null
          ? Number(sel.outSec)
          : Number(sel.inSec) || 0,
      sourceClip: sel.sourceClip || null,
    };
    const opts = { existingEdit: ed };
    return runEditorOnSelection(editorId, selection, opts);
  }

  async function runLocalEditorJob(ed, editor, files) {
    const cfg = getVideoChannelConfig();
    if (!window.VflowLocal || !window.VflowAdapter) {
      throw new Error(t("common.localModuleMissing"));
    }
    if (window.VflowLocal.ensureAgentOnline) {
      await window.VflowLocal.ensureAgentOnline();
    }
    const size = commitWfSizeInputs();
    const adapterMode = {
      workflowId: (editor.adapter && editor.adapter.workflowId) || "",
      workflow:
        (editor.adapter && editor.adapter.workflow) ||
        (editor.adapter &&
          editor.adapter.workflowUi &&
          window.VflowAdapter &&
          window.VflowAdapter.uiWorkflowToApiPrompt(
            editor.adapter.workflowUi
          )) ||
        null,
      bindings: (editor.adapter && editor.adapter.bindings) || {},
      params: editor.params || [],
    };
    const bound = { ...((files && files.boundValues) || {}) };
    const paramValues =
      (files && files.paramValues && typeof files.paramValues === "object"
        ? files.paramValues
        : ed.editorParams) || {};
    (editor.params || []).forEach((p) => {
      if (!p) return;
      if (p.visibility === "hidden" && p.bind) {
        if (bound[p.bind] != null && bound[p.bind] !== "") return;
        if (p.default != null && p.default !== "") {
          bound[p.bind] = p.default;
        }
        return;
      }
      if (!p.bind || p.type === "audio") return;
      const raw =
        paramValues[p.id] != null && paramValues[p.id] !== ""
          ? paramValues[p.id]
          : p.default;
      if (raw == null || raw === "") return;
      if (bound[p.bind] == null || bound[p.bind] === "") {
        bound[p.bind] = raw;
      }
    });
    const values = {
      prompt: ed.prompt || editor.name || "",
      negative:
        bound.negative != null
          ? String(bound.negative)
          : (negativeInput && negativeInput.value.trim()) || "",
      width: bound.width != null ? Number(bound.width) : size.width,
      height: bound.height != null ? Number(bound.height) : size.height,
      length:
        bound.length != null ? Number(bound.length) : resolveClipLength(ed),
      fps: bound.fps != null ? Number(bound.fps) : resolveClipFps(ed),
      paramValues,
    };
    const localEditSeeds = freshNoiseSeeds();
    values.seedHigh =
      bound.seedHigh != null && bound.seedHigh !== ""
        ? bound.seedHigh
        : localEditSeeds.seedHigh;
    values.seedLow =
      bound.seedLow != null && bound.seedLow !== ""
        ? bound.seedLow
        : localEditSeeds.seedLow;
    Object.keys(bound).forEach((k) => {
      if (values[k] == null) values[k] = bound[k];
    });
    Object.keys(paramValues).forEach((k) => {
      if (values[k] == null) values[k] = paramValues[k];
    });

    const localJobId = `local-edit-${ed.id}`;
    const slotIndex = edits.findIndex((x) => x.id === ed.id) + 1;
    upsertLocalJob({
      id: localJobId,
      projectId: currentProjectId,
      projectName: currentProjectName,
      kind: "edit",
      refId: ed.id,
      slotIndex: slotIndex > 0 ? slotIndex : null,
      status: "running",
      rhTaskId: null,
      request: {
        mode: "edit",
        editorId: editor.id,
        editorSource: "user",
        prompt: values.prompt,
        paramValues,
      },
      result: null,
      error: null,
      canceled: false,
    });

    ed.status = "running";
    ed.label = t("status.agentRunning");
    ed.origin = "local";
    renderAll();

    const resultFilename =
      formatProjectSlotTimeName({
        projectName: currentProjectName,
        projectId: currentProjectId,
        kind: "edit",
        slotIndex: slotIndex > 0 ? slotIndex : 1,
        at: new Date().toISOString(),
      }) + ".mp4";
    const useDuck = isUseDuckEncrypt();
    const duckPassword =
      useDuck && duckPasswordEl ? duckPasswordEl.value || "" : "";

    const provider = editor.provider || "comfyui";
    let result;
    try {
      if (provider === "runninghub") {
        if (!cfg.rh || !cfg.rh.apiKey) {
          throw new Error(t("settings.fillRhApiKey"));
        }
        result = await window.VflowLocal.runRhJob({
          baseUrl: (cfg.rh && cfg.rh.baseUrl) || RH_DEFAULT_BASE,
          apiKey: cfg.rh.apiKey,
          adapterMode,
          values,
          imageFile: files.imageFile || null,
          videoFile: files.videoFile || null,
          audioFile: files.audioFile || null,
          kind: "edit",
          prompt: values.prompt,
          filename: resultFilename,
          projectId: currentProjectId,
          refId: ed.id,
          segmentKind: "edit",
          useDuckEncrypt: useDuck,
          password: duckPassword,
        });
      } else {
        result = await window.VflowLocal.runComfyJob({
          baseUrl: (cfg.comfy && cfg.comfy.baseUrl) || COMFY_DEFAULT_BASE,
          authHeader: (cfg.comfy && cfg.comfy.authHeader) || "",
          adapterMode,
          values,
          imageFile: files.imageFile || null,
          videoFile: files.videoFile || null,
          audioFile: files.audioFile || null,
          kind: "edit",
          prompt: values.prompt,
          filename: resultFilename,
          projectId: currentProjectId,
          refId: ed.id,
          segmentKind: "edit",
          useDuckEncrypt: useDuck,
          password: duckPassword,
        });
      }
    } catch (e) {
      ed.status = "failed";
      ed.label = t("status.failed");
      ed.meta = e.message || String(e);
      upsertLocalJob({
        id: localJobId,
        status: "failed",
        error: e.message || String(e),
      });
      renderAll();
      scheduleSaveDraft();
      throw e;
    }

    if (result && result.asset) {
      ed.playUrl = result.asset.playUrl;
      ed.status = "success";
      ed.label = t("status.success");
      ed.dirty = false;
      ed.origin = "local";
      ed.taskId = result.taskId;
      ed.mediaFileId = result.asset.id;
      ed.durationSec = null;
      upsertLocalJob({
        id: localJobId,
        status: "success",
        rhTaskId: result.taskId || null,
        result: {
          playUrl: result.asset.playUrl,
          results: [{ mediaFileId: result.asset.id }],
        },
        error: null,
      });
      probeClipDuration(ed).then(() => {
        rebuildTimeline();
        scheduleSaveDraft();
      });
    } else {
      ed.status = "failed";
      ed.label = t("status.failed");
      ed.meta = t("editor.localNoResult");
      upsertLocalJob({
        id: localJobId,
        status: "failed",
        error: ed.meta,
      });
    }
    await refreshAssetLibrary();
    renderAll();
    scheduleSaveDraft();
    if (globalStatus) globalStatus.textContent = t("editor.done");
    return result;
  }

  function clearClipLongPress() {
    if (longPressTimer != null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressState = null;
  }

  function abortClipDragForMenu() {
    if (trimState) {
      const el = trimState.el;
      try {
        if (trimState.pointerId != null) {
          el.releasePointerCapture(trimState.pointerId);
        }
      } catch (_) {}
      el.removeEventListener("pointermove", onTrimPointerMove);
      el.removeEventListener("pointerup", onTrimPointerUp);
      el.removeEventListener("pointercancel", onTrimPointerUp);
      el.classList.remove("is-trimming");
      suppressClipClickUntil = Date.now() + 450;
      trimState = null;
      renderTimelineTrack();
      return;
    }
    if (!dragState) return;
    const el = dragState.el;
    try {
      if (dragState.pointerId != null) el.releasePointerCapture(dragState.pointerId);
    } catch (_) {}
    el.removeEventListener("pointermove", onClipPointerMove);
    el.removeEventListener("pointerup", onClipPointerUp);
    el.removeEventListener("pointercancel", onClipPointerUp);
    el.classList.remove("is-dragging");
    if (timelineTracks) {
      timelineTracks.querySelectorAll(".tl-lane").forEach((lane) => {
        lane.classList.remove("is-drag-over");
      });
    }
    suppressClipClickUntil = Date.now() + 450;
    dragState = { ...dragState, moved: true };
    setTimeout(() => {
      dragState = null;
    }, 0);
    renderTimelineTrack();
  }

  function setMainsFromPrompts(texts) {
    const oldByPrompt = mains.slice();
    const trackId = defaultVideoTrackId();
    let cursor = 0;
    mains = (texts && texts.length ? texts : [""]).map((t, i) => {
      const prev = oldByPrompt[i];
      let m;
      if (prev && prev.prompt === t) {
        m = prev;
      } else if (prev) {
        m = {
          ...prev,
          prompt: t,
          dirty: prev.prompt !== t ? true : prev.dirty,
          label:
            prev.prompt !== t && prev.status === "success"
              ? t("status.promptChanged")
              : prev.label,
        };
      } else {
        m = emptyMain(t, { trackId, startSec: cursor });
      }
      normalizePlacementFields(m, trackId, cursor);
      cursor = clipTimelineEnd(m);
      return m;
    });
    renderAll();
  }

  /** @deprecated no-op: bridges are free-floating now */
  function ensureBridges() {
    ensureDefaultTrack();
  }

  /**
   * Clamp outSec to probed media duration when the trim end exceeds the file.
   * Does not expand intentional shorter trims (outSec < durationSec).
   */
  function clampClipOutSecToMedia(clip) {
    if (!clip) return false;
    const dur = Number(clip.durationSec);
    if (!(dur > 0) || !Number.isFinite(dur)) return false;
    const inSec = Number(clip.inSec) || 0;
    if (clip.outSec == null) {
      clip.outSec = dur;
      return true;
    }
    const out = Number(clip.outSec);
    if (Number.isFinite(out) && out > dur + 0.001) {
      clip.outSec = Math.max(inSec + 0.05, dur);
      return true;
    }
    return false;
  }

  function probeClipDuration(clip) {
    if (!clip || !clip.playUrl) return Promise.resolve(null);
    if (clip.durationSec != null && Number(clip.durationSec) > 0) {
      clampClipOutSecToMedia(clip);
      return Promise.resolve(Number(clip.durationSec));
    }
    const applyProbedDuration = (dur) => {
      if (dur == null || !Number.isFinite(dur) || !(dur > 0)) return null;
      clip.durationSec = dur;
      const inSec = Number(clip.inSec) || 0;
      // Fresh media: replace placeholder outSec with real length so export
      // keeps the ending. Mid-clip trims (inSec > 0) only clamp to EOF.
      if (inSec <= 0.001) {
        clip.outSec = dur;
      } else {
        clampClipOutSecToMedia(clip);
      }
      return dur;
    };
    const cached = durationProbeCache.get(clip);
    if (cached) {
      return cached.then((dur) => applyProbedDuration(dur));
    }
    const p = new Promise((resolve) => {
      const useAudio = clipUsesAudioProbe(clip);
      const v = document.createElement(useAudio ? "audio" : "video");
      v.preload = "metadata";
      if (!useAudio) v.muted = true;
      const finish = (dur) => {
        v.removeAttribute("src");
        v.load();
        v.remove();
        resolve(applyProbedDuration(dur));
      };
      v.addEventListener("loadedmetadata", () => finish(v.duration));
      v.addEventListener("error", () => finish(null));
      v.src = clip.playUrl;
    });
    durationProbeCache.set(clip, p);
    return p;
  }

  function probeAllClipDurations() {
    const jobs = [];
    mains.forEach((m) => {
      if (m.playUrl) jobs.push(probeClipDuration(m));
    });
    bridges.forEach((b) => {
      if (b.playUrl) jobs.push(probeClipDuration(b));
    });
    edits.forEach((ed) => {
      if (ed.playUrl) jobs.push(probeClipDuration(ed));
    });
    audios.forEach((a) => {
      if (a.playUrl) jobs.push(probeClipDuration(a));
    });
    if (!jobs.length) return Promise.resolve();
    return Promise.all(jobs).then(() => {
      renderTimelineTrack();
      buildSchedule();
      updatePlaylistMeta();
    });
  }

  function renderPromptList() {
    promptListEl.innerHTML = "";
    const clipState = buildStoryboardStateFromClips();
    storyboardState = {
      ...storyboardState,
      scriptSynopsis: storyboardState.scriptSynopsis || clipState.scriptSynopsis || "",
      shots: clipState.shots,
      bridges: clipState.bridges,
      clips: clipState.clips,
    };
    if (storyboardSynopsisEl) {
      const synopsis = String(storyboardState.scriptSynopsis || "").trim();
      storyboardSynopsisEl.textContent =
        synopsis || t("storyboard.synopsisEmpty");
      storyboardSynopsisEl.classList.toggle("muted", !synopsis);
    }
    updatePolishScopeUi(clipState.clips || collectLayer12Clips());
    const layerMains = mainsOnLayer1();
    const shownMainIds = new Set(layerMains.map((m) => m.id));
    const showPolishCheck = polishScopeMode === "selected";

    function attachPolishCheckbox(item, clipId) {
      if (!showPolishCheck) return;
      item.classList.add("has-polish-check");
      const lab = document.createElement("label");
      lab.className = "prompt-polish-check";
      lab.addEventListener("click", (e) => e.stopPropagation());
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = polishSelectedIds.has(clipId);
      cb.addEventListener("change", () => {
        if (cb.checked) polishSelectedIds.add(clipId);
        else polishSelectedIds.delete(clipId);
        updatePolishScopeUi();
        updateLlmButtonState();
      });
      lab.appendChild(cb);
      item.insertBefore(lab, item.firstChild);
    }

    function appendMainItem(m, displayIndex, isFinalMain, titleOverride) {
      const item = document.createElement("div");
      const focused =
        selectedClip &&
        selectedClip.kind === "main" &&
        selectedClip.id === m.id;
      item.className = "prompt-item prompt-card" + (focused ? " is-focused" : "");
      item.dataset.mainId = m.id;
      const durationLabel = `${Math.round(clipDuration(m) * 10) / 10}s`;
      const title = m.title || t("storyboard.defaultShotTitle", { n: displayIndex });
      const beat = m.beat || m.prompt || "";
      const camera = m.camera || t("common.dash");
      // Final main has no next seam — cutToNext is structural only; do not show as 硬切.
      const cutText = isFinalMain
        ? t("storyboard.endShot")
        : m.cutToNext === "soft"
          ? t("storyboard.cutToNextSoft")
          : t("storyboard.cutToNextHard");
      item.innerHTML = `
        <div class="prompt-item-head">
          <div class="prompt-card-title-wrap">
            <span class="prompt-item-title">${escapeHtml(titleOverride || t("inspector.mainSegment", { n: displayIndex }))}</span>
            <strong class="prompt-card-title">${escapeHtml(title)}</strong>
          </div>
          <div class="prompt-card-badges">
            <label class="prompt-card-badge prompt-card-duration-edit">
              <input type="number" class="prompt-card-duration-input" min="${MAIN_MIN_SEC}" max="${MAIN_MAX_SEC}" step="0.5" value="${Math.round(clipDuration(m) * 10) / 10}" />
              <span>s</span>
            </label>
            <span class="prompt-card-badge">${escapeHtml(camera)}</span>
            <span class="prompt-card-badge">${cutText}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm btn-remove">${t("common.delete")}</button>
        </div>
        <p class="prompt-card-beat">${escapeHtml(beat)}</p>
        <details class="prompt-card-details">
          <summary>${t("storyboard.expandPrompt")}</summary>
          <label class="field-label muted">${t("storyboard.shotTitleLabel")}</label>
          <input class="storyboard-inline-input prompt-card-title-input" type="text" value="${escapeAttr(title)}" />
          <label class="field-label muted">${t("storyboard.shotBeatLabel")}</label>
          <textarea rows="3" class="prompt-card-beat-input" placeholder="${t("storyboard.shotBeatPlaceholder")}">${escapeHtml(beat)}</textarea>
          <label class="field-label muted">${t("storyboard.shotCameraLabel")}</label>
          <input class="storyboard-inline-input prompt-card-camera-input" type="text" value="${escapeAttr(m.camera || "")}" placeholder="${t("storyboard.shotCameraPlaceholder")}" />
          <label class="field-label muted">${t("storyboard.mainPromptPlaceholder")}</label>
          <textarea rows="4" class="prompt-card-prompt-input" placeholder="${t("storyboard.mainPromptPlaceholder")}">${escapeHtml(m.prompt || "")}</textarea>
        </details>
      `;
      const titleInput = item.querySelector(".prompt-card-title-input");
      const beatInput = item.querySelector(".prompt-card-beat-input");
      const cameraInput = item.querySelector(".prompt-card-camera-input");
      const promptInput = item.querySelector(".prompt-card-prompt-input");
      const durationInput = item.querySelector(".prompt-card-duration-input");
      [titleInput, beatInput, cameraInput, promptInput, durationInput].forEach((el) => {
        if (!el) return;
        el.addEventListener("focus", () => {
          selectedClip = { kind: "main", id: m.id };
          syncClipSelectionHighlight();
        });
      });
      if (durationInput) {
        durationInput.addEventListener("change", () => {
          const E = window.VflowStoryboardEngines;
          const next = E
            ? E.clampMainSec(durationInput.value, storyboardEngineProfile)
            : Math.max(MAIN_MIN_SEC, Math.min(MAIN_MAX_SEC, Number(durationInput.value) || MAIN_DEFAULT_SEC));
          m.durationSec = next;
          durationInput.value = String(next);
          relayoutStoryboardTracks(true);
          storyboardState = buildStoryboardStateFromClips();
          scheduleSaveDraft();
        });
      }
      promptInput.addEventListener("input", () => {
        const prev = m.prompt;
        m.prompt = promptInput.value;
        if (prev !== m.prompt) {
          m.dirty = true;
          if (m.status === "success") m.label = t("status.promptChanged");
          renderJobList();
          updatePhaseSteps();
        }
        m.beat = beatInput.value.trim();
        m.title = titleInput.value.trim();
        m.camera = cameraInput.value.trim();
        storyboardState = buildStoryboardStateFromClips();
        updatePromptEmptyHint();
        scheduleSaveDraft();
      });
      titleInput.addEventListener("change", () => {
        m.title = titleInput.value.trim();
        storyboardState = buildStoryboardStateFromClips();
        renderPromptList();
        scheduleSaveDraft();
      });
      beatInput.addEventListener("change", () => {
        m.beat = beatInput.value.trim();
        storyboardState = buildStoryboardStateFromClips();
        renderPromptList();
        scheduleSaveDraft();
      });
      cameraInput.addEventListener("change", () => {
        m.camera = cameraInput.value.trim();
        storyboardState = buildStoryboardStateFromClips();
        renderPromptList();
        scheduleSaveDraft();
      });
      item.addEventListener("click", () => {
        selectedClip = { kind: "main", id: m.id };
        syncClipSelectionHighlight();
      });
      item.querySelector(".btn-remove").addEventListener("click", () => {
        const idx = mains.findIndex((x) => x.id === m.id);
        if (idx < 0) return;
        if (mains.length <= 1) {
          m.prompt = "";
          m.dirty = true;
          m.status = "pending";
          m.label = t("timeline.pendingGen");
          m.playUrl = null;
          m.results = [];
          renderAll();
          scheduleSaveDraft();
          return;
        }
        removeMainAt(idx);
      });
      attachPolishCheckbox(item, m.id);
      promptListEl.appendChild(item);
    }

    function appendBridgeItem(b, leftIdx, rightIdx, titleOverride) {
      const item = document.createElement("div");
      const focused =
        selectedClip &&
        selectedClip.kind === "bridge" &&
        selectedClip.id === b.id;
      item.className =
        "prompt-item prompt-card is-bridge" + (focused ? " is-focused" : "");
      item.dataset.bridgeId = b.id;
      const modeText =
        b.needBridge === false
          ? t("storyboard.hardCut")
          : t("storyboard.softCut");
      const durationText =
        b.needBridge === false
          ? t("storyboard.abutNoBridge")
          : t("storyboard.bridgeDurationLabel", {
              sec: Math.round(clipDuration(b) * 10) / 10,
            });
      item.innerHTML = `
        <div class="prompt-item-head">
          <div class="prompt-card-title-wrap">
            <span class="prompt-item-title">${escapeHtml(
              titleOverride ||
                t("storyboard.bridgeTag", { left: leftIdx, right: rightIdx })
            )}</span>
            <strong class="prompt-card-title">${modeText}</strong>
          </div>
          <div class="prompt-card-badges">
            <span class="prompt-card-badge">${durationText}</span>
            <span class="prompt-card-badge">${t("storyboard.bridgeItemMeta", { sec: BRIDGE_OVERLAP_SEC })}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm btn-remove">${t("common.delete")}</button>
        </div>
        <p class="prompt-card-beat">${escapeHtml(
          b.needBridge === false
            ? t("storyboard.abutHint")
            : b.prompt || t("storyboard.bridgePromptPlaceholder")
        )}</p>
        <details class="prompt-card-details"${b.needBridge === false ? " open" : ""}>
          <summary>${t("storyboard.expandPrompt")}</summary>
          <label class="field-label muted">${t("storyboard.bridgeModeLabel")}</label>
          <select class="storyboard-inline-input prompt-card-bridge-mode">
            <option value="soft"${b.needBridge === false ? "" : " selected"}>${t("storyboard.softCut")}</option>
            <option value="hard"${b.needBridge === false ? " selected" : ""}>${t("storyboard.hardCut")}</option>
          </select>
          <label class="field-label muted">${t("storyboard.bridgePromptPlaceholder")}</label>
          <textarea rows="3" class="prompt-card-prompt-input" placeholder="${t("storyboard.bridgePromptPlaceholder")}">${escapeHtml(b.prompt || "")}</textarea>
        </details>
      `;
      const modeInput = item.querySelector(".prompt-card-bridge-mode");
      const ta = item.querySelector(".prompt-card-prompt-input");
      [modeInput, ta].forEach((el) => {
        if (!el) return;
        el.addEventListener("focus", () => {
          selectedClip = { kind: "bridge", id: b.id };
          syncClipSelectionHighlight();
        });
      });
      item.addEventListener("click", () => {
        selectedClip = { kind: "bridge", id: b.id };
        syncClipSelectionHighlight();
      });
      modeInput.addEventListener("change", () => {
        const hard = modeInput.value === "hard";
        b.needBridge = !hard;
        const left = b.leftMainId ? mains.find((m) => m.id === b.leftMainId) : null;
        if (left) left.cutToNext = hard ? "hard" : "soft";
        if (hard) {
          b.prompt = "";
          const idx = bridges.findIndex((x) => x.id === b.id);
          if (idx >= 0) bridges.splice(idx, 1);
          layoutLayer1UnderLayer2Bridges();
        }
        storyboardState = buildStoryboardStateFromClips();
        renderAll();
        scheduleSaveDraft();
      });
      ta.addEventListener("input", () => {
        const prev = b.prompt;
        b.prompt = ta.value;
        if (prev !== b.prompt) {
          b.dirty = true;
          if (b.status === "success") b.label = t("status.promptChanged");
          renderJobList();
          renderBridges();
          updatePhaseSteps();
        }
        b.needBridge = true;
        const left = b.leftMainId ? mains.find((m) => m.id === b.leftMainId) : null;
        if (left) left.cutToNext = "soft";
        storyboardState = buildStoryboardStateFromClips();
        scheduleSaveDraft();
      });
      item.querySelector(".btn-remove").addEventListener("click", () => {
        removeBridgeById(b.id);
      });
      attachPolishCheckbox(item, b.id);
      promptListEl.appendChild(item);
    }

    const linkedBridgeIds = new Set();
    const seamUsed = new Set();
    layerMains.forEach((m, i) => {
      appendMainItem(m, i + 1, i === layerMains.length - 1);
      if (i < layerMains.length - 1) {
        const next = layerMains[i + 1];
        const b = findPhysicalBridgeForSeam(m, next, seamUsed);
        if (b) {
          seamUsed.add(b.id);
          linkedBridgeIds.add(b.id);
          appendBridgeItem(b, i + 1, i + 2);
        } else {
          const seam = document.createElement("div");
          seam.className = "prompt-seam prompt-seam-hard";
          seam.textContent = t("storyboard.hardCutSeam", {
            left: i + 1,
            right: i + 2,
          });
          promptListEl.appendChild(seam);
        }
      }
    });
    const layer2Mains = mains
      .filter((m) => clipStoryboardLayer(m) === 2)
      .sort((a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0));
    layer2Mains.forEach((m, i) => {
      appendMainItem(
        m,
        layerMains.length + i + 1,
        false,
        t("storyboard.layer2Main")
      );
    });
    bridgesOnLayer2()
      .filter((b) => !linkedBridgeIds.has(b.id))
      .forEach((b) => {
        appendBridgeItem(b, "–", "–", t("storyboard.layer2Bridge"));
      });
    const otherMains = mains.filter((m) => {
      const layer = clipStoryboardLayer(m);
      return layer !== 1 && layer !== 2 && !shownMainIds.has(m.id);
    });
    otherMains.forEach((m, i) => {
      appendMainItem(m, layerMains.length + layer2Mains.length + i + 1, false);
    });
  }

  function openStoryboardModal(opts) {
    if (!storyboardModal) return;
    storyboardState = buildStoryboardStateFromClips();
    renderPromptList();
    storyboardModal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    setActivePhase(1);
    populateLlmModelSelects();
    updateLlmButtonState();
    const wantStep = opts && opts.step === "prompts" ? "prompts" : "script";
    setStoryboardStep(wantStep);
    loadUserScripts().then(() => {
      if (opts && opts.scriptId) {
        const doc = userScripts.find((s) => Number(s.id) === Number(opts.scriptId));
        if (doc) selectScriptDoc(doc);
      }
    });
  }

  function closeStoryboardModal() {
    if (!storyboardModal) return;
    storyboardModal.classList.add("hidden");
    if (framePickerModal.classList.contains("hidden")) {
      document.body.classList.remove("modal-open");
    }
  }

  function openPresetDropdown() {
    if (!presetDropdownPanel || !btnPresetToggle) return;
    closeJobsDropdown();
    presetDropdownPanel.classList.remove("hidden");
    btnPresetToggle.setAttribute("aria-expanded", "true");
    presetDropdown.classList.add("is-open");
  }

  function closePresetDropdown() {
    if (!presetDropdownPanel || !btnPresetToggle) return;
    presetDropdownPanel.classList.add("hidden");
    btnPresetToggle.setAttribute("aria-expanded", "false");
    presetDropdown.classList.remove("is-open");
  }

  function togglePresetDropdown() {
    if (presetDropdownPanel.classList.contains("hidden")) {
      openPresetDropdown();
    } else {
      closePresetDropdown();
    }
  }

  function openJobsDropdown() {
    if (!jobsDropdownPanel || !btnJobsToggle) return;
    closePresetDropdown();
    jobsDropdownPanel.classList.remove("hidden");
    btnJobsToggle.setAttribute("aria-expanded", "true");
    if (jobsDropdown) jobsDropdown.classList.add("is-open");
    refreshUserJobs().catch((e) => console.warn(e));
  }

  function closeJobsDropdown() {
    if (!jobsDropdownPanel || !btnJobsToggle) return;
    jobsDropdownPanel.classList.add("hidden");
    btnJobsToggle.setAttribute("aria-expanded", "false");
    if (jobsDropdown) jobsDropdown.classList.remove("is-open");
  }

  function toggleJobsDropdown() {
    if (!jobsDropdownPanel) return;
    if (jobsDropdownPanel.classList.contains("hidden")) openJobsDropdown();
    else closeJobsDropdown();
  }

  function jobStatusLabel(job) {
    if (job.canceled) return t("status.canceled");
    const s = (job.status || "").toLowerCase();
    if (s === "pending") return t("status.pending");
    if (s === "queued") return t("status.queued");
    if (s === "running" || s === "finalizing") return t("status.running");
    if (s === "success") return t("status.success");
    if (s === "failed") return t("status.failed");
    return s || t("status.unknown");
  }

  function isActiveJobStatus(status) {
    return ["pending", "queued", "running", "finalizing"].includes(status);
  }

  function formatJobAge(iso) {
    if (!iso) return "";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "";
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return formatDurationSec(sec);
  }

  function formatDurationSec(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return t("jobs.durationSeconds", { n: s });
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) {
      return rem
        ? t("jobs.durationMinutesSeconds", { m, s: rem })
        : t("jobs.durationMinutes", { m });
    }
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm
      ? t("jobs.durationHoursMinutes", { h, m: rm })
      : t("jobs.durationHours", { h });
  }

  function formatJobTimeMeta(job) {
    // Duration starts at successful API submit; local/pending queue wait is excluded.
    let start = Date.parse(job.submittedAt);
    if (!Number.isFinite(start)) {
      if (!job.rhTaskId && isActiveJobStatus(job.status)) {
        return "";
      }
      start = Date.parse(job.createdAt);
      if (!Number.isFinite(start)) {
        return formatJobAge(job.updatedAt || job.createdAt);
      }
    }
    if (isActiveJobStatus(job.status)) {
      const sec = Math.max(0, Math.round((Date.now() - start) / 1000));
      return t("jobs.elapsed", { time: formatDurationSec(sec) });
    }
    const end = Date.parse(job.updatedAt || job.createdAt);
    if (!Number.isFinite(end)) return "";
    const sec = Math.max(0, Math.round((end - start) / 1000));
    return t("jobs.took", { time: formatDurationSec(sec) });
  }

  function sanitizeNamePart(value, fallback = "project") {
    const text = String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 80);
    return text || fallback;
  }

  function formatNameTimestamp(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (!Number.isFinite(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  function slotNameLabel(kind, slotIndex) {
    const n = Number(slotIndex);
    const idx = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    if (idx == null) {
      if (kind === "bridge") return t("jobs.kindBridge");
      if (kind === "edit") return t("jobs.kindEdit");
      if (kind === "t2i") return t("jobs.kindT2i");
      return t("jobs.kindMain");
    }
    if (kind === "bridge") return t("bridge.label", { n: idx });
    if (kind === "edit") return t("editor.labelShort", { n: idx });
    if (kind === "t2i") return t("jobs.kindT2i");
    return t("bridge.mainLabel", { n: idx });
  }

  function resolveJobSlotIndex(job) {
    const n = Number(job && job.slotIndex);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    if (job && job.projectId === currentProjectId && job.refId) {
      const list =
        job.kind === "bridge"
          ? bridges
          : job.kind === "edit"
            ? edits
            : mains;
      const i = list.findIndex((x) => x.id === job.refId);
      if (i >= 0) return i + 1;
    }
    return null;
  }

  function formatProjectSlotTimeName({
    projectName,
    projectId,
    kind,
    slotIndex,
    at,
  }) {
    const proj = sanitizeNamePart(
      projectName || "",
      projectId != null ? `p${projectId}` : "project"
    );
    const slot = slotNameLabel(kind, slotIndex);
    const ts = formatNameTimestamp(at);
    return ts ? `${proj}_${slot}_${ts}` : `${proj}_${slot}`;
  }

  function formatJobTitle(job) {
    const proj =
      (job.projectName && String(job.projectName).trim()) ||
      (job.projectId != null
        ? t("jobs.projectFallback", { id: job.projectId })
        : t("project.unnamed"));
    const slot = slotNameLabel(job.kind, resolveJobSlotIndex(job));
    return `${proj} · ${slot}`;
  }

  function renderJobsPanel() {
    if (!jobsListEl) return;
    const jobs = mergedJobsList();
    const active = jobs.filter((j) => isActiveJobStatus(j.status));
    const localActive = (localJobsCache || []).filter((j) =>
      isActiveJobStatus(j.status)
    );
    const pendingN =
      (jobsPanelMeta.pendingCount != null
        ? jobsPanelMeta.pendingCount
        : active.filter((j) => j.status === "pending" && !j.local).length) +
      localActive.filter((j) => j.status === "pending").length;
    const runningN =
      (jobsPanelMeta.runningCount != null
        ? jobsPanelMeta.runningCount
        : active.filter(
            (j) =>
              !j.local &&
              ["queued", "running", "finalizing"].includes(j.status)
          ).length) +
      localActive.filter((j) =>
        ["queued", "running", "finalizing"].includes(j.status)
      ).length;
    if (jobsBadge) {
      if (active.length) {
        jobsBadge.textContent = String(active.length);
        jobsBadge.classList.remove("hidden");
      } else {
        jobsBadge.classList.add("hidden");
      }
    }
    if (jobsPanelHint) {
      jobsPanelHint.textContent =
        t("topbar.jobsPendingRunning", { pending: pendingN, running: runningN }) +
        t("topbar.jobsConcurrency", {
          perUser: jobsPanelMeta.perUserMaxRunning,
          global: jobsPanelMeta.globalMaxRunning,
        }) +
        t("topbar.jobsQueueHint", {
          minutes: Math.round((jobsPanelMeta.staleSeconds || 2700) / 60),
        });
    }
    jobsListEl.innerHTML = "";
    if (!jobs.length) {
      if (jobsEmpty) jobsEmpty.classList.remove("hidden");
      return;
    }
    if (jobsEmpty) jobsEmpty.classList.add("hidden");
    jobs.forEach((job) => {
      const li = document.createElement("li");
      li.className =
        "jobs-item" +
        (isActiveJobStatus(job.status) ? " is-active" : "");
      const err = job.error
        ? escapeHtml(String(localizeStoredLabel(job.error)).slice(0, 120))
        : "";
      const canRetry =
        !isActiveJobStatus(job.status) &&
        (job.status === "failed" || job.status === "success") &&
        job.kind === "edit" &&
        job.refId;
      li.innerHTML = `
        <div class="jobs-item-main">
          <span class="badge ${badgeClass(job.status)}">${escapeHtml(jobStatusLabel(job))}</span>
          <span class="jobs-item-title">${escapeHtml(formatJobTitle(job))}${
            job.local ? ` · ${escapeHtml(t("jobs.localTag"))}` : ""
          }</span>
          <span class="muted jobs-item-age">${escapeHtml(formatJobTimeMeta(job))}</span>
        </div>
        ${err ? `<p class="jobs-item-error muted">${err}</p>` : ""}
        <div class="row gap jobs-item-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="open">${t("jobs.openProject")}</button>
          ${
            canRetry
              ? `<button type="button" class="btn btn-ghost btn-sm" data-act="retry">${t("jobs.retry")}</button>`
              : ""
          }
          ${
            isActiveJobStatus(job.status)
              ? `<button type="button" class="btn btn-danger btn-sm" data-act="force">${t("jobs.forceEnd")}</button>`
              : `<button type="button" class="btn btn-ghost btn-sm" data-act="delete">${t("jobs.deleteRecord")}</button>`
          }
        </div>
      `;
      li.querySelector('[data-act="open"]').addEventListener("click", async () => {
        closeJobsDropdown();
        if (job.projectId && job.projectId !== currentProjectId) {
          try {
            await loadProject(job.projectId);
          } catch (e) {
            alert(e.message || String(e));
          }
        }
      });
      const retryBtn = li.querySelector('[data-act="retry"]');
      if (retryBtn) {
        retryBtn.addEventListener("click", async () => {
          try {
            await retryJob(job);
            await refreshUserJobs();
          } catch (e) {
            alert(e.message || String(e));
          }
        });
      }
      const forceBtn = li.querySelector('[data-act="force"]');
      if (forceBtn) {
        forceBtn.addEventListener("click", async () => {
          try {
            if (job.local) {
              upsertLocalJob({
                id: job.id,
                status: "failed",
                canceled: true,
                error: t("status.forceEnded"),
              });
              const seg =
                job.kind === "main"
                  ? findMain(job.refId)
                  : job.kind === "bridge"
                    ? findBridge(job.refId)
                    : findEdit(job.refId);
              if (seg && isActiveJobStatus(seg.status)) {
                seg.status = "failed";
                seg.label = t("status.forceEnded");
                seg.meta = t("status.forceEnded");
                renderAll();
                scheduleSaveDraft();
              }
            } else {
              await forceFailJobs({ jobIds: [job.id] });
              await refreshUserJobs();
              if (job.projectId === currentProjectId) await syncActiveJobs();
            }
          } catch (e) {
            alert(e.message || String(e));
          }
        });
      }
      const deleteBtn = li.querySelector('[data-act="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener("click", async () => {
          try {
            if (job.local) {
              removeLocalJob(job.id);
            } else {
              await postJson("/api/jobs/delete", { jobIds: [job.id] });
              await refreshUserJobs();
            }
          } catch (e) {
            alert(e.message || String(e));
          }
        });
      }
      jobsListEl.appendChild(li);
    });
  }

  async function retryJob(job) {
    if (!job) throw new Error(t("editor.notFound"));
    if (job.projectId && job.projectId !== currentProjectId) {
      await loadProject(job.projectId);
    }
    if (job.kind === "t2i") {
      const req = job.request || {};
      if (req.prompt && firstFramePrompt) {
        firstFramePrompt.value = String(req.prompt);
      }
      closeJobsDropdown();
      focusFirstFrameGenerator();
      await runFirstFrameGenerate();
      return;
    }
    if (job.kind === "edit") {
      const ed = findEdit(job.refId);
      if (!ed) throw new Error(t("editor.notFound"));
      closeJobsDropdown();
      await rerunEditClip(ed);
      return;
    }
    const request = job.request && typeof job.request === "object" ? job.request : null;
    if (!request) throw new Error(t("jobs.retryNeedRequest"));
    await enqueueJobs([
      { kind: job.kind, refId: job.refId, request },
    ]);
  }

  async function refreshUserJobs() {
    const data = await apiJson("/api/jobs?limit=40");
    userJobsCache = data.jobs || [];
    jobsPanelMeta = {
      staleSeconds: data.staleSeconds || jobsPanelMeta.staleSeconds,
      perUserMaxRunning: data.perUserMaxRunning || jobsPanelMeta.perUserMaxRunning,
      globalMaxRunning: data.globalMaxRunning || jobsPanelMeta.globalMaxRunning,
      pendingCount:
        data.pendingCount != null ? data.pendingCount : jobsPanelMeta.pendingCount,
      runningCount:
        data.runningCount != null ? data.runningCount : jobsPanelMeta.runningCount,
    };
    renderJobsPanel();
    return userJobsCache;
  }

  async function cancelWaitingJobs(projectId) {
    const pid = projectId || currentProjectId;
    if (!pid) throw new Error(t("jobs.openProjectFirst"));
    let localCanceled = 0;
    try {
      const local = await cancelLocalWaitingJobs(pid);
      localCanceled = (local && local.canceled) || 0;
    } catch (e) {
      console.warn(e);
    }
    let serverCanceled = 0;
    try {
      const data = await postJson("/api/jobs/cancel", {
        projectId: pid,
        scope: "waiting",
      });
      serverCanceled = (data && data.canceled) || 0;
    } catch (e) {
      console.warn(e);
    }
    return { canceled: localCanceled + serverCanceled };
  }

  async function forceFailJobs({ projectId = null, jobIds = null, scopeAll = false } = {}) {
    try {
      const list = [...(localJobsCache || [])];
      for (const j of list) {
        if (!["pending", "running", "queued", "finalizing"].includes(j.status)) {
          continue;
        }
        if (jobIds && jobIds.length && !jobIds.includes(j.id)) continue;
        if (projectId != null && Number(j.projectId) !== Number(projectId)) {
          continue;
        }
        await persistLocalJob({
          id: j.id,
          status: "failed",
          canceled: true,
          error: t("status.forceEnded"),
        });
        const target =
          j.kind === "main"
            ? findMain(j.refId)
            : j.kind === "bridge"
              ? findBridge(j.refId)
              : findEdit(j.refId);
        if (target && isActiveJobStatus(target.status)) {
          target.status = "failed";
          target.label = t("status.forceEnded");
        }
      }
      refreshLocalBatchFlag();
      renderAll();
    } catch (e) {
      console.warn(e);
    }
    if (scopeAll) {
      const body = { scope: "all" };
      if (projectId != null) body.projectId = projectId;
      return postJson("/api/jobs/cancel", body);
    }
    const body = {};
    if (projectId) body.projectId = projectId;
    if (jobIds && jobIds.length) body.jobIds = jobIds;
    if (!body.projectId && !(body.jobIds && body.jobIds.length)) {
      if (!currentProjectId) throw new Error(t("jobs.openProjectFirst"));
      body.projectId = currentProjectId;
    }
    return postJson("/api/jobs/force-fail", body);
  }

  async function promptForceFailProject() {
    const goForce = confirm(t("jobs.confirmForceProject"));
    if (goForce) {
      try {
        await forceFailJobs({ projectId: currentProjectId });
        await syncActiveJobs();
        await refreshUserJobs();
        if (globalStatus) globalStatus.textContent = t("status.projectForceEnded");
      } catch (e) {
        alert(e.message || String(e));
      }
    } else {
      openJobsDropdown();
    }
  }

  function renderFlfFramePreview(previewEl, metaEl, frame, link) {
    if (!previewEl) return;
    const previewSrc =
      (frame && (frame.blobUrl || frame.playUrl || frame.previewUrl)) || null;
    if (previewSrc) {
      previewEl.innerHTML = `<img src="${escapeHtml(previewSrc)}" alt="frame" />`;
    } else if (frame && frame.rhFileName) {
      previewEl.innerHTML = `<span class="muted">${t("bins.flfUploaded")}</span>`;
    } else if (link) {
      previewEl.innerHTML = `<span class="muted">${t("bins.flfAutoReading")}</span>`;
    } else {
      previewEl.innerHTML = `<span class="muted">${t("bins.flfEmpty")}</span>`;
    }
    if (metaEl) {
      if (frame && frame.source === "auto" && link) {
        metaEl.textContent = `自动 ← ${linkSourceLabel(link)} · ${Number(
          frame.timeSec != null ? frame.timeSec : link.srcTimeSec
        ).toFixed(2)}s`;
      } else if (frame && frame.source === "manual" && frame.timeSec != null) {
        metaEl.textContent = `${Number(frame.timeSec).toFixed(2)}s · 手动节选`;
      } else if (frame && frame.rhFileName && frame.timeSec == null) {
        metaEl.textContent = t("bins.flfMetaManualUpload");
      } else if (frame && frame.timeSec != null) {
        metaEl.textContent = `${Number(frame.timeSec).toFixed(2)}s · 视频节选`;
      } else if (link) {
        metaEl.textContent = `自动 ← ${linkSourceLabel(link)}`;
      } else {
        metaEl.textContent = t("bins.flfMetaNoNeighbor");
      }
    }
  }

  function renderFlfFramePanel(bridge) {
    if (!flfFramePanel) return;
    if (editFramePanel) editFramePanel.classList.add("hidden");
    if (!bridge) {
      if (imagePanel) imagePanel.classList.remove("hidden");
      flfFramePanel.classList.add("hidden");
      if (flfStaleBanner) flfStaleBanner.classList.add("hidden");
      syncMediaBinMultiRefPanel();
      return;
    }
    if (imagePanel) imagePanel.classList.add("hidden");
    flfFramePanel.classList.remove("hidden");
    // Refresh neighbor links so auto frames schedule previews on open
    // (previously only extracted on「开始生成」).
    refreshBridgeLinks();
    if (flfFramePanelTitle) {
      flfFramePanelTitle.textContent = t("bins.flfTitleNamed", {
        name: bridgeLabel(bridge),
      });
    }
    if (flfStaleBanner) {
      flfStaleBanner.classList.toggle("hidden", !bridge.connectionStale);
    }
    renderFlfFramePreview(
      flfStartPreview,
      flfStartMeta,
      bridge.startFrame,
      bridge.startLink
    );
    renderFlfFramePreview(
      flfEndPreview,
      flfEndMeta,
      bridge.endFrame,
      bridge.endLink
    );
    syncMediaBinMultiRefPanel();
  }

  /**
   * Left bin for editor video slots: hide shared start, show this slot's first frame.
   * @param {EditSeg|null} ed
   */
  function renderEditFramePanel(ed) {
    if (!editFramePanel) return;
    if (!ed) {
      editFramePanel.classList.add("hidden");
      syncMediaBinMultiRefPanel();
      return;
    }
    if (imagePanel) imagePanel.classList.add("hidden");
    if (flfFramePanel) flfFramePanel.classList.add("hidden");
    if (flfStaleBanner) flfStaleBanner.classList.add("hidden");
    editFramePanel.classList.remove("hidden");
    syncMediaBinMultiRefPanel();
    if (editFramePanelTitle) {
      editFramePanelTitle.textContent = t("bins.editFrameTitleNamed", {
        name: editLabel(ed),
      });
    }
    const token =
      String(ed.id) +
      "|" +
      String(ed.playUrl || "") +
      "|" +
      String(ed.status || "") +
      "|" +
      String((ed.sourceSelection && ed.sourceSelection.inSec) || "");
    if (editFramePreview && editFramePreview.dataset.token === token) {
      return;
    }
    if (editFramePreview) editFramePreview.dataset.token = token;

    if (ed.playUrl && editFramePreview) {
      editFramePreview.innerHTML = `<video muted playsinline preload="metadata" src="${escapeHtml(
        ed.playUrl
      )}#t=0.05"></video>`;
      if (editFrameMeta) {
        editFrameMeta.textContent = ed.editorName
          ? t("bins.editFrameMetaReady", { name: ed.editorName })
          : t("bins.editFrameMetaReadySimple");
      }
      return;
    }

    // Pending: try source clip / timeline frame at sourceSelection.inSec
    if (editFramePreview) {
      editFramePreview.innerHTML = `<span class="muted">${escapeHtml(
        t("bins.editFramePending")
      )}</span>`;
    }
    if (editFrameMeta) {
      editFrameMeta.textContent = ed.editorName
        ? t("bins.editFrameMetaPending", { name: ed.editorName })
        : t("bins.editFrameMetaPendingSimple");
    }
    const sel = ed.sourceSelection;
    const frameSec = sel && sel.inSec != null ? Number(sel.inSec) : null;
    if (frameSec == null || !Number.isFinite(frameSec)) return;

    let sourceUrl = null;
    if (sel && sel.sourceClip && sel.sourceClip.kind && sel.sourceClip.id) {
      const src = findClip(sel.sourceClip.kind, sel.sourceClip.id);
      if (src && src.playUrl) sourceUrl = src.playUrl;
    }
    if (!sourceUrl) {
      // Fall back to composed timeline materialization via schedule lookup
      const hit = (schedule || []).find(
        (s) =>
          s.playUrl &&
          frameSec >= Number(s.gStart) - 1e-6 &&
          frameSec < Number(s.gEnd) + 1e-6
      );
      if (hit) sourceUrl = hit.playUrl;
    }
    if (!sourceUrl) return;

    const requestToken = token;
    extractFrameBlobFromUrl(sourceUrl, frameSec)
      .then((frame) => {
        if (!editFramePreview || editFramePreview.dataset.token !== requestToken) {
          return;
        }
        editFramePreview.innerHTML = `<img src="${escapeHtml(
          frame.dataUrl
        )}" alt="" />`;
        if (editFrameMeta) {
          editFrameMeta.textContent = t("bins.editFrameMetaSource", {
            time: frameSec.toFixed(2),
          });
        }
      })
      .catch(() => {
        /* keep pending placeholder */
      });
  }

  async function assignUploadedFrame(bridgeId, side, file) {
    if (!file) return;
    const b = bridges.find((x) => x.id === bridgeId);
    if (!b) return;
    try {
      const blobUrl = URL.createObjectURL(file);
      let rhFileName = null;
      let playUrl = blobUrl;
      let mediaFileId = null;
      if (getVideoChannelConfig().channel === "platform") {
        const uploaded = await uploadImage(file);
        rhFileName = uploaded.fileName;
        playUrl = uploaded.playUrl || blobUrl;
        mediaFileId = uploaded.mediaFileId || null;
      }
      const frame = {
        blobUrl,
        playUrl,
        mediaFileId,
        rhFileName,
        sourceMainId: null,
        timeSec: null,
        source: "manual",
        previewUrl: null,
        linkSig: null,
        origin:
          getVideoChannelConfig().channel === "platform" ? "server" : "local",
      };
      if (side === "start") {
        if (b.startFrame && b.startFrame.blobUrl) {
          URL.revokeObjectURL(b.startFrame.blobUrl);
        }
        b.startFrame = frame;
        if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
        b.linkedSig.start = linkSig(b.startLink);
      } else {
        if (b.endFrame && b.endFrame.blobUrl) {
          URL.revokeObjectURL(b.endFrame.blobUrl);
        }
        b.endFrame = frame;
        if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
        b.linkedSig.end = linkSig(b.endLink);
      }
      b.connectionStale = bridgeConnectionStale(b);
      b.needsReselect = false;
      b.dirty = true;
      if (b.status === "success") b.label = t("status.frameUpdated");
      else b.label = t("bins.flfClipped");
      renderFlfFramePanel(b);
      renderBridges();
      rebuildTimeline();
      scheduleSaveDraft();
    } catch (e) {
      alert(t("common.uploadFailedPrefix") + (e.message || e));
    }
  }

  function focusPromptItem(mainId) {
    openStoryboardModal();
    setActivePhase(1);
    let item = null;
    promptListEl.querySelectorAll(".prompt-item").forEach((el) => {
      if (el.dataset.mainId === mainId) item = el;
    });
    if (!item) return;
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const ta = item.querySelector("textarea");
    if (ta) ta.focus({ preventScroll: true });
  }

  /** Keep selection pointing at a live segment (LLM regenerate replaces main ids). */
  function ensureValidSelection() {
    if (selectedClip) {
      if (selectedClip.kind === "main" && findMain(selectedClip.id)) return true;
      if (
        selectedClip.kind === "bridge" &&
        bridges.some((b) => b.id === selectedClip.id)
      ) {
        return true;
      }
      if (
        selectedClip.kind === "edit" &&
        edits.some((e) => e.id === selectedClip.id)
      ) {
        return true;
      }
      if (selectedClip.kind === "audio" && findAudio(selectedClip.id)) {
        return true;
      }
    }
    if (!mains.length) {
      selectedClip = null;
      return false;
    }
    const pending = mains.find(
      (m) =>
        (m.prompt || "").trim() &&
        (m.dirty || m.status !== "success" || !m.playUrl)
    );
    const pick = pending || mains[0];
    selectedClip = { kind: "main", id: pick.id };
    return true;
  }

  function mainGenerateLabel(main) {
    return main && (main.playUrl || main.status === "success")
      ? t("inspector.regenerate")
      : t("inspector.generate");
  }

  function ensureGenerateSelectedButton() {
    if (!selectionActions) return null;
    let btn = selectionActions.querySelector("#btnGenerateSelected");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "btnGenerateSelected";
      btn.className = "btn btn-primary";
      btn.textContent = t("inspector.generate");
      selectionActions.appendChild(btn);
    }
    btn.disabled = false;
    return btn;
  }

  function syncSelectionActionButtons() {
    const btn = ensureGenerateSelectedButton();
    if (!selectionActions || !btn) return;
    selectionActions.querySelectorAll("[data-dyn-act]").forEach((el) => el.remove());
    syncInspectorEngineUi();

    if (!selectedClip || selectedClip.kind === "main") {
      const m =
        selectedClip && selectedClip.kind === "main"
          ? findMain(selectedClip.id)
          : null;
      btn.textContent = mainGenerateLabel(m);
      btn.className = "btn btn-primary";
      btn.hidden = false;
      return;
    }

    if (selectedClip.kind === "audio") {
      btn.hidden = true;
      const a = findAudio(selectedClip.id);
      if (a) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-ghost btn-sm";
        remove.dataset.dynAct = "audio-remove";
        remove.textContent = t("project.delete");
        remove.title = t("timeline.deleteAudio");
        remove.addEventListener("click", () => {
          deleteTimelineClip("audio", a.id);
        });
        selectionActions.appendChild(remove);
      }
      return;
    }

    if (selectedClip.kind === "edit") {
      const ed = findEdit(selectedClip.id);
      if (!ed) {
        btn.hidden = true;
        return;
      }
      // Reuse the primary button (avoid a second "regenerate" control)
      btn.hidden = false;
      btn.textContent =
        ed.playUrl || ed.status === "success"
          ? t("inspector.regenerate")
          : t("inspector.generate");
      btn.className = "btn btn-primary";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-ghost btn-sm";
      remove.dataset.dynAct = "edit-remove";
      remove.textContent = t("project.delete");
      remove.title = t("editor.deleteThisSlot");
      remove.addEventListener("click", () => {
        deleteTimelineClip("edit", ed.id);
      });
      selectionActions.appendChild(remove);
      return;
    }

    const b = bridges.find((x) => x.id === selectedClip.id);
    btn.textContent = t("inspector.generateBridge");
    btn.className = "btn btn-primary";
    btn.hidden = false;
    if (b && b.playUrl) {
      const reroll = document.createElement("button");
      reroll.type = "button";
      reroll.className = "btn btn-ghost btn-sm";
      reroll.dataset.dynAct = "bridge-reroll";
      reroll.textContent = t("inspector.regenerate");
      reroll.disabled = false;
      reroll.addEventListener("click", () => runBridge(b.id, true));
      selectionActions.appendChild(reroll);
    }
    if (b) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-ghost btn-sm";
      remove.dataset.dynAct = "bridge-remove";
      remove.textContent = t("project.delete");
      remove.title = t("bridge.deleteThisSlot");
      remove.addEventListener("click", () => {
        deleteTimelineClip("bridge", b.id);
      });
      selectionActions.appendChild(remove);
    }
  }

  async function onGenerateSelectedClick() {
    ensureValidSelection();
    if (!selectedClip) {
      // 未选中时：有提示词则批量开跑，否则提示
      const hasPrompt = mains.some((m) => (m.prompt || "").trim());
      if (hasPrompt) {
        try {
          await runBatch();
        } catch (e) {
          alert(e.message || String(e));
        }
        return;
      }
      alert(t("main.needStoryboardOrPrompt"));
      return;
    }
    if (selectedClip.kind === "main") {
      await rerollMain(selectedClip.id);
      return;
    }
    if (selectedClip.kind === "edit") {
      const ed = findEdit(selectedClip.id);
      if (ed) {
        await rerunEditClip(ed);
      } else {
        alert(t("editor.rerunViaMenu"));
      }
      return;
    }
    await runBridge(selectedClip.id, false);
  }

  function renderSelectionUI() {
    const emptyRight = () => {
      if (clipMetaTitle) clipMetaTitle.textContent = t("inspector.noneSelected");
      if (clipMetaBadge) clipMetaBadge.classList.add("hidden");
      if (clipMetaHint) {
        clipMetaHint.classList.remove("hidden");
        clipMetaHint.textContent = t("inspector.selectHint");
      }
      if (clipMetaSeed) clipMetaSeed.classList.add("hidden");
      if (selectedPromptEl) {
        selectedPromptEl.value = "";
        selectedPromptEl.disabled = true;
      }
      if (selectionPromptWrap) selectionPromptWrap.hidden = false;
      const vflowParamsEl = document.getElementById("vflowParams");
      if (vflowParamsEl) vflowParamsEl.hidden = false;
      clearEditorSlotInspector();
      renderEditFramePanel(null);
      syncTimingInspectorUI();
      syncSelectionActionButtons();
      if (typeof syncStoryboardDynamicUi === "function") {
        syncStoryboardDynamicUi();
      }
    };

    if (frameAssetPickTarget) {
      const keepShared =
        frameAssetPickTarget === "shared" &&
        selectedClip &&
        selectedClip.kind === "main";
      const keepBridge =
        frameAssetPickTarget &&
        frameAssetPickTarget !== "shared" &&
        selectedClip &&
        selectedClip.kind === "bridge" &&
        selectedClip.id === frameAssetPickTarget.bridgeId;
      if (!keepShared && !keepBridge) {
        clearFrameAssetPick({ rerender: false });
      }
    }

    if (!ensureValidSelection()) {
      emptyRight();
      renderFlfFramePanel(null);
      syncAssetLibraryToSelection();
      updatePlaylistMeta();
      return;
    }

    let title = "";
    let status = "pending";
    let label = "";
    let prompt = "";
    let playUrl = null;
    let seedHigh = null;
    let seedLow = null;
    /** @type {EditSeg|null} */
    let selectedEdit = null;

    if (selectedClip.kind === "main") {
      const m = findMain(selectedClip.id);
      if (!m) {
        emptyRight();
        renderFlfFramePanel(null);
        syncAssetLibraryToSelection();
        updatePlaylistMeta();
        return;
      }
      const idx = mains.indexOf(m);
      title = t("inspector.mainSegment", { n: idx + 1 });
      status = m.status;
      label = localizeStoredLabel(m.label || m.status);
      prompt = m.prompt || "";
      playUrl = m.playUrl;
      seedHigh = m.seedHigh;
      seedLow = m.seedLow;
      setActivePhase(1);
      renderEditFramePanel(null);
      renderFlfFramePanel(null);
      clearEditorSlotInspector();
    } else if (selectedClip.kind === "edit") {
      const ed = findEdit(selectedClip.id);
      if (!ed) {
        emptyRight();
        renderFlfFramePanel(null);
        syncAssetLibraryToSelection();
        updatePlaylistMeta();
        return;
      }
      selectedEdit = ed;
      title = editLabel(ed);
      status = ed.status;
      label = localizeStoredLabel(ed.label || ed.status);
      prompt = ed.prompt || "";
      playUrl = ed.playUrl;
      seedHigh = ed.seedHigh;
      seedLow = ed.seedLow;
      setActivePhase(3);
      renderEditFramePanel(ed);
      syncEditorSlotInspector(ed);
    } else if (selectedClip.kind === "audio") {
      const a = findAudio(selectedClip.id);
      if (!a) {
        emptyRight();
        renderFlfFramePanel(null);
        syncAssetLibraryToSelection();
        updatePlaylistMeta();
        return;
      }
      const idx = audios.indexOf(a);
      title = t("inspector.audioSegment", { n: idx >= 0 ? idx + 1 : "?" });
      status = a.status || (a.playUrl ? "success" : "pending");
      label = localizeStoredLabel(a.label || a.name || status);
      prompt = "";
      playUrl = a.playUrl;
      seedHigh = null;
      seedLow = null;
      renderEditFramePanel(null);
      renderFlfFramePanel(null);
      clearEditorSlotInspector();
    } else {
      const b = bridges.find((x) => x.id === selectedClip.id);
      if (!b) {
        emptyRight();
        renderFlfFramePanel(null);
        syncAssetLibraryToSelection();
        updatePlaylistMeta();
        return;
      }
      title = bridgeLabel(b);
      status = b.status;
      label = localizeStoredLabel(b.label || b.status);
      prompt = b.prompt || "";
      playUrl = b.playUrl;
      seedHigh = b.seedHigh;
      seedLow = b.seedLow;
      setActivePhase(2);
      renderEditFramePanel(null);
      renderFlfFramePanel(b);
      clearEditorSlotInspector();
    }

    if (clipMetaTitle) clipMetaTitle.textContent = title;
    if (clipMetaBadge) {
      clipMetaBadge.classList.remove("hidden");
      clipMetaBadge.className = `badge ${badgeClass(status)}`;
      clipMetaBadge.textContent = label || status;
    }
    if (clipMetaHint) {
      if (selectedClip.kind === "audio") {
        const a = findAudio(selectedClip.id);
        const durSec = a ? clipDuration(a) : 0;
        clipMetaHint.textContent = t("clip.metaAudio", {
          duration: (Number(durSec) || 0).toFixed(1),
        });
      } else {
        const size = getWfSizePayload();
        const timingClip = getSelectedTimingClip();
        const length = resolveClipLength(timingClip);
        const fps = resolveClipFps(timingClip);
        const durSec = estimatedDurationSec(timingClip);
        const durLabel = durSec.toFixed(1);
        const independent =
          timingClip && timingClip.useGlobalTiming === false
            ? t("clip.independentTiming")
            : "";
        const selBridge =
          selectedClip && selectedClip.kind === "bridge"
            ? bridges.find((x) => x.id === selectedClip.id)
            : null;
        if (selBridge && selBridge.connectionStale) {
          clipMetaHint.textContent = t("bridge.staleBanner");
        } else if (playUrl) {
          clipMetaHint.textContent = t("clip.metaRerun", {
            width: size.width,
            height: size.height,
            frames: length,
            fps,
            duration: durLabel,
            independent,
          });
        } else {
          clipMetaHint.textContent = t("clip.metaPending", {
            width: size.width,
            height: size.height,
            frames: length,
            fps,
            duration: durLabel,
            independent,
          });
        }
      }
      clipMetaHint.classList.remove("hidden");
    }
    syncTimingInspectorUI();
    if (clipMetaSeed) {
      if (seedHigh != null || seedLow != null) {
        clipMetaSeed.textContent = t("inspector.seed", {
          high: seedHigh || "—",
          low: seedLow || "—",
        });
        clipMetaSeed.classList.remove("hidden");
      } else {
        clipMetaSeed.classList.add("hidden");
      }
    }

    const isAudioSel = selectedClip.kind === "audio";
    if (selectionPromptWrap) selectionPromptWrap.hidden = isAudioSel;
    const vflowParamsEl = document.getElementById("vflowParams");
    if (vflowParamsEl) vflowParamsEl.hidden = isAudioSel;

    // Editor slots use the mounted editor form for prompt/params
    if (selectedPromptEl) {
      const useEditorForm =
        !!selectedEdit &&
        editorSlotPanel &&
        !editorSlotPanel.classList.contains("hidden");
      if (useEditorForm || isAudioSel) {
        selectedPromptEl.disabled = true;
        if (isAudioSel) selectedPromptEl.value = "";
      } else {
        selectedPromptEl.disabled = false;
        if (selectedPromptEl.value !== prompt) {
          selectedPromptEl.value = prompt;
        }
      }
    }

    syncSelectionActionButtons();
    syncAssetLibraryToSelection();
    syncStoryboardDynamicUi();
    updatePlaylistMeta();
  }

  function badgeClass(status) {
    const s = (status || "").toLowerCase();
    if (s === "success") return "success";
    if (s === "failed" || s === "fail") return "failed";
    if (s === "running" || s === "finalizing") return "running";
    if (s === "queued" || s === "create") return "queued";
    return "pending";
  }

  function isPlayableExt(ext) {
    return /^(mp4|webm|mov)$/i.test(ext || "");
  }

  function looksLikeVideoUrl(u) {
    return /\.(mp4|webm|mov)(\?|$)/i.test(u) || /\/video/i.test(u) || /^\/media\//i.test(u);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(String(s)).replace(/'/g, "&#39;");
  }

  function filenameFromPlayUrl(playUrl) {
    if (!playUrl) return "";
    try {
      const path = String(playUrl).split("?")[0];
      const parts = path.split("/").filter(Boolean);
      return decodeURIComponent(parts[parts.length - 1] || "");
    } catch (_) {
      return "";
    }
  }

  function downloadAnchorHtml(playUrl, label = t("common.download")) {
    if (!playUrl) return "";
    const name = filenameFromPlayUrl(playUrl);
    const dlAttr = name ? ` download="${escapeHtml(name)}"` : "";
    return `<a class="download" href="${escapeHtml(playUrl)}"${dlAttr} target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }

  function renderResultLinks(items) {
    return (items || [])
      .map((it) => {
        const parts = [];
        if (it.playUrl) {
          parts.push(downloadAnchorHtml(it.playUrl, t("common.download")));
        }
        if (it.sourceUrl) {
          parts.push(
            `<a class="download" href="${escapeHtml(it.sourceUrl)}" target="_blank" rel="noopener">原始</a>`
          );
        }
        if (it.error) {
          parts.push(`<div class="job-error">${escapeHtml(it.error)}</div>`);
        }
        return parts.join("");
      })
      .join("");
  }

  function setGapBlackPreview(on) {
    if (!playlistPanel) return;
    if (on) {
      clearPreviewImage();
      playlistPanel.classList.add("is-gap-black", "has-source");
      if (previewEmpty) previewEmpty.classList.add("hidden");
    } else {
      playlistPanel.classList.remove("is-gap-black");
    }
  }

  function clearPreviewImage() {
    if (playlistPanel) playlistPanel.classList.remove("is-image-preview");
    if (playlistImage) {
      playlistImage.removeAttribute("src");
      playlistImage.classList.add("hidden");
    }
    syncFirstFrameGenBar();
  }

  function showPreviewImage(url) {
    if (!playlistPanel || !playlistImage || !url) return;
    clearPreviewStandby();
    previewVideoElements().forEach((v) => {
      try {
        v.pause();
      } catch (_) {}
      v.removeAttribute("src");
      try {
        v.load();
      } catch (_) {}
    });
    previewLoadedUrl = url;
    playlistImage.src = url;
    playlistImage.classList.remove("hidden");
    playlistPanel.classList.add("has-source", "is-image-preview");
    if (previewEmpty) previewEmpty.classList.add("hidden");
    setGapBlackPreview(false);
    syncFirstFrameGenBar();
  }

  function isAssetImage(asset) {
    if (!asset) return false;
    return (
      asset.kind === "upload" ||
      /\.(png|jpe?g|webp)(\?|$)/i.test(asset.playUrl || "")
    );
  }

  function isAssetAudio(asset) {
    if (!asset) return false;
    return (
      asset.kind === "audio" ||
      isAudioMediaUrl(asset.playUrl || "")
    );
  }

  function paintAssetVideoThumb(videoEl) {
    if (!videoEl) return;
    const seek = () => {
      try {
        const dur = Number(videoEl.duration);
        const target =
          Number.isFinite(dur) && dur > 0
            ? Math.min(0.1, Math.max(0.04, dur * 0.01))
            : 0.1;
        if (Math.abs((videoEl.currentTime || 0) - target) > 0.02) {
          videoEl.currentTime = target;
        }
      } catch (_) {
        /* ignore seek errors before ready */
      }
    };
    videoEl.addEventListener("loadedmetadata", seek);
    videoEl.addEventListener("loadeddata", seek, { once: true });
    if (videoEl.readyState >= 1) seek();
  }

  function syncVideoThumbPreviewButton() {
    if (!btnVideoThumbPreview) return;
    btnVideoThumbPreview.classList.toggle("is-on", assetVideoThumbPreview);
    btnVideoThumbPreview.setAttribute(
      "aria-pressed",
      assetVideoThumbPreview ? "true" : "false"
    );
  }

  function setAssetVideoThumbPreview(on) {
    assetVideoThumbPreview = !!on;
    localStorage.setItem(
      ASSET_VIDEO_THUMB_KEY,
      assetVideoThumbPreview ? "1" : "0"
    );
    syncVideoThumbPreviewButton();
    renderAssetLibrary();
  }

  function setPreviewSource(url, promptText, { load = true, fromAsset = false } = {}) {
    if (!fromAsset) {
      browsingAssetId = null;
      hideAssetBrowseBar();
    }
    clearPreviewImage();
    playlistVideo.muted = !fromAsset;
    if (url) {
      setGapBlackPreview(false);
      playlistPanel.classList.add("has-source");
      if (previewEmpty) previewEmpty.classList.add("hidden");
      const same = previewLoadedUrl === url && playlistVideo.getAttribute("src");
      if (!same) {
        playlistVideo.src = url;
        previewLoadedUrl = url;
        if (load) playlistVideo.load();
      } else if (load) {
        // already loaded; caller may still want a seek without reload
      }
    } else {
      setGapBlackPreview(false);
      playlistPanel.classList.remove("has-source");
      if (previewEmpty) previewEmpty.classList.remove("hidden");
      playlistVideo.removeAttribute("src");
      previewLoadedUrl = null;
      if (load) playlistVideo.load();
    }
    if (playlistPrompt) {
      playlistPrompt.textContent = promptText || "";
    }
    syncFirstFrameGenBar();
  }

  function syncClipSelectionHighlight() {
    // Only timeline/job cards carry data-clip-*; asset library cards share
    // .media-clip + .is-selected for browsingAssetId and must not be cleared.
    document.querySelectorAll(".media-clip[data-clip-kind]").forEach((el) => {
      const kind = el.dataset.clipKind;
      const id = el.dataset.clipId;
      const on =
        selectedClip &&
        selectedClip.kind === kind &&
        selectedClip.id === id;
      el.classList.toggle("is-selected", !!on);
    });
    document.querySelectorAll(".tl-clip").forEach((el) => {
      const kind = el.dataset.clipKind;
      const id = el.dataset.clipId;
      const on =
        selectedClip &&
        selectedClip.kind === kind &&
        selectedClip.id === id;
      el.classList.toggle("is-active", !!on);
    });
    document.querySelectorAll(".prompt-item").forEach((el) => {
      let on = false;
      if (selectedClip && selectedClip.kind === "main" && el.dataset.mainId) {
        on = selectedClip.id === el.dataset.mainId;
      } else if (
        selectedClip &&
        selectedClip.kind === "bridge" &&
        el.dataset.bridgeId
      ) {
        on = selectedClip.id === el.dataset.bridgeId;
      }
      el.classList.toggle("is-focused", !!on);
    });
  }

  function previewMainClip(mainId, autoPlay) {
    selectAndPreviewClip("main", mainId, !!autoPlay);
    focusPromptItem(mainId);
  }

  function previewBridgeClip(bridgeId, autoPlay) {
    selectAndPreviewClip("bridge", bridgeId, !!autoPlay);
  }

  function renderJobList() {
    if (!jobListEl) return;
    jobListEl.innerHTML = "";
    if (mediaMainEmpty) {
      mediaMainEmpty.classList.toggle("hidden", mains.length > 0);
    }
    mains.forEach((m, i) => {
      const card = document.createElement("div");
      card.className =
        "media-clip" +
        (selectedClip &&
        selectedClip.kind === "main" &&
        selectedClip.id === m.id
          ? " is-selected"
          : "");
      card.dataset.mainId = m.id;
      card.dataset.clipKind = "main";
      card.dataset.clipId = m.id;
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      const dirtyMark = m.dirty && m.status === "success" ? t("inspector.dirtyMark") : "";
      const thumbInner = m.playUrl
        ? `<video muted preload="metadata" src="${escapeHtml(m.playUrl)}#t=0.1"></video>`
        : `<span>—</span>`;
      card.innerHTML = `
        <div class="media-thumb">${thumbInner}</div>
        <div class="media-clip-body">
          <span class="media-clip-title">${t("inspector.mainSegment", { n: i + 1 })}</span>
          <span class="badge ${badgeClass(m.status)}" data-badge>${escapeHtml(localizeStoredLabel(m.label || m.status))}</span>
          <span class="media-clip-meta job-meta">${escapeHtml(m.meta || "")}${dirtyMark}</span>
        </div>
        <div class="media-clip-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="reroll">${mainGenerateLabel(m)}</button>
          ${
            m.playUrl
              ? downloadAnchorHtml(m.playUrl, t("common.download")).replace(
                  'class="download"',
                  'class="download" data-act="dl"'
                )
              : ""
          }
        </div>
      `;
      const activate = () => {
        selectedClip = { kind: "main", id: m.id };
        syncClipSelectionHighlight();
        renderSelectionUI();
        renderTimelineTrack();
        if (m.playUrl) previewMainClip(m.id, true);
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-act]")) return;
        activate();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      card.querySelector('[data-act="reroll"]').addEventListener("click", (e) => {
        e.stopPropagation();
        rerollMain(m.id);
      });
      const dl = card.querySelector('[data-act="dl"]');
      if (dl) {
        dl.addEventListener("click", (e) => e.stopPropagation());
      }
      jobListEl.appendChild(card);
    });
  }

  function renderMediaBridges() {
    if (!mediaBridgeList) return;
    mediaBridgeList.innerHTML = "";
    const ready = bridges.filter((b) => b.playUrl);
    if (mediaBridgeEmpty) {
      mediaBridgeEmpty.classList.toggle("hidden", ready.length > 0);
    }
    ready.forEach((b) => {
      const card = document.createElement("div");
      card.className =
        "media-clip is-bridge" +
        (selectedClip &&
        selectedClip.kind === "bridge" &&
        selectedClip.id === b.id
          ? " is-selected"
          : "");
      card.dataset.clipKind = "bridge";
      card.dataset.clipId = b.id;
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.innerHTML = `
        <div class="media-thumb">
          <video muted preload="metadata" src="${escapeHtml(b.playUrl)}#t=0.1"></video>
        </div>
        <div class="media-clip-body">
          <span class="media-clip-title">${escapeHtml(bridgeLabel(b))}</span>
          <span class="badge ${badgeClass(b.status)}">${escapeHtml(localizeStoredLabel(b.label || b.status))}</span>
          <span class="media-clip-meta">${escapeHtml(b.meta || "")}</span>
        </div>
      `;
      const activate = () => previewBridgeClip(b.id, true);
      card.addEventListener("click", activate);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      mediaBridgeList.appendChild(card);
    });
  }

  function updateMainCard(mainId) {
    const m = mains.find((x) => x.id === mainId);
    if (!m) return;
    if (!jobListEl) {
      if (
        selectedClip &&
        selectedClip.kind === "main" &&
        selectedClip.id === mainId
      ) {
        renderSelectionUI();
      }
      renderTimelineTrack();
      return;
    }
    const card = jobListEl.querySelector(`[data-main-id="${mainId}"]`);
    if (!card) {
      renderJobList();
      return;
    }
    const i = mains.indexOf(m);
    const badge = card.querySelector("[data-badge]");
    if (badge) {
      badge.className = `badge ${badgeClass(m.status)}`;
      badge.textContent = localizeStoredLabel(m.label || m.status);
    }
    const title = card.querySelector(".media-clip-title");
    if (title) title.textContent = t("inspector.mainSegment", { n: i + 1 });
    const dirtyMark = m.dirty && m.status === "success" ? t("inspector.dirtyMark") : "";
    const meta = card.querySelector(".job-meta");
    if (meta) meta.textContent = `${m.meta || ""}${dirtyMark}`;
    const thumb = card.querySelector(".media-thumb");
    if (thumb) {
      if (m.playUrl) {
        thumb.innerHTML = `<video muted preload="metadata" src="${escapeHtml(m.playUrl)}#t=0.1"></video>`;
      } else if (
        m.status === "running" ||
        m.status === "queued" ||
        m.status === "finalizing"
      ) {
        thumb.innerHTML = `<span>…</span>`;
      } else {
        thumb.innerHTML = `<span>空</span>`;
      }
    }
    const actions = card.querySelector(".media-clip-actions");
    if (actions) {
      const reroll = actions.querySelector('[data-act="reroll"]');
      if (reroll) {
        reroll.disabled = false;
        reroll.textContent = mainGenerateLabel(m);
      }
      let dl = actions.querySelector('[data-act="dl"]');
      if (m.playUrl) {
        if (!dl) {
          dl = document.createElement("a");
          dl.className = "download";
          dl.dataset.act = "dl";
          dl.target = "_blank";
          dl.rel = "noopener";
          dl.textContent = t("common.download");
          dl.addEventListener("click", (e) => e.stopPropagation());
          actions.appendChild(dl);
        }
        dl.href = m.playUrl;
        const fname = filenameFromPlayUrl(m.playUrl);
        if (fname) dl.setAttribute("download", fname);
        else dl.removeAttribute("download");
      } else if (dl) {
        dl.remove();
      }
    }
    if (
      selectedClip &&
      selectedClip.kind === "main" &&
      selectedClip.id === mainId
    ) {
      renderSelectionUI();
    }
    renderTimelineTrack();
  }

  // —— Bridges ——

  function findMain(id) {
    return mains.find((m) => m.id === id);
  }

  function findBridge(id) {
    return bridges.find((b) => b.id === id) || null;
  }

  function markBridgesNeedReselectForMain(mainId) {
    bridges.forEach((b) => {
      const used =
        b.leftMainId === mainId ||
        b.rightMainId === mainId ||
        (b.startFrame && b.startFrame.sourceMainId === mainId) ||
        (b.endFrame && b.endFrame.sourceMainId === mainId);
      if (used) {
        b.needsReselect = true;
        if (b.status === "success") b.label = t("timeline.suggestReselect");
      }
    });
  }

  function markBridgesNeedReselectForAll() {
    bridges.forEach((b) => {
      b.needsReselect = true;
      if (b.status === "success") b.label = t("timeline.suggestReselect");
    });
  }

  function renderBridges() {
    // 右侧栏不再列出全部桥；在时间轴点选后逐个编辑
    renderMediaBridges();
  }

  // —— Frame picker ——

  function pickMainIdForFrame(preferredId) {
    if (preferredId) {
      const pref = findMain(preferredId);
      if (pref && pref.playUrl) return preferredId;
    }
    const withVideo = mains.filter((m) => m.playUrl);
    if (!withVideo.length) {
      alert(t("main.noVideoToClip"));
      return null;
    }
    if (withVideo.length === 1) return withVideo[0].id;
    const lines = withVideo
      .map((m) => {
        const i = mains.indexOf(m);
        return `${i + 1}`;
      })
      .join(", ");
    const choice = prompt(
      `选择节选来源主段编号（${lines}）`,
      String(mains.indexOf(withVideo[0]) + 1)
    );
    if (choice == null) return null;
    const idx = Number(choice) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= mains.length || !mains[idx].playUrl) {
      alert(t("main.invalidIndex"));
      return null;
    }
    return mains[idx].id;
  }

  function openFramePicker(bridgeId, side, mainId) {
    const resolvedMainId = pickMainIdForFrame(mainId);
    if (!resolvedMainId) return;
    const main = findMain(resolvedMainId);
    if (!main || !main.playUrl) {
      alert(t("main.noPlayableVideo"));
      return;
    }
    pickerContext = { bridgeId, side, mainId: resolvedMainId };
    framePickerTitle.textContent =
      side === "start" ? t("framePicker.titleFlfStart") : t("framePicker.titleFlfEnd");
    framePickerHint.textContent = `来源：${mainLabel(main)}。拖动进度或用步进对准姿势，再点「截取当前帧」。`;
    pickerThumb.classList.add("hidden");
    applyMediaCors(pickerVideo, main.playUrl);
    pickerVideo.src = main.playUrl;
    pickerVideo.load();
    framePickerModal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    pickerVideo.addEventListener("timeupdate", onPickerTimeUpdate);
    pickerVideo.addEventListener("seeked", refreshPickerThumb);
  }

  function closeFramePicker() {
    framePickerModal.classList.add("hidden");
    document.body.classList.remove("modal-open");
    pickerVideo.pause();
    pickerVideo.removeAttribute("src");
    pickerVideo.load();
    pickerVideo.removeEventListener("timeupdate", onPickerTimeUpdate);
    pickerVideo.removeEventListener("seeked", refreshPickerThumb);
    pickerContext = null;
  }

  function onPickerTimeUpdate() {
    pickerTime.textContent = `${pickerVideo.currentTime.toFixed(2)}s`;
  }

  function refreshPickerThumb() {
    try {
      const w = pickerVideo.videoWidth;
      const h = pickerVideo.videoHeight;
      if (!w || !h) return;
      pickerCanvas.width = w;
      pickerCanvas.height = h;
      const ctx = pickerCanvas.getContext("2d");
      ctx.drawImage(pickerVideo, 0, 0, w, h);
      pickerThumb.src = pickerCanvas.toDataURL("image/jpeg", 0.85);
      pickerThumb.classList.remove("hidden");
    } catch (e) {
      console.warn("preview frame failed", e);
    }
  }

  function seekPicker(delta) {
    if (!pickerVideo.duration) return;
    pickerVideo.currentTime = Math.max(
      0,
      Math.min(pickerVideo.duration, pickerVideo.currentTime + delta)
    );
  }

  async function captureCurrentFrame() {
    if (!pickerContext) return;
    const { bridgeId, side, mainId } = pickerContext;
    const b = bridges.find((x) => x.id === bridgeId);
    if (!b) return;

    try {
      const w = pickerVideo.videoWidth;
      const h = pickerVideo.videoHeight;
      if (!w || !h) {
        alert(t("framePicker.videoNotReady"));
        return;
      }
      pickerCanvas.width = w;
      pickerCanvas.height = h;
      const ctx = pickerCanvas.getContext("2d");
      ctx.drawImage(pickerVideo, 0, 0, w, h);
      const blob = await new Promise((resolve, reject) => {
        pickerCanvas.toBlob(
          (bl) => (bl ? resolve(bl) : reject(new Error(t("framePicker.captureFailedSimple")))),
          "image/jpeg",
          0.92
        );
      });
      const timeSec = pickerVideo.currentTime;
      const oldFrame = side === "start" ? b.startFrame : b.endFrame;
      const oldMediaFileId =
        oldFrame && oldFrame.mediaFileId && !isLocalMediaId(oldFrame.mediaFileId)
          ? oldFrame.mediaFileId
          : null;
      const file = new File([blob], `frame_${side}_${timeSec.toFixed(2)}.jpg`, {
        type: "image/jpeg",
      });
      btnCaptureFrame.disabled = true;
      btnCaptureFrame.textContent = t("framePicker.capturing");
      const uploaded = await uploadImage(file);
      const rhFileName = uploaded.fileName;
      const blobUrl = URL.createObjectURL(blob);
      const frame = {
        blobUrl,
        playUrl: uploaded.playUrl || null,
        mediaFileId: uploaded.mediaFileId || null,
        rhFileName,
        sourceMainId: mainId,
        timeSec,
        source: "manual",
        previewUrl: null,
        linkSig: null,
      };
      if (side === "start") {
        if (b.startFrame && b.startFrame.blobUrl) {
          URL.revokeObjectURL(b.startFrame.blobUrl);
        }
        b.startFrame = frame;
        b.leftMainId = mainId || b.leftMainId;
        if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
        b.linkedSig.start = linkSig(b.startLink);
      } else {
        if (b.endFrame && b.endFrame.blobUrl) {
          URL.revokeObjectURL(b.endFrame.blobUrl);
        }
        b.endFrame = frame;
        b.rightMainId = mainId || b.rightMainId;
        if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
        b.linkedSig.end = linkSig(b.endLink);
      }
      if (oldMediaFileId && oldMediaFileId !== frame.mediaFileId) {
        await cleanupOldBridgeFrame(oldMediaFileId);
      }
      b.connectionStale = bridgeConnectionStale(b);
      b.needsReselect = !!b.connectionStale;
      b.dirty = true;
      if (b.connectionStale) b.label = t("timeline.staleChip");
      else if (b.status === "success") b.label = t("status.frameUpdated");
      else b.label = t("bins.flfClipped");
      closeFramePicker();
      if (
        selectedClip &&
        selectedClip.kind === "bridge" &&
        selectedClip.id === b.id
      ) {
        renderFlfFramePanel(b);
      }
      renderBridges();
      rebuildTimeline();
      scheduleSaveDraft();
    } catch (e) {
      alert(t("framePicker.captureFailedPrefix") + (e.message || e));
    } finally {
      btnCaptureFrame.disabled = false;
      btnCaptureFrame.textContent = t("framePicker.capture");
    }
  }

  // —— Multitrack timeline / priority compositor ——

  function formatTlTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    if (s < 60) return `${s.toFixed(2)}s`;
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
  }

  function timelineTotalDuration() {
    let max = 5;
    mains.forEach((m) => {
      max = Math.max(max, clipTimelineEnd(m));
    });
    bridges.forEach((b) => {
      max = Math.max(max, clipTimelineEnd(b));
    });
    edits.forEach((ed) => {
      max = Math.max(max, clipTimelineEnd(ed));
    });
    audios.forEach((a) => {
      max = Math.max(max, clipTimelineEnd(a));
    });
    if (timelineSelection && timelineSelection.kind === "range") {
      max = Math.max(max, Number(timelineSelection.outSec) || 0);
    }
    return Math.max(max, playheadSec + 1);
  }

  function findClip(kind, id) {
    if (kind === "main") return findMain(id);
    if (kind === "edit") return findEdit(id);
    if (kind === "audio") return findAudio(id);
    return bridges.find((b) => b.id === id) || null;
  }

  function bridgeLabel(b) {
    const idx = bridges.indexOf(b);
    return t("bridge.label", { n: idx >= 0 ? idx + 1 : "?" });
  }

  function mainLabel(m) {
    const idx = mains.indexOf(m);
    return t("bridge.mainLabel", { n: idx >= 0 ? idx + 1 : "?" });
  }

  function editLabel(ed) {
    const idx = edits.indexOf(ed);
    const name = (ed && ed.editorName) || t("editor.defaultLabel");
    return t("editor.label", { n: idx >= 0 ? idx + 1 : "?", name });
  }

  function allPlacedClips() {
    /** @type {{ kind: 'main'|'bridge'|'edit', id: string, trackId: string, start: number, end: number, playUrl: string|null, inSec: number, durationSec: number, prompt: string, label: string, status: string, clip: object }[]} */
    const list = [];
    mains.forEach((m, i) => {
      if (!m.trackId) m.trackId = defaultVideoTrackId();
      const dur = clipDuration(m);
      const start = Number(m.startSec) || 0;
      list.push({
        kind: "main",
        id: m.id,
        trackId: m.trackId,
        start,
        end: start + dur,
        playUrl: m.playUrl || null,
        inSec: Number(m.inSec) || 0,
        durationSec: dur,
        prompt: t("clip.promptMain", { n: i + 1, prompt: m.prompt || "" }),
        label: t("bridge.mainLabel", { n: i + 1 }),
        status: m.status,
        clip: m,
      });
    });
    bridges.forEach((b, i) => {
      if (!b.trackId) b.trackId = defaultVideoTrackId();
      const dur = clipDuration(b);
      const start = Number(b.startSec) || 0;
      list.push({
        kind: "bridge",
        id: b.id,
        trackId: b.trackId,
        start,
        end: start + dur,
        playUrl: b.playUrl || null,
        inSec: Number(b.inSec) || 0,
        durationSec: dur,
        prompt: t("clip.promptBridge", { n: i + 1, prompt: b.prompt || "" }),
        label: t("bridge.label", { n: i + 1 }),
        status: b.status,
        clip: b,
      });
    });
    edits.forEach((ed, i) => {
      if (!ed.trackId) ed.trackId = editTrackId();
      const dur = clipDuration(ed);
      const start = Number(ed.startSec) || 0;
      list.push({
        kind: "edit",
        id: ed.id,
        trackId: ed.trackId,
        start,
        end: start + dur,
        playUrl: ed.playUrl || null,
        inSec: Number(ed.inSec) || 0,
        durationSec: dur,
        prompt: t("clip.promptEdit", {
          n: i + 1,
          name: ed.editorName || "",
          prompt: ed.prompt || "",
        }),
        label: editLabel(ed),
        status: ed.status,
        clip: ed,
      });
    });
    audios.forEach((a) => {
      if (!a.trackId) a.trackId = defaultAudioTrackId() || ensureAudioTrack();
      const dur = clipDuration(a);
      const start = Number(a.startSec) || 0;
      list.push({
        kind: "audio",
        id: a.id,
        trackId: a.trackId,
        start,
        end: start + dur,
        playUrl: a.playUrl || null,
        inSec: Number(a.inSec) || 0,
        durationSec: dur,
        prompt: audioLabel(a),
        label: audioLabel(a),
        status: a.status,
        clip: a,
      });
    });
    return list;
  }

  const BRIDGE_LINK_EPS = 1e-3;
  /** @type {Map<string, number>} */
  const autoPreviewGen = new Map();

  /**
   * Topmost-wins clip covering tSec (with playUrl). Optionally exclude a bridge.
   * @returns {ReturnType<typeof allPlacedClips>[number]|null}
   */
  function clipVisibleAt(tSec, excludeBridgeId) {
    ensureDefaultTrack();
    const priority = new Map();
    tracks.forEach((t, i) => {
      if (t.kind === "video" && !t.hidden) priority.set(t.id, i);
    });
    let best = null;
    let bestPri = -1;
    for (const c of allPlacedClips()) {
      if (!c.playUrl) continue;
      if (!priority.has(c.trackId)) continue;
      if (excludeBridgeId && c.kind === "bridge" && c.id === excludeBridgeId) {
        continue;
      }
      if (tSec < c.start || tSec >= c.end) continue;
      const pri = priority.get(c.trackId);
      if (pri > bestPri) {
        bestPri = pri;
        best = c;
      }
    }
    return best;
  }

  /**
   * Map a timeline sample time onto the neighbor clip's source time.
   * Overlapping layers: sample at the bridge edge → mid-clip frame.
   * Pure adjacency (no overlap): clamps to neighbor in/out (legacy behavior).
   * @param {ReturnType<typeof allPlacedClips>[number]} placed
   * @param {number} sampleTimelineSec  bridge start (left) or end (right)
   * @returns {BridgeLink}
   */
  function placedToBridgeLink(placed, sampleTimelineSec) {
    const inSec = Number(placed.inSec) || 0;
    const dur = Number(placed.durationSec) || 0;
    const maxT = inSec + Math.max(dur, 0);
    const maxReadable = Math.max(inSec, maxT - 0.001);
    const rel = Number(sampleTimelineSec) - (Number(placed.start) || 0);
    const raw = inSec + rel;
    const srcTimeSec = Math.min(maxReadable, Math.max(inSec, raw));
    return {
      clipKind: placed.kind,
      clipId: placed.id,
      srcTimeSec: Math.round(srcTimeSec * 100) / 100,
      playUrl: placed.playUrl,
    };
  }

  /** @returns {{ start: BridgeLink|null, end: BridgeLink|null }} */
  function computeBridgeLinks(bridge) {
    const start = Number(bridge.startSec) || 0;
    const end = start + clipDuration(bridge);
    const left = clipVisibleAt(start - BRIDGE_LINK_EPS, bridge.id);
    const right = clipVisibleAt(end + BRIDGE_LINK_EPS, bridge.id);
    return {
      start: left ? placedToBridgeLink(left, start) : null,
      end: right ? placedToBridgeLink(right, end) : null,
    };
  }

  function linkSig(link) {
    if (!link) return "∅";
    return `${link.clipKind}:${link.clipId}@${Number(link.srcTimeSec).toFixed(2)}|${
      link.playUrl || ""
    }`;
  }

  function bridgeConnectionStale(b) {
    const generated = !!(b.playUrl || b.status === "success");
    if (!generated) return false;
    const sig = b.linkedSig || { start: "∅", end: "∅" };
    return (
      linkSig(b.startLink) !== (sig.start || "∅") ||
      linkSig(b.endLink) !== (sig.end || "∅")
    );
  }

  function snapshotBridgeLinkedSig(b) {
    b.linkedSig = {
      start: linkSig(b.startLink),
      end: linkSig(b.endLink),
    };
    b.connectionStale = false;
  }

  function linkSourceLabel(link) {
    if (!link) return "—";
    if (link.clipKind === "main") {
      const m = findMain(link.clipId);
      return m ? mainLabel(m) : t("common.mainShortQ");
    }
    const br = bridges.find((x) => x.id === link.clipId);
    return br ? bridgeLabel(br) : t("common.bridgeShortQ");
  }

  function frameHasUsableImage(frame) {
    return !!(
      frame &&
      (frame.rhFileName || frame.blobUrl || frame.playUrl || frame.previewUrl)
    );
  }

  function frameSideReady(b, side) {
    const frame = side === "start" ? b.startFrame : b.endFrame;
    const link = side === "start" ? b.startLink : b.endLink;
    if (frame && frame.rhFileName) return true;
    if (frame && frame.source === "manual" && frameHasUsableImage(frame)) {
      return true;
    }
    if (link && frame && frame.source === "auto") return true;
    if (link && !frame) return true;
    return false;
  }

  function revokeFrameBlob(frame) {
    if (frame && frame.blobUrl) {
      try {
        URL.revokeObjectURL(frame.blobUrl);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** True if frame already has something an <img> can show. */
  function frameHasDisplayPreview(frame) {
    return !!(frame && (frame.blobUrl || frame.playUrl || frame.previewUrl));
  }

  /**
   * Apply auto frame from link; never overwrites manual frames.
   * @param {'start'|'end'} side
   */
  function applyAutoFrameFromLink(b, side, link) {
    const field = side === "start" ? "startFrame" : "endFrame";
    const prev = b[field];
    if (prev && prev.source === "manual") return;

    if (!link) {
      if (prev && prev.source !== "manual") {
        revokeFrameBlob(prev);
        b[field] = null;
      }
      return;
    }

    const sig = linkSig(link);
    if (prev && prev.source === "auto" && prev.linkSig === sig) {
      // Same neighbor link, but draft reload / early skip may leave preview empty —
      // still extract a display preview from the adjacent video.
      if (!frameHasDisplayPreview(prev)) {
        scheduleAutoFramePreview(b, side);
      }
      return;
    }

    revokeFrameBlob(prev);
    b[field] = {
      blobUrl: null,
      playUrl: null,
      mediaFileId: null,
      rhFileName: null,
      sourceMainId: link.clipKind === "main" ? link.clipId : null,
      timeSec: link.srcTimeSec,
      source: "auto",
      previewUrl: null,
      linkSig: sig,
    };
    if (side === "start" && link.clipKind === "main") {
      b.leftMainId = link.clipId;
    }
    if (side === "end" && link.clipKind === "main") {
      b.rightMainId = link.clipId;
    }
    scheduleAutoFramePreview(b, side);
  }

  /** True when URL is cross-origin vs the page (e.g. local agent assets). */
  function mediaUrlIsCrossOrigin(url) {
    if (!url) return false;
    const s = String(url);
    if (s.startsWith("blob:") || s.startsWith("data:")) return false;
    try {
      return new URL(s, location.href).origin !== location.origin;
    } catch (e) {
      return false;
    }
  }

  /**
   * Mark <video> for CORS so canvas export (toDataURL/toBlob) is allowed.
   * Must be called before assigning src. Local-agent playUrls are cross-origin.
   */
  function applyMediaCors(video, url) {
    if (!video) return;
    if (mediaUrlIsCrossOrigin(url)) {
      video.crossOrigin = "anonymous";
    } else {
      video.removeAttribute("crossorigin");
    }
  }

  /**
   * Fetch remote media into a same-origin blob: URL (avoids tainted canvas
   * when CORS-on-video fails due to non-CORS cache, etc.).
   * @returns {Promise<{ src: string, revoke: () => void }>}
   */
  async function mediaUrlAsObjectUrl(playUrl) {
    const resp = await fetch(playUrl);
    if (!resp.ok) throw new Error(t("common.videoLoadFailed"));
    const blob = await resp.blob();
    const src = URL.createObjectURL(blob);
    return {
      src,
      revoke: () => {
        try {
          URL.revokeObjectURL(src);
        } catch (e) {
          /* ignore */
        }
      },
    };
  }

  /**
   * Seek hidden video and extract JPEG blob + dataURL preview.
   * Cross-origin sources (custom-channel / local-agent assets) need CORS or a
   * blob: rewrite; otherwise canvas.toDataURL throws "Tainted canvases…".
   * @returns {Promise<{ blob: Blob, dataUrl: string }>}
   */
  function extractFrameBlobFromUrl(playUrl, timeSec) {
    function extractFromSrc(src) {
      return new Promise((resolve, reject) => {
        if (!src) {
          reject(new Error(t("common.noVideoUrl")));
          return;
        }
        const v = document.createElement("video");
        v.preload = "auto";
        v.muted = true;
        v.playsInline = true;
        applyMediaCors(v, src);
        const cleanup = () => {
          v.removeAttribute("src");
          try {
            v.load();
          } catch (e) {
            /* ignore */
          }
          v.remove();
        };
        v.addEventListener("error", () => {
          cleanup();
          reject(new Error(t("common.videoLoadFailed")));
        });
        v.addEventListener("loadedmetadata", () => {
          const dur = Number(v.duration) || 0;
          const seekTo = Math.max(
            0,
            Math.min(dur > 0 ? dur - 0.001 : 0, Number(timeSec) || 0)
          );
          const onSeeked = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = v.videoWidth;
              canvas.height = v.videoHeight;
              if (!canvas.width || !canvas.height) {
                cleanup();
                reject(new Error(t("common.videoSizeInvalid")));
                return;
              }
              const ctx = canvas.getContext("2d");
              ctx.drawImage(v, 0, 0);
              const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
              canvas.toBlob(
                (blob) => {
                  cleanup();
                  if (!blob) reject(new Error(t("framePicker.captureFailedSimple")));
                  else resolve({ blob, dataUrl });
                },
                "image/jpeg",
                0.92
              );
            } catch (e) {
              cleanup();
              reject(e);
            }
          };
          v.addEventListener("seeked", onSeeked, { once: true });
          try {
            v.currentTime = seekTo;
          } catch (e) {
            cleanup();
            reject(e);
          }
        });
        v.src = src;
      });
    }

    async function extractWithCorsFallback(url) {
      try {
        return await extractFromSrc(url);
      } catch (err) {
        // Cross-origin (local agent): CORS-on-<video> or tainted canvas →
        // rewrite via fetch → blob: so canvas export is same-origin.
        if (!mediaUrlIsCrossOrigin(url)) throw err;
        const obj = await mediaUrlAsObjectUrl(url);
        try {
          return await extractFromSrc(obj.src);
        } finally {
          obj.revoke();
        }
      }
    }

    if (!playUrl) {
      return Promise.reject(new Error(t("common.noVideoUrl")));
    }
    return extractWithCorsFallback(playUrl);
  }

  function scheduleAutoFramePreview(b, side) {
    const key = `${b.id}:${side}`;
    const gen = (autoPreviewGen.get(key) || 0) + 1;
    autoPreviewGen.set(key, gen);
    const frame = side === "start" ? b.startFrame : b.endFrame;
    const link = side === "start" ? b.startLink : b.endLink;
    if (!frame || frame.source !== "auto" || !link || !link.playUrl) return;
    const bridgeId = b.id;
    const timeSec = link.srcTimeSec;
    const playUrl = link.playUrl;
    const expectedSig = linkSig(link);
    extractFrameBlobFromUrl(playUrl, timeSec)
      .then(({ dataUrl }) => {
        if (autoPreviewGen.get(key) !== gen) return;
        const br = bridges.find((x) => x.id === bridgeId);
        if (!br) return;
        const fr = side === "start" ? br.startFrame : br.endFrame;
        if (!fr || fr.source !== "auto" || fr.linkSig !== expectedSig) return;
        fr.previewUrl = dataUrl;
        if (
          selectedClip &&
          selectedClip.kind === "bridge" &&
          selectedClip.id === bridgeId
        ) {
          renderFlfFramePanel(br);
        }
        renderBridges();
      })
      .catch((e) => {
        console.warn("auto frame preview failed", e);
      });
  }

  /**
   * For local video channels: prepare bridge frames as blob URLs without server RH upload.
   */
  async function ensureLocalBridgeFrames(b) {
    for (const side of ["start", "end"]) {
      const field = side === "start" ? "startFrame" : "endFrame";
      const link = side === "start" ? b.startLink : b.endLink;
      let frame = b[field];
      if (
        frame &&
        (frame.blobUrl || frame.playUrl || frame.previewUrl)
      ) {
        continue;
      }
      if (!link || !link.playUrl) {
        throw new Error(
          side === "start" ? t("bridge.prevEmpty") : t("bridge.nextEmpty")
        );
      }
      if (!frame || frame.source !== "auto") {
        applyAutoFrameFromLink(b, side, link);
        frame = b[field];
      }
      const { blob, dataUrl } = await extractFrameBlobFromUrl(
        link.playUrl,
        link.srcTimeSec
      );
      const blobUrl = URL.createObjectURL(blob);
      frame.blobUrl = blobUrl;
      frame.previewUrl = dataUrl;
      frame.playUrl = blobUrl;
      frame.timeSec = link.srcTimeSec;
      frame.linkSig = linkSig(link);
      frame.source = frame.source || "auto";
      frame.origin = "local";
    }
  }

  /**
   * Ensure auto frame has rhFileName by extracting+uploading from link.
   * @param {'start'|'end'} side
   */
  async function cleanupOldBridgeFrame(mediaId) {
    if (!mediaId) return;
    try {
      await fetch(`/api/media_files/${mediaId}`, {
        method: "DELETE",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
    } catch (e) {
      console.warn("清理旧桥帧文件失败:", e);
    }
  }

  async function ensureAutoFrameUploaded(b, side) {
    const field = side === "start" ? "startFrame" : "endFrame";
    const link = side === "start" ? b.startLink : b.endLink;
    let frame = b[field];
    const oldMediaFileId =
      frame && frame.mediaFileId && !isLocalMediaId(frame.mediaFileId)
        ? frame.mediaFileId
        : null;
    if (frame && frame.source === "manual") {
      if (isPlatformRhFileName(frame.rhFileName) && !isLocalMediaId(frame.mediaFileId)) {
        return frame;
      }
      if (frame.blobUrl || frame.playUrl || frame.previewUrl) {
        const file = await fileFromFrame(frame);
        const uploaded = await uploadImage(file);
        frame.rhFileName = uploaded.fileName;
        frame.mediaFileId = uploaded.mediaFileId || null;
        frame.playUrl = uploaded.playUrl || frame.playUrl;
        frame.origin = "server";
        if (oldMediaFileId && oldMediaFileId !== frame.mediaFileId) {
          await cleanupOldBridgeFrame(oldMediaFileId);
        }
        return frame;
      }
      throw new Error(
        side === "start"
          ? t("bridge.manualStartInvalid")
          : t("bridge.manualEndInvalid")
      );
    }
    if (
      frame &&
      isPlatformRhFileName(frame.rhFileName) &&
      !isLocalMediaId(frame.mediaFileId)
    ) {
      return frame;
    }
    if (!link || !link.playUrl) {
      throw new Error(side === "start" ? t("bridge.prevEmpty") : t("bridge.nextEmpty"));
    }
    if (!frame || frame.source !== "auto") {
      applyAutoFrameFromLink(b, side, link);
      frame = b[field];
    }
    const { blob, dataUrl } = await extractFrameBlobFromUrl(
      link.playUrl,
      link.srcTimeSec
    );
    const file = new File(
      [blob],
      `frame_${side}_auto_${Number(link.srcTimeSec).toFixed(2)}.jpg`,
      { type: "image/jpeg" }
    );
    const uploaded = await uploadImage(file);
    frame.previewUrl = dataUrl;
    frame.playUrl = uploaded.playUrl || null;
    frame.mediaFileId = uploaded.mediaFileId || null;
    frame.rhFileName = uploaded.fileName;
    frame.timeSec = link.srcTimeSec;
    frame.linkSig = linkSig(link);
    frame.source = "auto";
    if (oldMediaFileId && oldMediaFileId !== frame.mediaFileId) {
      await cleanupOldBridgeFrame(oldMediaFileId);
    }
    return frame;
  }

  /** Recompute all bridge neighbor links and auto frames after timeline changes. */
  function refreshBridgeLinks() {
    let uiDirty = false;
    bridges.forEach((b) => {
      if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
      const links = computeBridgeLinks(b);
      b.startLink = links.start;
      b.endLink = links.end;

      const prevStartSig = b.startFrame && b.startFrame.linkSig;
      const prevEndSig = b.endFrame && b.endFrame.linkSig;
      applyAutoFrameFromLink(b, "start", links.start);
      applyAutoFrameFromLink(b, "end", links.end);
      if (
        (b.startFrame && b.startFrame.linkSig) !== prevStartSig ||
        (b.endFrame && b.endFrame.linkSig) !== prevEndSig
      ) {
        uiDirty = true;
      }

      const stale = bridgeConnectionStale(b);
      if (stale !== !!b.connectionStale) uiDirty = true;
      b.connectionStale = stale;
      if (stale) {
        b.needsReselect = true;
        if (b.playUrl || b.status === "success") {
          b.label = t("timeline.staleChip");
        }
      }
    });
    return uiDirty;
  }

  function buildSchedule() {
    ensureDefaultTrack();
    const priority = new Map();
    tracks.forEach((t, i) => {
      if (t.kind === "video" && !t.hidden) priority.set(t.id, i);
    });
    const clips = allPlacedClips().filter((c) => priority.has(c.trackId));
    const points = new Set([0]);
    let contentEnd = 0;
    clips.forEach((c) => {
      if (!c.playUrl) return;
      points.add(c.start);
      points.add(c.end);
      contentEnd = Math.max(contentEnd, c.end);
    });
    buildAudioSchedule().forEach((a) => {
      contentEnd = Math.max(contentEnd, a.gEnd);
    });
    // No playable visible content → empty schedule (no trailing black).
    if (contentEnd <= 0) {
      schedule = [];
      return schedule;
    }
    points.add(contentEnd);
    const sorted = Array.from(points)
      .filter((t) => t <= contentEnd + 1e-9)
      .sort((a, b) => a - b);
    /** @type {{ gStart: number, gEnd: number, kind: string, sourceId: string|null, playUrl: string|null, srcIn: number, prompt: string, label: string }[]} */
    const segs = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const gStart = sorted[i];
      const gEnd = sorted[i + 1];
      if (gEnd - gStart < 1e-4) continue;
      if (gStart >= contentEnd - 1e-9) continue;
      const mid = (gStart + gEnd) / 2;
      let best = null;
      let bestPri = -1;
      for (const c of clips) {
        if (!c.playUrl) continue;
        if (mid < c.start || mid >= c.end) continue;
        const pri = priority.has(c.trackId) ? priority.get(c.trackId) : -1;
        if (pri > bestPri) {
          bestPri = pri;
          best = c;
        }
      }
      const last = segs[segs.length - 1];
      if (!best) {
        if (
          last &&
          last.kind === "gap" &&
          Math.abs(last.gEnd - gStart) < 1e-4
        ) {
          last.gEnd = gEnd;
        } else {
          segs.push({
            gStart,
            gEnd,
            kind: "gap",
            sourceId: null,
            playUrl: null,
            srcIn: 0,
            prompt: "",
            label: t("preview.blackFrame"),
          });
        }
        continue;
      }
      const srcIn = best.inSec + (gStart - best.start);
      if (
        last &&
        last.sourceId === best.id &&
        last.kind === best.kind &&
        Math.abs(last.gEnd - gStart) < 1e-4
      ) {
        last.gEnd = gEnd;
      } else {
        segs.push({
          gStart,
          gEnd,
          kind: best.kind,
          sourceId: best.id,
          playUrl: best.playUrl,
          srcIn,
          prompt: best.prompt,
          label: best.label,
        });
      }
    }
    schedule = segs;
    return segs;
  }

  function createExportAudioMix() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const dest = ctx.createMediaStreamDestination();
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(dest);
    return { ctx, dest, master, pool: new Map() };
  }

  function syncExportAudioMix(mix, globalSec, audioSegments, playing) {
    if (!mix) return;
    const { ctx, master, pool } = mix;
    if (playing && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const activeUrls = new Set();
    for (const seg of audioSegments) {
      if (globalSec < seg.gStart - 0.03 || globalSec >= seg.gEnd - 0.01) {
        continue;
      }
      activeUrls.add(seg.playUrl);
      let entry = pool.get(seg.playUrl);
      if (!entry) {
        const el = document.createElement(
          isAudioMediaUrl(seg.playUrl) ? "audio" : "video"
        );
        el.preload = "auto";
        el.muted = false;
        el.style.cssText =
          "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
        document.body.appendChild(el);
        applyMediaCors(el, seg.playUrl);
        el.src = seg.playUrl;
        const gain = ctx.createGain();
        try {
          const src = ctx.createMediaElementSource(el);
          src.connect(gain);
          gain.connect(master);
          entry = { el, gain };
        } catch (e) {
          console.warn("export audio connect failed", e);
          el.remove();
          continue;
        }
        pool.set(seg.playUrl, entry);
      }
      const localT = seg.srcIn + (globalSec - seg.gStart);
      if (Math.abs((entry.el.currentTime || 0) - localT) > 0.12) {
        try {
          entry.el.currentTime = Math.max(0, localT);
        } catch (_) {}
      }
      if (playing) {
        if (entry.el.paused) entry.el.play().catch(() => {});
      } else if (!entry.el.paused) {
        entry.el.pause();
      }
    }
    pool.forEach((entry, url) => {
      if (!activeUrls.has(url) && entry.el && !entry.el.paused) {
        entry.el.pause();
      }
    });
  }

  function stopExportAudioMix(mix) {
    if (!mix) return;
    mix.pool.forEach(({ el }) => {
      try {
        el.pause();
      } catch (_) {}
      el.remove();
    });
    mix.pool.clear();
    try {
      mix.ctx.close();
    } catch (_) {}
  }

  /**
   * Edit decision list for export. Video segments match preview schedule
   * (topmost-wins). audioSegments follow the same mute rules as preview mix.
   */
  function buildExportPlan() {
    const size = getWfSizePayload();
    const segs = buildSchedule();
    const audioSegs = buildAudioSchedule();
    return {
      width: size.width,
      height: size.height,
      fps: getGlobalFps(),
      videoSegments: segs.map((s) => ({
        gStart: s.gStart,
        gEnd: s.gEnd,
        playUrl: s.playUrl,
        srcIn: s.srcIn,
        kind: s.kind,
        sourceId: s.sourceId,
        label: s.label || "",
        duration: Math.max(0, s.gEnd - s.gStart),
      })),
      audioSegments: audioSegs.map((s) => ({
        playUrl: s.playUrl,
        gStart: s.gStart,
        gEnd: s.gEnd,
        srcIn: s.srcIn,
        label: s.label || "",
        duration: Math.max(0, s.gEnd - s.gStart),
      })),
    };
  }

  function pickRecorderMime() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const t of candidates) {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported(t)
      ) {
        return t;
      }
    }
    return "";
  }

  function drawVideoContain(ctx, video, w, h) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    ctx.drawImage(video, dx, dy, dw, dh);
  }

  function loadExportVideo(video, url, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const onMeta = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(t("common.videoLoadFailed")));
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort);
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      if (video.getAttribute("src") === url && video.readyState >= 1) {
        cleanup();
        resolve();
        return;
      }
      applyMediaCors(video, url);
      video.src = url;
      try {
        video.load();
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  function seekExportVideo(video, timeSec, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const target = Math.max(0, Number(timeSec) || 0);
      if (Math.abs((video.currentTime || 0) - target) < 0.04) {
        resolve();
        return;
      }
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(t("common.videoSeekFailed")));
      };
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onErr);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onErr);
      try {
        video.currentTime = target;
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  /**
   * Play one schedule segment onto canvas in real time (wall-clock duration).
   * MediaRecorder samples the canvas stream independently.
   *
   * Finish only after source has reached the trim end (or EOF). If EOF arrives
   * before wall-clock duration, hold the last frame until duration elapses —
   * matching preview so the last export segment is not truncated. If the media
   * clock lags wall clock, keep playing until source end (with a short overtime
   * cap) so trailing frames are not dropped.
   */
  function playSegmentToCanvas(video, ctx, canvas, seg, signal, onProgress) {
    const duration = Math.max(0.05, Number(seg.duration) || 0);
    const srcIn = Number(seg.srcIn) || 0;
    const mediaDur =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Infinity;
    const endSrc = Math.min(srcIn + duration, mediaDur);
    const overtimeCap = duration + 0.75;
    return new Promise((resolve, reject) => {
      let raf = null;
      let settled = false;
      let holdingLastFrame = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (raf != null) cancelAnimationFrame(raf);
        raf = null;
        try {
          video.pause();
        } catch (_) {}
        if (signal) signal.removeEventListener("abort", onAbort);
        video.removeEventListener("ended", onEnded);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
      const beginHoldLastFrame = () => {
        if (holdingLastFrame) return;
        holdingLastFrame = true;
        try {
          video.pause();
        } catch (_) {}
        drawVideoContain(ctx, video, canvas.width, canvas.height);
      };
      const onEnded = () => {
        beginHoldLastFrame();
      };
      if (signal) signal.addEventListener("abort", onAbort);
      video.addEventListener("ended", onEnded);

      seekExportVideo(video, srcIn, signal)
        .then(() => video.play())
        .then(() => {
          const t0 = performance.now();
          const tick = () => {
            if (settled) return;
            if (signal && signal.aborted) {
              finish(new DOMException("Aborted", "AbortError"));
              return;
            }
            drawVideoContain(ctx, video, canvas.width, canvas.height);
            const elapsed = (performance.now() - t0) / 1000;
            const srcT = video.currentTime;
            if (onProgress) {
              onProgress(Math.min(1, elapsed / duration));
            }
            const sourceDone =
              holdingLastFrame ||
              video.ended ||
              srcT >= endSrc - 0.03;
            if (sourceDone) {
              beginHoldLastFrame();
              // Pad frozen frames if media ended before scheduled duration.
              if (elapsed >= duration || elapsed >= overtimeCap) {
                drawVideoContain(ctx, video, canvas.width, canvas.height);
                finish(null);
                return;
              }
              raf = requestAnimationFrame(tick);
              return;
            }
            // Media lagging wall clock: keep playing for trailing frames.
            if (elapsed >= overtimeCap) {
              beginHoldLastFrame();
              finish(null);
              return;
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        })
        .catch((e) => finish(e));
    });
  }

  /** Hold last canvas frame briefly, requestData, then stop MediaRecorder. */
  async function flushAndStopRecorder(recorder, fps) {
    if (!recorder || recorder.state === "inactive") return;
    const frameMs = Math.ceil(1000 / Math.max(1, Number(fps) || 16));
    // captureStream + WebM often drop trailing frames if stop() is immediate.
    await new Promise((r) => setTimeout(r, Math.max(500, frameMs * 8)));
    try {
      if (
        recorder.state === "recording" &&
        typeof recorder.requestData === "function"
      ) {
        recorder.requestData();
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
    if (recorder.state !== "inactive") recorder.stop();
  }

  /** Hold solid black on canvas for wall-clock duration (gap filler). */
  function holdBlackOnCanvas(ctx, canvas, duration, signal, onProgress) {
    const dur = Math.max(0.05, Number(duration) || 0);
    return new Promise((resolve, reject) => {
      let raf = null;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (raf != null) cancelAnimationFrame(raf);
        raf = null;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
      if (signal) signal.addEventListener("abort", onAbort);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const t0 = performance.now();
      const tick = () => {
        if (settled) return;
        if (signal && signal.aborted) {
          finish(new DOMException("Aborted", "AbortError"));
          return;
        }
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const elapsed = (performance.now() - t0) / 1000;
        if (onProgress) onProgress(Math.min(1, elapsed / dur));
        if (elapsed >= dur) {
          finish(null);
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function setExportMeta(text) {
    if (!exportState) return;
    exportState.meta = text;
    if (playlistMeta) {
      playlistMeta.textContent = text;
      playlistMeta.classList.add("is-exporting");
    }
  }

  function updateExportUi() {
    const busy = !!exportState;
    if (btnExportVideo) {
      btnExportVideo.classList.toggle("is-exporting", busy);
      btnExportVideo.textContent = busy ? t("preview.exportCancel") : t("preview.export");
      btnExportVideo.disabled = false;
      btnExportVideo.title = busy
        ? t("preview.exportCancelTitle")
        : t("preview.exportTitle");
    }
    if (btnPlaylistPlay) btnPlaylistPlay.disabled = busy;
    if (btnPlaylistPrev) btnPlaylistPrev.disabled = busy;
    if (btnPlaylistNext) btnPlaylistNext.disabled = busy;
    if (!busy && playlistMeta) {
      playlistMeta.classList.remove("is-exporting");
    }
  }

  function cancelTimelineExport() {
    if (exportState && exportState.abort) {
      exportState.abort.abort();
    }
  }

  /** Slice timeline into an export plan for [inSec, outSec]. */
  function buildRangeExportPlan(inSec, outSec) {
    const size = getWfSizePayload();
    const segs = buildSchedule().filter((s) => s.gEnd > inSec && s.gStart < outSec);
    const audioSegs = buildAudioSchedule().filter(
      (s) => s.gEnd > inSec && s.gStart < outSec
    );
    const videoSegments = [];
    for (const s of segs) {
      const clipStart = Math.max(s.gStart, inSec);
      const clipEnd = Math.min(s.gEnd, outSec);
      const dur = clipEnd - clipStart;
      if (dur < 0.02) continue;
      videoSegments.push({
        gStart: clipStart - inSec,
        gEnd: clipEnd - inSec,
        playUrl: s.playUrl,
        srcIn: (Number(s.srcIn) || 0) + (clipStart - s.gStart),
        kind: s.kind,
        sourceId: s.sourceId,
        label: s.label || "",
        duration: dur,
      });
    }
    const audioSegments = [];
    for (const s of audioSegs) {
      const clipStart = Math.max(s.gStart, inSec);
      const clipEnd = Math.min(s.gEnd, outSec);
      const dur = clipEnd - clipStart;
      if (dur < 0.02) continue;
      audioSegments.push({
        playUrl: s.playUrl,
        gStart: clipStart - inSec,
        gEnd: clipEnd - inSec,
        srcIn: (Number(s.srcIn) || 0) + (clipStart - s.gStart),
        label: s.label || "",
        duration: dur,
      });
    }
    return {
      width: size.width,
      height: size.height,
      fps: getGlobalFps(),
      videoSegments,
      audioSegments,
    };
  }

  function formatOfflineExportProgress(progress) {
    if (!progress) return t("preview.exporting");
    if (progress.phase === "video") {
      return t("preview.exportFrameProgress", {
        frame: progress.frame,
        total: progress.totalFrames,
        pct: Math.round((progress.ratio || 0) * 100),
      });
    }
    if (progress.phase === "audio") {
      return t("preview.exportAudioMixing");
    }
    if (progress.phase === "finish") {
      return t("preview.exportFinishing");
    }
    return t("preview.exporting");
  }

  function getOfflineExportApi() {
    return window.VflowOfflineExport || null;
  }

  async function runTimelineExport() {
    if (exportState) {
      cancelTimelineExport();
      return;
    }

    const offlineApi = getOfflineExportApi();
    const useOffline = !!(offlineApi && offlineApi.canOfflineExport());
    let mime = "";
    if (!useOffline) {
      if (typeof MediaRecorder === "undefined") {
        alert(t("common.webCodecsUnsupported"));
        return;
      }
      mime = pickRecorderMime();
      if (!mime) {
        alert(t("common.webmUnsupported"));
        return;
      }
    }

    stopTimelinePlayback();
    const abort = new AbortController();
    exportState = { abort, meta: t("preview.exportPreparing") };
    updateExportUi();
    setExportMeta(t("preview.exportPreparing"));

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    if (!useOffline) document.body.appendChild(video);

    let recorder = null;
    let stream = null;
    let exportAudioMix = null;

    try {
      await probeAllClipDurations();
      if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const plan = buildExportPlan();
      const segs = plan.videoSegments.filter((s) => s.duration > 0);
      const hasVideo = segs.some((s) => s.playUrl && s.kind !== "gap");
      const hasAudio = !!(plan.audioSegments && plan.audioSegments.length);
      if ((!segs.length && !hasAudio) || (!hasVideo && !hasAudio)) {
        alert(t("main.noExportableClips"));
        return;
      }

      if (useOffline) {
        setExportMeta(t("preview.exportEncoding"));
        const blob = await offlineApi.encodeTimelineWebm(plan, {
          signal: abort.signal,
          onProgress: (progress) => {
            setExportMeta(formatOfflineExportProgress(progress));
          },
          loadVideo: loadExportVideo,
          seekVideo: seekExportVideo,
          drawFrame: drawVideoContain,
        });
        if (abort.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const safeName = String(currentProjectName || "project")
          .replace(/[\\/:*?"<>|]+/g, "_")
          .trim()
          .slice(0, 80);
        downloadBlob(blob, `${safeName || "project"}_export.webm`);
        setExportMeta(
          t("preview.exportDone", {
            size: (blob.size / (1024 * 1024)).toFixed(1),
          })
        );
        return;
      }

      document.body.appendChild(video);
      console.warn(
        "[export] Using realtime MediaRecorder fallback — keep this tab visible until export completes."
      );
      exportAudioMix =
        plan.audioSegments && plan.audioSegments.length
          ? createExportAudioMix()
          : null;
      if (exportAudioMix) {
        await exportAudioMix.ctx.resume();
      }

      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error(t("common.canvasCreateFailed"));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      stream = canvas.captureStream(plan.fps);
      if (exportAudioMix) {
        const audioTrack = exportAudioMix.dest.stream.getAudioTracks()[0];
        if (audioTrack) stream.addTrack(audioTrack);
      }
      const chunks = [];
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: Math.min(
          8_000_000,
          Math.max(2_500_000, plan.width * plan.height * plan.fps * 0.12)
        ),
      });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.start(250);

      // Warm-up black frames so the container has a keyframe.
      await new Promise((r) => setTimeout(r, Math.ceil(1000 / plan.fps) * 2));

      const totalDur = segs.reduce((a, s) => a + s.duration, 0);
      let doneDur = 0;

      for (let i = 0; i < segs.length; i++) {
        if (abort.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const seg = segs[i];
        if (exportAudioMix) {
          syncExportAudioMix(exportAudioMix, doneDur, plan.audioSegments, true);
        }
        setExportMeta(
          `导出中 ${Math.round((doneDur / totalDur) * 100)}% · 段 ${i + 1}/${segs.length}`
        );
        try {
          const onProgress = (localP) => {
            if (exportAudioMix) {
              syncExportAudioMix(
                exportAudioMix,
                doneDur + localP * seg.duration,
                plan.audioSegments,
                true
              );
            }
            const p = (doneDur + localP * seg.duration) / totalDur;
            setExportMeta(
              `导出中 ${Math.round(p * 100)}% · 段 ${i + 1}/${segs.length}`
            );
          };
          if (seg.kind === "gap" || !seg.playUrl) {
            await holdBlackOnCanvas(
              ctx,
              canvas,
              seg.duration,
              abort.signal,
              onProgress
            );
          } else {
            await loadExportVideo(video, seg.playUrl, abort.signal);
            await playSegmentToCanvas(
              video,
              ctx,
              canvas,
              seg,
              abort.signal,
              onProgress
            );
          }
        } catch (e) {
          if (e && e.name === "AbortError") throw e;
          throw new Error(
            t("export.failedSeg", { label: seg.label || t("preview.segmentPrefix") + (i + 1), error: e.message || e })
          );
        }
        doneDur += seg.duration;
      }

      setExportMeta(t("preview.exportFinishing"));
      await flushAndStopRecorder(recorder, plan.fps);
      await stopped;

      if (abort.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (!chunks.length) throw new Error(t("preview.exportEmpty"));

      const blob = new Blob(chunks, { type: mime.split(";")[0] || "video/webm" });
      const safeName = String(currentProjectName || "project")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .trim()
        .slice(0, 80);
      downloadBlob(blob, `${safeName || "project"}_export.webm`);
      setExportMeta(`导出完成 · ${(blob.size / (1024 * 1024)).toFixed(1)} MB`);
    } catch (e) {
      if (e && e.name === "AbortError") {
        setExportMeta(t("preview.exportCanceled"));
      } else {
        console.error(e);
        alert(e.message || String(e));
        setExportMeta("");
      }
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch (_) {}
      }
    } finally {
      stopExportAudioMix(exportAudioMix);
      try {
        video.pause();
      } catch (_) {}
      video.removeAttribute("src");
      try {
        video.load();
      } catch (_) {}
      video.remove();
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      exportState = null;
      updateExportUi();
      updatePlaylistMeta();
    }
  }

  function rebuildTimeline() {
    ensureDefaultTrack();
    invalidateAudioScheduleCache();
    buildSchedule();
    const linksDirty = refreshBridgeLinks();
    renderTimelineTrack();
    updatePlaylistMeta();
    updatePlayheadUi();
    renderMediaBridges();
    if (linksDirty) {
      renderBridges();
      if (
        selectedClip &&
        selectedClip.kind === "bridge"
      ) {
        const br = bridges.find((x) => x.id === selectedClip.id);
        if (br) {
          renderFlfFramePanel(br);
          renderSelectionUI();
        }
      }
    }
    probeAllClipDurations().catch(() => {});
  }

  function rulerStepSec() {
    if (pxPerSec >= 80) return 0.5;
    if (pxPerSec >= 40) return 1;
    if (pxPerSec >= 20) return 2;
    if (pxPerSec >= 10) return 5;
    return 10;
  }

  function setPxPerSec(next) {
    pxPerSec = Math.min(
      PX_PER_SEC_MAX,
      Math.max(PX_PER_SEC_MIN, Number(next) || 40)
    );
    if (tlZoomLabel) {
      tlZoomLabel.textContent = t("timeline.zoomLabel", {
        px: Math.round(pxPerSec),
      });
    }
    renderTimelineTrack();
  }

  function fitTimelineZoom() {
    if (!timelineScroll) return;
    const total = timelineTotalDuration();
    const w = Math.max(200, timelineScroll.clientWidth - 8);
    setPxPerSec(w / Math.max(total, 1));
  }

  function updatePlayheadUi() {
    if (timelinePlayhead) {
      timelinePlayhead.style.left = `${playheadSec * pxPerSec}px`;
    }
    if (tlPlayheadTime) {
      tlPlayheadTime.textContent = formatTlTime(playheadSec);
    }
  }

  function canvasWidthPx() {
    return Math.max(
      (timelineScroll && timelineScroll.clientWidth) || 400,
      timelineTotalDuration() * pxPerSec + 80
    );
  }

  const TL_LANE_H = 56;
  const TL_RULER_H = 28;
  const TL_MIN_H = 128;
  /** Grow timeline panel with track count; cap at ~half viewport. */
  function updateTimelineHeight() {
    const shell = document.querySelector(".editor-timeline");
    if (!shell) return;
    const head = shell.querySelector(".timeline-head");
    const headH = (head && head.offsetHeight) || 28;
    // padding 8+10, gap 6, body border 2
    const chrome = 8 + 10 + 6 + 2;
    const n = Math.max(1, tracks.length || 1);
    const desired = headH + chrome + TL_RULER_H + TL_LANE_H * n;
    const maxH = Math.round(window.innerHeight * 0.5);
    const h = Math.min(maxH, Math.max(TL_MIN_H, desired));
    document.documentElement.style.setProperty("--timeline-h", `${h}px`);
  }

  function timelineClipSub(c) {
    const isStale = c.kind === "bridge" && c.clip && c.clip.connectionStale;
    if (isStale) return t("timeline.connectionStale");
    if (c.playUrl) {
      return `${formatTlTime(c.start)} · ${c.durationSec.toFixed(1)}s`;
    }
    const s = (c.status || "").toLowerCase();
    if (s === "running" || s === "finalizing") return t("timeline.generating");
    if (s === "queued") return t("status.queuing");
    if (s === "pending") {
      const lbl = (c.clip && c.clip.label) || "";
      if (
        lbl === t("status.pending") ||
        lbl === t("common.queueParamsUpdated") ||
        lbl === t("status.submitting")
      ) {
        return lbl;
      }
    }
    return t("timeline.pendingGen");
  }

  function renderTimelineTrack() {
    if (!timelineTracks || !timelineLabels || !timelineRuler || !timelineCanvas) {
      return;
    }
    ensureDefaultTrack();
    buildSchedule();

    const width = canvasWidthPx();
    timelineCanvas.style.width = `${width}px`;
    timelineCanvas.style.setProperty("--tl-pps", `${pxPerSec}px`);
    if (tlZoomLabel) {
      tlZoomLabel.textContent = t("timeline.zoomLabel", {
        px: Math.round(pxPerSec),
      });
    }

    // Labels: spacer + tracks top→bottom (highest priority first visually)
    const visualTracks = tracks.slice().reverse();
    timelineLabels.innerHTML = "";
    const spacer = document.createElement("div");
    spacer.className = "tl-label-spacer";
    timelineLabels.appendChild(spacer);

    visualTracks.forEach((track) => {
      const lab = document.createElement("div");
      const isHidden = !!track.hidden;
      lab.className =
        "tl-track-label" +
        (track.kind === "audio" ? " is-audio" : "") +
        (isHidden ? " is-hidden" : "");
      lab.dataset.trackId = track.id;
      const onlyVideo = videoTrackCount() <= 1;
      const isMutedLayer = !!track.muteAudio;
      let actions;
      if (track.kind === "video") {
        actions = `<div class="tl-track-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-tl-add="main" title="${t("storyboard.addMain")}">${t("timeline.addMain")}</button>
              <button type="button" class="btn btn-ghost btn-sm" data-tl-add="bridge" title="${t("timeline.addBridgeTitle")}">${t("timeline.addBridge")}</button>
              <button type="button" class="btn btn-ghost btn-sm tl-track-btn${
                isHidden ? " is-active" : ""
              }" data-tl-hide title="${
                isHidden ? t("timeline.showLayer") : t("timeline.hideLayer")
              }" aria-pressed="${isHidden ? "true" : "false"}">${
                isHidden ? t("timeline.showLayerShort") : t("timeline.hideLayerShort")
              }</button>
              <button type="button" class="btn btn-ghost btn-sm tl-track-btn${
                isMutedLayer ? " is-active" : ""
              }" data-tl-mute-audio title="${
                isMutedLayer ? t("timeline.unmuteLayer") : t("timeline.muteLayer")
              }" aria-pressed="${isMutedLayer ? "true" : "false"}">${
                isMutedLayer ? t("timeline.unmuteLayerShort") : t("timeline.muteLayerShort")
              }</button>
              <button type="button" class="btn btn-ghost btn-sm tl-track-btn" data-tl-del title="${t("timeline.deleteLayer")}"${
                onlyVideo ? " disabled" : ""
              }>${t("timeline.deleteLayerShort")}</button>
            </div>`;
      } else {
        actions = `<div class="tl-track-actions">
              <button type="button" class="btn btn-ghost btn-sm tl-track-btn${
                isHidden ? " is-active" : ""
              }" data-tl-hide title="${
                isHidden ? t("timeline.showLayer") : t("timeline.hideLayer")
              }" aria-pressed="${isHidden ? "true" : "false"}">${
                isHidden ? t("timeline.showLayerShort") : t("timeline.hideLayerShort")
              }</button>
              <button type="button" class="btn btn-ghost btn-sm tl-track-btn" data-tl-del title="${t("timeline.deleteLayer")}">${t("timeline.deleteLayerShort")}</button>
            </div>`;
      }
      lab.innerHTML = `<span class="tl-track-name" title="${escapeHtml(
        track.name
      )}">${escapeHtml(track.name)}</span>${actions}`;
      lab.querySelectorAll("[data-tl-add]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const kind = btn.getAttribute("data-tl-add");
          if (kind === "main") {
            const m = emptyMain("", {
              trackId: track.id,
              startSec: nextStartOnTrack(track.id),
            });
            mains.push(m);
            selectedClip = { kind: "main", id: m.id };
            renderAll();
            scheduleSaveDraft();
          } else if (kind === "bridge") {
            addBridgeClip(track.id);
          }
        });
      });
      const hideBtn = lab.querySelector("[data-tl-hide]");
      if (hideBtn) {
        hideBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleTrackHidden(track.id);
        });
      }
      const muteAudioBtn = lab.querySelector("[data-tl-mute-audio]");
      if (muteAudioBtn) {
        muteAudioBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleTrackMuteAudio(track.id);
        });
      }
      const delBtn = lab.querySelector("[data-tl-del]");
      if (delBtn) {
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (track.kind === "audio") removeAudioTrack(track.id);
          else removeVideoTrack(track.id);
        });
      }
      timelineLabels.appendChild(lab);
    });

    // Ruler
    timelineRuler.innerHTML = "";
    timelineRuler.style.width = `${width}px`;
    const step = rulerStepSec();
    const total = timelineTotalDuration();
    for (let t = 0; t <= total + step; t += step) {
      const tick = document.createElement("div");
      const isMajor = Math.abs(t % (step >= 5 ? step : 5)) < 1e-6 || t === 0;
      tick.className = "tl-tick" + (isMajor ? " is-major" : "");
      tick.style.left = `${t * pxPerSec}px`;
      if (isMajor || step <= 1) {
        const label = document.createElement("span");
        label.className = "tl-tick-label";
        label.textContent = formatTlTime(t);
        tick.appendChild(label);
      }
      timelineRuler.appendChild(tick);
    }

    // Selection range highlight on ruler
    const oldRange = timelineRuler.querySelector(".tl-sel-range");
    if (oldRange) oldRange.remove();
    if (
      timelineSelection &&
      timelineSelection.kind === "range" &&
      timelineSelection.outSec > timelineSelection.inSec
    ) {
      const rangeEl = document.createElement("div");
      rangeEl.className = "tl-sel-range";
      rangeEl.style.left = `${timelineSelection.inSec * pxPerSec}px`;
      rangeEl.style.width = `${
        (timelineSelection.outSec - timelineSelection.inSec) * pxPerSec
      }px`;
      timelineRuler.appendChild(rangeEl);
    }

    // Lanes
    timelineTracks.innerHTML = "";
    const placed = allPlacedClips();
    visualTracks.forEach((track) => {
      const lane = document.createElement("div");
      lane.className = "tl-lane" + (track.hidden ? " is-hidden" : "");
      lane.dataset.trackId = track.id;
      lane.style.width = `${width}px`;

      placed
        .filter((c) => c.trackId === track.id)
        .forEach((c) => {
          const el = document.createElement("div");
          const isActive =
            selectedClip &&
            selectedClip.kind === c.kind &&
            selectedClip.id === c.id;
          const isStale =
            c.kind === "bridge" && c.clip && c.clip.connectionStale;
          const kindClass =
            c.kind === "bridge"
              ? " is-bridge"
              : c.kind === "edit"
                ? " is-edit"
                : c.kind === "audio"
                  ? " is-audio"
                  : " is-main";
          const isMutedClip =
            c.kind !== "audio" && c.clip && c.clip.muteAudio;
          el.className =
            "tl-clip" +
            kindClass +
            (isActive ? " is-active" : "") +
            (isStale ? " is-stale" : "") +
            (isMutedClip ? " is-audio-muted" : "") +
            ` status-${badgeClass(c.status)}`;
          el.dataset.clipKind = c.kind;
          el.dataset.clipId = c.id;
          el.style.left = `${c.start * pxPerSec}px`;
          el.style.width = `${Math.max(24, c.durationSec * pxPerSec)}px`;
          const sub = timelineClipSub(c);
          el.innerHTML = `<span class="tl-clip-label">${escapeHtml(
            c.label
          )}</span><span class="chip-sub">${escapeHtml(sub)}</span>`;
          el.title = isStale
            ? `${c.prompt}\n${t("timeline.connectionStaleFull")}`
            : c.prompt;
          ["left", "right"].forEach((edge) => {
            const handle = document.createElement("span");
            handle.className = `tl-trim-handle is-${edge}`;
            handle.title = t("timeline.trimHint");
            handle.addEventListener("pointerdown", (e) =>
              onTrimPointerDown(e, c, el, edge)
            );
            el.appendChild(handle);
          });
          el.addEventListener("pointerdown", (e) =>
            onClipPointerDown(e, c, el)
          );
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openClipContextMenu(e.clientX, e.clientY, c.kind, c.id);
          });
          el.addEventListener("click", (e) => {
            if (Date.now() < suppressClipClickUntil) return;
            if (dragState && dragState.moved) return;
            if (trimState && trimState.moved) return;
            e.stopPropagation();
            // Clicking a clip outside the box selection exits the selection
            if (
              timelineSelection &&
              (timelineSelection.kind === "range" ||
                timelineSelection.kind === "frame") &&
              !isSecInsideTimelineSelection(timelineSecFromClientX(e.clientX))
            ) {
              timelineSelection = null;
            }
            selectAndPreviewClip(c.kind, c.id, false);
          });
          lane.appendChild(el);
        });

      timelineTracks.appendChild(lane);
    });

    if (!placed.length) {
      const hint = document.createElement("p");
      hint.className = "muted tl-empty-hint";
      hint.textContent =
        t("timeline.emptyHint");
      timelineTracks.appendChild(hint);
    }

    updatePlayheadUi();
    updateTimelineHeight();
  }

  function snapStartSec(raw, excludeKind, excludeId) {
    const candidates = [0, playheadSec];
    allPlacedClips().forEach((c) => {
      if (c.kind === excludeKind && c.id === excludeId) return;
      candidates.push(c.start, c.end);
    });
    const threshold = Math.max(0.12, 6 / pxPerSec);
    let best = Math.max(0, raw);
    let bestDist = threshold;
    candidates.forEach((c) => {
      const d = Math.abs(raw - c);
      if (d <= bestDist) {
        bestDist = d;
        best = Math.max(0, c);
      }
    });
    return Math.round(best * 100) / 100;
  }

  function trackIdFromClientY(clientY) {
    if (!timelineTracks) return defaultVideoTrackId();
    const lanes = timelineTracks.querySelectorAll(".tl-lane");
    for (const lane of lanes) {
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return lane.dataset.trackId || defaultVideoTrackId();
      }
    }
    if (!lanes.length) return defaultVideoTrackId();
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    if (clientY < first.top) return lanes[0].dataset.trackId;
    return lanes[lanes.length - 1].dataset.trackId;
  }

  function onTrimPointerDown(e, placed, el, edge) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeClipContextMenu();
    clearClipLongPress();
    if (dragState) return;
    const clip = placed.clip;
    const originStart = Number(clip.startSec) || 0;
    const originIn = Number(clip.inSec) || 0;
    const originOut = clipResolvedOutSec(clip);
    if (clip.outSec == null) clip.outSec = originOut;
    const mediaDur =
      clip.durationSec != null && Number(clip.durationSec) > 0
        ? Number(clip.durationSec)
        : null;
    trimState = {
      kind: placed.kind,
      id: placed.id,
      el,
      edge: edge === "right" ? "right" : "left",
      originStart,
      originIn,
      originOut,
      originDur: Math.max(MIN_CLIP_TRIM_SEC, originOut - originIn),
      mediaDur,
      pointerId: e.pointerId,
      moved: false,
    };
    el.classList.add("is-trimming");
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", onTrimPointerMove);
    el.addEventListener("pointerup", onTrimPointerUp);
    el.addEventListener("pointercancel", onTrimPointerUp);
  }

  function onTrimPointerMove(e) {
    if (!trimState || e.pointerId !== trimState.pointerId) return;
    if (!timelineScroll) return;
    const rect = timelineScroll.getBoundingClientRect();
    const sec = Math.max(
      0,
      (e.clientX - rect.left + timelineScroll.scrollLeft) / pxPerSec
    );
    if (trimState.edge === "left") {
      const rightEdge = trimState.originStart + trimState.originDur;
      let newStart = snapStartSec(sec, trimState.kind, trimState.id);
      newStart = Math.min(newStart, rightEdge - MIN_CLIP_TRIM_SEC);
      let newIn = trimState.originIn + (newStart - trimState.originStart);
      if (newIn < 0) {
        newStart = trimState.originStart - trimState.originIn;
        newIn = 0;
      }
      newStart = Math.max(0, Math.min(newStart, rightEdge - MIN_CLIP_TRIM_SEC));
      newIn = trimState.originIn + (newStart - trimState.originStart);
      if (newIn < 0) {
        newIn = 0;
        newStart = trimState.originStart - trimState.originIn;
        newStart = Math.max(0, newStart);
      }
      const newDur = rightEdge - newStart;
      trimState.el.style.left = `${newStart * pxPerSec}px`;
      trimState.el.style.width = `${Math.max(24, newDur * pxPerSec)}px`;
      trimState._pendingStart = newStart;
      trimState._pendingIn = newIn;
      trimState._pendingOut = trimState.originOut;
      trimState.moved =
        Math.abs(newStart - trimState.originStart) > 0.001 ||
        Math.abs(newIn - trimState.originIn) > 0.001;
    } else {
      let newEnd = snapStartSec(sec, trimState.kind, trimState.id);
      newEnd = Math.max(trimState.originStart + MIN_CLIP_TRIM_SEC, newEnd);
      let newOut =
        trimState.originIn + (newEnd - trimState.originStart);
      if (trimState.mediaDur != null) {
        newOut = Math.min(newOut, trimState.mediaDur);
        newEnd = trimState.originStart + (newOut - trimState.originIn);
      }
      if (newOut < trimState.originIn + MIN_CLIP_TRIM_SEC) {
        newOut = trimState.originIn + MIN_CLIP_TRIM_SEC;
        newEnd = trimState.originStart + MIN_CLIP_TRIM_SEC;
      }
      const newDur = Math.max(MIN_CLIP_TRIM_SEC, newEnd - trimState.originStart);
      trimState.el.style.width = `${Math.max(24, newDur * pxPerSec)}px`;
      trimState._pendingStart = trimState.originStart;
      trimState._pendingIn = trimState.originIn;
      trimState._pendingOut = newOut;
      trimState.moved = Math.abs(newOut - trimState.originOut) > 0.001;
    }
  }

  function onTrimPointerUp(e) {
    if (!trimState || e.pointerId !== trimState.pointerId) return;
    const el = trimState.el;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (_) {}
    el.removeEventListener("pointermove", onTrimPointerMove);
    el.removeEventListener("pointerup", onTrimPointerUp);
    el.removeEventListener("pointercancel", onTrimPointerUp);
    el.classList.remove("is-trimming");
    const clip = findClip(trimState.kind, trimState.id);
    const moved = trimState.moved;
    const kind = trimState.kind;
    const id = trimState.id;
    if (clip && moved) {
      pushTimelineUndo("trim");
      clip.startSec =
        trimState._pendingStart != null
          ? trimState._pendingStart
          : trimState.originStart;
      clip.inSec =
        trimState._pendingIn != null ? trimState._pendingIn : trimState.originIn;
      clip.outSec =
        trimState._pendingOut != null
          ? trimState._pendingOut
          : trimState.originOut;
      selectedClip = { kind, id };
      rebuildTimeline();
      syncClipSelectionHighlight();
      renderSelectionUI();
      scheduleSaveDraft();
    } else if (!moved) {
      if (Date.now() >= suppressClipClickUntil) {
        selectAndPreviewClip(kind, id, false);
      }
    } else {
      renderTimelineTrack();
    }
    suppressClipClickUntil = Date.now() + 50;
    trimState = null;
  }

  function onClipPointerDown(e, placed, el) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(".tl-trim-handle")) {
      return;
    }
    if (trimState) return;
    closeClipContextMenu();
    e.preventDefault();
    e.stopPropagation();
    clearClipLongPress();
    const isTouchLike = e.pointerType === "touch" || e.pointerType === "pen";
    if (isTouchLike) {
      longPressState = {
        kind: placed.kind,
        id: placed.id,
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
      };
      longPressTimer = setTimeout(() => {
        if (!longPressState || longPressState.pointerId !== e.pointerId) return;
        const { kind, id, x, y } = longPressState;
        clearClipLongPress();
        selectedClip = { kind, id };
        abortClipDragForMenu();
        openClipContextMenu(x, y, kind, id);
      }, 550);
    }
    dragState = {
      kind: placed.kind,
      id: placed.id,
      el,
      originStart: Number(placed.clip.startSec) || 0,
      originTrackId: placed.clip.trackId,
      pointerId: e.pointerId,
      grabOffsetX: e.clientX - el.getBoundingClientRect().left,
      moved: false,
    };
    el.classList.add("is-dragging");
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", onClipPointerMove);
    el.addEventListener("pointerup", onClipPointerUp);
    el.addEventListener("pointercancel", onClipPointerUp);
  }

  function onClipPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    if (!timelineScroll) return;
    if (longPressState && longPressState.pointerId === e.pointerId) {
      const dx = e.clientX - longPressState.x;
      const dy = e.clientY - longPressState.y;
      if (dx * dx + dy * dy > 36) clearClipLongPress();
    }
    const rect = timelineScroll.getBoundingClientRect();
    const x =
      e.clientX -
      rect.left +
      timelineScroll.scrollLeft -
      dragState.grabOffsetX;
    let start = Math.max(0, x / pxPerSec);
    start = snapStartSec(start, dragState.kind, dragState.id);
    const hoverId = trackIdFromClientY(e.clientY);
    const hoverTrack = tracks.find((tr) => tr.id === hoverId);
    const trackId =
      hoverTrack && trackAllowsClipKind(hoverTrack, dragState.kind)
        ? hoverId
        : dragState.originTrackId;
    dragState.moved =
      dragState.moved ||
      Math.abs(start - dragState.originStart) > 0.02 ||
      trackId !== dragState.originTrackId;
    if (dragState.moved) clearClipLongPress();
    dragState.el.style.left = `${start * pxPerSec}px`;
    dragState._pendingStart = start;
    dragState._pendingTrackId = trackId;
    timelineTracks.querySelectorAll(".tl-lane").forEach((lane) => {
      const laneTrack = tracks.find((tr) => tr.id === lane.dataset.trackId);
      lane.classList.toggle(
        "is-drag-over",
        lane.dataset.trackId === trackId &&
          trackAllowsClipKind(laneTrack, dragState.kind)
      );
    });
  }

  function onClipPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    clearClipLongPress();
    const el = dragState.el;
    el.releasePointerCapture(e.pointerId);
    el.removeEventListener("pointermove", onClipPointerMove);
    el.removeEventListener("pointerup", onClipPointerUp);
    el.removeEventListener("pointercancel", onClipPointerUp);
    el.classList.remove("is-dragging");
    timelineTracks.querySelectorAll(".tl-lane").forEach((lane) => {
      lane.classList.remove("is-drag-over");
    });
    const clip = findClip(dragState.kind, dragState.id);
    const moved = dragState.moved;
    const kind = dragState.kind;
    const id = dragState.id;
    if (clip && moved) {
      const targetTrackId =
        dragState._pendingTrackId || dragState.originTrackId;
      const targetTrack = tracks.find((tr) => tr.id === targetTrackId);
      if (
        targetTrack &&
        !trackAllowsClipKind(targetTrack, dragState.kind)
      ) {
        renderTimelineTrack();
        dragState = { ...dragState, moved: true };
        setTimeout(() => {
          dragState = null;
        }, 0);
        return;
      }
      pushTimelineUndo("move");
      clip.startSec =
        dragState._pendingStart != null
          ? dragState._pendingStart
          : dragState.originStart;
      clip.trackId = targetTrackId;
      selectedClip = { kind, id };
      rebuildTimeline();
      syncClipSelectionHighlight();
      renderSelectionUI();
      scheduleSaveDraft();
    } else if (!moved) {
      if (Date.now() >= suppressClipClickUntil) {
        selectAndPreviewClip(kind, id, false);
      }
    } else {
      renderTimelineTrack();
    }
    // suppress following click
    dragState = { ...dragState, moved: true };
    setTimeout(() => {
      dragState = null;
    }, 0);
  }

  function selectAndPreviewClip(kind, id, autoPlay) {
    const clip = findClip(kind, id);
    if (!clip) return;
    selectedClip = { kind, id };
    stopTimelinePlayback();
    scheduleIndex = -1;
    playheadSec = Number(clip.startSec) || 0;
    updatePlayheadUi();
    renderTimelineTrack();
    syncClipSelectionHighlight();
    renderSelectionUI();
    updatePlaylistMeta();
    const prompt =
      kind === "audio"
        ? audioLabel(clip)
        : kind === "main"
          ? t("preview.promptMainPrefix", { prompt: clip.prompt || "" })
          : kind === "edit"
            ? t("preview.promptEditPrefix", {
                name: clip.editorName || "",
                prompt: clip.prompt || "",
              })
            : t("preview.promptBridgePrefix", { prompt: clip.prompt || "" });
    if (kind === "audio") {
      setGapBlackPreview(true);
      setPreviewSource(null, prompt, { load: true });
      if (autoPlay && clip.playUrl) {
        const dur = clipDuration(clip);
        const gStart = Number(clip.startSec) || 0;
        activeSegment = {
          kind: "audio",
          sourceId: clip.id,
          gStart,
          gEnd: gStart + dur,
          srcIn: Number(clip.inSec) || 0,
          playUrl: null,
          prompt,
        };
        timelinePlaying = true;
        warmAudioMixForPlayback(playheadSec);
        startGapPlaybackLoop();
        syncAudioMix(playheadSec, true);
        updateTransportUi();
      } else {
        syncAudioMix(playheadSec, false);
      }
      return;
    }
    if (!clip.playUrl) {
      setPreviewSource(null, prompt, { load: true });
      return;
    }
    // Load this clip's own source and freeze on its first frame (not composited layer).
    // Nudge off exact 0 while paused so browsers decode and paint a visible frame.
    const inSec = Math.max(0, Number(clip.inSec) || 0);
    const seekTo = autoPlay ? inSec : inSec > 0 ? inSec : 0.04;
    previewSourceAt(clip.playUrl, seekTo, prompt, !!autoPlay, {
      driveTimeline: false,
    });
  }

  /**
   * Load preview URL, seek, optionally play. Shared by clip click and schedule playback.
   * @param {{ driveTimeline?: boolean }} opts driveTimeline=true starts the composited rAF loop.
   */
  function previewSourceAt(url, seekTo, promptText, autoPlay, opts) {
    const driveTimeline = !!(opts && opts.driveTimeline);
    const gen = ++playbackGen;
    const sameSrc = previewLoadedUrl === url && playlistVideo.getAttribute("src");

    const afterReady = () => {
      if (gen !== playbackGen) return;
      const target = Math.max(0, seekTo);
      // ended→replay (or any real seek) must wait for seeked before play();
      // otherwise browsers often no-op play() while still at EOF.
      const needsSeek =
        !!playlistVideo.ended ||
        Math.abs((playlistVideo.currentTime || 0) - target) > 0.04;

      const applyPlayState = () => {
        if (gen !== playbackGen) return;
        withMediaSyncLock(() => {
          if (autoPlay) {
            if (driveTimeline) {
              timelinePlaying = true;
              playlistVideo.play().catch(() => {});
              startPlaybackLoop();
              syncAudioMix(playheadSec, true);
            } else {
              timelinePlaying = false;
              playlistVideo.play().catch(() => {});
              syncAudioMix(playheadSec, false);
            }
          } else {
            timelinePlaying = false;
            try {
              playlistVideo.pause();
            } catch (_) {}
            syncAudioMix(playheadSec, false);
          }
        });
        updatePlaylistMeta();
      };

      if (!needsSeek) {
        applyPlayState();
        return;
      }

      mediaSyncLock += 1;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        playlistVideo.removeEventListener("seeked", onSeeked);
        clearTimeout(failSafe);
        queueMicrotask(() => {
          mediaSyncLock = Math.max(0, mediaSyncLock - 1);
        });
        applyPlayState();
      };
      const onSeeked = () => settle();
      playlistVideo.addEventListener("seeked", onSeeked);
      const failSafe = setTimeout(settle, 400);
      try {
        // Leaving ended often requires an explicit pause before seek in some browsers.
        if (playlistVideo.ended) {
          try {
            playlistVideo.pause();
          } catch (_) {}
        }
        playlistVideo.currentTime = target;
      } catch (_) {
        settle();
        return;
      }
      // Some engines skip seeked when already at the target; recover next frame.
      requestAnimationFrame(() => {
        if (settled || playlistVideo.seeking) return;
        if (Math.abs((playlistVideo.currentTime || 0) - target) <= 0.05) {
          settle();
        }
      });
    };

    if (sameSrc && playlistVideo.readyState >= 1) {
      if (playlistPrompt) playlistPrompt.textContent = promptText || "";
      afterReady();
      return;
    }

    mediaSyncLock += 1;
    setPreviewSource(url, promptText, { load: false });
    const onMeta = () => {
      playlistVideo.removeEventListener("loadedmetadata", onMeta);
      queueMicrotask(() => {
        mediaSyncLock = Math.max(0, mediaSyncLock - 1);
      });
      if (gen !== playbackGen) return;
      afterReady();
    };
    playlistVideo.addEventListener("loadedmetadata", onMeta);
    try {
      playlistVideo.load();
    } catch (_) {
      queueMicrotask(() => {
        mediaSyncLock = Math.max(0, mediaSyncLock - 1);
      });
    }
  }

  function stopPlaybackLoop() {
    if (playbackRaf != null) {
      cancelAnimationFrame(playbackRaf);
      playbackRaf = null;
    }
  }

  function clearClipEndWatcher() {
    // Back-compat alias: cancel rAF playback loop.
    stopPlaybackLoop();
  }

  function updateTransportUi() {
    if (exportState) {
      updateExportUi();
      return;
    }
    if (!btnPlaylistPlay) return;
    btnPlaylistPlay.classList.toggle("is-playing", !!timelinePlaying);
    if (timelinePlaying) {
      btnPlaylistPlay.textContent = t("preview.pause");
      return;
    }
    if (isComposePlayMode()) {
      const canResume =
        playheadSec > 0.05 ||
        (scheduleIndex >= 0 && schedule.length > 0);
      btnPlaylistPlay.textContent = canResume
        ? t("preview.resumeCompose")
        : t("preview.playCompose");
      return;
    }
    // Slot mode: resume if playhead sits inside the selected clip.
    let canResumeSlot = false;
    if (selectedClip) {
      const clip = findClip(selectedClip.kind, selectedClip.id);
      if (clip && clip.playUrl) {
        const gStart = Number(clip.startSec) || 0;
        const gEnd = gStart + clipDuration(clip);
        canResumeSlot =
          playheadSec > gStart + 0.05 && playheadSec < gEnd - 0.05;
      }
    }
    btnPlaylistPlay.textContent = canResumeSlot
      ? t("preview.resume")
      : t("preview.play");
  }

  function clipSlotTitle(kind, id) {
    if (kind === "main") {
      const m = findMain(id);
      if (!m) return "";
      const idx = mains.indexOf(m);
      return idx >= 0 ? t("inspector.mainSegment", { n: idx + 1 }) : "";
    }
    if (kind === "edit") {
      const ed = findEdit(id);
      return ed ? editLabel(ed) : "";
    }
    if (kind === "audio") {
      const a = findAudio(id);
      return a ? audioLabel(a) : "";
    }
    const b = bridges.find((x) => x.id === id);
    return b ? bridgeLabel(b) : "";
  }

  /** All timeline clips ordered by start time (ignores layer compositing). */
  function listClipsChronological() {
    /** @type {{ kind: 'main'|'bridge'|'edit'|'audio', id: string, start: number, playUrl: string|null }[]} */
    const items = [];
    for (const m of mains) {
      items.push({
        kind: "main",
        id: m.id,
        start: Number(m.startSec) || 0,
        playUrl: m.playUrl || null,
      });
    }
    for (const b of bridges) {
      items.push({
        kind: "bridge",
        id: b.id,
        start: Number(b.startSec) || 0,
        playUrl: b.playUrl || null,
      });
    }
    for (const ed of edits) {
      items.push({
        kind: "edit",
        id: ed.id,
        start: Number(ed.startSec) || 0,
        playUrl: ed.playUrl || null,
      });
    }
    for (const a of audios) {
      items.push({
        kind: "audio",
        id: a.id,
        start: Number(a.startSec) || 0,
        playUrl: a.playUrl || null,
      });
    }
    items.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.kind !== b.kind) {
        const order = { main: 0, bridge: 1, edit: 2, audio: 3 };
        return (order[a.kind] || 0) - (order[b.kind] || 0);
      }
      return String(a.id).localeCompare(String(b.id));
    });
    return items;
  }

  function updatePlaylistMeta() {
    if (exportState) {
      if (playlistMeta) {
        playlistMeta.textContent = exportState.meta || t("preview.exporting");
        playlistMeta.classList.add("is-exporting");
      }
      updateTransportUi();
      return;
    }
    if (playlistMeta) playlistMeta.classList.remove("is-exporting");

    if (!isComposePlayMode()) {
      if (!playlistMeta) {
        updateTransportUi();
        return;
      }
      if (!selectedClip) {
        playlistMeta.textContent = "";
        updateTransportUi();
        return;
      }
      const clip = findClip(selectedClip.kind, selectedClip.id);
      const title =
        clipSlotTitle(selectedClip.kind, selectedClip.id) || "—";
      if (!clip || !clip.playUrl) {
        playlistMeta.textContent = t("preview.noSlotVideo");
        updateTransportUi();
        return;
      }
      playlistMeta.textContent = t("preview.slotMeta", {
        title,
        time: formatTlTime(playheadSec),
      });
      updateTransportUi();
      return;
    }

    const playable = schedule.filter((s) => s.playUrl);
    const total = playable.length;
    if (!total) {
      if (playlistMeta) {
        playlistMeta.textContent = schedule.length ? t("preview.noClips") : "";
      }
      updateTransportUi();
      return;
    }
    const cur =
      scheduleIndex >= 0 && scheduleIndex < schedule.length
        ? scheduleIndex + 1
        : "-";
    if (playlistMeta) {
      playlistMeta.textContent = t("preview.composeMeta", {
        count: schedule.length,
        cur,
        total: schedule.length,
        time: formatTlTime(playheadSec),
      });
    }
    updateTransportUi();
  }

  function scheduleIndexAt(globalSec) {
    buildSchedule();
    for (let i = 0; i < schedule.length; i++) {
      if (globalSec >= schedule[i].gStart && globalSec < schedule[i].gEnd) {
        return i;
      }
    }
    return -1;
  }

  /** Next schedule index whose gStart >= globalSec (for gap skip). */
  function scheduleIndexAtOrAfter(globalSec) {
    buildSchedule();
    for (let i = 0; i < schedule.length; i++) {
      if (schedule[i].gStart >= globalSec - 1e-6) return i;
    }
    return -1;
  }

  /** Suppress native video play/pause sync while we drive the element programmatically. */
  let mediaSyncLock = 0;

  function withMediaSyncLock(fn) {
    mediaSyncLock += 1;
    try {
      return fn();
    } finally {
      // Defer unlock so pause/play events from load()/pause() flush first.
      queueMicrotask(() => {
        mediaSyncLock = Math.max(0, mediaSyncLock - 1);
      });
    }
  }

  function previewVideoElements() {
    return [playlistVideoA, playlistVideoB].filter(Boolean);
  }

  function getPreviewStandbyEl() {
    if (!playlistVideoA || !playlistVideoB) return null;
    return playlistVideo === playlistVideoA ? playlistVideoB : playlistVideoA;
  }

  function setActivePreviewVideo(el) {
    if (!el || el === playlistVideo) return;
    previewVideoElements().forEach((v) => {
      v.classList.toggle("is-active", v === el);
    });
    playlistVideo = el;
  }

  function clearPreviewStandby() {
    previewStandbyGen += 1;
    previewStandbyReady = false;
    previewStandbySeg = null;
    const el = previewStandbyEl || getPreviewStandbyEl();
    previewStandbyEl = null;
    if (!el) return;
    try {
      el.pause();
    } catch (_) {}
  }

  function flushPlaybackDeferredUi() {
    if (!playbackDeferredUi) return;
    playbackDeferredUi = false;
    renderTimelineTrack();
    syncClipSelectionHighlight();
    renderSelectionUI();
  }

  function applyActiveSegmentFromItem(item, idx, globalSec) {
    scheduleIndex = idx;
    const g =
      globalSec != null
        ? Math.max(item.gStart, Math.min(item.gEnd - 0.001, globalSec))
        : item.gStart;
    playheadSec = g;
    activeSegment = {
      kind: item.kind,
      sourceId: item.sourceId,
      gStart: item.gStart,
      gEnd: item.gEnd,
      srcIn: item.srcIn,
      playUrl: item.playUrl,
      prompt: item.prompt || "",
    };
    if (item.sourceId) {
      selectedClip = { kind: item.kind, id: item.sourceId };
    }
    if (playlistPrompt) playlistPrompt.textContent = item.prompt || "";
    playbackDeferredUi = true;
    updatePlaylistMeta();
    updatePlayheadUi();
    syncClipSelectionHighlight();
  }

  function peekNextScheduleItem(fromItem) {
    if (!fromItem || !schedule.length) return null;
    const eps = 1e-3;
    const boundary = fromItem.gEnd;
    let idx = -1;
    for (let i = 0; i < schedule.length; i++) {
      if (
        boundary + eps >= schedule[i].gStart &&
        boundary + eps < schedule[i].gEnd
      ) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = 0; i < schedule.length; i++) {
        if (schedule[i].gStart >= boundary - 1e-6) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) return null;
    return { idx, item: schedule[idx] };
  }

  function warmNextPreviewSegment(fromItem) {
    if (!isComposePlayMode() || !fromItem) return;
    const standby = getPreviewStandbyEl();
    if (!standby) return;
    const next = peekNextScheduleItem(fromItem);
    if (!next || !next.item.playUrl || next.item.kind === "gap") return;
    const item = next.item;
    if (
      previewLoadedUrl === item.playUrl &&
      Math.abs((playlistVideo.currentTime || 0) - item.srcIn) < 0.25
    ) {
      return;
    }
    if (
      previewStandbySeg &&
      previewStandbySeg.playUrl === item.playUrl &&
      Math.abs(previewStandbySeg.srcIn - item.srcIn) < 0.04 &&
      previewStandbyEl === standby
    ) {
      return;
    }
    const gen = ++previewStandbyGen;
    previewStandbyReady = false;
    previewStandbyEl = standby;
    previewStandbySeg = {
      playUrl: item.playUrl,
      srcIn: item.srcIn,
      kind: item.kind,
      sourceId: item.sourceId,
      gStart: item.gStart,
      gEnd: item.gEnd,
      prompt: item.prompt || "",
      scheduleIdx: next.idx,
    };
    applyMediaCors(standby, item.playUrl);
    standby.preload = "auto";
    standby.muted = playlistVideo ? playlistVideo.muted : false;
    const same = standby.getAttribute("src") === item.playUrl;
    const target = Math.max(0, item.srcIn);
    const afterMeta = () => {
      if (gen !== previewStandbyGen) return;
      const settle = () => {
        if (gen !== previewStandbyGen) return;
        previewStandbyReady =
          standby.readyState >= 2 &&
          Math.abs((standby.currentTime || 0) - target) <= 0.12;
      };
      if (
        Math.abs((standby.currentTime || 0) - target) <= 0.04 &&
        standby.readyState >= 2
      ) {
        settle();
        return;
      }
      const onSeeked = () => {
        standby.removeEventListener("seeked", onSeeked);
        settle();
      };
      standby.addEventListener("seeked", onSeeked);
      try {
        standby.currentTime = target;
      } catch (_) {
        settle();
      }
      setTimeout(() => {
        if (gen !== previewStandbyGen) return;
        standby.removeEventListener("seeked", onSeeked);
        settle();
      }, 600);
    };
    if (same && standby.readyState >= 1) {
      afterMeta();
      return;
    }
    standby.src = item.playUrl;
    const onMeta = () => {
      standby.removeEventListener("loadedmetadata", onMeta);
      afterMeta();
    };
    standby.addEventListener("loadedmetadata", onMeta);
    try {
      standby.load();
    } catch (_) {}
  }

  function trySeamlessAdvance(nextIdx, nextItem) {
    if (!nextItem || !nextItem.playUrl || nextItem.kind === "gap") return false;
    if (previewLoadedUrl !== nextItem.playUrl) return false;
    if (!playlistVideo || !playlistVideo.getAttribute("src")) return false;
    if (playlistVideo.ended) return false;
    const ct = playlistVideo.currentTime || 0;
    if (Math.abs(ct - nextItem.srcIn) > PREVIEW_SEAMLESS_SEEK_EPS) return false;
    applyActiveSegmentFromItem(nextItem, nextIdx, nextItem.gStart);
    warmUpcomingAudio(playheadSec);
    warmNextPreviewSegment(nextItem);
    startPlaybackLoop();
    return true;
  }

  function tryStandbyHandoff(nextIdx, nextItem) {
    if (!previewStandbyReady || !previewStandbyEl || !previewStandbySeg) {
      return false;
    }
    if (!nextItem || !nextItem.playUrl || nextItem.kind === "gap") return false;
    if (previewStandbySeg.playUrl !== nextItem.playUrl) return false;
    if (Math.abs(previewStandbySeg.srcIn - nextItem.srcIn) > 0.08) return false;
    const standby = previewStandbyEl;
    if (standby.readyState < 2) return false;

    const outgoing = playlistVideo;
    mediaSyncLock += 1;
    try {
      try {
        outgoing.pause();
      } catch (_) {}
      setActivePreviewVideo(standby);
      previewLoadedUrl = nextItem.playUrl;
      previewStandbyEl = outgoing;
      previewStandbyReady = false;
      previewStandbySeg = null;
      applyActiveSegmentFromItem(nextItem, nextIdx, nextItem.gStart);
      playlistVideo.play().catch(() => {});
      syncAudioMix(playheadSec, true);
      warmUpcomingAudio(playheadSec);
      startPlaybackLoop();
      warmNextPreviewSegment(nextItem);
    } finally {
      queueMicrotask(() => {
        mediaSyncLock = Math.max(0, mediaSyncLock - 1);
      });
    }
    return true;
  }

  function stopTimelinePlayback() {
    timelinePlaying = false;
    activeSegment = null;
    stopPlaybackLoop();
    playbackGen += 1;
    clearPreviewStandby();
    stopAudioMix();
    withMediaSyncLock(() => {
      try {
        playlistVideo.pause();
      } catch (_) {}
    });
    flushPlaybackDeferredUi();
    updatePlaylistMeta();
  }

  function startPlaybackLoop() {
    stopPlaybackLoop();
    const tick = () => {
      playbackRaf = null;
      if (!timelinePlaying) return;
      // Drive from the by-value snapshot, not schedule[scheduleIndex], so a
      // rebuild (zoom/probe/edit) mid-playback cannot desync this segment.
      const item = activeSegment;
      if (!item) {
        stopTimelinePlayback();
        return;
      }
      // Gap segments are driven by wall-clock in startGapPlaybackLoop.
      if (item.kind === "gap" || !item.playUrl) {
        stopTimelinePlayback();
        return;
      }
      const ct = playlistVideo.currentTime;
      playheadSec = item.gStart + Math.max(0, ct - item.srcIn);
      // Clamp visual playhead inside segment until we advance
      if (playheadSec > item.gEnd) playheadSec = item.gEnd;
      updatePlayheadUi();
      updatePlaylistMeta();
      syncAudioMix(playheadSec, true);
      warmUpcomingAudio(playheadSec);
      if (
        isComposePlayMode() &&
        playheadSec >= item.gEnd - PREVIEW_PRELOAD_LEAD_SEC
      ) {
        warmNextPreviewSegment(item);
      }

      if (playheadSec >= item.gEnd - 1e-3) {
        advanceFromSegment();
        return;
      }
      // Native ended can linger after a segment switch; only honor it when
      // the playhead is still at this segment's end (not mid next segment).
      if (playlistVideo.ended && playheadSec >= item.gEnd - 0.05) {
        advanceFromSegment();
        return;
      }
      playbackRaf = requestAnimationFrame(tick);
    };
    playbackRaf = requestAnimationFrame(tick);
  }

  /** Wall-clock playhead for black-gap segments (no media). */
  function startGapPlaybackLoop() {
    stopPlaybackLoop();
    const item = activeSegment;
    if (!item || (item.kind !== "gap" && item.playUrl)) return;
    const t0 = performance.now();
    const startAt = playheadSec;
    const tick = () => {
      playbackRaf = null;
      if (!timelinePlaying) return;
      if (!activeSegment || activeSegment !== item) return;
      const elapsed = (performance.now() - t0) / 1000;
      playheadSec = Math.min(item.gEnd, startAt + elapsed);
      updatePlayheadUi();
      updatePlaylistMeta();
      syncAudioMix(playheadSec, true);
      warmUpcomingAudio(playheadSec);
      if (playheadSec >= item.gEnd - PREVIEW_PRELOAD_LEAD_SEC) {
        warmNextPreviewSegment(item);
      }
      if (playheadSec >= item.gEnd - 1e-3) {
        advanceFromSegment();
        return;
      }
      playbackRaf = requestAnimationFrame(tick);
    };
    playbackRaf = requestAnimationFrame(tick);
  }

  /**
   * After finishing the segment at fromIdx, find next covering/next segment
   * (including black gaps). Idempotent: a second trigger for the same
   * boundary is a no-op once scheduleIndex has already moved.
   */
  function advanceFromSegment() {
    // Guard against double-trigger (rAF loop vs native "ended"): the first
    // caller consumes activeSegment, the second no-ops.
    if (!activeSegment) return;

    // Slot mode: finish the selected clip and stop (no layer fallback / next).
    if (!isComposePlayMode()) {
      playheadSec = activeSegment.gEnd;
      stopTimelinePlayback();
      updatePlayheadUi();
      return;
    }

    // Capture the boundary time from the live snapshot BEFORE any rebuild,
    // so a stale schedule index can never point us at the wrong segment.
    const boundarySec = activeSegment.gEnd;
    activeSegment = null;
    scheduleIndex = -1;

    const eps = 1e-3;
    // scheduleIndexAt rebuilds; with gap segments, contiguous ranges are covered.
    let nextIdx = scheduleIndexAt(boundarySec + eps);
    if (nextIdx < 0) nextIdx = scheduleIndexAtOrAfter(boundarySec + eps);
    if (nextIdx >= 0) {
      const nextItem = schedule[nextIdx];
      if (trySeamlessAdvance(nextIdx, nextItem)) return;
      if (tryStandbyHandoff(nextIdx, nextItem)) return;
      showScheduleSegment(nextIdx, nextItem.gStart, true);
      return;
    }
    // Nothing covers the boundary yet. A lower-layer clip may only look
    // "short" because its true media duration hasn't been probed (it falls
    // back to the length estimate). Probe once, rebuild, and retry before
    // giving up — this is what lets playback drop to a longer lower layer.
    probeAllClipDurations()
      .then(() => {
        if (!timelinePlaying) return;
        let idx = scheduleIndexAt(boundarySec + eps);
        if (idx < 0) idx = scheduleIndexAtOrAfter(boundarySec + eps);
        if (idx < 0) {
          stopTimelinePlayback();
          return;
        }
        showScheduleSegment(idx, schedule[idx].gStart, true);
      })
      .catch(() => stopTimelinePlayback());
  }

  function showScheduleSegment(idx, globalSec, autoPlay) {
    if (idx < 0 || idx >= schedule.length) {
      stopTimelinePlayback();
      return;
    }
    clearPreviewStandby();
    stopPlaybackLoop();
    scheduleIndex = idx;
    const item = schedule[idx];
    const g = globalSec != null ? globalSec : item.gStart;
    playheadSec = Math.max(item.gStart, Math.min(item.gEnd - 0.001, g));

    // Black gap: no media; hold black and advance by wall clock.
    if (item.kind === "gap" || !item.playUrl) {
      activeSegment = {
        kind: "gap",
        sourceId: null,
        gStart: item.gStart,
        gEnd: item.gEnd,
        srcIn: 0,
        playUrl: null,
        prompt: "",
      };
      setGapBlackPreview(true);
      withMediaSyncLock(() => {
        try {
          playlistVideo.pause();
        } catch (_) {}
        playlistVideo.removeAttribute("src");
        previewLoadedUrl = null;
        try {
          playlistVideo.load();
        } catch (_) {}
      });
      if (playlistPrompt) playlistPrompt.textContent = t("preview.blackFrameParen");
      updatePlaylistMeta();
      updatePlayheadUi();
      if (autoPlay) {
        timelinePlaying = true;
        warmAudioMixForPlayback(playheadSec);
        startGapPlaybackLoop();
        syncAudioMix(playheadSec, true);
      } else {
        timelinePlaying = false;
        syncAudioMix(playheadSec, false);
      }
      updateTransportUi();
      return;
    }

    setGapBlackPreview(false);
    const offset = playheadSec - item.gStart;
    // Snapshot by value so schedule rebuilds can't desync in-flight playback.
    activeSegment = {
      kind: item.kind,
      sourceId: item.sourceId,
      gStart: item.gStart,
      gEnd: item.gEnd,
      srcIn: item.srcIn,
      playUrl: item.playUrl,
      prompt: item.prompt,
    };
    selectedClip = { kind: item.kind, id: item.sourceId };
    updatePlaylistMeta();
    updatePlayheadUi();
    if (timelinePlaying || autoPlay) {
      playbackDeferredUi = true;
      syncClipSelectionHighlight();
    } else {
      renderTimelineTrack();
      syncClipSelectionHighlight();
      renderSelectionUI();
    }

    const seekTo = Math.max(0, item.srcIn + offset);
    if (autoPlay) warmAudioMixForPlayback(playheadSec);
    previewSourceAt(item.playUrl, seekTo, item.prompt, !!autoPlay, {
      driveTimeline: !!autoPlay,
    });
  }

  function seekPlayhead(globalSec, autoPlay) {
    buildSchedule();
    playheadSec = Math.max(0, globalSec);
    updatePlayheadUi();
    const covering = scheduleIndexAt(playheadSec);
    if (covering < 0) {
      stopTimelinePlayback();
      scheduleIndex = -1;
      setGapBlackPreview(false);
      setPreviewSource(null, t("preview.noVideoLayer"), { load: true });
      updatePlaylistMeta();
      return;
    }
    showScheduleSegment(covering, playheadSec, !!autoPlay);
  }

  function playTimelineFromStart() {
    rebuildTimeline();
    if (!schedule.length || !schedule.some((s) => s.playUrl)) {
      alert(t("preview.noPlayableSlots"));
      return;
    }
    warmAudioMixForPlayback(playheadSec);
    const timelineEnd = schedule[schedule.length - 1].gEnd;
    // Finished timeline (or native EOF past last segment): replay from the start.
    if (
      playheadSec >= timelineEnd - 1e-3 ||
      (playlistVideo.ended &&
        scheduleIndexAt(playheadSec) < 0 &&
        scheduleIndexAtOrAfter(playheadSec) < 0)
    ) {
      playheadSec = schedule[0].gStart;
      showScheduleSegment(0, schedule[0].gStart, true);
      return;
    }
    // If playhead already inside a schedule segment (content or gap), resume;
    // else jump to the next segment (including leading gap from t=0).
    const covering = scheduleIndexAt(playheadSec);
    if (covering >= 0) {
      showScheduleSegment(covering, playheadSec, true);
    } else {
      const next = scheduleIndexAtOrAfter(playheadSec);
      const idx = next >= 0 ? next : 0;
      playheadSec = schedule[idx].gStart;
      showScheduleSegment(idx, schedule[idx].gStart, true);
    }
  }

  /**
   * Play only the currently selected slot (ignore layer compositing).
   * Uses the same rAF playhead loop, but advance stops at clip end.
   */
  function playSelectedSlot(autoPlay) {
    if (autoPlay == null) autoPlay = true;
    if (!ensureValidSelection() || !selectedClip) {
      alert(t("preview.noSlot"));
      return;
    }
    const clip = findClip(selectedClip.kind, selectedClip.id);
    if (!clip || !clip.playUrl) {
      alert(t("preview.noSlotVideo"));
      return;
    }
    const dur = clipDuration(clip);
    if (!(dur > 0)) {
      alert(t("preview.noSlotVideo"));
      return;
    }
    const gStart = Number(clip.startSec) || 0;
    const gEnd = gStart + dur;
    const srcIn = Number(clip.inSec) || 0;
    const prompt =
      selectedClip.kind === "audio"
        ? audioLabel(clip)
        : selectedClip.kind === "main"
          ? t("preview.promptMainPrefix", { prompt: clip.prompt || "" })
          : t("preview.promptBridgePrefix", { prompt: clip.prompt || "" });

    stopPlaybackLoop();
    scheduleIndex = -1;

    if (selectedClip.kind === "audio") {
      setGapBlackPreview(true);
      setPreviewSource(null, prompt, { load: true });
      let g = playheadSec;
      if (g < gStart + 1e-3 || g >= gEnd - 1e-3) g = gStart;
      playheadSec = g;
      activeSegment = {
        kind: "audio",
        sourceId: selectedClip.id,
        gStart,
        gEnd,
        srcIn,
        playUrl: null,
        prompt,
      };
      updatePlaylistMeta();
      updatePlayheadUi();
      renderTimelineTrack();
      syncClipSelectionHighlight();
      renderSelectionUI();
      if (autoPlay) {
        timelinePlaying = true;
        warmAudioMixForPlayback(playheadSec);
        startGapPlaybackLoop();
        syncAudioMix(playheadSec, true);
      } else {
        timelinePlaying = false;
        syncAudioMix(playheadSec, false);
      }
      updateTransportUi();
      return;
    }

    setGapBlackPreview(false);

    // Resume inside this slot when playhead is within it; else restart slot.
    let g = playheadSec;
    if (g < gStart + 1e-3 || g >= gEnd - 1e-3) g = gStart;
    playheadSec = g;
    const offset = playheadSec - gStart;

    activeSegment = {
      kind: selectedClip.kind,
      sourceId: selectedClip.id,
      gStart,
      gEnd,
      srcIn,
      playUrl: clip.playUrl,
      prompt,
    };

    updatePlaylistMeta();
    updatePlayheadUi();
    renderTimelineTrack();
    syncClipSelectionHighlight();
    renderSelectionUI();

    const seekTo = Math.max(0, srcIn + offset);
    if (autoPlay) warmAudioMixForPlayback(playheadSec);
    previewSourceAt(clip.playUrl, seekTo, prompt, !!autoPlay, {
      driveTimeline: !!autoPlay,
    });
  }

  /** Step to previous/next slot chronologically (no layer compositing). */
  function stepSlotClip(dir) {
    const clips = listClipsChronological();
    const playable = clips.filter((c) => c.playUrl);
    const pool = playable.length ? playable : clips;
    if (!pool.length) {
      alert(t("preview.noPlayableSlots"));
      return;
    }
    let idx = -1;
    if (selectedClip) {
      idx = pool.findIndex(
        (c) => c.kind === selectedClip.kind && c.id === selectedClip.id
      );
    }
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    const nextIdx = Math.max(0, Math.min(pool.length - 1, idx + dir));
    const target = pool[nextIdx];
    const wasPlaying = timelinePlaying;
    if (wasPlaying) stopTimelinePlayback();
    selectAndPreviewClip(target.kind, target.id, false);
    if (wasPlaying && target.playUrl) playSelectedSlot(true);
  }

  function playTimelineNext() {
    buildSchedule();
    if (!schedule.length) {
      stopTimelinePlayback();
      return;
    }
    const next = scheduleIndex + 1;
    if (next >= schedule.length) {
      stopTimelinePlayback();
      return;
    }
    showScheduleSegment(next, schedule[next].gStart, true);
  }

  function playTimelinePrev() {
    buildSchedule();
    if (!schedule.length) return;
    const prev = scheduleIndex - 1;
    const idx = prev >= 0 ? prev : 0;
    showScheduleSegment(idx, schedule[idx].gStart, timelinePlaying);
  }

  function scrubFromRulerEvent(e) {
    if (!timelineScroll) return;
    const rect = timelineScroll.getBoundingClientRect();
    const x = e.clientX - rect.left + timelineScroll.scrollLeft;
    const sec = Math.max(0, x / pxPerSec);
    stopTimelinePlayback();
    seekPlayhead(sec, false);
  }

  function setActivePhase(phase) {
    activePhase = Math.min(3, Math.max(1, Number(phase) || 1));
    if (editorShell) editorShell.dataset.phase = String(activePhase);
    updatePhaseSteps();
  }

  function updatePhaseSteps() {
    const successCount = mains.filter(
      (m) => m.status === "success" && m.playUrl
    ).length;
    const hasBridge = bridges.some(
      (b) => b.status === "success" && b.playUrl
    );
    document.querySelectorAll(".phase-step").forEach((el) => {
      const step = Number(el.dataset.step);
      el.classList.remove("active", "done");
      if (step === activePhase) el.classList.add("active");
      if (step === 1 && successCount > 0) el.classList.add("done");
      if (step === 2 && hasBridge) el.classList.add("done");
      if (step === 3 && schedule.length) el.classList.add("done");
    });
  }

  function renderAll() {
    ensureDefaultTrack();
    renderPromptList();
    renderJobList();
    renderBridges();
    rebuildTimeline();
    // LLM / 导入会换新主段 id，这里先纠正选中再刷时间轴高亮
    ensureValidSelection();
    renderTimelineTrack();
    syncClipSelectionHighlight();
    updatePromptEmptyHint();
    setActivePhase(activePhase);
    renderSelectionUI();
  }

  // —— API helpers ——

  async function apiJson(url, { method = "GET", body = undefined } = {}) {
    const opts = {
      method,
      credentials: "same-origin",
      headers: {
        "X-Locale": currentLocale(),
      },
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) {
      const err = new Error(json.message || t("auth.notLoggedIn"));
      err.status = 401;
      throw err;
    }
    if (!json.success) {
      const msg = json.message || t("common.requestFailed");
      const err = new Error(msg);
      err.payload = json;
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  async function postJson(url, data) {
    return apiJson(url, { method: "POST", body: data });
  }

  function emptyScriptDoc() {
    return {
      id: null,
      title: t("storyboard.unnamedScript"),
      format: "short",
      plotDirection: "",
      sceneBible: "",
      llmPickCount: false,
      episodes: [
        {
          id: "e1",
          index: 1,
          title: t("storyboard.episodeChip", { n: 1 }),
          script: "",
          beats: [],
          boundProjectId: null,
          boundProjectName: null,
        },
      ],
    };
  }

  function currentEpisode() {
    if (!currentScript || !Array.isArray(currentScript.episodes)) return null;
    return (
      currentScript.episodes.find((ep) => String(ep.id) === String(currentEpisodeId)) ||
      currentScript.episodes[0] ||
      null
    );
  }

  function beatsToText(beats) {
    if (!Array.isArray(beats) || !beats.length) return "";
    return beats
      .map((b) => {
        const title = String((b && b.title) || "").trim();
        const desc = String((b && (b.description || b.text)) || "").trim();
        if (title && desc) return `${title}：${desc}`;
        return desc || title;
      })
      .filter(Boolean)
      .join("\n");
  }

  function textToBeats(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?)[：:](.+)$/);
        if (m) return { title: m[1].trim(), description: m[2].trim() };
        return { title: "", description: line };
      });
  }

  function readScriptEditorIntoCurrent() {
    if (!currentScript) return;
    currentScript.title = scriptTitleEl ? scriptTitleEl.value.trim() : currentScript.title;
    currentScript.sceneBible = scriptSceneBibleEl
      ? scriptSceneBibleEl.value
      : currentScript.sceneBible;
    currentScript.plotDirection = scriptPlotDirectionEl
      ? scriptPlotDirectionEl.value
      : currentScript.plotDirection;
    currentScript.llmPickCount = !!(scriptLlmPickCountEl && scriptLlmPickCountEl.checked);
    const ep = currentEpisode();
    if (ep) {
      ep.title = scriptEpisodeTitleEl ? scriptEpisodeTitleEl.value.trim() : ep.title;
      ep.script = scriptEpisodeBodyEl ? scriptEpisodeBodyEl.value : ep.script;
      ep.beats = textToBeats(scriptEpisodeBeatsEl ? scriptEpisodeBeatsEl.value : "");
    }
  }

  function syncScriptFormatUi() {
    const fmt = currentScript && currentScript.format === "series" ? "series" : "short";
    const shortBtn = document.getElementById("btnScriptFormatShort");
    const seriesBtn = document.getElementById("btnScriptFormatSeries");
    if (shortBtn) shortBtn.classList.toggle("is-active", fmt === "short");
    if (seriesBtn) seriesBtn.classList.toggle("is-active", fmt === "series");
    if (scriptSeriesCountRow) {
      scriptSeriesCountRow.classList.toggle("hidden", fmt !== "series");
    }
  }

  function renderScriptLibrary() {
    if (!scriptLibraryList) return;
    scriptLibraryList.innerHTML = "";
    const has = userScripts.length > 0;
    if (scriptLibraryEmpty) scriptLibraryEmpty.classList.toggle("hidden", has);
    userScripts.forEach((doc) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "script-lib-item" +
        (currentScript && currentScript.id === doc.id ? " is-active" : "");
      const n = (doc.episodes || []).length;
      const fmt =
        doc.format === "series"
          ? t("storyboard.formatSeries")
          : t("storyboard.formatShort");
      btn.innerHTML = `<strong>${escapeHtml(doc.title || t("storyboard.unnamedScript"))}</strong><div class="muted">${escapeHtml(fmt)} · ${n}</div>`;
      btn.addEventListener("click", () => {
        readScriptEditorIntoCurrent();
        selectScriptDoc(doc);
      });
      scriptLibraryList.appendChild(btn);
    });
  }

  function renderEpisodeNav() {
    if (!scriptEpisodeNav) return;
    const series = currentScript && currentScript.format === "series";
    const eps = (currentScript && currentScript.episodes) || [];
    scriptEpisodeNav.classList.toggle("hidden", !series || eps.length < 1);
    scriptEpisodeNav.innerHTML = "";
    if (!series) return;
    eps.forEach((ep, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className =
        "script-episode-chip" +
        (String(ep.id) === String(currentEpisodeId) ? " is-active" : "");
      let label = ep.title || t("storyboard.episodeChip", { n: i + 1 });
      if (ep.boundProjectId && Number(ep.boundProjectId) === Number(currentProjectId)) {
        label += " · ✓";
      }
      chip.textContent = label;
      chip.addEventListener("click", () => {
        readScriptEditorIntoCurrent();
        currentEpisodeId = ep.id;
        fillScriptEditor();
      });
      scriptEpisodeNav.appendChild(chip);
    });
  }

  function fillScriptEditor() {
    if (!currentScript) currentScript = emptyScriptDoc();
    if (scriptTitleEl) scriptTitleEl.value = currentScript.title || "";
    if (scriptSceneBibleEl) scriptSceneBibleEl.value = currentScript.sceneBible || "";
    if (scriptPlotDirectionEl) scriptPlotDirectionEl.value = currentScript.plotDirection || "";
    if (scriptLlmPickCountEl) scriptLlmPickCountEl.checked = !!currentScript.llmPickCount;
    if (scriptEpisodeCountEl && currentScript.format === "series") {
      scriptEpisodeCountEl.value = String(
        Math.max(1, (currentScript.episodes || []).length || 3)
      );
    }
    const ep = currentEpisode();
    if (!ep && currentScript.episodes && currentScript.episodes[0]) {
      currentEpisodeId = currentScript.episodes[0].id;
    }
    const cur = currentEpisode();
    if (scriptEpisodeTitleEl) scriptEpisodeTitleEl.value = (cur && cur.title) || "";
    if (scriptEpisodeBodyEl) scriptEpisodeBodyEl.value = (cur && cur.script) || "";
    if (scriptEpisodeBeatsEl) scriptEpisodeBeatsEl.value = beatsToText(cur && cur.beats);
    syncScriptFormatUi();
    renderEpisodeNav();
    renderScriptLibrary();
    updateBoundHint();
  }

  function updateBoundHint() {
    if (!storyboardBoundHint) return;
    const ep = currentEpisode();
    if (!ep) {
      storyboardBoundHint.textContent = "";
      return;
    }
    const pid = ep.boundProjectId != null ? Number(ep.boundProjectId) : null;
    if (pid && pid === Number(currentProjectId)) {
      storyboardBoundHint.textContent = t("storyboard.boundThisProject");
    } else if (pid) {
      storyboardBoundHint.textContent = t("storyboard.boundOtherProject", {
        name: ep.boundProjectName || pid,
      });
    } else {
      storyboardBoundHint.textContent = "";
    }
  }

  function selectScriptDoc(doc) {
    currentScript = JSON.parse(JSON.stringify(doc));
    const boundEp =
      currentScript.episodes &&
      currentScript.episodes.find(
        (ep) => Number(ep.boundProjectId) === Number(currentProjectId)
      );
    if (boundEpisodeId && currentScript.episodes) {
      const match = currentScript.episodes.find(
        (ep) => String(ep.id) === String(boundEpisodeId)
      );
      currentEpisodeId = match ? match.id : (boundEp && boundEp.id) || currentScript.episodes[0].id;
    } else {
      currentEpisodeId =
        (boundEp && boundEp.id) ||
        (currentScript.episodes && currentScript.episodes[0] && currentScript.episodes[0].id) ||
        "e1";
    }
    scriptDirty = false;
    fillScriptEditor();
  }

  async function loadUserScripts() {
    try {
      const data = await apiJson("/api/scripts");
      userScripts = (data && data.scripts) || [];
    } catch (e) {
      console.warn("loadUserScripts", e);
      userScripts = [];
    }
    if (
      boundScriptAssetId &&
      !currentScript &&
      userScripts.some((s) => Number(s.id) === Number(boundScriptAssetId))
    ) {
      selectScriptDoc(
        userScripts.find((s) => Number(s.id) === Number(boundScriptAssetId))
      );
    } else if (!currentScript && userScripts.length) {
      selectScriptDoc(userScripts[0]);
    } else if (currentScript && currentScript.id) {
      const fresh = userScripts.find((s) => s.id === currentScript.id);
      if (fresh) selectScriptDoc(fresh);
      else fillScriptEditor();
    } else {
      fillScriptEditor();
    }
    renderAssetLibrary();
  }

  async function saveCurrentScript() {
    readScriptEditorIntoCurrent();
    if (!currentScript) currentScript = emptyScriptDoc();
    const body = {
      title: currentScript.title || t("storyboard.unnamedScript"),
      format: currentScript.format === "series" ? "series" : "short",
      plotDirection: currentScript.plotDirection || "",
      sceneBible: currentScript.sceneBible || "",
      llmPickCount: !!currentScript.llmPickCount,
      episodes: (currentScript.episodes || []).map((ep) => ({
        id: ep.id,
        index: ep.index,
        title: ep.title || "",
        script: ep.script || "",
        beats: ep.beats || [],
        boundProjectId: ep.boundProjectId || null,
      })),
    };
    let saved;
    if (currentScript.id) {
      saved = await apiJson(`/api/scripts/${currentScript.id}`, {
        method: "PUT",
        body,
      });
    } else {
      saved = await postJson("/api/scripts", body);
    }
    currentScript = saved.script;
    scriptDirty = false;
    await loadUserScripts();
    if (scriptLlmStatus) scriptLlmStatus.textContent = t("storyboard.scriptSaved");
    return currentScript;
  }

  function setStoryboardStep(step) {
    storyboardStep = step === "prompts" ? "prompts" : "script";
    document.querySelectorAll("[data-storyboard-step]").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.storyboardStep === storyboardStep);
    });
    if (storyboardStepScriptEl) {
      storyboardStepScriptEl.classList.toggle("hidden", storyboardStep !== "script");
    }
    if (storyboardStepPromptsEl) {
      storyboardStepPromptsEl.classList.toggle("hidden", storyboardStep !== "prompts");
    }
    if (storyboardStep === "prompts") {
      const ep = currentEpisode();
      if (ep && scriptSceneBibleEl && sceneDescriptionEl && !sceneDescriptionEl.value.trim()) {
        sceneDescriptionEl.value = currentScript.sceneBible || "";
      }
      if (ep && plotDirectionEl) {
        plotDirectionEl.value = (ep.script || currentScript.plotDirection || "").slice(0, 4000);
      }
    }
  }

  async function gotoPromptsStep() {
    readScriptEditorIntoCurrent();
    const ep = currentEpisode();
    if (!ep || !(ep.script || "").trim()) {
      alert(t("storyboard.needEpisodeScript"));
      return;
    }
    if (currentScript && currentScript.format === "series" && !currentEpisodeId) {
      alert(t("storyboard.needSelectEpisode"));
      return;
    }
    if (
      ep.boundProjectId &&
      Number(ep.boundProjectId) !== Number(currentProjectId)
    ) {
      alert(t("storyboard.confirmBindOther"));
      return;
    }
    if (!currentProjectId) {
      alert(t("bins.importNeedProject"));
      return;
    }
    try {
      const saved = await saveCurrentScript();
      const data = await postJson(`/api/scripts/${saved.id}/bind`, {
        episodeId: ep.id,
        projectId: currentProjectId,
      });
      currentScript = data.script;
      boundScriptAssetId = saved.id;
      boundEpisodeId = ep.id;
      scheduleSaveDraft();
      setStoryboardStep("prompts");
      updateBoundHint();
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  async function generateReadableScript() {
    syncLlmConfiguredFromLocal();
    if (!llmConfigured) {
      alert(t("storyboard.configureLlm"));
      openSettingsModal("llm");
      return;
    }
    readScriptEditorIntoCurrent();
    const scene = scriptSceneBibleEl ? scriptSceneBibleEl.value.trim() : "";
    const plot = scriptPlotDirectionEl ? scriptPlotDirectionEl.value.trim() : "";
    if (!scene && !plot) {
      alert(t("storyboard.fillPlot"));
      return;
    }
    if ((currentEpisode() && (currentEpisode().script || "").trim()) || (currentScript && currentScript.id)) {
      if (!confirm(t("storyboard.confirmReplaceScript"))) return;
    }
    const fmt = currentScript && currentScript.format === "series" ? "series" : "short";
    const pick = scriptLlmPickCountEl && scriptLlmPickCountEl.checked;
    let episodeCount = null;
    if (fmt === "series" && !pick) {
      episodeCount = Math.max(
        1,
        Math.min(12, parseInt(scriptEpisodeCountEl && scriptEpisodeCountEl.value, 10) || 3)
      );
    }
    llmGenerating = true;
    updateLlmButtonState();
    const modelLabel = getSelectedLlmModel() || "platform";
    if (scriptLlmStatus) {
      scriptLlmStatus.textContent = t("storyboard.scriptGenProgress", { model: modelLabel });
    }
    try {
      let result;
      if (llmChannel === "custom") {
        const tpl = await getLlmPromptTemplates();
        const countNote =
          fmt === "short"
            ? "exactly 1 episode"
            : episodeCount
              ? `exactly ${episodeCount}`
              : "choose count 1-12";
        const userTpl =
          tpl.script_user_template ||
          "{scene}\n{plot}\n{format}\n{count_note}";
        const userMsg = userTpl
          .replace(/\{scene\}/g, scene || "(none)")
          .replace(/\{plot\}/g, plot || "(none)")
          .replace(/\{format\}/g, fmt)
          .replace(/\{count_note\}/g, countNote);
        const content = await browserLlmChat({
          system: tpl.script_system || "",
          userMsg,
        });
        result = parseLlmJsonObject(content);
        if (!result || !Array.isArray(result.episodes)) {
          throw new Error(t("storyboard.noPromptsReturned"));
        }
        result.format = fmt;
      } else {
        const data = await postJson("/api/llm/script", {
          sceneBible: scene,
          plotDirection: plot,
          format: fmt,
          episodeCount,
          llmModel: getSelectedLlmModel(),
          locale: currentLocale(),
        });
        result = data && data.script;
      }
      if (!result || !Array.isArray(result.episodes) || !result.episodes.length) {
        throw new Error(t("storyboard.noPromptsReturned"));
      }
      const prevBind = {};
      (currentScript && currentScript.episodes ? currentScript.episodes : []).forEach((ep) => {
        prevBind[ep.id] = ep.boundProjectId;
      });
      currentScript = currentScript || emptyScriptDoc();
      currentScript.title = result.title || currentScript.title;
      currentScript.format = fmt;
      currentScript.sceneBible = scene;
      currentScript.plotDirection = plot;
      currentScript.episodes = result.episodes.map((ep, i) => ({
        id: ep.id || `e${i + 1}`,
        index: i + 1,
        title: ep.title || t("storyboard.episodeChip", { n: i + 1 }),
        script: ep.script || "",
        beats: Array.isArray(ep.beats) ? ep.beats : [],
        boundProjectId: prevBind[ep.id] || null,
        boundProjectName: null,
      }));
      currentEpisodeId = currentScript.episodes[0].id;
      await saveCurrentScript();
      fillScriptEditor();
    } catch (e) {
      if (scriptLlmStatus) scriptLlmStatus.textContent = "";
      alert(e.message || String(e));
    } finally {
      llmGenerating = false;
      updateLlmButtonState();
    }
  }

  async function polishReadableScript() {
    syncLlmConfiguredFromLocal();
    if (!llmConfigured) {
      alert(t("storyboard.configureLlm"));
      openSettingsModal("llm");
      return;
    }
    readScriptEditorIntoCurrent();
    const instruction = scriptPolishInputEl ? scriptPolishInputEl.value.trim() : "";
    if (!instruction) return;
    if (scriptPolishStatusEl) scriptPolishStatusEl.textContent = t("storyboard.scriptGenProgress", { model: getSelectedLlmModel() || "" });
    try {
      let data;
      const payloadScript = {
        title: currentScript.title,
        format: currentScript.format,
        sceneBible: currentScript.sceneBible,
        plotDirection: currentScript.plotDirection,
        episodes: currentScript.episodes,
      };
      if (llmChannel === "custom") {
        const tpl = await getLlmPromptTemplates();
        const userTpl =
          tpl.script_polish_user_template ||
          "{scope}\n{instruction}\n{script_json}";
        const content = await browserLlmChat({
          system: tpl.script_polish_system || "",
          userMsg: userTpl
            .replace(/\{scope\}/g, "all")
            .replace(/\{instruction\}/g, instruction)
            .replace(/\{script_json\}/g, JSON.stringify(payloadScript, null, 2)),
        });
        data = parseLlmJsonObject(content);
      } else {
        data = await postJson("/api/llm/script-polish", {
          script: payloadScript,
          instruction,
          scope: "all",
          llmModel: getSelectedLlmModel(),
          locale: currentLocale(),
        });
      }
      scriptPolishDraft = data;
      if (btnScriptApplyPatch) btnScriptApplyPatch.disabled = !data || !data.patch;
      const lines = [];
      if (data && data.summary) lines.push(data.summary);
      const patch = (data && data.patch) || {};
      if (patch.title) lines.push(`title: ${patch.title}`);
      if (Array.isArray(patch.episodes)) {
        patch.episodes.forEach((ep) => {
          lines.push(`• ${ep.id || ""} ${ep.title || ""} ${ep.script ? "[script]" : ""}`);
        });
      }
      if (scriptPolishDiffEl) {
        scriptPolishDiffEl.textContent = lines.join("\n") || t("storyboard.scriptPolishDiffEmpty");
      }
      if (scriptPolishStatusEl) scriptPolishStatusEl.textContent = data.summary || "";
    } catch (e) {
      if (scriptPolishStatusEl) scriptPolishStatusEl.textContent = "";
      alert(e.message || String(e));
    }
  }

  function applyScriptPolishDraft() {
    if (!scriptPolishDraft || !scriptPolishDraft.patch || !currentScript) return;
    const patch = scriptPolishDraft.patch;
    if (patch.title) currentScript.title = patch.title;
    if (patch.sceneBible != null) currentScript.sceneBible = patch.sceneBible;
    if (patch.plotDirection != null) currentScript.plotDirection = patch.plotDirection;
    if (Array.isArray(patch.episodes)) {
      patch.episodes.forEach((p) => {
        const ep = currentScript.episodes.find((e) => String(e.id) === String(p.id));
        if (!ep) return;
        if (p.title != null) ep.title = p.title;
        if (p.script != null) ep.script = p.script;
        if (Array.isArray(p.beats)) ep.beats = p.beats;
      });
    }
    scriptPolishDraft = null;
    if (btnScriptApplyPatch) btnScriptApplyPatch.disabled = true;
    fillScriptEditor();
    saveCurrentScript().catch((e) => alert(e.message || String(e)));
  }

  function newBlankScript() {
    currentScript = emptyScriptDoc();
    currentEpisodeId = "e1";
    boundScriptAssetId = null;
    boundEpisodeId = "";
    fillScriptEditor();
  }

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append("file", file);
    if (currentProjectId) fd.append("projectId", String(currentProjectId));
    const res = await fetch("/api/upload", {
      method: "POST",
      body: fd,
      credentials: "same-origin",
      headers: { "X-Locale": currentLocale() },
    });
    const json = await res.json();
    if (res.status === 401) {
      throw new Error(json.message || t("auth.notLoggedIn"));
    }
    if (!json.success) {
      throw new Error(json.message || t("common.uploadFailed"));
    }
    return json.data;
  }

  async function ensureSharedStartUploaded() {
    if (isPlatformRhFileName(sharedStartRhName) && !isLocalMediaId(sharedStartMediaId)) {
      return sharedStartRhName;
    }
    let file = selectedFile;
    if (!file && sharedStartPlayUrl) {
      file = await fileFromSharedStart();
    }
    if (!file) throw new Error(t("common.selectSharedStart"));
    const uploaded = await uploadImage(file);
    sharedStartRhName = uploaded.fileName;
    sharedStartPlayUrl = uploaded.playUrl || sharedStartPlayUrl;
    sharedStartMediaId = uploaded.mediaFileId || sharedStartMediaId;
    scheduleSaveDraft();
    try {
      renderStoryboardRefList();
    } catch (e) {
      /* ignore */
    }
    return sharedStartRhName;
  }

  /**
   * Jobs from API are newest-first (created_at DESC, id DESC).
   * Apply only the latest job per kind+refId so an older success cannot
   * overwrite a newer regen on the same timeline slot.
   */
  function applyLatestJobsToSegments(jobs) {
    const seen = new Set();
    for (const job of jobs || []) {
      if (!job) continue;
      const kind = String(job.kind || "main");
      const refId = job.refId != null ? String(job.refId) : "";
      const key = `${kind}:${refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      applyJobToSegment(job);
    }
  }

  function applyJobToSegment(job) {
    if (job && job.kind === "t2i") {
      handleT2iJobUpdate(job).catch((err) => console.warn(err));
      return;
    }
    const kind =
      job.kind === "bridge"
        ? "bridge"
        : job.kind === "edit"
          ? "edit"
          : "main";
    const target =
      kind === "main"
        ? findMain(job.refId)
        : kind === "edit"
          ? findEdit(job.refId)
          : bridges.find((b) => b.id === job.refId);
    if (!target) return;
    const result = job.result || {};
    const jobTaskId =
      job.rhTaskId != null && String(job.rhTaskId).trim()
        ? String(job.rhTaskId).trim()
        : "";
    const slotTaskId =
      target.taskId != null && String(target.taskId).trim()
        ? String(target.taskId).trim()
        : "";
    // Stale success: slot already tracks a different remote task (newer regen).
    if (result.playUrl && jobTaskId && slotTaskId && jobTaskId !== slotTaskId) {
      return;
    }
    target.status = job.status || target.status;
    target.taskId = job.rhTaskId || target.taskId;
    if (job.seedHigh != null) target.seedHigh = String(job.seedHigh);
    if (job.seedLow != null) target.seedLow = String(job.seedLow);
    if (job.error) target.meta = job.error;
    if (result.playUrl) {
      target.playUrl = result.playUrl;
      target.mediaFileId =
        (result.results && result.results[0] && result.results[0].mediaFileId) ||
        target.mediaFileId ||
        null;
      target.results = result.results || target.results || [];
      target.status = "success";
      target.label = t("status.success");
      target.dirty = false;
      if (kind === "bridge") {
        target.needsReselect = false;
        snapshotBridgeLinkedSig(target);
      }
      if (kind === "main") markBridgesNeedReselectForMain(target.id);
      target.durationSec = null;
      probeClipDuration(target).then(() => {
        rebuildTimeline();
        scheduleSaveDraft();
      });
    } else if (job.status === "pending") {
      target.label = job.replaced ? t("common.queueParamsUpdated") : t("status.pending");
    } else if (job.status === "queued") {
      target.label = t("status.remoteQueuing");
    } else if (job.status === "running" || job.status === "finalizing") {
      target.label = t("status.running");
      if (target.taskId) {
        target.meta = `taskId ${target.taskId}`;
      }
    } else if (job.status === "failed") {
      target.label = job.canceled
        ? /强制|Force-end|force-end/i.test(job.error || "")
          ? t("status.forceEnded")
          : t("status.canceled")
        : t("status.failed");
      target.meta = localizeStoredLabel(job.error || target.meta || "");
    }
  }


  function resolveAdapterMode(cfg, mode, opts) {
    const W = window.VflowAdapter;
    const U = window.VflowUserEngines;
    const eng = getStoryboardEngine(
      opts && opts.engineProfile != null ? opts.engineProfile : null
    );
    if (mode !== "t2i") {
      if (eng && eng.source === "user") {
        const slotMode =
          U && typeof U.adapterModeFromSlot === "function"
            ? U.adapterModeFromSlot(eng, mode === "flf" ? "bridge" : "main")
            : null;
        if (!slotMode) {
          throw new Error(
            t("engine.needDockSlot", {
              slot: mode === "flf" ? t("engine.slotBridge") : t("engine.slotMain"),
            })
          );
        }
        if (eng.provider === "runninghub" && !slotMode.workflowId) {
          throw new Error(
            t("workflow.needWorkflowIdMode", {
              mode: mode === "flf" ? "FLF" : "I2V",
            })
          );
        }
        return slotMode;
      }
      throw new Error(t("engine.none"));
    }
    let modeKey = mode;
    let adapter =
      cfg.channel === "comfyui"
        ? cfg.comfy && cfg.comfy.adapter
        : cfg.rh && cfg.rh.adapter;
    if (!adapter && cfg.channel === "custom_rh" && W) {
      adapter = W.platformBuiltinAdapter(
        cfg.rh.workflowIdI2v,
        cfg.rh.workflowIdFlf
      );
    }
    if (!adapter || !adapter.modes || !adapter.modes[modeKey]) {
      // Do not silently fall back to Wan i2v/flf when MiniMax modes are missing.
      throw new Error(
        t("workflow.needDockMode", { mode: String(modeKey).toUpperCase() })
      );
    }
    const modeCfg = { ...adapter.modes[modeKey] };
    if (W) {
      if (!modeCfg.workflow && modeCfg.workflowUi) {
        modeCfg.workflow = W.uiWorkflowToApiPrompt(modeCfg.workflowUi);
      }
    }
    if (cfg.channel === "custom_rh") {
      if (!modeCfg.workflowId) {
        const wid =
          mode === "flf" || modeKey === "minimax_flf"
            ? cfg.rh.workflowIdFlf
            : cfg.rh.workflowIdI2v;
        if (wid) modeCfg.workflowId = wid;
      }
      if (!modeCfg.workflowId) {
        throw new Error(
          t("workflow.needWorkflowIdMode", {
            mode: String(modeKey).toUpperCase(),
          })
        );
      }
    }
    return modeCfg;
  }

  function applyHiddenParamDefaults(values, params) {
    (params || []).forEach((p) => {
      if (!p || p.visibility !== "hidden" || !p.bind) return;
      if (values[p.bind] != null && values[p.bind] !== "") return;
      if (p.default != null && p.default !== "") {
        values[p.bind] = p.default;
      }
    });
    return values;
  }

  async function fileFromSharedStart() {
    if (selectedFile) return selectedFile;
    if (sharedStartPlayUrl) {
      const resp = await fetch(sharedStartPlayUrl);
      const blob = await resp.blob();
      return new File([blob], "start.png", { type: blob.type || "image/png" });
    }
    throw new Error(t("common.uploadSharedStart"));
  }

  async function fileFromFrame(frame) {
    if (!frame) throw new Error(t("common.missingFrame"));
    if (frame.blobUrl) {
      const resp = await fetch(frame.blobUrl);
      const blob = await resp.blob();
      return new File([blob], "frame.png", { type: blob.type || "image/png" });
    }
    if (frame.playUrl || frame.previewUrl) {
      const resp = await fetch(frame.playUrl || frame.previewUrl);
      const blob = await resp.blob();
      return new File([blob], "frame.png", { type: blob.type || "image/png" });
    }
    throw new Error(t("common.frameUnreadable"));
  }

  function localVideoJobId(kind, refId) {
    return `local-${kind}-${refId}`;
  }

  function isLocalJobCanceled(jobId) {
    const j = (localJobsCache || []).find((x) => x.id === jobId);
    return !!(j && j.canceled);
  }

  async function persistLocalJob(job) {
    const next = upsertLocalJob(job);
    if (window.VflowLocal && window.VflowLocal.putJob && next) {
      try {
        await window.VflowLocal.putJob({ ...next });
      } catch (e) {
        console.warn("persistLocalJob", e);
      }
    }
    return next;
  }

  async function snapshotFileToBlobId(file, meta) {
    if (!file || !window.VflowLocal || !window.VflowLocal.putBlob) return null;
    const asset = await window.VflowLocal.putBlob(file, meta || {});
    return asset && asset.id ? asset.id : null;
  }

  function localQueueActiveCount() {
    return (localJobsCache || []).filter(
      (j) =>
        !j.canceled &&
        ["pending", "queued", "running", "finalizing"].includes(j.status)
    ).length;
  }

  function refreshLocalBatchFlag() {
    batchRunning = localQueueActiveCount() > 0;
    if (btnStop) btnStop.disabled = !batchRunning;
    if (btnStart) btnStart.disabled = false;
  }

  function jobUsesLocalAgent(spec) {
    if (!spec) return false;
    if (spec.kind === "t2i") {
      return getVideoChannelConfig().channel !== "platform";
    }
    if (spec.kind === "edit") {
      const src =
        (spec.editorPayload && spec.editorPayload.editorSource) ||
        (spec.request && spec.request.editorSource) ||
        spec.editorSource;
      return src === "user";
    }
    const eng = getStoryboardEngine(
      spec.request && spec.request.engineProfile
    );
    return !!(eng && eng.source === "user");
  }

  function channelForUserEngine(eng) {
    if (!eng || eng.source !== "user") return "custom_rh";
    return eng.provider === "comfyui" ? "comfyui" : "custom_rh";
  }

  async function enqueueLocalJobSpec(spec) {
    const cfg = getVideoChannelConfig();
    const reqPreview = (spec && spec.request) || {};
    const jobEng = getStoryboardEngine(reqPreview.engineProfile);
    const allowLocal =
      jobUsesLocalAgent(spec) ||
      (spec && spec.kind === "edit") ||
      (jobEng && jobEng.source === "user");
    if (cfg.channel === "platform" && !allowLocal) {
      throw new Error(t("common.useServerQueue"));
    }
    if (!window.VflowLocal || !window.VflowAdapter) {
      throw new Error(t("common.localModuleMissing"));
    }
    if (!currentProjectId) throw new Error(t("jobs.openProjectFirst"));
    const kind = spec.kind;
    const refId = spec.refId;
    const req = {
      ...(spec.request || {}),
      concurrency: getSubmitConcurrency(),
    };
    let startBlobId = null;
    let endBlobId = null;
    let videoBlobId = null;
    let audioBlobId = null;
    let editorPayload = spec.editorPayload || null;

    if (kind === "main") {
      const imageFile = await fileFromSharedStart();
      startBlobId = await snapshotFileToBlobId(imageFile, {
        kind: "upload",
        filename: imageFile.name || "start.png",
        projectId: currentProjectId,
        refId,
        segmentKind: "main",
      });
    } else if (kind === "bridge") {
      const b = findBridge(refId);
      if (!b) throw new Error(t("common.bridgeNotFound"));
      const imageFile = await fileFromFrame(b.startFrame);
      const endFile = await fileFromFrame(b.endFrame);
      startBlobId = await snapshotFileToBlobId(imageFile, {
        kind: "upload",
        filename: "start.png",
        projectId: currentProjectId,
        refId,
        segmentKind: "bridge",
      });
      endBlobId = await snapshotFileToBlobId(endFile, {
        kind: "upload",
        filename: "end.png",
        projectId: currentProjectId,
        refId,
        segmentKind: "bridge",
      });
    } else if (kind === "edit" && spec.files) {
      const files = spec.files;
      if (files.imageFile) {
        startBlobId = await snapshotFileToBlobId(files.imageFile, {
          kind: "upload",
          filename: files.imageFile.name || "start.png",
          projectId: currentProjectId,
          refId,
          segmentKind: "edit",
        });
      }
      if (files.videoFile) {
        videoBlobId = await snapshotFileToBlobId(files.videoFile, {
          kind: "upload",
          filename: files.videoFile.name || "input.mp4",
          projectId: currentProjectId,
          refId,
          segmentKind: "edit",
        });
      }
      if (files.audioFile) {
        audioBlobId = await snapshotFileToBlobId(files.audioFile, {
          kind: "upload",
          filename: files.audioFile.name || "input.mp3",
          projectId: currentProjectId,
          refId,
          segmentKind: "edit",
        });
      }
      editorPayload = {
        editorId: files.editorId || (editorPayload && editorPayload.editorId),
        editorSource:
          files.editorSource ||
          req.editorSource ||
          (editorPayload && editorPayload.editorSource) ||
          "user",
        provider: files.provider || (editorPayload && editorPayload.provider),
        adapterMode:
          files.adapterMode || (editorPayload && editorPayload.adapterMode),
        boundValues: files.boundValues || {},
        paramValues: files.paramValues || {},
      };
    }

    const baseId = localVideoJobId(kind, refId);
    const existing = (localJobsCache || []).find((j) => j.id === baseId);
    let jobId = baseId;
    if (existing && existing.status === "running" && !existing.canceled) {
      jobId = baseId + "-next";
    }
    const slotIndex =
      kind === "main"
        ? mains.findIndex((m) => m.id === refId) + 1
        : kind === "bridge"
          ? bridges.findIndex((b) => b.id === refId) + 1
          : edits.findIndex((e) => e.id === refId) + 1;
    const now = new Date().toISOString();
    const prevSame = (localJobsCache || []).find((j) => j.id === jobId);
    const job = {
      id: jobId,
      local: true,
      projectId: currentProjectId,
      projectName: currentProjectName,
      kind,
      refId,
      slotIndex: slotIndex > 0 ? slotIndex : null,
      status: "pending",
      channel:
        spec.kind === "edit"
          ? cfg.channel
          : jobEng && jobEng.source === "user"
            ? channelForUserEngine(jobEng)
            : cfg.channel,
      rhTaskId: null,
      request: req,
      startBlobId,
      endBlobId,
      videoBlobId,
      audioBlobId,
      editorPayload,
      result: null,
      error: null,
      canceled: false,
      createdAt: (prevSame && prevSame.createdAt) || now,
      updatedAt: now,
    };
    await persistLocalJob(job);
    const target =
      kind === "main"
        ? findMain(refId)
        : kind === "bridge"
          ? findBridge(refId)
          : kind === "edit"
            ? findEdit(refId)
            : null;
    if (target) {
      target.status = "pending";
      target.label = t("status.pending");
      target.origin = "local";
      target.meta = "";
    }
    if (kind === "t2i") {
      handleT2iJobUpdate({
        kind: "t2i",
        status: "pending",
        result: null,
      }).catch(() => {});
    }
    refreshLocalBatchFlag();
    renderAll();
    scheduleSaveDraft();
    kickLocalQueueDrain();
    return job;
  }

  function getSubmitConcurrency() {
    return parseInt(normalizeConcurrency(concurrencyEl && concurrencyEl.value), 10) || 1;
  }

  async function executePersistedLocalJobSafe(job) {
    try {
      await executePersistedLocalJob(job);
    } catch (e) {
      console.warn("local job failed", e);
      await persistLocalJob({
        id: job.id,
        status: "failed",
        error: e.message || String(e),
      });
      const target =
        job.kind === "main"
          ? findMain(job.refId)
          : job.kind === "bridge"
            ? findBridge(job.refId)
            : job.kind === "edit"
              ? findEdit(job.refId)
              : null;
      if (job.kind === "t2i") {
        handleT2iJobUpdate({
          kind: "t2i",
          status: "failed",
          error: e.message || String(e),
        }).catch(() => {});
      } else if (target && isActiveJobStatus(target.status)) {
        target.status = "failed";
        target.label = t("status.failed");
        target.meta = e.message || String(e);
      }
      renderAll();
      scheduleSaveDraft();
    }
  }

  async function kickLocalQueueDrain() {
    if (typeof localDrainWakeResolve === "function") {
      const wake = localDrainWakeResolve;
      localDrainWakeResolve = null;
      wake();
    }
    if (localDrainActive) return;
    localDrainActive = true;
    refreshLocalBatchFlag();
    const inFlight = new Map();
    const launch = (job) => {
      if (!job || inFlight.has(job.id)) return;
      const p = executePersistedLocalJobSafe(job).finally(() => {
        inFlight.delete(job.id);
      });
      inFlight.set(job.id, p);
    };
    try {
      while (true) {
        const conc = getSubmitConcurrency();
        const runningJobs = (localJobsCache || [])
          .filter((j) => j.status === "running" && !j.canceled)
          .sort(
            (a, b) =>
              (Date.parse(a.updatedAt || a.createdAt || 0) || 0) -
              (Date.parse(b.updatedAt || b.createdAt || 0) || 0)
          );
        for (const j of runningJobs) {
          if (inFlight.size >= conc) break;
          launch(j);
        }
        const pending = (localJobsCache || [])
          .filter(
            (j) =>
              (j.status === "pending" || j.status === "queued") && !j.canceled
          )
          .sort(
            (a, b) =>
              (Date.parse(a.createdAt || 0) || 0) -
              (Date.parse(b.createdAt || 0) || 0)
          );
        for (const j of pending) {
          if (inFlight.size >= conc) break;
          launch(j);
        }
        if (inFlight.size === 0) break;
        await Promise.race([
          ...inFlight.values(),
          new Promise((resolve) => {
            localDrainWakeResolve = resolve;
          }),
        ]);
        localDrainWakeResolve = null;
      }
    } finally {
      localDrainActive = false;
      localDrainWakeResolve = null;
      refreshLocalBatchFlag();
      renderJobsPanel();
      const leftover = (localJobsCache || []).some(
        (j) =>
          !j.canceled &&
          (j.status === "pending" ||
            j.status === "queued" ||
            j.status === "running")
      );
      if (leftover) kickLocalQueueDrain();
    }
  }

  async function executePersistedLocalJob(job) {
    const cfg = getVideoChannelConfig();
    if (!window.VflowLocal || !window.VflowAdapter) {
      throw new Error(t("common.localModuleMissing"));
    }
    const kind = job.kind;
    const localJobId = job.id;
    await persistLocalJob({
      id: localJobId,
      status: "running",
      error: null,
      canceled: false,
    });
    const target =
      kind === "main"
        ? findMain(job.refId)
        : kind === "bridge"
          ? findBridge(job.refId)
          : findEdit(job.refId);
    if (target) {
      target.status = "running";
      target.label = t("status.agentRunning");
      target.origin = "local";
    }
    renderAll();
    await window.VflowLocal.ensureAgentOnline();
    if (isLocalJobCanceled(localJobId)) {
      throw new Error(t("status.forceEnded"));
    }

    const req = job.request || {};
    const useDuck =
      req.useDuckEncrypt != null ? !!req.useDuckEncrypt : isUseDuckEncrypt();
    const duckPassword =
      req.password != null
        ? String(req.password)
        : useDuck && duckPasswordEl
          ? duckPasswordEl.value || ""
          : "";
    const resultFilename =
      formatProjectSlotTimeName({
        projectName: job.projectName || currentProjectName,
        projectId: job.projectId || currentProjectId,
        kind,
        slotIndex: job.slotIndex,
        at: new Date().toISOString(),
      }) + (kind === "t2i" ? ".png" : ".mp4");

    let adapterMode;
    let values;
    let imageFile = null;
    let endImageFile = null;
    let videoFile = null;
    let audioFile = null;
    let providerChannel = job.channel || cfg.channel;

    if (kind === "edit") {
      const ep = job.editorPayload || {};
      adapterMode = ep.adapterMode;
      if (!adapterMode) throw new Error(t("common.localModuleMissing"));
      values = applyHiddenParamDefaults(
        {
          prompt: req.prompt || "",
          negative:
            req.negative ||
            (negativeInput && negativeInput.value.trim()) ||
            "",
          width: req.width,
          height: req.height,
          length: req.length,
          fps: req.fps || req.frame_rate,
          seedHigh: req.seedHigh,
          seedLow: req.seedLow,
          paramValues: ep.paramValues || req.paramValues || {},
          ...(ep.boundValues || {}),
        },
        adapterMode.params
      );
      ensureRequestSeeds(values, req);
      providerChannel =
        ep.provider === "runninghub" || providerChannel === "custom_rh"
          ? "custom_rh"
          : "comfyui";
      if (job.startBlobId) {
        imageFile = await window.VflowLocal.blobFileFromId(
          job.startBlobId,
          "start.png"
        );
      }
      if (job.videoBlobId) {
        videoFile = await window.VflowLocal.blobFileFromId(
          job.videoBlobId,
          "input.mp4"
        );
      }
      if (job.audioBlobId) {
        audioFile = await window.VflowLocal.blobFileFromId(
          job.audioBlobId,
          "input.mp3"
        );
      }
    } else if (kind === "t2i") {
      adapterMode = resolveAdapterMode(cfg, "t2i");
      const size = commitWfSizeInputs();
      values = applyHiddenParamDefaults(
        {
          prompt: req.prompt || "",
          negative:
            req.negative ||
            (negativeInput && negativeInput.value.trim()) ||
            "",
          width: req.width || size.width,
          height: req.height || size.height,
          seedHigh: req.seedHigh,
          seedLow: req.seedLow,
        },
        adapterMode.params
      );
      ensureRequestSeeds(values, req);
      providerChannel = cfg.channel;
      handleT2iJobUpdate({
        kind: "t2i",
        status: "running",
        result: null,
      }).catch(() => {});
    } else {
      const mode = kind === "bridge" ? "flf" : "i2v";
      const refNames = Array.isArray(req.refImageFileNames)
        ? req.refImageFileNames.filter(Boolean)
        : [];
      const hasVideo = !!(
        Array.isArray(req.refVideoFileNames) && req.refVideoFileNames[0]
      );
      const hasAudio = !!(
        (Array.isArray(req.refAudioFileNames) && req.refAudioFileNames[0]) ||
        req.refAudioFileName
      );
      const jobEngineId = normalizeEngineId(
        req.engineProfile || storyboardEngineProfile
      );
      const adapterOpts =
        jobEngineId === "minimax" && mode === "i2v"
          ? {
              engineProfile: jobEngineId,
              nImages: refNames.length || 1,
              hasVideo,
              hasAudio,
            }
          : { engineProfile: jobEngineId };
      adapterMode = resolveAdapterMode(cfg, mode, adapterOpts);
      const size = commitWfSizeInputs();
      const reqParams =
        req.paramValues && typeof req.paramValues === "object"
          ? req.paramValues
          : {};
      values = applyHiddenParamDefaults(
        {
          prompt: req.prompt || "",
          negative:
            req.negative ||
            (negativeInput && negativeInput.value.trim()) ||
            "",
          width: req.width || size.width,
          height: req.height || size.height,
          length: req.length || size.length,
          fps: req.fps || req.frame_rate || size.fps,
          duration: req.durationSec != null ? req.durationSec : req.duration,
          seedHigh: req.seedHigh,
          seedLow: req.seedLow,
          inputVideo: req.inputVideoFileName || "",
          inputAudio: req.inputAudioFileName || "",
          paramValues: reqParams,
        },
        adapterMode.params
      );
      (adapterMode.params || []).forEach((p) => {
        if (!p || !p.id) return;
        const raw = reqParams[p.id];
        if (raw == null || raw === "") return;
        if (p.bind) values[p.bind] = raw;
        values[p.id] = raw;
      });
      Object.keys(req).forEach((k) => {
        if (
          /^(refImage|refVideo|startImage|endImage|inputVideo|inputAudio)/.test(k) &&
          req[k]
        ) {
          values[k] = req[k];
        }
      });
      // Multi-ref: map ordered RH names into refImageN (fixed-slot; no Enable)
      if (refNames.length) {
        refNames.forEach((name, i) => {
          if (name) values["refImage" + i] = name;
        });
        if (refNames[0] && !values.startImage) {
          values.startImage = refNames[0];
        }
      }
      // Video/audio only when this adapter mode binds them (phase-1 MiniMax: none)
      const binds = (adapterMode && adapterMode.bindings) || {};
      if (hasVideo && binds.refVideo0) {
        values.refVideo0 = req.refVideoFileNames[0];
        if (binds.refVideo0Enable) values.refVideo0Enable = "true";
        if (binds.refVideoAudio0Enable) values.refVideoAudio0Enable = "true";
      }
      if (hasAudio && binds.refAudio0) {
        values.refAudio0 =
          (Array.isArray(req.refAudioFileNames) && req.refAudioFileNames[0]) ||
          req.refAudioFileName;
        if (binds.refAudio0Enable) values.refAudio0Enable = "true";
      }
      ensureRequestSeeds(values, req);
      if (job.startBlobId) {
        imageFile = await window.VflowLocal.blobFileFromId(
          job.startBlobId,
          "start.png"
        );
      }
      if (job.endBlobId) {
        endImageFile = await window.VflowLocal.blobFileFromId(
          job.endBlobId,
          "end.png"
        );
      }
      if (!imageFile && kind === "main") imageFile = await fileFromSharedStart();
      if (!imageFile && kind === "bridge") {
        const b = findBridge(job.refId);
        imageFile = await fileFromFrame(b.startFrame);
        if (!endImageFile) endImageFile = await fileFromFrame(b.endFrame);
      }
      const jobEng = getStoryboardEngine(jobEngineId);
      providerChannel =
        jobEng && jobEng.source === "user"
          ? channelForUserEngine(jobEng)
          : job.channel || cfg.channel;
    }

    const agentOptsBase = {
      adapterMode,
      values,
      imageFile,
      endImageFile,
      videoFile,
      audioFile,
      kind:
        kind === "bridge"
          ? "flf"
          : kind === "edit"
            ? "edit"
            : kind === "t2i"
              ? "t2i"
              : "i2v",
      prompt: values.prompt,
      filename: resultFilename,
      projectId: job.projectId || currentProjectId,
      refId: job.refId,
      segmentKind: kind,
      useDuckEncrypt: useDuck,
      password: duckPassword,
    };

    let taskId = String(job.rhTaskId || "").trim();
    if (!taskId) {
      let created;
      if (providerChannel === "custom_rh") {
        if (!cfg.rh || !cfg.rh.apiKey) throw new Error(t("settings.fillRhApiKey"));
        created = await window.VflowLocal.createViaAgent({
          ...agentOptsBase,
          channel: "custom_rh",
          rh: {
            baseUrl: (cfg.rh && cfg.rh.baseUrl) || RH_DEFAULT_BASE,
            apiKey: cfg.rh.apiKey,
          },
        });
      } else {
        created = await window.VflowLocal.createViaAgent({
          ...agentOptsBase,
          channel: "comfyui",
          comfy: {
            baseUrl: (cfg.comfy && cfg.comfy.baseUrl) || COMFY_DEFAULT_BASE,
            authHeader: (cfg.comfy && cfg.comfy.authHeader) || "",
          },
        });
      }
      taskId = String(created.taskId || "").trim();
      if (!taskId) throw new Error(t("local.noTaskId"));
      await persistLocalJob({
        id: localJobId,
        rhTaskId: taskId,
        status: "running",
        submittedAt: new Date().toISOString(),
      });
      if (target) {
        target.taskId = taskId;
        target.meta = "taskId " + taskId;
      }
    }

    const pollOpts = {
      channel: providerChannel === "custom_rh" ? "custom_rh" : "comfyui",
      taskId,
      filename: resultFilename,
      kind: agentOptsBase.kind,
      prompt: values.prompt,
      projectId: job.projectId || currentProjectId,
      refId: job.refId,
      segmentKind: kind,
      useDuckEncrypt: useDuck,
      password: duckPassword,
      rh:
        providerChannel === "custom_rh"
          ? {
              baseUrl: (cfg.rh && cfg.rh.baseUrl) || RH_DEFAULT_BASE,
              apiKey: cfg.rh && cfg.rh.apiKey,
            }
          : undefined,
      comfy:
        providerChannel !== "custom_rh"
          ? {
              baseUrl: (cfg.comfy && cfg.comfy.baseUrl) || COMFY_DEFAULT_BASE,
              authHeader: (cfg.comfy && cfg.comfy.authHeader) || "",
            }
          : undefined,
    };

    let pollResult = null;
    while (true) {
      if (isLocalJobCanceled(localJobId)) {
        throw new Error(t("status.forceEnded"));
      }
      pollResult = await window.VflowLocal.pollViaAgent(pollOpts);
      if (pollResult.status === "SUCCESS" && pollResult.asset) break;
      if (pollResult.status === "FAILED" || pollResult.done) {
        throw new Error(pollResult.error || t("status.failed"));
      }
      await new Promise((r) => setTimeout(r, LOCAL_POLL_MS));
    }

    const result = { asset: pollResult.asset, taskId };
    if (kind === "t2i") {
      if (!result.asset) throw new Error(t("editor.localNoResult"));
      await persistLocalJob({
        id: localJobId,
        status: "success",
        rhTaskId: result.taskId || null,
        result: {
          playUrl: result.asset.playUrl,
          results: [{ mediaFileId: result.asset.id }],
        },
        error: null,
      });
      await handleT2iJobUpdate({
        kind: "t2i",
        status: "success",
        result: {
          playUrl: result.asset.playUrl,
          results: [{ mediaFileId: result.asset.id }],
        },
      });
      await refreshAssetLibrary();
      renderAll();
      scheduleSaveDraft();
      return result;
    }
    if (target && result.asset) {
      target.playUrl = result.asset.playUrl;
      target.status = "success";
      target.label = t("status.success");
      target.dirty = false;
      target.origin = "local";
      target.taskId = result.taskId;
      target.mediaFileId = result.asset.id;
      target.durationSec = null;
      if (kind === "bridge") {
        target.needsReselect = false;
        snapshotBridgeLinkedSig(target);
      }
      if (kind === "main") markBridgesNeedReselectForMain(target.id);
      await persistLocalJob({
        id: localJobId,
        status: "success",
        rhTaskId: result.taskId || null,
        result: {
          playUrl: result.asset.playUrl,
          results: [{ mediaFileId: result.asset.id }],
        },
        error: null,
      });
      probeClipDuration(target).then(() => {
        rebuildTimeline();
        scheduleSaveDraft();
      });
    } else {
      throw new Error(t("editor.localNoResult"));
    }
    await refreshAssetLibrary();
    renderAll();
    scheduleSaveDraft();
    return result;
  }

  async function runLocalVideoJob(spec) {
    return enqueueLocalJobSpec(spec);
  }

  async function cancelLocalWaitingJobs(projectId) {
    const pid = projectId != null ? Number(projectId) : currentProjectId;
    let n = 0;
    for (const j of [...(localJobsCache || [])]) {
      if (pid && Number(j.projectId) !== Number(pid)) continue;
      if (j.status !== "pending" || j.canceled) continue;
      await persistLocalJob({
        id: j.id,
        status: "failed",
        canceled: true,
        error: t("status.canceled"),
      });
      const target =
        j.kind === "main"
          ? findMain(j.refId)
          : j.kind === "bridge"
            ? findBridge(j.refId)
            : findEdit(j.refId);
      if (
        target &&
        (target.status === "pending" || target.status === "queued")
      ) {
        target.status = "failed";
        target.label = t("status.canceled");
      }
      n += 1;
    }
    refreshLocalBatchFlag();
    renderAll();
    return { canceled: n };
  }

  async function resumeLocalJobs() {
    if (!window.VflowLocal || !window.VflowLocal.listJobs) return;
    let jobs = [];
    try {
      jobs = await window.VflowLocal.listJobs();
    } catch (e) {
      console.warn(e);
      return;
    }
    const active = (jobs || []).filter(
      (j) =>
        !j.canceled &&
        ["pending", "running", "queued", "finalizing"].includes(j.status)
    );
    for (const j of active) {
      upsertLocalJob(j);
    }
    refreshLocalBatchFlag();
    renderJobsPanel();
    if (active.length) kickLocalQueueDrain();
  }

  async function enqueueJobsLocalOrServer(jobSpecs) {
    if (!currentProjectId) throw new Error(t("jobs.openProjectFirst"));
    const server = [];
    const local = [];
    (jobSpecs || []).forEach((spec) => {
      if (jobUsesLocalAgent(spec)) local.push(spec);
      else server.push(spec);
    });
    const results = [];
    if (server.length) {
      results.push(...(await enqueueJobs(server)));
    }
    if (local.length) {
      for (const spec of local) {
        results.push(await enqueueLocalJobSpec(spec));
      }
      if (globalStatus) {
        globalStatus.textContent = t("status.agentBatchRunning", {
          channel: "local",
        });
      }
      if (btnStart) btnStart.disabled = false;
      if (btnStop) btnStop.disabled = false;
      refreshLocalBatchFlag();
    }
    return results;
  }

  async function enqueueJobs(jobSpecs) {
    if (!currentProjectId) throw new Error(t("jobs.openProjectFirst"));
    await saveDraftImmediate();
    const conc = getSubmitConcurrency();
    const jobsWithConc = (jobSpecs || []).map((spec) => ({
      ...spec,
      request: { ...(spec.request || {}), concurrency: conc },
    }));
    let data;
    try {
      data = await postJson("/api/jobs", {
        projectId: currentProjectId,
        jobs: jobsWithConc,
      });
    } catch (e) {
      if (e && (e.status === 413 || (e.payload && e.payload.code === "quota_exceeded"))) {
        if (e.payload && e.payload.usage) applyStorageUsage(e.payload.usage);
        highlightStorageQuota();
        const err = new Error(
          e.message || t("asset.quotaExceeded")
        );
        err.code = "quota_exceeded";
        err.payload = e.payload;
        throw err;
      }
      throw e;
    }
    if (data.usage) applyStorageUsage(data.usage);
    if (data.pendingCount != null) jobsPanelMeta.pendingCount = data.pendingCount;
    if (data.runningCount != null) jobsPanelMeta.runningCount = data.runningCount;
    if (data.perUserMaxRunning != null) {
      jobsPanelMeta.perUserMaxRunning = data.perUserMaxRunning;
    }
    if (data.globalMaxRunning != null) {
      jobsPanelMeta.globalMaxRunning = data.globalMaxRunning;
    }
    applyLatestJobsToSegments(data.jobs || []);
    batchRunning = true;
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = false;
    const jobs = data.jobs || [];
    const replacedN = jobs.filter((j) => j.replaced).length;
    const addedN = jobs.length - replacedN;
    if (globalStatus) {
      const parts = [];
      if (addedN) parts.push(`新增 ${addedN}`);
      if (replacedN) parts.push(`更新排队 ${replacedN}`);
      const pendingHint =
        data.pendingCount != null ? `，缓存等待 ${data.pendingCount}` : "";
      globalStatus.textContent =
        (parts.length ? parts.join(" · ") : `已入队 ${jobs.length} 个任务`) +
        pendingHint +
        t("status.syncing");
    }
    renderAll();
    startJobPolling();
    try {
      await syncActiveJobs();
      await refreshUserJobs();
    } catch (e) {
      console.warn(e);
    }
    return data.jobs || [];
  }

  async function syncActiveJobs() {
    if (!currentProjectId) return [];
    const data = await apiJson(
      `/api/jobs?projectId=${currentProjectId}&active=0`
    );
    const jobs = data.jobs || [];
    applyLatestJobsToSegments(jobs);
    const active = jobs.filter((j) => isActiveJobStatus(j.status));
    batchRunning = active.length > 0;
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = !batchRunning;
    if (data.pendingCount != null) jobsPanelMeta.pendingCount = data.pendingCount;
    if (data.runningCount != null) jobsPanelMeta.runningCount = data.runningCount;
    if (active.length) {
      const pending = active.filter((j) => j.status === "pending").length;
      const queued = active.filter((j) => j.status === "queued").length;
      const running = active.filter((j) =>
        ["running", "finalizing"].includes(j.status)
      ).length;
      globalStatus.textContent =
        `队列 ${active.length} 个（等待提交 ${pending} · 远端排队 ${queued} · 运行 ${running}）· 可继续追加`;
    }
    renderAll();
    refreshUserJobs().catch(() => {});
    return active;
  }

  function startJobPolling() {
    stopJobPolling();
    // Immediate tick, then interval
    jobPollTimer = setInterval(async () => {
      try {
        const active = await syncActiveJobs();
        await refreshAssetLibrary();
        if (!active.length) {
          stopJobPolling();
          if (globalStatus && /队列进行中|已入队|同步中/.test(globalStatus.textContent || "")) {
            globalStatus.textContent = t("status.queueDone");
          }
          await saveDraftImmediate();
        }
      } catch (e) {
        console.warn("job poll failed", e);
        if (globalStatus) {
          globalStatus.textContent = t("status.queueSyncFailed");
        }
      }
    }, POLL_MS);
  }

  function stopJobPolling() {
    if (jobPollTimer) {
      clearInterval(jobPollTimer);
      jobPollTimer = null;
    }
  }

  /** Fresh seeds for each submit (gacha / regenerate). Never reuse clip seeds. */
  function freshNoiseSeeds() {
    const max = BigInt("0x7fffffffffffffff"); // 2^63 - 1
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

  function ensureRequestSeeds(obj, prefer) {
    const out = obj || {};
    const fresh = freshNoiseSeeds();
    const src = prefer || {};
    // Prefer explicit request seeds; otherwise always gacha (ignore baked hidden defaults).
    out.seedHigh =
      src.seedHigh != null && src.seedHigh !== ""
        ? src.seedHigh
        : fresh.seedHigh;
    out.seedLow =
      src.seedLow != null && src.seedLow !== "" ? src.seedLow : fresh.seedLow;
    return out;
  }

  function buildMainRequest(main) {
    const size = commitWfSizeInputs();
    const engId = resolveClipEngineId(main);
    const eng = getStoryboardEngine(engId);
    const useDuck = eng.id === "minimax" ? true : isUseDuckEncrypt();
    const seeds = freshNoiseSeeds();
    const rawDur =
      main.durationSec != null && Number(main.durationSec) > 0
        ? Number(main.durationSec)
        : eng.mainDefaultSec;
    const E = window.VflowStoryboardEngines;
    const durationSec =
      E && typeof E.clampMainSec === "function"
        ? E.clampMainSec(rawDur, engId)
        : Math.max(eng.mainMinSec, Math.min(eng.mainMaxSec, rawDur));
    const base = {
      mode: "i2v",
      engineProfile: eng.id,
      prompt: (main.prompt || "").trim(),
      negative: negativeInput.value.trim(),
      imageFileName: sharedStartRhName,
      imageMediaFileId: sharedStartMediaId || null,
      startMediaFileId: sharedStartMediaId || null,
      startImageFileName: sharedStartRhName,
      width: size.width,
      height: size.height,
      seedHigh: seeds.seedHigh,
      seedLow: seeds.seedLow,
      useDuckEncrypt: useDuck,
      password: useDuck && duckPasswordEl ? duckPasswordEl.value : "",
      durationSec,
      paramValues:
        main.workflowParams && typeof main.workflowParams === "object"
          ? { ...main.workflowParams }
          : {},
    };
    Object.keys(storyboardMediaByBind || {}).forEach((bind) => {
      const entry = storyboardMediaByBind[bind];
      if (!entry) return;
      const name = entry.rhFileName || entry.fileName;
      if (!name) return;
      if (bind === "inputVideo") base.inputVideoFileName = name;
      else if (bind === "inputAudio") base.inputAudioFileName = name;
      else base[bind] = name;
    });
    if (eng.usesDurationSeconds) {
      // Semantic: <Picture 1> = shared start → refImage0; list → <Picture 2..> → refImage1..
      const extraImgs = [];
      const videos = [];
      const audios = [];
      if (storyboardUseMultiRef && storyboardRefAssets.length) {
        storyboardRefAssets.forEach((a) => {
          if (!a || !a.rhFileName) return;
          if (a.kind === "image") extraImgs.push(a.rhFileName);
          else if (a.kind === "video") videos.push(a.rhFileName);
          else if (a.kind === "audio") audios.push(a.rhFileName);
        });
      }
      const refs = [];
      if (sharedStartRhName) {
        refs.push(sharedStartRhName);
        refs.push(...extraImgs);
      } else if (extraImgs.length) {
        // Fallback: first list image becomes Picture 1 if no shared start
        refs.push(...extraImgs);
      }
      const maxImg = eng.maxRefImages || 5;
      const startRef = refs[0];
      if (startRef) {
        while (refs.length < maxImg) refs.push(startRef);
      }
      base.refImageFileNames = refs.slice(0, maxImg);
      if (videos.length) {
        base.refVideoFileNames = videos.slice(0, eng.maxRefVideos || 0);
      }
      if (audios.length) {
        base.refAudioFileNames = audios.slice(0, eng.maxRefAudios || 0);
      }
      if (refs[0]) {
        base.imageFileName = refs[0];
        base.startImageFileName = refs[0];
      }
      base.length = framesFromDurationSec(
        durationSec,
        eng.nativeFps || eng.defaultFps || 24
      );
      base.fps = eng.nativeFps || eng.defaultFps || resolveClipFps(main);
      base.frame_rate = base.fps;
      return base;
    }
    const length = resolveClipLength(main);
    const fps = resolveClipFps(main);
    base.length = length;
    base.fps = fps;
    base.frame_rate = fps;
    return base;
  }

  function buildBridgeRequest(b) {
    const size = commitWfSizeInputs();
    const engId = resolveClipEngineId(b);
    const eng = getStoryboardEngine(engId);
    const useDuck = eng.id === "minimax" ? true : isUseDuckEncrypt();
    const seeds = freshNoiseSeeds();
    const rawDur =
      b.durationSec != null && Number(b.durationSec) > 0
        ? Number(b.durationSec)
        : eng.bridgeDefaultSec;
    const E = window.VflowStoryboardEngines;
    const durationSec =
      E && typeof E.clampBridgeSec === "function"
        ? E.clampBridgeSec(rawDur, engId, false)
        : Math.max(eng.bridgeMinSec, Math.min(eng.bridgeMaxSec, rawDur));
    const base = {
      mode: "flf",
      engineProfile: eng.id,
      prompt: (b.prompt || "").trim(),
      negative: negativeInput.value.trim(),
      startImageFileName: b.startFrame && b.startFrame.rhFileName,
      endImageFileName: b.endFrame && b.endFrame.rhFileName,
      startMediaFileId:
        (b.startFrame && b.startFrame.mediaFileId) || null,
      endMediaFileId: (b.endFrame && b.endFrame.mediaFileId) || null,
      width: size.width,
      height: size.height,
      seedHigh: seeds.seedHigh,
      seedLow: seeds.seedLow,
      useDuckEncrypt: useDuck,
      password: useDuck && duckPasswordEl ? duckPasswordEl.value : "",
      durationSec,
      paramValues:
        b.workflowParams && typeof b.workflowParams === "object"
          ? { ...b.workflowParams }
          : {},
    };
    Object.keys(storyboardMediaByBind || {}).forEach((bind) => {
      const entry = storyboardMediaByBind[bind];
      if (!entry) return;
      const name = entry.rhFileName || entry.fileName;
      if (!name) return;
      if (bind === "inputVideo") base.inputVideoFileName = name;
      else if (bind === "inputAudio") base.inputAudioFileName = name;
      else base[bind] = name;
    });
    if (eng.usesDurationSeconds) {
      base.length = framesFromDurationSec(
        durationSec,
        eng.nativeFps || eng.defaultFps || 24
      );
      base.fps = eng.nativeFps || eng.defaultFps || resolveClipFps(b);
      base.frame_rate = base.fps;
      return base;
    }
    const length = resolveClipLength(b);
    const fps = resolveClipFps(b);
    base.length = length;
    base.fps = fps;
    base.frame_rate = fps;
    return base;
  }

  async function runMainJob(main) {
    const prompt = (main.prompt || "").trim();
    if (!prompt) throw new Error(t("common.promptEmpty"));
    main.status = "queued";
    main.label = t("status.submitting");
    main.dirty = false;
    updateMainCard(main.id);
    if (isPlatformEngine(getStoryboardEngine(resolveClipEngineId(main)))) {
      await ensureSharedStartUploaded();
    } else if (!selectedFile && !sharedStartPlayUrl) {
      throw new Error(t("main.needStartFrame"));
    }
    const request = buildMainRequest(main);
    await enqueueJobsLocalOrServer([
      { kind: "main", refId: main.id, request },
    ]);
    commitClipEngineAfterEnqueue(main, request.engineProfile);
    return { ok: true };
  }

  async function rerollMain(mainId) {
    const main = findMain(mainId);
    if (!main) {
      alert(t("main.notFoundReselect"));
      return;
    }
    if (!(main.prompt || "").trim()) {
      alert(t("main.needPrompt"));
      return;
    }
    if (!selectedFile && !sharedStartRhName && !sharedStartPlayUrl) {
      alert(t("main.needStartFrame"));
      return;
    }
    globalStatus.textContent = t("status.mainQueued");
    try {
      await runMainJob(main);
    } catch (e) {
      main.status = "failed";
      main.label = t("status.failed");
      main.meta = e.message || String(e);
      updateMainCard(main.id);
      globalStatus.textContent = t("common.generateFailedPrefix") + e.message;
      alert(t("common.generateFailedPrefix") + (e.message || String(e)));
    }
  }

  async function runBatch() {
    if (!selectedFile && !sharedStartRhName && !sharedStartPlayUrl) {
      alert(t("main.needStartFrame"));
      return;
    }
    syncPromptsFromDom();
    const todo = mains.filter((m) => {
      const p = (m.prompt || "").trim();
      if (!p) return false;
      return m.dirty || m.status !== "success" || !m.playUrl;
    });
    if (!todo.length) {
      alert(t("main.noPending"));
      return;
    }
    const usePlatform = todo.some((m) =>
      isPlatformEngine(getStoryboardEngine(resolveClipEngineId(m)))
    );
    globalStatus.textContent = usePlatform
      ? t("status.uploadingStart")
      : t("status.submittingLocal");
    try {
      if (usePlatform) {
        await ensureSharedStartUploaded();
      }
      const jobs = todo.map((main) => {
        main.status = "queued";
        main.label = t("status.queuing");
        main.dirty = false;
        return {
          kind: "main",
          refId: main.id,
          request: buildMainRequest(main),
        };
      });
      await enqueueJobsLocalOrServer(jobs);
      const engineIds = new Set();
      jobs.forEach((job) => {
        const m = findMain(job.refId);
        const engId = normalizeEngineId(
          (job.request && job.request.engineProfile) || storyboardEngineProfile
        );
        stampClipEngine(m, engId);
        engineIds.add(engId);
      });
      if (engineIds.size === 1) {
        const only = engineIds.values().next().value;
        if (storyboardEngineProfile !== only) {
          applyStoryboardEngineProfile(only);
        } else {
          syncInspectorEngineUi();
        }
      } else {
        syncInspectorEngineUi();
      }
      scheduleSaveDraft();
      globalStatus.textContent = usePlatform
        ? t("status.mainBatchQueued", { n: jobs.length })
        : t("status.mainBatchLocalDone", { n: jobs.length });
    } catch (e) {
      globalStatus.textContent = "";
      batchRunning = false;
      if (btnStart) btnStart.disabled = false;
      if (btnStop) btnStop.disabled = true;
      alert(t("common.enqueueFailedPrefix") + (e.message || String(e)));
    }
  }

  /**
   * Preflight checks for bridge FLF generation.
   * Returns human-readable error lines (empty = ready).
   * @param {BridgeSeg} b
   * @returns {string[]}
   */
  function collectBridgeReadyErrors(b) {
    const name = bridgeLabel(b);
    /** @type {string[]} */
    const errors = [];
    if (!(b.prompt || "").trim()) {
      errors.push(`${name}：缺少桥接提示词`);
    }
    const usePlatform = isPlatformEngine(
      getStoryboardEngine(resolveClipEngineId(b))
    );
    const startManual =
      b.startFrame && b.startFrame.source === "manual" ? b.startFrame : null;
    const endManual =
      b.endFrame && b.endFrame.source === "manual" ? b.endFrame : null;

    const startManualOk = startManual
      ? usePlatform
        ? isPlatformRhFileName(startManual.rhFileName) &&
          !isLocalMediaId(startManual.mediaFileId)
        : !!(startManual.rhFileName || startManual.blobUrl || startManual.playUrl)
      : false;
    const endManualOk = endManual
      ? usePlatform
        ? isPlatformRhFileName(endManual.rhFileName) &&
          !isLocalMediaId(endManual.mediaFileId)
        : !!(endManual.rhFileName || endManual.blobUrl || endManual.playUrl)
      : false;

    if (!startManualOk) {
      if (startManual) {
        errors.push(`${name}：首帧未正确配置（请重新节选或上传）`);
      } else if (!b.startLink) {
        errors.push(
          `${name}：前侧无主视频，无法提取首帧（请先生成前主段，或手动配置首帧）`
        );
      } else if (!b.startLink.playUrl) {
        errors.push(`${name}：前主视频不可用，无法提取首帧`);
      }
    }
    if (!endManualOk) {
      if (endManual) {
        errors.push(`${name}：尾帧未正确配置（请重新节选或上传）`);
      } else if (!b.endLink) {
        errors.push(
          `${name}：后侧无主视频，无法提取尾帧（请先生成后主段，或手动配置尾帧）`
        );
      } else if (!b.endLink.playUrl) {
        errors.push(`${name}：后主视频不可用，无法提取尾帧`);
      }
    }
    return errors;
  }

  /**
   * Batch-generate pending bridges (mirrors runBatch for mains).
   * Preflights first/last frames from neighbor mains; reports errors clearly.
   */
  async function runBridgeBatch() {
    syncPromptsFromDom();
    refreshBridgeLinks();
    const todo = bridges.filter((b) => {
      const p = (b.prompt || "").trim();
      if (!p) return false;
      return b.dirty || b.status !== "success" || !b.playUrl;
    });
    if (!todo.length) {
      if (!bridges.length) {
        alert(t("bridge.noBridges"));
      } else {
        alert(
          t("bridge.noPending")
        );
      }
      return;
    }

    /** @type {BridgeSeg[]} */
    const ready = [];
    /** @type {string[]} */
    const blockLines = [];
    todo.forEach((b) => {
      const errs = collectBridgeReadyErrors(b);
      if (errs.length) blockLines.push(...errs);
      else ready.push(b);
    });

    if (!ready.length) {
      alert(
        t("bridge.cannotOneClick") +
          blockLines.join("\n") +
          t("bridge.oneClickHint")
      );
      if (globalStatus) {
        globalStatus.textContent = t("bridge.batchPrecheckFailed", {
          count: blockLines.length,
        });
      }
      return;
    }

    if (blockLines.length) {
      const ok = confirm(
        t("bridge.partialUnavailable", { count: blockLines.length }) +
          blockLines.join("\n") +
          t("bridge.continueReady", { ready: ready.length })
      );
      if (!ok) {
        if (globalStatus) {
          globalStatus.textContent = t("bridge.batchCanceled");
        }
        return;
      }
    }

    const usePlatform = ready.some((b) =>
      isPlatformEngine(getStoryboardEngine(resolveClipEngineId(b)))
    );
    if (globalStatus) {
      globalStatus.textContent = usePlatform
        ? t("bridge.preparingFramesEnqueue", { n: ready.length })
        : t("bridge.submittingLocal", { n: ready.length });
    }

    /** @type {{ kind: string, refId: string, request: object }[]} */
    const jobs = [];
    /** @type {string[]} */
    const prepFails = [];

    for (const b of ready) {
      b.status = "queued";
      b.label = t("status.queuing");
      b.dirty = false;
      b.meta = t("status.preparingFrames");
      try {
        const clipPlatform = isPlatformEngine(
          getStoryboardEngine(resolveClipEngineId(b))
        );
        if (clipPlatform) {
          await ensureAutoFrameUploaded(b, "start");
          await ensureAutoFrameUploaded(b, "end");
          if (!b.startFrame || !isPlatformRhFileName(b.startFrame.rhFileName)) {
            throw new Error(t("bridge.startPrepFailed"));
          }
          if (!b.endFrame || !isPlatformRhFileName(b.endFrame.rhFileName)) {
            throw new Error(t("bridge.endPrepFailed"));
          }
        } else {
          await ensureLocalBridgeFrames(b);
        }
        snapshotBridgeLinkedSig(b);
        b.needsReselect = false;
        b.meta = "";
        jobs.push({
          kind: "bridge",
          refId: b.id,
          request: buildBridgeRequest(b),
        });
      } catch (e) {
        b.status = "failed";
        b.label = t("status.failed");
        b.meta = e.message || String(e);
        prepFails.push(`${bridgeLabel(b)}：${e.message || String(e)}`);
      }
    }

    renderBridges();
    if (selectedClip && selectedClip.kind === "bridge") {
      const cur = bridges.find((x) => x.id === selectedClip.id);
      if (cur) renderFlfFramePanel(cur);
    }
    scheduleSaveDraft();

    if (!jobs.length) {
      alert(
        t("bridge.framesAllFailed") + prepFails.join("\n")
      );
      if (globalStatus) globalStatus.textContent = t("bridge.batchEnqueueFailed");
      return;
    }

    try {
      await enqueueJobsLocalOrServer(jobs);
      const engineIds = new Set();
      jobs.forEach((job) => {
        const bridge = bridges.find((x) => x.id === job.refId);
        const engId = normalizeEngineId(
          (job.request && job.request.engineProfile) || storyboardEngineProfile
        );
        stampClipEngine(bridge, engId);
        engineIds.add(engId);
      });
      if (engineIds.size === 1) {
        const only = engineIds.values().next().value;
        if (storyboardEngineProfile !== only) {
          applyStoryboardEngineProfile(only);
        } else {
          syncInspectorEngineUi();
        }
      } else {
        syncInspectorEngineUi();
      }
      scheduleSaveDraft();
      let msg = usePlatform
        ? t("status.bridgeBatchQueued", { n: jobs.length })
        : t("status.bridgeBatchLocalDone", { n: jobs.length });
      if (prepFails.length) {
        msg += t("bridge.prepSkippedSuffix", { n: prepFails.length });
        alert(
          t("bridge.queuedWithPrepFails", { n: jobs.length }) +
            prepFails.join("\n")
        );
      }
      if (globalStatus) globalStatus.textContent = msg;
    } catch (e) {
      if (globalStatus) globalStatus.textContent = "";
      batchRunning = false;
      if (btnStart) btnStart.disabled = false;
      if (btnStartBridges) btnStartBridges.disabled = false;
      if (btnStop) btnStop.disabled = true;
      alert(t("common.bridgeBatchEnqueueFailedPrefix") + (e.message || String(e)));
    }
  }

  async function runBridge(bridgeId, isReroll) {
    const b = bridges.find((x) => x.id === bridgeId);
    if (!b) {
      alert(t("bridge.notFoundReselect"));
      return;
    }
    // Refresh links so auto frames match current timeline
    refreshBridgeLinks();
    const preflight = collectBridgeReadyErrors(b);
    if (preflight.length) {
      alert(
        t("bridge.cannotConnect") +
          preflight.join("\n") +
          "\n\n提示：请先生成前后主段视频以自动提取首尾帧，或在右侧面板手动节选/上传。"
      );
      return;
    }
    b.status = "queued";
    b.label = isReroll ? t("status.bridgeRerollQueued") : t("status.queuing");
    b.dirty = false;
    b.meta = t("status.preparingFrames");
    renderBridges();
    renderFlfFramePanel(b);
    try {
      const usePlatform = isPlatformEngine(
        getStoryboardEngine(resolveClipEngineId(b))
      );
      if (usePlatform) {
        await ensureAutoFrameUploaded(b, "start");
        await ensureAutoFrameUploaded(b, "end");
        if (!b.startFrame || !isPlatformRhFileName(b.startFrame.rhFileName)) {
          throw new Error(t("bridge.startPrepFailed"));
        }
        if (!b.endFrame || !isPlatformRhFileName(b.endFrame.rhFileName)) {
          throw new Error(t("bridge.endPrepFailed"));
        }
      } else {
        await ensureLocalBridgeFrames(b);
      }
      snapshotBridgeLinkedSig(b);
      b.needsReselect = false;
      b.meta = "";
      const request = buildBridgeRequest(b);
      await enqueueJobsLocalOrServer([
        { kind: "bridge", refId: b.id, request },
      ]);
      commitClipEngineAfterEnqueue(b, request.engineProfile);
      globalStatus.textContent = usePlatform
        ? t("status.bridgeQueued")
        : t("status.localBridgeDone");
      renderBridges();
      renderFlfFramePanel(b);
      scheduleSaveDraft();
    } catch (e) {
      b.status = "failed";
      b.label = t("status.failed");
      b.meta = e.message || String(e);
      renderBridges();
      renderFlfFramePanel(b);
      alert(e.message || String(e));
    }
  }

    // —— Projects ——

  async function refreshProjectList() {
    const data = await apiJson("/api/projects");
    projectList = data.projects || [];
    renderProjects();
    renderAssetLibrary();
  }

  function renderProjects() {
    if (!presetListEl) return;
    presetListEl.innerHTML = "";
    if (presetEmpty) {
      presetEmpty.classList.toggle("hidden", projectList.length > 0);
    }
    projectList.forEach((project) => {
      const li = document.createElement("li");
      li.className = "preset-item";
      const active = project.id === currentProjectId;
      const updated = project.updated_at || project.updatedAt || "";
      li.innerHTML = `
        <div class="preset-info">
          <span class="preset-name"></span>
          <span class="preset-meta muted"></span>
        </div>
        <div class="preset-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="load">${
            active ? t("project.current") : t("project.load")
          }</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="rename">重命名</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="delete">删除</button>
        </div>
      `;
      li.querySelector(".preset-name").textContent =
        (project.name || t("project.unnamed")) + (active ? t("project.opening") : "");
      li.querySelector(".preset-meta").textContent = updated
        ? `更新 ${updated}`
        : "";
      const loadBtn = li.querySelector('[data-act="load"]');
      if (active) loadBtn.disabled = true;
      loadBtn.addEventListener("click", () => loadProject(project.id));
      li.querySelector('[data-act="rename"]').addEventListener("click", () => {
        renameProject(project.id, project.name);
      });
      li.querySelector('[data-act="delete"]').addEventListener("click", () => {
        deleteProject(project.id);
      });
      presetListEl.appendChild(li);
    });
  }

  async function saveCurrentProject() {
    if (!currentProjectId) {
      await createProjectAndOpen();
      return;
    }
    await saveDraftImmediate();
    closePresetDropdown();
  }

  async function createProjectAndOpen() {
    const data = await postJson("/api/projects", {
      // 名称由后端自动生成「新建1」「新建2」…
      payload: collectDraftPayload(),
    });
    currentProjectId = data.project.id;
    currentProjectName = data.project.name;
    localStorage.setItem(PROJECT_KEY, String(currentProjectId));
    await refreshProjectList();
    enterAssetLibraryDefault();
    setDraftStatus(t("topbar.draftCreated", { name: currentProjectName }));
    closePresetDropdown();
  }

  async function loadProject(projectId, { skipSave = false } = {}) {
    if (!skipSave && currentProjectId && currentProjectId !== projectId) {
      try {
        await saveDraftImmediate();
      } catch (e) {
        console.warn(e);
      }
    }
    const data = await apiJson(`/api/projects/${projectId}`);
    await applyProjectPayload(data.project);
    localStorage.setItem(PROJECT_KEY, String(currentProjectId));
    await refreshProjectList();
    enterAssetLibraryDefault();
    const active = await syncActiveJobs();
    if (active.length) startJobPolling();
    refreshUserJobs().catch(() => {});
    resumeLocalJobs().catch((e) => console.warn(e));
    closePresetDropdown();
    closeJobsDropdown();
  }

  async function renameProject(projectId, oldName) {
    const name = prompt(t("project.newNamePrompt"), oldName || "");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      alert(t("project.nameRequired"));
      return;
    }
    await apiJson(`/api/projects/${projectId}`, {
      method: "PUT",
      body: { name: trimmed },
    });
    if (projectId === currentProjectId) {
      currentProjectName = trimmed;
    }
    await refreshProjectList();
    renderAssetLibrary();
  }

  async function deleteProject(projectId) {
    if (!confirm(t("project.confirmDelete"))) return;
    await apiJson(`/api/projects/${projectId}`, { method: "DELETE" });
    if (projectId === currentProjectId) {
      currentProjectId = null;
      const data = await apiJson("/api/projects");
      projectList = data.projects || [];
      if (projectList.length) {
        await loadProject(projectList[0].id, { skipSave: true });
      } else {
        await createProjectAndOpen();
        resetEditorState();
        await saveDraftImmediate();
      }
    } else {
      await refreshProjectList();
    }
    await refreshAssetLibrary();
  }

  /** Re-resolve local IndexedDB assets to fresh blob URLs after project load. */
  async function rebindLocalMediaUrls() {
    if (!window.VflowLocal || !window.VflowLocal.listAssets) return false;
    let list;
    try {
      list = await window.VflowLocal.listAssets();
    } catch (e) {
      console.warn("rebindLocalMediaUrls", e);
      return false;
    }
    const byId = new Map();
    for (const asset of list) {
      if (asset.id) byId.set(String(asset.id), asset.playUrl);
      if (asset.blobId) byId.set(String(asset.blobId), asset.playUrl);
    }
    if (!byId.size) return false;

    let changed = false;
    function rebindTarget(target) {
      if (!target || target.mediaFileId == null) return;
      const fresh = byId.get(String(target.mediaFileId));
      if (!fresh) return;
      const cur = target.playUrl;
      if (!cur || String(cur).startsWith("blob:") || cur !== fresh) {
        target.playUrl = fresh;
        if (target.blobUrl != null) target.blobUrl = fresh;
        changed = true;
      }
    }

    mains.forEach(rebindTarget);
    bridges.forEach((b) => {
      rebindTarget(b);
      if (b.startFrame) rebindTarget(b.startFrame);
      if (b.endFrame) rebindTarget(b.endFrame);
    });
    edits.forEach(rebindTarget);

    if (sharedStartMediaId != null) {
      const fresh = byId.get(String(sharedStartMediaId));
      if (
        fresh &&
        (!sharedStartPlayUrl || String(sharedStartPlayUrl).startsWith("blob:"))
      ) {
        sharedStartPlayUrl = fresh;
        changed = true;
      }
    }

    return changed;
  }

  function setSharedStartFromUrl(url, name) {
    selectedFile = null;
    revokePreviewUrl();
    sharedStartPlayUrl = url || null;
    if (!url) {
      imageName.textContent = t("bins.notSelected");
      imagePreviewWrap.classList.add("hidden");
      imagePreview.removeAttribute("src");
      dropZone.classList.remove("has-image", "hidden");
      if (startCompact) startCompact.classList.add("hidden");
      try {
        renderStoryboardRefList();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    imageName.textContent = name || t("project.savedStartFrame");
    imagePreview.src = url;
    imagePreviewWrap.classList.remove("hidden");
    dropZone.classList.add("has-image", "hidden");
    if (startCompact) {
      startCompact.classList.remove("hidden");
      if (startCompactThumb) startCompactThumb.src = url;
      if (startCompactName) startCompactName.textContent = name || t("project.savedStartFrame");
    }
    applyStartFrameOrientDefault(url).catch((err) => {
      console.warn("detect shared-start orientation failed", err);
    });
    try {
      renderStoryboardRefList();
    } catch (e) {
      /* ignore */
    }
  }

  async function applyProjectPayload(project) {
    suppressSave = true;
    storyboardPolishDraft = null;
    currentProjectId = project.id;
    currentProjectName = project.name || t("project.unnamedProject");
    const draft = project.payload || {};
    if (draft.negative != null) negativeInput.value = draft.negative;
    if (draft.concurrency) concurrencyEl.value = String(draft.concurrency);
    if (duckPasswordEl && draft.password != null) {
      duckPasswordEl.value = draft.password;
    }
    sharedStartRhName = draft.sharedStartRhName || null;
    sharedStartPlayUrl = draft.sharedStartPlayUrl || null;
    sharedStartMediaId = draft.sharedStartMediaId || null;
    storyboardUseMultiRef = !!draft.storyboardUseMultiRef;
    storyboardRefAssets = [];
    storyboardMediaByBind = {};
    if (sceneDescriptionEl && draft.sceneDescription != null) {
      sceneDescriptionEl.value = draft.sceneDescription;
    }
    if (plotDirectionEl && draft.plotDirection != null) {
      plotDirectionEl.value = draft.plotDirection;
    }
    if (segmentCountEl && draft.segmentCount != null) {
      segmentCountEl.value = String(draft.segmentCount);
    }
    if (storyboardTargetDurationEl) {
      storyboardTargetDurationEl.value = String(
        clampTargetDurationSec(
          draft.storyboardTargetDuration != null
            ? draft.storyboardTargetDuration
            : draft.targetDurationSec,
          30
        )
      );
    }
    // storyboardMainDuration restored after engine profile (see below)
    if (llmPickCountEl && draft.llmPickCount != null) {
      llmPickCountEl.checked = !!draft.llmPickCount;
    }
    if (llmAutoBridgeEl && draft.llmAutoBridge != null) {
      llmAutoBridgeEl.checked = !!draft.llmAutoBridge;
    }
    boundScriptAssetId = draft.scriptAssetId != null ? Number(draft.scriptAssetId) : null;
    boundEpisodeId = String(draft.episodeId || "").trim();
    syncLlmCountUi();
    const draftW = draft.vflowWidth != null ? draft.vflowWidth : draft.wfWidth;
    const draftH = draft.vflowHeight != null ? draft.vflowHeight : draft.wfHeight;
    const draftL = draft.vflowLength != null ? draft.vflowLength : draft.wfLength;
    const draftFps = draft.vflowFps != null ? draft.vflowFps : draft.wfFps;
    const draftO = draft.vflowOrient || draft.wfOrient;
    if (draftW != null && vflowWidthEl) vflowWidthEl.value = String(draftW);
    if (draftH != null && vflowHeightEl) {
      vflowHeightEl.value = String(draftH);
    }
    if (draftL != null) {
      projectTiming.length = snapLength(draftL, vflowDefaults.length);
      if (vflowLengthEl) vflowLengthEl.value = String(projectTiming.length);
    }
    if (draftFps != null) {
      projectTiming.fps = clampFps(draftFps, vflowDefaults.fps || 16);
      if (vflowFpsEl) vflowFpsEl.value = String(projectTiming.fps);
    } else {
      projectTiming.fps = vflowDefaults.fps || 16;
      if (vflowFpsEl) vflowFpsEl.value = String(projectTiming.fps);
    }
    if (draftO) vflowOrient = draftO;
    commitWfSizeInputs();
    syncLengthPresetActive();

    const draftVersion = Number(draft.version) || 0;
    const hasTracks =
      Array.isArray(draft.tracks) && draft.tracks.length > 0;

    if (hasTracks) {
      tracks = draft.tracks.map((tr, i) => ({
        id: tr.id || uid(tr.kind === "audio" ? "atr" : "vtr"),
        kind: tr.kind === "audio" ? "audio" : "video",
        name: tr.name || (tr.kind === "audio" ? `音轨 ${i + 1}` : `视频 ${i + 1}`),
        hidden: !!tr.hidden,
        role: tr.role || null,
      }));
    } else {
      tracks = [emptyTrack("video", t("timeline.videoTrackN", { n: 1 }))];
    }
    const fallbackTrackId = defaultVideoTrackId();

    if (Array.isArray(draft.mains) && draft.mains.length) {
      mains = draft.mains.map((m) =>
        normalizePlacementFields(
          {
            id: m.id || uid("m"),
            title: m.title || "",
            beat: m.beat || "",
            camera: m.camera || "",
            cutToNext: m.cutToNext === "soft" ? "soft" : "hard",
            prompt: m.prompt || "",
            status: m.status || "pending",
            label: m.label || m.status || t("timeline.pendingGen"),
            meta: m.meta || "",
            playUrl: m.playUrl || null,
            mediaFileId: m.mediaFileId || null,
            results: m.results || [],
            seedHigh: m.seedHigh || null,
            seedLow: m.seedLow || null,
            dirty: !!m.dirty,
            taskId: m.taskId || null,
            trackId: m.trackId || null,
            startSec: m.startSec,
            inSec: m.inSec,
            outSec: m.outSec,
            durationSec: m.durationSec,
            useGlobalTiming: m.useGlobalTiming !== false,
            length: m.length != null ? m.length : null,
            fps: m.fps != null ? m.fps : null,
            engineProfile: m.engineProfile
              ? normalizeEngineId(m.engineProfile)
              : null,
          },
          fallbackTrackId,
          0
        )
      );
    } else {
      mains = [emptyMain("")];
    }
    bridges = Array.isArray(draft.bridges)
      ? draft.bridges.map((b) =>
          normalizePlacementFields(
            {
              id: b.id || uid("b"),
              afterShot: b.afterShot || b.leftMainId || null,
              needBridge: b.needBridge !== false,
              leftMainId: b.leftMainId || null,
              rightMainId: b.rightMainId || null,
              prompt: b.prompt || "",
              startFrame: b.startFrame
                ? {
                    blobUrl: null,
                    playUrl: b.startFrame.playUrl || null,
                    mediaFileId: b.startFrame.mediaFileId || null,
                    rhFileName: b.startFrame.rhFileName || null,
                    sourceMainId: b.startFrame.sourceMainId,
                    timeSec: b.startFrame.timeSec,
                    source:
                      b.startFrame.source === "manual" ||
                      b.startFrame.source === "auto"
                        ? b.startFrame.source
                        : null,
                    previewUrl: null,
                    linkSig: b.startFrame.linkSig || null,
                  }
                : null,
              endFrame: b.endFrame
                ? {
                    blobUrl: null,
                    playUrl: b.endFrame.playUrl || null,
                    mediaFileId: b.endFrame.mediaFileId || null,
                    rhFileName: b.endFrame.rhFileName || null,
                    sourceMainId: b.endFrame.sourceMainId,
                    timeSec: b.endFrame.timeSec,
                    source:
                      b.endFrame.source === "manual" ||
                      b.endFrame.source === "auto"
                        ? b.endFrame.source
                        : null,
                    previewUrl: null,
                    linkSig: b.endFrame.linkSig || null,
                  }
                : null,
              status: b.status || "pending",
              label: b.label || t("bridge.waitingClip"),
              meta: b.meta || "",
              playUrl: b.playUrl || null,
              mediaFileId: b.mediaFileId || null,
              results: b.results || [],
              seedHigh: b.seedHigh || null,
              seedLow: b.seedLow || null,
              dirty: !!b.dirty,
              needsReselect: !!b.needsReselect,
              connectionStale: false,
              linkedSig:
                b.linkedSig && typeof b.linkedSig === "object"
                  ? {
                      start: b.linkedSig.start || "∅",
                      end: b.linkedSig.end || "∅",
                    }
                  : { start: "∅", end: "∅" },
              startLink: null,
              endLink: null,
              taskId: b.taskId || null,
              trackId: b.trackId || null,
              startSec: b.startSec,
              inSec: b.inSec,
              outSec: b.outSec,
              durationSec: b.durationSec,
              useGlobalTiming: b.useGlobalTiming !== false,
              length: b.length != null ? b.length : null,
              fps: b.fps != null ? b.fps : null,
              engineProfile: b.engineProfile
                ? normalizeEngineId(b.engineProfile)
                : null,
            },
            fallbackTrackId,
            0
          )
        )
      : [];

    edits = Array.isArray(draft.edits)
      ? draft.edits.map((ed) =>
          normalizePlacementFields(
            {
              id: ed.id || uid("e"),
              clipKind: "edit",
              editorId: ed.editorId || "",
              editorSource:
                ed.editorSource === "user" ? "user" : "platform",
              editorName: ed.editorName || "",
              sourceSelection: ed.sourceSelection || null,
              prompt: ed.prompt || "",
              editorParams:
                ed.editorParams && typeof ed.editorParams === "object"
                  ? ed.editorParams
                  : {},
              status: ed.status || "pending",
              label: ed.label || t("timeline.pendingGen"),
              meta: ed.meta || "",
              playUrl: ed.playUrl || null,
              mediaFileId: ed.mediaFileId || null,
              results: ed.results || [],
              seedHigh: ed.seedHigh || null,
              seedLow: ed.seedLow || null,
              dirty: !!ed.dirty,
              taskId: ed.taskId || null,
              trackId: ed.trackId || null,
              startSec: ed.startSec,
              inSec: ed.inSec,
              outSec: ed.outSec,
              durationSec: ed.durationSec,
              useGlobalTiming: ed.useGlobalTiming !== false,
              length: ed.length != null ? ed.length : null,
              fps: ed.fps != null ? ed.fps : null,
            },
            fallbackTrackId,
            0
          )
        )
      : [];

    let fallbackAudioTrackId = defaultAudioTrackId();
    if (
      Array.isArray(draft.audios) &&
      draft.audios.length &&
      !fallbackAudioTrackId
    ) {
      const tr = emptyTrack("audio");
      tracks.push(tr);
      fallbackAudioTrackId = tr.id;
    }
    audios = Array.isArray(draft.audios)
      ? draft.audios.map((a) => {
          const startSec =
            a.startSec != null && !Number.isNaN(Number(a.startSec))
              ? Math.max(0, Number(a.startSec))
              : 0;
          const inSec =
            a.inSec != null && !Number.isNaN(Number(a.inSec))
              ? Math.max(0, Number(a.inSec))
              : 0;
          return {
            id: a.id || uid("a"),
            trackId: a.trackId || fallbackAudioTrackId,
            startSec,
            inSec,
            outSec:
              a.outSec != null && !Number.isNaN(Number(a.outSec))
                ? Number(a.outSec)
                : null,
            durationSec:
              a.durationSec != null && Number(a.durationSec) > 0
                ? Number(a.durationSec)
                : null,
            playUrl: a.playUrl || null,
            mediaFileId: a.mediaFileId || null,
            status: a.status || (a.playUrl ? "success" : "pending"),
            label: a.label || "",
            name: a.name || "",
            volume: a.volume != null ? Number(a.volume) : 1,
            linkedFrom: a.linkedFrom || null,
          };
        })
      : [];

    // v3 / missing placement: lay out old linear main→bridge→main sequence
    if (!hasTracks || draftVersion < 4) {
      migrateLinearPlacement(fallbackTrackId);
    }

    if (draft.storyboardState && typeof draft.storyboardState === "object") {
      if (draft.storyboardState.engineProfile || draft.storyboardEngineProfile) {
        applyStoryboardEngineProfile(
          draft.storyboardState.engineProfile || draft.storyboardEngineProfile
        );
      }
      // After engine sync (which resets default), restore user-saved main duration
      if (storyboardMainDurationEl) {
        const E = window.VflowStoryboardEngines;
        const raw =
          draft.storyboardMainDuration != null
            ? draft.storyboardMainDuration
            : MAIN_DEFAULT_SEC;
        storyboardMainDurationEl.value = String(
          E && typeof E.clampMainSec === "function"
            ? E.clampMainSec(raw, storyboardEngineProfile)
            : Math.max(
                MAIN_MIN_SEC,
                Math.min(MAIN_MAX_SEC, Number(raw) || MAIN_DEFAULT_SEC)
              )
        );
      }
      if (draft.storyboardState.useMultiRef != null || draft.storyboardUseMultiRef != null) {
        storyboardUseMultiRef = !!(
          draft.storyboardState.useMultiRef != null
            ? draft.storyboardState.useMultiRef
            : draft.storyboardUseMultiRef
        );
      }
      if (Array.isArray(draft.storyboardState.refAssets)) {
        storyboardRefAssets = draft.storyboardState.refAssets.map((a, i) =>
          normalizeRefAssetFields(a, i)
        );
      }
      let normalizedState;
      try {
        // Drafts may have 0–1 shots or empty prompts; do not apply LLM min-segment rules.
        normalizedState = normalizeStoryboardResult(
          draft.storyboardState,
          null,
          undefined,
          { strict: false }
        );
      } catch (e) {
        console.warn("storyboardState normalize failed", e);
        normalizedState = null;
      }
      if (normalizedState) {
        storyboardState = {
          scriptSynopsis:
            normalizedState.script_synopsis ||
            String(draft.storyboardState.scriptSynopsis || "").trim() ||
            "",
          totalDurationSec: clampTargetDurationSec(
            normalizedState.totalDurationSec,
            getStoryboardTargetDurationSec()
          ),
          shots: normalizedState.shots.map((shot) => ({ ...shot })),
          bridges: normalizedState.bridges.map((bridge) => ({ ...bridge })),
          lastPolishSummary: String(
            draft.storyboardState.lastPolishSummary || ""
          ).trim(),
        };
      } else {
        storyboardState = buildStoryboardStateFromClips();
      }
    } else {
      if (draft.storyboardEngineProfile) {
        applyStoryboardEngineProfile(draft.storyboardEngineProfile);
      }
      if (storyboardMainDurationEl) {
        const E = window.VflowStoryboardEngines;
        const raw =
          draft.storyboardMainDuration != null
            ? draft.storyboardMainDuration
            : MAIN_DEFAULT_SEC;
        storyboardMainDurationEl.value = String(
          E && typeof E.clampMainSec === "function"
            ? E.clampMainSec(raw, storyboardEngineProfile)
            : Math.max(
                MAIN_MIN_SEC,
                Math.min(MAIN_MAX_SEC, Number(raw) || MAIN_DEFAULT_SEC)
              )
        );
      }
      storyboardState = buildStoryboardStateFromClips();
    }
    syncLlmCountUi();

    await rebindLocalMediaUrls();
    setSharedStartFromUrl(sharedStartPlayUrl, draft.imageName || "");
    schedule = [];
    scheduleIndex = -1;
    playheadSec = 0;
    stopTimelinePlayback();
    previewLoadedUrl = null;
    clearTimelineUndoHistory();
    renderAll();
    try {
      syncStoryboardEngineUi();
    } catch (_) {
      renderStoryboardRefList();
      syncMediaBinMultiRefPanel();
    }
    previewFilledSlotAfterLoad();
    suppressSave = false;
    setDraftStatus(t("topbar.draftLoaded", { name: currentProjectName }));
  }

  /**
   * After load/refresh: if any slot already has video, open video preview
   * instead of leaving the first-frame generator visible in the center.
   */
  function previewFilledSlotAfterLoad() {
    const filled = listClipsChronological().filter((c) => c.playUrl);
    if (!filled.length) {
      syncFirstFrameGenBar();
      return;
    }
    let target = null;
    if (selectedClip) {
      target = filled.find(
        (c) => c.kind === selectedClip.kind && c.id === selectedClip.id
      );
    }
    if (!target) target = filled[0];
    selectAndPreviewClip(target.kind, target.id, false);
  }

  /** Convert legacy adjacent main/bridge order into sequential placement on one track. */
  function migrateLinearPlacement(trackId) {
    const tid = trackId || defaultVideoTrackId();
    let cursor = 0;
    const usedBridge = new Set();
    for (let i = 0; i < mains.length; i++) {
      const m = mains[i];
      m.trackId = tid;
      m.startSec = cursor;
      if (m.inSec == null) m.inSec = 0;
      cursor = clipTimelineEnd(m);
      const next = mains[i + 1];
      if (!next) continue;
      const b = bridges.find(
        (x) =>
          !usedBridge.has(x.id) &&
          x.leftMainId === m.id &&
          x.rightMainId === next.id
      );
      if (b) {
        usedBridge.add(b.id);
        b.trackId = tid;
        b.startSec = cursor;
        if (b.inSec == null) b.inSec = 0;
        cursor = clipTimelineEnd(b);
      }
    }
    bridges.forEach((b) => {
      if (usedBridge.has(b.id)) return;
      b.trackId = b.trackId || tid;
      if (b.startSec == null || Number.isNaN(Number(b.startSec))) {
        b.startSec = cursor;
        cursor = clipTimelineEnd(b);
      }
    });
  }

  function resetEditorState() {
    suppressSave = true;
    clearTimeout(saveTimer);
    clearTimelineUndoHistory();
    clearFrameAssetPick();
    setImageFile(null);
    sharedStartRhName = null;
    sharedStartPlayUrl = null;
    sharedStartMediaId = null;
    storyboardUseMultiRef = false;
    storyboardRefAssets = [];
    storyboardMediaByBind = {};
    negativeInput.value = defaultNegative;
    persistConcurrencyPref(concurrencyEl && concurrencyEl.value);
    if (duckPasswordEl) duckPasswordEl.value = "";
    if (sceneDescriptionEl) sceneDescriptionEl.value = "";
    if (plotDirectionEl) plotDirectionEl.value = "";
    if (segmentCountEl) segmentCountEl.value = "3";
    if (storyboardTargetDurationEl) storyboardTargetDurationEl.value = "30";
    if (storyboardMainDurationEl) {
      storyboardMainDurationEl.value = String(MAIN_DEFAULT_SEC);
    }
    if (llmPickCountEl) llmPickCountEl.checked = false;
    if (llmAutoBridgeEl) llmAutoBridgeEl.checked = true;
    if (storyboardPolishInputEl) storyboardPolishInputEl.value = "";
    if (storyboardPolishStatusEl) storyboardPolishStatusEl.textContent = "";
    if (storyboardPolishDiffEl) {
      storyboardPolishDiffEl.textContent = t("storyboard.polishDiffEmpty");
    }
    storyboardPolishDraft = null;
    syncLlmCountUi();
    applyOrientPreset("landscape", false);
    projectTiming.length = vflowDefaults.length;
    projectTiming.fps = vflowDefaults.fps || 16;
    if (vflowLengthEl) vflowLengthEl.value = String(projectTiming.length);
    if (vflowFpsEl) vflowFpsEl.value = String(projectTiming.fps);
    syncLengthPresetActive();
    if (llmStatus) llmStatus.textContent = "";
    tracks = [emptyTrack("video", t("timeline.videoTrackN", { n: 1 }))];
    mains = [emptyMain("")];
    bridges = [];
    edits = [];
    audios = [];
    storyboardState = {
      scriptSynopsis: "",
      totalDurationSec: 30,
      shots: [],
      bridges: [],
      lastPolishSummary: "",
    };
    timelineSelection = null;
    selectedClip = null;
    browsingAssetId = null;
    hideAssetBrowseBar();
    schedule = [];
    scheduleIndex = -1;
    playheadSec = 0;
    stopTimelinePlayback();
    previewLoadedUrl = null;
    clearPreviewImage();
    previewVideoElements().forEach((v) => {
      v.removeAttribute("src");
      try {
        v.load();
      } catch (_) {}
    });
    if (playlistVideoA) setActivePreviewVideo(playlistVideoA);
    globalStatus.textContent = "";
    suppressSave = false;
    renderAll();
    try {
      syncStoryboardEngineUi();
    } catch (_) {
      renderStoryboardRefList();
      syncMediaBinMultiRefPanel();
    }
  }

  function formatBytes(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function applyStorageUsage(usage) {
    storageUsage = usage || null;
    if (assetUsageBar) assetUsageBar.classList.add("hidden");
  }

  function highlightStorageQuota() {
    if (!assetUsageBar) return;
    assetUsageBar.scrollIntoView({ behavior: "smooth", block: "nearest" });
    assetUsageBar.classList.add("is-flash");
    setTimeout(() => assetUsageBar.classList.remove("is-flash"), 2000);
  }


  async function deleteAssetSmart(asset) {
    if (!asset) return;
    if (asset.origin === "local" && window.VflowLocal) {
      await window.VflowLocal.deleteAsset(asset.blobId || asset.id);
      if (browsingAssetId === asset.id) browsingAssetId = null;
      await refreshAssetLibrary();
      return;
    }
    await deleteAsset(asset.id);
  }

  async function refreshAssetLibrary() {
    const data = await apiJson("/api/assets");
    const serverAssets = (data.assets || []).map((a) => ({
      ...a,
      origin: a.origin || "server",
    }));
    try {
      localAssetLibrary =
        window.VflowLocal && window.VflowLocal.listAssets
          ? await window.VflowLocal.listAssets()
          : [];
    } catch (e) {
      console.warn("local assets", e);
      localAssetLibrary = [];
    }
    assetLibrary = [...localAssetLibrary, ...serverAssets].sort((a, b) => {
      const ta = Date.parse(a.createdAt || "") || 0;
      const tb = Date.parse(b.createdAt || "") || 0;
      if (tb !== ta) return tb - ta;
      const ida = String(a.id || "");
      const idb = String(b.id || "");
      return idb.localeCompare(ida);
    });
    applyStorageUsage(data.usage);
    renderAssetLibrary();
  }

  function importTargetProjectId() {
    const folderPid = folderProjectId();
    if (folderPid) return folderPid;
    const cur = Number(currentProjectId);
    return Number.isFinite(cur) && cur > 0 ? cur : null;
  }

  function classifyImportFile(file) {
    if (!file) return null;
    const name = file.name || "";
    const mt = (file.type || "").toLowerCase();
    if (mt.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) {
      return "image";
    }
    if (mt.startsWith("audio/") || /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(name)) {
      return "audio";
    }
    if (mt.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v)$/i.test(name)) {
      return "video";
    }
    return null;
  }

  async function importCloudAssetFile(file, projectId) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("projectId", String(projectId));
    const res = await fetch("/api/assets/import", {
      method: "POST",
      body: fd,
      credentials: "same-origin",
      headers: { "X-Locale": currentLocale() },
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw new Error(json.message || t("auth.notLoggedIn"));
    }
    if (!json.success) {
      const err = new Error(json.message || t("common.uploadFailed"));
      err.payload = json;
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  async function importLocalAssets(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;

    const projectId = importTargetProjectId();
    if (!projectId) {
      alert(t("bins.importNeedProject"));
      return;
    }

    const toLocal = true;
    if (toLocal) {
      if (
        !agentConnected ||
        !window.VflowLocal ||
        !window.VflowLocal.putBlob
      ) {
        alert(t("bins.importNeedAgent"));
        return;
      }
    }

    let ok = 0;
    let fail = 0;
    const failMsgs = [];

    for (const file of files) {
      const mediaKind = classifyImportFile(file);
      if (!mediaKind) {
        fail += 1;
        failMsgs.push(t("bins.importUnsupported", { name: file.name || "?" }));
        continue;
      }
      const kind =
        mediaKind === "image"
          ? "upload"
          : mediaKind === "audio"
            ? "audio"
            : "i2v";
      try {
        if (toLocal) {
          await window.VflowLocal.putBlob(file, {
            kind,
            filename: file.name || `${kind}.bin`,
            projectId,
            promptSnapshot: file.name || "",
          });
        } else {
          await importCloudAssetFile(file, projectId);
        }
        ok += 1;
      } catch (e) {
        fail += 1;
        failMsgs.push(
          `${file.name || "?"}: ${(e && e.message) || String(e)}`
        );
      }
    }

    assetLibraryUserBrowsing = true;
    assetLibraryFolder = { type: "project", projectId: Number(projectId) };
    await refreshAssetLibrary();

    if (ok && !fail) {
      setDraftStatus(t("bins.importDone", { n: ok }));
    } else if (ok && fail) {
      setDraftStatus(
        `${t("bins.importDone", { n: ok })} · ${t("bins.importPartialFail", {
          ok,
          fail,
        })}`
      );
      if (failMsgs.length) {
        alert(failMsgs.slice(0, 5).join("\n"));
      }
    } else if (!ok && fail) {
      alert(
        failMsgs.length
          ? failMsgs.slice(0, 5).join("\n")
          : t("bins.importNone")
      );
    }
  }

  function assetMatchesOrigin(asset) {
    if (assetLibraryOrigin === "local") return asset.origin === "local";
    if (assetLibraryOrigin === "cloud") return asset.origin !== "local";
    return true;
  }

  function assetProjectId(asset) {
    const n = Number(asset && asset.projectId);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function assetLibrarySelectionKeyOf() {
    return selectedClip ? `${selectedClip.kind}:${selectedClip.id}` : "";
  }

  function projectNameById(projectId) {
    const pid = Number(projectId);
    if (pid === Number(currentProjectId)) return currentProjectName;
    const project = projectList.find((p) => Number(p.id) === pid);
    return project ? project.name : t("bins.assetUncategorized");
  }

  function folderProjectId() {
    if (!assetLibraryFolder || assetLibraryFolder === "root") return null;
    if (assetLibraryFolder.projectId == null) return null;
    return Number(assetLibraryFolder.projectId);
  }

  function slotLabelForFolder(folder) {
    if (!folder || folder.type !== "slot") return "";
    const clip = findClip(folder.kind, folder.refId);
    if (folder.kind === "bridge") {
      return clip ? bridgeLabel(clip) : t("common.bridgeShortQ");
    }
    if (folder.kind === "edit") {
      return clip ? editLabel(clip) : t("common.editShortQ");
    }
    return clip ? mainLabel(clip) : t("common.mainShortQ");
  }

  function enterAssetLibraryDefault() {
    assetLibraryUserBrowsing = false;
    assetLibrarySelectionKey = assetLibrarySelectionKeyOf();
    if (selectedClip && currentProjectId) {
      assetLibraryFolder = {
        type: "slot",
        projectId: Number(currentProjectId),
        kind: selectedClip.kind,
        refId: selectedClip.id,
      };
    } else if (currentProjectId) {
      assetLibraryFolder = {
        type: "project",
        projectId: Number(currentProjectId),
      };
    } else {
      assetLibraryFolder = "root";
    }
    renderAssetLibrary();
  }

  function syncAssetLibraryToSelection() {
    const key = assetLibrarySelectionKeyOf();
    if (key !== assetLibrarySelectionKey) {
      assetLibrarySelectionKey = key;
      if (key && currentProjectId) {
        assetLibraryUserBrowsing = false;
        assetLibraryFolder = {
          type: "slot",
          projectId: Number(currentProjectId),
          kind: selectedClip.kind,
          refId: selectedClip.id,
        };
      } else if (!key && !assetLibraryUserBrowsing && currentProjectId) {
        assetLibraryFolder = {
          type: "project",
          projectId: Number(currentProjectId),
        };
      }
    }
    renderAssetLibrary();
  }

  function assetLibraryGoUp() {
    if (!assetLibraryFolder || assetLibraryFolder === "root") return;
    assetLibraryUserBrowsing = true;
    if (assetLibraryFolder.type === "slot") {
      assetLibraryFolder = {
        type: "project",
        projectId: Number(assetLibraryFolder.projectId),
      };
    } else {
      assetLibraryFolder = "root";
    }
    renderAssetLibrary();
  }

  function assetMatchesSlotFolder(asset, folder) {
    const pid = assetProjectId(asset);
    if (pid !== Number(folder.projectId)) return false;
    if (asset.kind === "upload") return true;
    const clip = findClip(folder.kind, folder.refId);
    if (
      clip &&
      clip.mediaFileId != null &&
      String(clip.mediaFileId) === String(asset.id)
    ) {
      return true;
    }
    if (!asset.refId || String(asset.refId) !== String(folder.refId)) {
      return false;
    }
    if (folder.kind === "edit") {
      return (
        asset.kind === "edit" ||
        asset.segmentKind === "edit" ||
        asset.kind === "i2v"
      );
    }
    if (folder.kind === "bridge") {
      return asset.kind === "flf" || asset.segmentKind === "bridge";
    }
    return asset.kind === "i2v" || asset.segmentKind === "main";
  }

  function setAssetLibraryOrigin(origin) {
    assetLibraryOrigin = origin === "script" ? "script" : "local";
    localStorage.setItem(ASSET_ORIGIN_KEY, assetLibraryOrigin);
    renderAssetLibrary();
  }

  function updateAssetLibraryChrome() {
    if (assetOriginTabs) {
      assetOriginTabs.querySelectorAll("[data-origin]").forEach((btn) => {
        const active = btn.dataset.origin === assetLibraryOrigin;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.tabIndex = active ? 0 : -1;
      });
    }
    if (assetUsageBar) assetUsageBar.classList.add("hidden");
    const localOnly = assetLibraryOrigin === "local";
    if (assetLocalHint) assetLocalHint.classList.toggle("hidden", !localOnly);

    const inFolder = assetLibraryFolder && assetLibraryFolder !== "root";
    if (assetFolderNav) assetFolderNav.classList.toggle("hidden", !inFolder);
    if (!inFolder) return;

    const pid = folderProjectId();
    const projectName =
      pid != null ? projectNameById(pid) : t("bins.assetUncategorized");
    if (assetFolderUpPrefix) {
      assetFolderUpPrefix.textContent =
        assetLibraryFolder.type === "slot"
          ? t("bins.assetFolderUpShort")
          : t("bins.assetFolderUp");
    }
    if (assetFolderLabel) {
      if (assetLibraryFolder.type === "slot") {
        assetFolderLabel.textContent = `${projectName} · ${slotLabelForFolder(
          assetLibraryFolder
        )}`;
      } else if (assetLibraryFolder.type === "uncategorized") {
        assetFolderLabel.textContent = t("bins.assetUncategorized");
      } else {
        assetFolderLabel.textContent = projectName;
      }
    }
  }

  function assetFolderEmptyMessage() {
    if (assetLibraryFolder === "root") return t("bins.assetRootEmpty");
    if (assetLibraryFolder && assetLibraryFolder.type === "slot") {
      if (assetLibraryOrigin === "cloud") return t("bins.assetSlotEmptyCloud");
      if (assetLibraryOrigin === "local") return t("bins.assetSlotEmptyLocal");
      return t("bins.assetSlotEmpty");
    }
    if (
      assetLibraryFolder &&
      assetLibraryFolder.type === "project" &&
      !selectedClip
    ) {
      return `${t("bins.assetFolderEmpty")} · ${t("bins.assetSelectSlotHint")}`;
    }
    if (assetLibraryOrigin === "cloud") return t("bins.assetFolderEmptyCloud");
    if (assetLibraryOrigin === "local") return t("bins.assetFolderEmptyLocal");
    return t("bins.assetFolderEmpty");
  }

  function renderAssetFolder(project, count) {
    const row = document.createElement("div");
    row.className = "media-clip is-folder";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="media-thumb asset-folder-thumb" aria-hidden="true">
        <span class="asset-folder-glyph"></span>
      </div>
      <div class="media-clip-body">
        <span class="media-clip-title">${escapeHtml(project.name)}</span>
        <span class="media-clip-meta">${escapeHtml(t("bins.assetFolder"))}</span>
      </div>
      <span class="asset-folder-count">${count}</span>
    `;
    const enter = () => {
      assetLibraryUserBrowsing = true;
      assetLibraryFolder = { type: "project", projectId: Number(project.id) };
      renderAssetLibrary();
    };
    row.addEventListener("click", enter);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        enter();
      }
    });
    assetLibraryList.appendChild(row);
  }

  function renderUncategorizedFolder(count) {
    const row = document.createElement("div");
    row.className = "media-clip is-folder";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="media-thumb asset-folder-thumb" aria-hidden="true">
        <span class="asset-folder-glyph"></span>
      </div>
      <div class="media-clip-body">
        <span class="media-clip-title">${escapeHtml(t("bins.assetUncategorized"))}</span>
        <span class="media-clip-meta">${escapeHtml(t("bins.assetFolder"))}</span>
      </div>
      <span class="asset-folder-count">${count}</span>
    `;
    const enter = () => {
      assetLibraryUserBrowsing = true;
      assetLibraryFolder = { type: "uncategorized" };
      renderAssetLibrary();
    };
    row.addEventListener("click", enter);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        enter();
      }
    });
    assetLibraryList.appendChild(row);
  }

  function visibleAssetsForFolder(sourceAssets) {
    const liveProjectIds = new Set(projectList.map((p) => Number(p.id)));
    if (!assetLibraryFolder || assetLibraryFolder === "root") return [];
    if (assetLibraryFolder.type === "slot") {
      return sourceAssets.filter((asset) =>
        assetMatchesSlotFolder(asset, assetLibraryFolder)
      );
    }
    if (assetLibraryFolder.type === "project") {
      const pid = Number(assetLibraryFolder.projectId);
      // Stale project id → treat as uncategorized list
      if (!liveProjectIds.has(pid) && pid !== Number(currentProjectId)) {
        return sourceAssets.filter((asset) => {
          const ap = assetProjectId(asset);
          return ap == null || !liveProjectIds.has(ap);
        });
      }
      return sourceAssets.filter(
        (asset) => assetProjectId(asset) === pid
      );
    }
    // uncategorized
    return sourceAssets.filter((asset) => {
      const pid = assetProjectId(asset);
      return pid == null || !liveProjectIds.has(pid);
    });
  }

  function renderAssetLibrary() {
    if (!assetLibraryList) return;
    assetLibraryList.innerHTML = "";
    updateAssetLibraryChrome();
    const sourceAssets = assetLibrary.filter(assetMatchesOrigin);
    const liveProjectIds = new Set(projectList.map((p) => Number(p.id)));

    if (assetLibraryFolder === "root") {
      projectList.forEach((project) => {
        const count = sourceAssets.filter(
          (asset) => assetProjectId(asset) === Number(project.id)
        ).length;
        renderAssetFolder(project, count);
      });
      const uncategorizedCount = sourceAssets.filter((asset) => {
        const pid = assetProjectId(asset);
        return pid == null || !liveProjectIds.has(pid);
      }).length;
      if (uncategorizedCount) renderUncategorizedFolder(uncategorizedCount);
      const hasFolders = projectList.length > 0 || uncategorizedCount > 0;
      if (assetLibraryEmpty) {
        assetLibraryEmpty.textContent = assetFolderEmptyMessage();
        assetLibraryEmpty.classList.toggle("hidden", hasFolders);
      }
      return;
    }

    if (
      assetLibraryFolder.type === "project" &&
      !projectList.some(
        (p) => Number(p.id) === Number(assetLibraryFolder.projectId)
      ) &&
      Number(assetLibraryFolder.projectId) !== Number(currentProjectId)
    ) {
      assetLibraryFolder = { type: "uncategorized" };
      updateAssetLibraryChrome();
    }

    const visibleAssets = visibleAssetsForFolder(sourceAssets);
    if (assetLibraryEmpty) {
      assetLibraryEmpty.textContent = assetFolderEmptyMessage();
      assetLibraryEmpty.classList.toggle("hidden", visibleAssets.length > 0);
    }
    const slotSelected = !!selectedClip;
    const pickingFrame = !!frameAssetPickTarget;
    visibleAssets.forEach((asset) => {
      const card = document.createElement("div");
      card.className =
        "media-clip" +
        (asset.origin === "local" ? " is-local" : "") +
        (browsingAssetId === asset.id ? " is-selected" : "");
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      const prompt = asset.promptSnapshot || "";
      const sizeLabel = asset.size != null ? formatBytes(asset.size) : "";
      const kindLabel =
        asset.kind === "upload"
          ? t("asset.uploadFrame")
          : asset.kind === "flf"
            ? t("jobs.kindBridge")
            : asset.kind === "edit"
              ? t("jobs.kindEdit")
              : asset.kind === "i2v"
                ? t("jobs.kindMain")
                : asset.kind === "audio"
                  ? t("asset.kindAudio")
                  : asset.kind || t("asset.media");
      const originBadge =
        asset.origin === "local" && assetLibraryOrigin === "all"
          ? `<span class="origin-badge">${t("asset.originLocal")}</span>`
          : "";
      const fileLabel =
        asset.filename ||
        filenameFromPlayUrl(asset.playUrl || "") ||
        kindLabel;
      const metaBits = [
        kindLabel,
        asset.origin === "local" && assetLibraryOrigin === "all"
          ? t("asset.localBadge")
          : null,
        sizeLabel,
        prompt || asset.createdAt || "",
      ]
        .filter(Boolean)
        .join(" · ");
      const isImg = isAssetImage(asset);
      const isAudioAsset = isAssetAudio(asset);
      const isVideoAsset = !isImg && !isAudioAsset;
      let applyBtnHtml = "";
      if (pickingFrame) {
        applyBtnHtml = isImg
          ? `<button type="button" class="btn btn-primary btn-sm btn-apply-slot" data-act="apply">${escapeHtml(
              t("bins.applyToFrame")
            )}</button>`
          : "";
      } else if (isImg) {
        applyBtnHtml = `<button type="button" class="btn btn-primary btn-sm btn-apply-slot" data-act="apply">${escapeHtml(
          t("bins.applyToFrame")
        )}</button>`;
      } else if (isAudioAsset) {
        const audioTitle =
          selectedClip && selectedClip.kind === "audio"
            ? t("asset.fillAudioSlot")
            : t("asset.insertAudioAtPlayhead");
        applyBtnHtml = `<button type="button" class="btn btn-primary btn-sm btn-apply-slot" data-act="apply" title="${escapeHtml(
          audioTitle
        )}">${escapeHtml(t("bins.applyToSlot"))}</button>`;
      } else if (isVideoAsset) {
        applyBtnHtml = `<button type="button" class="btn btn-primary btn-sm btn-apply-slot" data-act="apply" title="${
          slotSelected ? t("asset.fillSlot") : t("asset.selectSlotFirst")
        }"${slotSelected ? "" : " disabled"}>填充</button>`;
      }
      const downloadUrl =
        asset.origin === "local"
          ? asset.playUrl || ""
          : `/api/assets/${encodeURIComponent(asset.id)}/download`;
      const downloadHtml = downloadUrl
        ? `<a class="btn btn-ghost btn-sm btn-download" data-act="download" href="${escapeHtml(
            downloadUrl
          )}" download="${escapeHtml(fileLabel)}">${escapeHtml(
            t("bins.assetDownload")
          )}</a>`
        : "";
      card.innerHTML = `
        <div class="media-thumb${
          isAudioAsset
            ? " is-audio"
            : !isImg && !assetVideoThumbPreview
              ? " is-blurred"
              : ""
        }">
          ${
            isImg
              ? `<img src="${escapeHtml(asset.playUrl)}" alt="" />`
              : isAudioAsset
                ? `<div class="media-thumb-audio" aria-hidden="true">♪</div>`
                : `<video muted playsinline preload="metadata" src="${escapeHtml(asset.playUrl)}#t=0.1"></video>`
          }
        </div>
        <div class="media-clip-body">
          <span class="media-clip-title">${escapeHtml(fileLabel)}${originBadge}</span>
          <span class="media-clip-meta">${escapeHtml(metaBits)}</span>
        </div>
        <div class="media-clip-actions">
          ${applyBtnHtml}
          ${downloadHtml}
          <button type="button" class="btn btn-ghost btn-sm" data-act="delete" title="${escapeHtml(t("asset.delete"))}">删</button>
        </div>
      `;
      if (!isImg && !isAudioAsset) {
        paintAssetVideoThumb(card.querySelector(".media-thumb video"));
      }
      const activate = () => browseAsset(asset);
      card.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="delete"]')) return;
        if (e.target.closest('[data-act="apply"]')) return;
        if (e.target.closest('[data-act="download"]')) return;
        activate();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      const applyBtn = card.querySelector('[data-act="apply"]');
      if (applyBtn) {
        applyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (pickingFrame || isImg) {
            const target = inferFrameAssetPickTarget();
            if (!target) {
              alert(t("asset.pickFrameSideFirst"));
              return;
            }
            applyImageAssetToFrame(asset, target).catch((err) =>
              alert(err && err.message ? err.message : String(err))
            );
            return;
          }
          applyAssetToSlot(asset);
        });
      }
      const delBtn = card.querySelector('[data-act="delete"]');
      if (delBtn) {
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteAssetSmart(asset).catch((err) => alert(err.message || String(err)));
        });
      }
      assetLibraryList.appendChild(card);
    });
  }

  async function deleteAsset(assetId, { force = false } = {}) {
    const url = `/api/assets/${assetId}${force ? "?force=1" : ""}`;
    try {
      const data = await apiJson(url, { method: "DELETE" });
      if (browsingAssetId === assetId) {
        browsingAssetId = null;
        hideAssetBrowseBar();
      }
      if (data.forced && currentProjectId) {
        try {
          await loadProject(currentProjectId);
        } catch (e) {
          console.warn(e);
        }
      }
      await refreshAssetLibrary();
      return data;
    } catch (e) {
      if (e.status === 409 && e.payload && e.payload.code === "in_use") {
        const names = (e.payload.inUse || [])
          .map((p) => p.name || `#${p.id}`)
          .join("、");
        const ok = confirm(
          `该素材正在被 ${e.payload.inUse.length} 个项目使用：\n${names}\n\n删除后相关片段结果/帧引用会被清空，仍要删除？`
        );
        if (!ok) return null;
        return deleteAsset(assetId, { force: true });
      }
      throw e;
    }
  }

  function hideAssetBrowseBar() {
    if (assetBrowseBar) assetBrowseBar.classList.add("hidden");
    if (btnSetSharedFromBrowse) btnSetSharedFromBrowse.classList.add("hidden");
  }

  function framePickLabel(target = frameAssetPickTarget) {
    if (!target) return "";
    if (target === "shared") return t("asset.sharedStart");
    const b = bridges.find((x) => x.id === target.bridgeId);
    const bridgeName = b ? bridgeLabel(b) : t("jobs.kindBridge");
    const sideLabel =
      target.side === "start" ? t("asset.bridgeStart") : t("asset.bridgeEnd");
    return `${bridgeName} · ${sideLabel}`;
  }

  function updateFrameAssetPickUi() {
    const active = !!frameAssetPickTarget;
    if (assetLibrarySection) {
      assetLibrarySection.classList.toggle("is-frame-picking", active);
    }
    if (assetFramePickHint) {
      assetFramePickHint.classList.toggle("hidden", !active);
      if (active) {
        assetFramePickHint.textContent = `${t("asset.pickFrameHint")} · ${framePickLabel()}`;
      }
    }
    if (btnApplyAsset) {
      btnApplyAsset.textContent = active
        ? t("bins.applyToFrame")
        : t("bins.applyToSlot");
      btnApplyAsset.classList.toggle("btn-warning", active);
      btnApplyAsset.classList.toggle("btn-primary", !active);
    }
  }

  function clearFrameAssetPick({ rerender = true } = {}) {
    frameAssetPickTarget = null;
    updateFrameAssetPickUi();
    if (rerender) renderAssetLibrary();
  }

  function enterFrameAssetPick(target) {
    frameAssetPickTarget = target;
    updateFrameAssetPickUi();
    if (assetLibraryFolder === "root") {
      enterAssetLibraryDefault();
    }
    renderAssetLibrary();
    if (assetLibrarySection && typeof assetLibrarySection.scrollIntoView === "function") {
      assetLibrarySection.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function inferFrameAssetPickTarget() {
    if (frameAssetPickTarget) return frameAssetPickTarget;
    // Bridge FLF needs an explicit start/end via「从素材库选用」.
    if (selectedClip && selectedClip.kind === "bridge") return null;
    // Editor slots do not take image frames this way.
    if (selectedClip && selectedClip.kind === "edit") return null;
    return "shared";
  }

  function showAssetBrowseBar(asset) {
    if (!assetBrowseBar) return;
    assetBrowseBar.classList.remove("hidden");
    const isImg = isAssetImage(asset);
    if (assetBrowseHint) {
      assetBrowseHint.textContent = frameAssetPickTarget
        ? framePickLabel()
        : `素材 #${asset.id} · ${asset.kind || ""}`;
    }
    if (btnApplyAsset) {
      const asFrame = !!frameAssetPickTarget || isImg;
      btnApplyAsset.textContent = asFrame
        ? t("bins.applyToFrame")
        : t("bins.applyToSlot");
      btnApplyAsset.classList.toggle("btn-warning", asFrame);
      btnApplyAsset.classList.toggle("btn-primary", !asFrame);
    }
    if (btnSetSharedFromBrowse) {
      const showSet =
        isImg &&
        (!frameAssetPickTarget || frameAssetPickTarget === "shared");
      btnSetSharedFromBrowse.classList.toggle("hidden", !showSet);
    }
  }

  function updateFirstFrameSizeHint() {
    if (!firstFrameSizeHint) return;
    const size = getWfSizePayload();
    firstFrameSizeHint.textContent = t("firstFrame.sizeHint", {
      w: size.width,
      h: size.height,
    });
  }

  function syncFirstFrameGenBar() {
    if (!firstFrameGenBar) return;
    // Hide while a non-image clip is actively previewed as video.
    const showingVideo =
      playlistPanel &&
      playlistPanel.classList.contains("has-source") &&
      !playlistPanel.classList.contains("is-image-preview");
    firstFrameGenBar.classList.toggle("hidden", !!showingVideo);
    updateFirstFrameSizeHint();
  }

  function focusFirstFrameGenerator() {
    if (firstFrameGenBar) firstFrameGenBar.classList.remove("hidden");
    updateFirstFrameSizeHint();
    if (firstFramePrompt) {
      firstFramePrompt.focus();
      firstFramePrompt.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function isCustomT2iReady() {
    const cfg = getVideoChannelConfig();
    const F = window.VflowFeatures;
    if (!F) return false;
    const feature = F.getFeature("t2i");
    const adapter = getActiveChannelAdapter(cfg);
    const status = F.featureStatus(feature, cfg.channel, adapter);
    return status && status.key === "workflow.statusDocked";
  }

  function isT2iReady() {
    return isCustomT2iReady();
  }

  function setFirstFrameGenBusy(busy) {
    firstFrameGenBusy = !!busy;
    const blocked = firstFrameGenBusy || firstFrameExpandBusy;
    if (btnGenerateFirstFrame) {
      btnGenerateFirstFrame.disabled = blocked;
      btnGenerateFirstFrame.textContent = firstFrameGenBusy
        ? t("firstFrame.generating")
        : t("firstFrame.generate");
    }
    if (btnExpandFirstFramePrompt) {
      btnExpandFirstFramePrompt.disabled = blocked;
      if (!firstFrameExpandBusy) {
        btnExpandFirstFramePrompt.textContent = t("firstFrame.expand");
      }
    }
  }

  function setFirstFrameExpandBusy(busy) {
    firstFrameExpandBusy = !!busy;
    const blocked = firstFrameGenBusy || firstFrameExpandBusy;
    if (btnExpandFirstFramePrompt) {
      btnExpandFirstFramePrompt.disabled = blocked;
      btnExpandFirstFramePrompt.textContent = firstFrameExpandBusy
        ? t("firstFrame.expanding")
        : t("firstFrame.expand");
    }
    if (btnGenerateFirstFrame) {
      btnGenerateFirstFrame.disabled = blocked;
      if (!firstFrameGenBusy) {
        btnGenerateFirstFrame.textContent = t("firstFrame.generate");
      }
    }
  }

  function t2iJobTrackKey(job) {
    if (!job || job.id == null || job.id === "") return null;
    return String(job.id);
  }

  async function handleT2iJobUpdate(job) {
    if (!job) return;
    const trackKey = t2iJobTrackKey(job);
    const prevStatus = trackKey != null ? t2iJobUiStatus.get(trackKey) : undefined;

    if (isActiveJobStatus(job.status)) {
      if (trackKey != null) t2iJobUiStatus.set(trackKey, job.status);
      setFirstFrameGenBusy(true);
      if (firstFrameGenStatus) {
        firstFrameGenStatus.textContent =
          job.status === "pending"
            ? t("status.pending")
            : job.status === "queued"
              ? t("status.remoteQueuing")
              : t("status.running");
      }
      return;
    }
    if (job.status === "failed") {
      if (trackKey != null) {
        if (prevStatus === "failed") return;
        const fromActive =
          prevStatus != null && isActiveJobStatus(prevStatus);
        t2iJobUiStatus.set(trackKey, "failed");
        // Historical failures from poll: record only, don't flash status.
        if (!fromActive) {
          setFirstFrameGenBusy(false);
          return;
        }
      }
      setFirstFrameGenBusy(false);
      if (firstFrameGenStatus) {
        firstFrameGenStatus.textContent =
          localizeStoredLabel(job.error || "") || t("firstFrame.failed");
      }
      if (globalStatus) {
        globalStatus.textContent = t("firstFrame.failed");
      }
      return;
    }
    if (job.status !== "success") return;

    // Poll returns all historical successes; only steal selection when this
    // session saw the job move from active → success. Synthetic local updates
    // (no job.id) always apply once.
    if (trackKey != null) {
      if (prevStatus === "success") return;
      const fromActive =
        prevStatus != null && isActiveJobStatus(prevStatus);
      t2iJobUiStatus.set(trackKey, "success");
      if (!fromActive) {
        setFirstFrameGenBusy(false);
        return;
      }
    }

    setFirstFrameGenBusy(false);
    const playUrl = job.result && job.result.playUrl;
    const mediaFileId =
      (job.result &&
        job.result.results &&
        job.result.results[0] &&
        job.result.results[0].mediaFileId) ||
      null;
    try {
      await refreshAssetLibrary();
    } catch (e) {
      console.warn(e);
    }
    let asset = null;
    if (mediaFileId != null) {
      asset = assetLibrary.find((a) => String(a.id) === String(mediaFileId));
    }
    if (!asset && playUrl) {
      asset = assetLibrary.find((a) => a.playUrl === playUrl);
    }
    if (asset) {
      lastT2iAssetId = asset.id;
      browseAsset(asset);
      if (btnSetSharedFromBrowse) {
        btnSetSharedFromBrowse.classList.remove("hidden");
      }
    } else if (playUrl) {
      showPreviewImage(playUrl);
      lastT2iAssetId = mediaFileId;
    }
    if (firstFrameGenStatus) {
      firstFrameGenStatus.textContent = t("firstFrame.done");
    }
    if (globalStatus) {
      globalStatus.textContent = t("firstFrame.done");
    }
    syncFirstFrameGenBar();
  }

  async function runFirstFrameGenerate() {
    if (!currentProjectId) {
      alert(t("jobs.openProjectFirst"));
      return;
    }
    if (firstFrameGenBusy || firstFrameExpandBusy) return;
    const prompt = ((firstFramePrompt && firstFramePrompt.value) || "").trim();
    if (!prompt) {
      alert(t("firstFrame.needPrompt"));
      return;
    }
    await fetchPlatformEditors().catch(() => {});
    if (!isT2iReady()) {
      alert(t("firstFrame.t2iUnavailable"));
      return;
    }
    const size = commitWfSizeInputs();
    updateFirstFrameSizeHint();
    const negative =
      (negativeInput && negativeInput.value.trim()) || "";
    setFirstFrameGenBusy(true);
    if (firstFrameGenStatus) {
      firstFrameGenStatus.textContent = t("status.queuing");
    }
    const seeds = freshNoiseSeeds();
    const request = {
      mode: "t2i",
      prompt,
      negative,
      width: size.width,
      height: size.height,
      seedHigh: seeds.seedHigh,
      seedLow: seeds.seedLow,
    };
    const useDuck = isUseDuckEncrypt();
    request.useDuckEncrypt = useDuck;
    request.password =
      useDuck && duckPasswordEl ? duckPasswordEl.value || "" : "";
    try {
      await enqueueJobsLocalOrServer([
        {
          kind: "t2i",
          refId: FIRST_FRAME_JOB_REF,
          request,
        },
      ]);
      if (firstFrameGenStatus) {
        firstFrameGenStatus.textContent = t("firstFrame.queued");
      }
      if (globalStatus) {
        globalStatus.textContent = t("firstFrame.queued");
      }
    } catch (e) {
      setFirstFrameGenBusy(false);
      const msg = (e && e.message) || String(e);
      if (firstFrameGenStatus) firstFrameGenStatus.textContent = msg;
      alert(msg);
    }
  }

  async function runFirstFrameExpand() {
    const prompt = ((firstFramePrompt && firstFramePrompt.value) || "").trim();
    if (!prompt) {
      alert(t("firstFrame.needPrompt"));
      return;
    }
    if (firstFrameGenBusy || firstFrameExpandBusy) return;
    setFirstFrameExpandBusy(true);
    if (firstFrameGenStatus) {
      firstFrameGenStatus.textContent = t("firstFrame.expanding");
    }
    try {
      const expanded = await callT2iExpand(prompt);
      if (!expanded) {
        throw new Error(t("firstFrame.expandFailed"));
      }
      if (firstFramePrompt) {
        firstFramePrompt.value = expanded;
        const lineHint = Math.min(
          12,
          Math.max(3, Math.ceil(expanded.length / 80))
        );
        firstFramePrompt.rows = lineHint;
      }
      if (firstFrameGenStatus) {
        firstFrameGenStatus.textContent = t("firstFrame.expandDone");
      }
    } catch (e) {
      const msg =
        localizeStoredLabel((e && e.message) || "") ||
        t("firstFrame.expandFailed");
      if (firstFrameGenStatus) firstFrameGenStatus.textContent = msg;
      alert(msg);
    } finally {
      setFirstFrameExpandBusy(false);
    }
  }

  async function setBrowsedAssetAsSharedStart() {
    const asset =
      (browsingAssetId != null &&
        assetLibrary.find((a) => a.id === browsingAssetId)) ||
      (lastT2iAssetId != null &&
        assetLibrary.find((a) => String(a.id) === String(lastT2iAssetId)));
    if (!asset) {
      alert(t("asset.notFound"));
      return;
    }
    await applyImageAssetToFrame(asset, "shared");
  }

  async function resolveFrameAssetUpload(asset) {
    if (!asset || !asset.playUrl) throw new Error(t("asset.notFound"));
    const name =
      asset.filename || filenameFromPlayUrl(asset.playUrl || "") || "frame.png";
    if (getVideoChannelConfig().channel !== "platform") {
      return {
        fileName: name,
        mediaFileId: asset.id || null,
        playUrl: asset.playUrl,
        origin: asset.origin === "local" ? "local" : "server",
      };
    }
    const existingRh =
      (isPlatformRhFileName(asset.rhFileName) && asset.rhFileName) ||
      (isPlatformRhFileName(asset.fileName) && asset.fileName) ||
      null;
    if (existingRh && !isLocalMediaId(asset.id)) {
      return {
        fileName: existingRh,
        mediaFileId: asset.id || null,
        playUrl: asset.playUrl,
        origin: "server",
      };
    }
    const resp = await fetch(asset.playUrl);
    const blob = await resp.blob();
    const file = new File([blob], name, { type: blob.type || "image/png" });
    const uploaded = await uploadImage(file);
    return {
      fileName: uploaded.fileName,
      mediaFileId: uploaded.mediaFileId || null,
      playUrl: uploaded.playUrl || asset.playUrl,
      origin: "server",
    };
  }

  async function applyImageAssetToFrame(asset, target = frameAssetPickTarget) {
    if (!asset) {
      alert(t("asset.notFound"));
      return;
    }
    if (!isAssetImage(asset)) {
      alert(t("asset.notImage"));
      return;
    }
    if (!target) {
      alert(t("asset.pickFrameSideFirst"));
      return;
    }
    const resolved = await resolveFrameAssetUpload(asset);
    if (target === "shared") {
      selectedFile = null;
      sharedStartRhName = resolved.fileName || null;
      sharedStartMediaId = resolved.mediaFileId || null;
      setSharedStartFromUrl(
        resolved.playUrl || asset.playUrl,
        asset.filename || filenameFromPlayUrl(asset.playUrl || "") || t("project.savedStartFrame")
      );
      mains.forEach((m) => {
        m.dirty = true;
        if (m.status === "success") {
          m.label = t("status.needsRegen");
        }
      });
      markBridgesNeedReselectForAll();
      renderAll();
    } else {
      const { bridgeId, side } = target;
      const b = bridges.find((x) => x.id === bridgeId);
      if (!b) return;
      const current = side === "start" ? b.startFrame : b.endFrame;
      revokeFrameBlob(current);
      const frame = {
        blobUrl: asset.origin === "local" ? asset.playUrl : null,
        playUrl: resolved.playUrl || asset.playUrl,
        mediaFileId: resolved.mediaFileId || null,
        rhFileName: resolved.fileName || null,
        sourceMainId: null,
        timeSec: null,
        source: "manual",
        previewUrl: null,
        linkSig: null,
        origin: resolved.origin || (asset.origin === "local" ? "local" : "server"),
      };
      if (side === "start") {
        b.startFrame = frame;
        if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
        b.linkedSig.start = linkSig(b.startLink);
      } else {
        b.endFrame = frame;
        if (!b.linkedSig) b.linkedSig = { start: "∅", end: "∅" };
        b.linkedSig.end = linkSig(b.endLink);
      }
      b.connectionStale = bridgeConnectionStale(b);
      b.needsReselect = false;
      b.dirty = true;
      b.label = b.status === "success" ? t("status.frameUpdated") : t("bins.flfClipped");
      renderFlfFramePanel(b);
      renderBridges();
      rebuildTimeline();
    }
    clearFrameAssetPick({ rerender: false });
    renderAssetLibrary();
    scheduleSaveDraft();
    setDraftStatus(t("asset.frameApplied"));
  }

  function browseAsset(asset) {
    if (!asset || !asset.playUrl) return;
    browsingAssetId = asset.id;
    stopTimelinePlayback();
    const isImage = isAssetImage(asset);
    if (isImage) {
      showPreviewImage(asset.playUrl);
      if (playlistPrompt) {
        playlistPrompt.textContent =
          asset.promptSnapshot || t("bins.assetBrowseHint");
      }
    } else if (isAssetAudio(asset)) {
      setGapBlackPreview(true);
      setPreviewSource(asset.playUrl, asset.promptSnapshot || t("bins.assetBrowseHint"), {
        load: false,
        fromAsset: true,
      });
      const gen = ++playbackGen;
      const onMeta = () => {
        playlistVideo.removeEventListener("loadedmetadata", onMeta);
        if (gen !== playbackGen) return;
        playlistVideo.play().catch(() => {});
      };
      playlistVideo.addEventListener("loadedmetadata", onMeta);
      playlistVideo.load();
    } else {
      setPreviewSource(asset.playUrl, asset.promptSnapshot || t("bins.assetBrowseHint"), {
        load: false,
        fromAsset: true,
      });
      const gen = ++playbackGen;
      const onMeta = () => {
        playlistVideo.removeEventListener("loadedmetadata", onMeta);
        if (gen !== playbackGen) return;
        playlistVideo.play().catch(() => {});
      };
      playlistVideo.addEventListener("loadedmetadata", onMeta);
      playlistVideo.load();
    }
    showAssetBrowseBar(asset);
    renderAssetLibrary();
  }

  function applyAssetToSlot(asset) {
    if (!asset) {
      alert(t("asset.notFound"));
      return;
    }
    if (isAssetImage(asset) || asset.kind === "upload") {
      alert(t("asset.uploadFrameCannotApply"));
      return;
    }
    const fillMedia = (target) => {
      target.playUrl = asset.playUrl;
      target.mediaFileId = asset.id;
      target.status = "success";
      target.label = t("asset.applied");
      target.dirty = false;
      target.durationSec = null;
      if (asset.filename || asset.promptSnapshot) {
        target.name = asset.filename || asset.promptSnapshot;
      }
    };
    if (isAssetAudio(asset)) {
      if (selectedClip && selectedClip.kind !== "audio") {
        alert(t("asset.audioVideoMismatch"));
        return;
      }
      if (selectedClip && selectedClip.kind === "audio") {
        const target = findAudio(selectedClip.id);
        if (!target) return;
        pushTimelineUndo("fill");
        fillMedia(target);
        probeClipDuration(target).then(() => {
          rebuildTimeline();
          scheduleSaveDraft();
        });
        renderAll();
        scheduleSaveDraft();
        setDraftStatus(t("topbar.draftAppliedAsset"));
        return;
      }
      pushTimelineUndo("fill");
      const trackId = ensureAudioTrack();
      const audio = emptyAudio({
        trackId,
        startSec: snapStartSec(Math.max(0, playheadSec), null, null),
      });
      fillMedia(audio);
      audios.push(audio);
      selectedClip = { kind: "audio", id: audio.id };
      probeClipDuration(audio).then(() => {
        rebuildTimeline();
        scheduleSaveDraft();
      });
      renderAll();
      scheduleSaveDraft();
      setDraftStatus(t("topbar.draftAppliedAsset"));
      return;
    }
    if (selectedClip && selectedClip.kind === "audio") {
      alert(t("asset.videoAudioMismatch"));
      return;
    }
    if (!selectedClip) {
      alert(t("asset.selectTimelineSlot"));
      return;
    }
    const target = findClip(selectedClip.kind, selectedClip.id);
    if (!target) return;
    pushTimelineUndo("fill");
    fillMedia(target);
    if (selectedClip.kind === "main") {
      markBridgesNeedReselectForMain(target.id);
    } else if (selectedClip.kind === "bridge") {
      target.needsReselect = false;
      snapshotBridgeLinkedSig(target);
    }
    probeClipDuration(target).then(() => {
      rebuildTimeline();
      scheduleSaveDraft();
    });
    renderAll();
    scheduleSaveDraft();
    setDraftStatus(t("topbar.draftAppliedAsset"));
  }

  function applyBrowsedAssetToSlot() {
    if (!browsingAssetId) {
      alert(t("asset.selectInLibrary"));
      return;
    }
    const asset = assetLibrary.find((a) => a.id === browsingAssetId);
    // Images are frames (shared start / FLF), never video-slot fills.
    if (isAssetImage(asset)) {
      const target = inferFrameAssetPickTarget();
      if (!target) {
        alert(t("asset.pickFrameSideFirst"));
        return;
      }
      applyImageAssetToFrame(asset, target).catch((err) =>
        alert(err && err.message ? err.message : String(err))
      );
      return;
    }
    applyAssetToSlot(asset);
  }

  // —— Settings + channels + LLM assist ——

  function isUseDuckEncrypt() {
    return !!(useDuckEncryptEl && useDuckEncryptEl.checked);
  }

  function loadUseDuckEncrypt() {
    try {
      const raw = localStorage.getItem(DUCK_ENCRYPT_KEY);
      // Default: false (noa / direct MP4)
      const on = raw === "1" || raw === "true";
      if (useDuckEncryptEl) useDuckEncryptEl.checked = on;
    } catch (e) {
      if (useDuckEncryptEl) useDuckEncryptEl.checked = false;
    }
    syncDuckPasswordVisibility();
    return isUseDuckEncrypt();
  }

  function saveUseDuckEncrypt(on) {
    const enabled = !!on;
    try {
      localStorage.setItem(DUCK_ENCRYPT_KEY, enabled ? "1" : "0");
    } catch (e) {
      console.warn("save duck encrypt failed", e);
    }
    if (useDuckEncryptEl) useDuckEncryptEl.checked = enabled;
    syncDuckPasswordVisibility();
  }

  function syncDuckPasswordVisibility() {
    if (!duckPasswordRow) return;
    const on = isUseDuckEncrypt();
    duckPasswordRow.classList.toggle("hidden", !on);
    if (duckPasswordEl) duckPasswordEl.disabled = !on;
  }

  function syncDuckEncryptTip() {
    const tipEl = document.getElementById("useDuckEncryptTip");
    if (!tipEl) return;
    const key = "settings.useDuckEncryptTipCustom";
    tipEl.setAttribute("data-i18n", key);
    tipEl.textContent = t(key);
  }

  function loadJsonLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed != null ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJsonLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("save local failed", key, e);
    }
  }

  function loadLlmChannel() {
    llmChannel = "custom";
    return llmChannel;
  }

  function saveLlmChannel() {
    llmChannel = "custom";
    localStorage.setItem(LLM_CHANNEL_KEY, llmChannel);
    syncLlmConfiguredFromLocal();
    updateChannelSummary();
    updateLlmButtonState();
    syncSettingsChannelPanels();
    populateLlmModelSelects();
  }

  function defaultVideoChannel() {
    return "custom_rh";
  }

  function defaultVideoChannelConfig() {
    return {
      channel: defaultVideoChannel(),
      rh: {
        baseUrl: RH_DEFAULT_BASE,
        apiKey: "",
        workflowIdI2v: "",
        workflowIdFlf: "",
        adapter: null,
      },
      comfy: {
        baseUrl: COMFY_DEFAULT_BASE,
        authHeader: "",
        adapter: null,
      },
    };
  }

  function loadVideoChannelConfig() {
    const raw = loadJsonLocal(VIDEO_CHANNEL_KEY, null);
    const base = defaultVideoChannelConfig();
    if (!raw || typeof raw !== "object") return base;
    return {
      channel:
        raw.channel === "comfyui" ? "comfyui" : "custom_rh",
      rh: { ...base.rh, ...(raw.rh || {}) },
      comfy: { ...base.comfy, ...(raw.comfy || {}) },
    };
  }

  function getVideoChannelConfig() {
    const cfg = loadVideoChannelConfig();
    videoChannel = cfg.channel;
    return cfg;
  }

  function saveVideoChannelConfig(cfg) {
    const next = cfg || readVideoChannelForm();
    videoChannel = next.channel;
    saveJsonLocal(VIDEO_CHANNEL_KEY, next);
    updateChannelSummary();
    syncSettingsChannelPanels();
    syncConfigToAgent({ rh: next.rh, comfy: next.comfy });
  }

  function syncWorkflowIdsFromAdapter(rh) {
    const adapter = rh && rh.adapter;
    const modes = adapter && adapter.modes;
    const i2v =
      (modes && modes.i2v && modes.i2v.workflowId) ||
      (rh && rh.workflowIdI2v) ||
      "";
    const flf =
      (modes && modes.flf && modes.flf.workflowId) ||
      (rh && rh.workflowIdFlf) ||
      "";
    return {
      workflowIdI2v: String(i2v || "").trim(),
      workflowIdFlf: String(flf || "").trim(),
    };
  }

  function readVideoChannelForm() {
    const channelEl = document.querySelector('input[name="videoChannel"]:checked');
    const channel = (channelEl && channelEl.value) || defaultVideoChannel();
    const prev = loadVideoChannelConfig();
    const rhAdapter = prev.rh.adapter;
    const comfyAdapter = prev.comfy.adapter;
    const rhBase = document.getElementById("rhBaseUrl");
    const rhKey = document.getElementById("rhApiKey");
    const comfyBase = document.getElementById("comfyBaseUrl");
    const comfyAuth = document.getElementById("comfyAuthHeader");
    const ids = syncWorkflowIdsFromAdapter({
      adapter: rhAdapter,
      workflowIdI2v: prev.rh.workflowIdI2v,
      workflowIdFlf: prev.rh.workflowIdFlf,
    });
    return {
      channel: channel === "comfyui" ? "comfyui" : "custom_rh",
      rh: {
        baseUrl: (rhBase && rhBase.value.trim()) || RH_DEFAULT_BASE,
        apiKey: (rhKey && rhKey.value.trim()) || "",
        workflowIdI2v: ids.workflowIdI2v,
        workflowIdFlf: ids.workflowIdFlf,
        adapter: rhAdapter,
      },
      comfy: {
        baseUrl: (comfyBase && comfyBase.value.trim()) || COMFY_DEFAULT_BASE,
        authHeader: (comfyAuth && comfyAuth.value.trim()) || "",
        adapter: comfyAdapter,
      },
    };
  }

  function fillVideoChannelForm(cfg) {
    const c = cfg || getVideoChannelConfig();
    document.querySelectorAll('input[name="videoChannel"]').forEach((el) => {
      el.checked = el.value === c.channel;
    });
    const rhBase = document.getElementById("rhBaseUrl");
    const rhKey = document.getElementById("rhApiKey");
    const comfyBase = document.getElementById("comfyBaseUrl");
    const comfyAuth = document.getElementById("comfyAuthHeader");
    if (rhBase) rhBase.value = c.rh.baseUrl || RH_DEFAULT_BASE;
    if (rhKey) rhKey.value = c.rh.apiKey || "";
    if (comfyBase) comfyBase.value = c.comfy.baseUrl || COMFY_DEFAULT_BASE;
    if (comfyAuth) comfyAuth.value = c.comfy.authHeader || "";
    syncSettingsChannelPanels();
  }

  function updateBindingPreviews() {
    /* dock drawer owns adapter preview */
  }

  function getActiveChannelAdapter(cfg) {
    const c = cfg || getVideoChannelConfig();
    if (c.channel === "comfyui") return c.comfy && c.comfy.adapter;
    if (c.channel === "custom_rh") return c.rh && c.rh.adapter;
    return null;
  }

  function setActiveChannelAdapter(adapter, cfg) {
    const c = cfg || readVideoChannelForm();
    if (c.channel === "comfyui") {
      c.comfy.adapter = adapter;
    } else {
      c.channel = c.channel === "comfyui" ? "comfyui" : "custom_rh";
      c.rh.adapter = adapter;
      const ids = syncWorkflowIdsFromAdapter(c.rh);
      c.rh.workflowIdI2v = ids.workflowIdI2v;
      c.rh.workflowIdFlf = ids.workflowIdFlf;
    }
    saveVideoChannelConfig(c);
    fillVideoChannelForm(c);
    return c;
  }

  function updateChannelSummary() {
    if (!channelSummaryEl) return;
    const v =
      videoChannel === "comfyui"
        ? t("topbar.channelVideoComfy")
        : t("topbar.channelVideoRh");
    const l = t("topbar.channelLlmCustom");
    const eng = engineDisplayName(getStoryboardEngine());
    channelSummaryEl.textContent = `${v} · ${l} · ${eng}`;
  }

  let agentConnected = false;
  let agentVersion = "";

  function setAgentUiState({ ok, version, error, checking }) {
    agentConnected = !!ok;
    agentVersion = version || "";
    const dots = document.querySelectorAll(".agent-status-dot");
    const texts = document.querySelectorAll(".agent-status-text");
    const troubles = document.querySelectorAll(".agent-troubleshoot");
    dots.forEach((el) => {
      el.classList.toggle("is-on", !!ok);
      el.classList.toggle("is-off", !ok && !checking);
      el.classList.toggle("is-checking", !!checking);
    });
    texts.forEach((el) => {
      if (checking) {
        el.textContent = t("agent.statusChecking");
      } else if (ok) {
        el.textContent = t("agent.statusOn", { version: version || "?" });
      } else {
        el.textContent = t("agent.statusOff");
      }
    });
    troubles.forEach((el) => {
      const show = !ok && !checking;
      el.classList.toggle("hidden", !show);
      if (show && error) {
        const detail = el.querySelector(".agent-troubleshoot-detail");
        if (detail) detail.textContent = error;
      }
    });
  }

  async function checkLocalAgent(opts) {
    const silent = opts && opts.silent;
    setAgentUiState({ ok: false, checking: true });
    if (!window.VflowLocal || !window.VflowLocal.checkHealth) {
      setAgentUiState({
        ok: false,
        error: t("common.localModuleMissing"),
      });
      return false;
    }
    const baseInput = document.getElementById("agentBaseUrl");
    if (baseInput && baseInput.value.trim()) {
      window.VflowLocal.setAgentBase(baseInput.value.trim());
    } else if (baseInput) {
      baseInput.value = window.VflowLocal.getAgentBase();
    }
    const h = await window.VflowLocal.checkHealth();
    setAgentUiState({
      ok: h.ok,
      version: h.version,
      error: h.error || "",
    });
    if (!silent && h.ok) {
      const st = document.getElementById("agentCheckStatus");
      if (st) st.textContent = t("agent.checkOk", { version: h.version || "?" });
    }
    return !!h.ok;
  }

  function syncConfigToAgent(partial) {
    if (!window.VflowLocal || !window.VflowLocal.syncConfig) return;
    if (!agentConnected && !(partial && partial._force)) {
      // Fire-and-forget only when likely online; checkHealth updates flag
      window.VflowLocal.checkHealth(800).then((h) => {
        if (!h.ok) return;
        agentConnected = true;
        window.VflowLocal.syncConfig(partial).catch(() => {});
      });
      return;
    }
    window.VflowLocal.syncConfig(partial).catch(() => {});
  }

  function wireLocalAgentUi() {
    const baseInput = document.getElementById("agentBaseUrl");
    if (baseInput && window.VflowLocal) {
      baseInput.value = window.VflowLocal.getAgentBase();
    }
    const btnCheck = document.getElementById("btnAgentCheck");
    if (btnCheck) {
      btnCheck.addEventListener("click", async () => {
        btnCheck.disabled = true;
        try {
          const ok = await checkLocalAgent();
          if (ok) {
            const vcfg = loadVideoChannelConfig();
            try {
              await window.VflowLocal.syncConfig({
                rh: vcfg.rh,
                comfy: vcfg.comfy,
                llm: getLlmRequestConfig(),
              });
            } catch (e) {
              /* ignore sync errors after connect */
            }
          }
        } finally {
          btnCheck.disabled = false;
        }
      });
    }
    const btnCopy = document.getElementById("btnAgentCopyCmd");
    if (btnCopy) {
      btnCopy.addEventListener("click", async () => {
        const cmd = t("agent.startCommand");
        try {
          await navigator.clipboard.writeText(cmd);
          const st = document.getElementById("agentCheckStatus");
          if (st) st.textContent = t("agent.cmdCopied");
        } catch (e) {
          prompt(t("agent.copyManual"), cmd);
        }
      });
    }
    // Assets directory picker
    const assetsDirInput = document.getElementById("agentAssetsDir");
    const btnSetDir = document.getElementById("btnSetAssetsDir");
    const dirStatus = document.getElementById("assetsDirStatus");
    if (assetsDirInput && window.VflowLocal) {
      // Load current value on connect
      window.VflowLocal.checkHealth(1500).then((h) => {
        if (!h.ok) return;
        window.VflowLocal.getAssetsDir().then((dir) => {
          if (dir) assetsDirInput.value = dir;
        }).catch(() => {});
      });
    }
    if (btnSetDir) {
      btnSetDir.addEventListener("click", async () => {
        if (!window.VflowLocal) return;
        const dir = (assetsDirInput && assetsDirInput.value || "").trim();
        if (!dir) { if (dirStatus) dirStatus.textContent = t("agent.assetsDirEmpty"); return; }
        btnSetDir.disabled = true;
        try {
          const saved = await window.VflowLocal.setAssetsDir(dir);
          if (dirStatus) dirStatus.textContent = t("agent.assetsDirOk", { dir: saved || dir });
        } catch (e) {
          if (dirStatus) dirStatus.textContent = e.message || t("agent.assetsDirFail");
        } finally {
          btnSetDir.disabled = false;
        }
      });
    }
    setAgentUiState({ ok: false });
  }

  function syncSettingsChannelPanels() {
    const llmCust = document.getElementById("llmChannelCustom");
    if (llmCust) llmCust.classList.remove("hidden");
    const needsAgent = true;
    const agentBar = document.getElementById("agentStatusBar");
    if (agentBar) agentBar.classList.toggle("hidden", !needsAgent);
    const addFeat = document.getElementById("btnFeatureAddToggle");
    if (addFeat) {
      addFeat.disabled = false;
      addFeat.classList.remove("hidden");
    }
    syncDuckEncryptTip();
  }

  function setSettingsTab(tab) {
    const resolved =
      tab === "video" || tab === "editors" ? "workflows" : tab || "workflows";
    if (typeof closeWorkflowDock === "function") closeWorkflowDock();
    document.querySelectorAll(".settings-tab").forEach((btn) => {
      const on = btn.getAttribute("data-settings-tab") === resolved;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.classList.toggle(
        "hidden",
        pane.getAttribute("data-pane") !== resolved
      );
    });
    syncSettingsChannelPanels();
    if (resolved === "workflows") {
      renderWorkflowTables();
    }
    if (resolved === "agent") {
      checkLocalAgent({ silent: true }).catch(() => {});
    }
  }

  let pendingEditorWorkflow = null;
  let editingUserEditorId = null;
  let pendingDockWorkflow = null;
  let pendingDockParams = [];
  let dockTarget = null; // { kind: 'feature'|'engine'|'editor', id?, slot? }
  let editingUserEngineId = null;
  let pendingEngineSlots = { main: null, bridge: null };

  function categoryLabel(cat) {
    const key = `editor.category.${cat || "custom"}`;
    const label = t(key);
    return label === key ? cat || "custom" : label;
  }

  function statusBadgeHtml(status) {
    return `<span class="editor-catalog-badge ${escapeHtml(
      status.className || ""
    )}">${escapeHtml(t(status.key))}</span>`;
  }

  function renderFeaturesWorkflowTable() {
    const body = document.getElementById("featuresWorkflowBody");
    const F = window.VflowFeatures;
    if (!body || !F) return;
    if (window.VflowEditors && platformEditorsCache.length) {
      window.VflowEditors.setPlatformEditors(platformEditorsCache);
    }
    const cfg = getVideoChannelConfig();
    const adapter = getActiveChannelAdapter(cfg);
    const features = F.listFeatures().filter(
      (feat) => feat.id === "t2i" || !feat.builtin
    );
    if (!features.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(
        t("workflow.featuresEmpty")
      )}</td></tr>`;
      return;
    }
    body.innerHTML = features
      .map((feat) => {
        const status = F.featureStatus(feat, cfg.channel, adapter);
        const name = F.displayName(feat);
        const typeLabel = feat.builtin
          ? t("workflow.typeBuiltin")
          : t("workflow.typeCustom");
        const provider = F.providerLabel(cfg.channel);
        const readonly = !!status.readonly || !!status.disabled;
        const actions = [];
        if (!readonly && cfg.channel !== "platform") {
          actions.push(
            `<button type="button" class="btn btn-ghost btn-sm" data-act="dock-feature" data-feature-id="${escapeHtml(
              feat.id
            )}">${escapeHtml(
              status.key === "workflow.statusDocked"
                ? t("workflow.redock")
                : t("workflow.dock")
            )}</button>`
          );
          if (status.key === "workflow.statusDocked") {
            actions.push(
              `<button type="button" class="btn btn-ghost btn-sm" data-act="clear-feature" data-feature-id="${escapeHtml(
                feat.id
              )}">${escapeHtml(t("workflow.clearDock"))}</button>`
            );
          }
        }
        if (!feat.builtin) {
          actions.push(
            `<button type="button" class="btn btn-ghost btn-sm" data-act="delete-feature" data-feature-id="${escapeHtml(
              feat.id
            )}">${escapeHtml(t("common.delete"))}</button>`
          );
        }
        return `<tr data-feature-id="${escapeHtml(feat.id)}">
          <td><strong>${escapeHtml(name)}</strong>
            <div class="muted workflow-row-meta">${escapeHtml(feat.id)}</div>
          </td>
          <td>${escapeHtml(typeLabel)}</td>
          <td>${escapeHtml(provider)}</td>
          <td>${statusBadgeHtml(status)}</td>
          <td class="workflow-actions">${actions.join(" ") || "—"}</td>
        </tr>`;
      })
      .join("");
  }

  function renderEditorsWorkflowTable() {
    const body = document.getElementById("editorsWorkflowBody");
    const E = window.VflowEditors;
    const users = E ? E.getUserEditors() : [];
    if (!body) return;
    if (!users.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(
        t("editor.mineEmpty")
      )}</td></tr>`;
      return;
    }
    body.innerHTML = users
      .map((ed) => {
        const name = E ? E.displayName(ed) : ed.name || ed.id;
        const enabled = ed.enabled !== false;
        const docked =
          ed.adapter &&
          ed.adapter.bindings &&
          Object.keys(ed.adapter.bindings).length;
        const conf = docked
          ? { key: "workflow.statusDocked", className: "is-ok" }
          : { key: "workflow.statusUndocked", className: "is-warn" };
        const provider =
          ed.provider === "comfyui"
            ? t("editor.providerComfy")
            : t("editor.providerRh");
        return `<tr data-user-editor-id="${escapeHtml(ed.id)}">
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>${escapeHtml(categoryLabel(ed.category))}</td>
        <td>${escapeHtml(provider)}</td>
        <td>${statusBadgeHtml(conf)}</td>
        <td class="workflow-actions">
          <label class="channel-option editor-enable-toggle">
            <input type="checkbox" data-act="toggle-enabled" ${
              enabled ? "checked" : ""
            } />
            <span>${escapeHtml(t("editor.enabled"))}</span>
          </label>
          <button type="button" class="btn btn-ghost btn-sm" data-act="edit-user">${escapeHtml(
            t("editor.editBtn")
          )}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="delete-user">${escapeHtml(
            t("common.delete")
          )}</button>
        </td>
      </tr>`;
      })
      .join("");
  }

  function renderUserEnginesTable() {
    const body = document.getElementById("userEnginesBody");
    const U = window.VflowUserEngines;
    if (!body || !U) return;
    const list = U.list();
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(
        t("engine.mineEmpty")
      )}</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((eng) => {
        const dock = U.dockStatus(eng);
        const status = dock.main
          ? { key: "workflow.statusDocked", className: "is-ok" }
          : { key: "workflow.statusUndocked", className: "is-warn" };
        const provider =
          eng.provider === "comfyui"
            ? t("editor.providerComfy")
            : t("editor.providerRh");
        const dockHint =
          (dock.main ? t("engine.slotMain") : "—") +
          " / " +
          (dock.bridge ? t("engine.slotBridge") : "—");
        return `<tr data-user-engine-id="${escapeHtml(eng.id)}">
          <td><strong>${escapeHtml(eng.name)}</strong>
            <div class="muted workflow-row-meta">${escapeHtml(dockHint)}</div>
          </td>
          <td>${escapeHtml(U.capabilitySummary(eng))}</td>
          <td>${escapeHtml(provider)}</td>
          <td>${statusBadgeHtml(status)}</td>
          <td class="workflow-actions">
            <label class="channel-option editor-enable-toggle">
              <input type="checkbox" data-act="toggle-engine" ${
                eng.enabled !== false ? "checked" : ""
              } />
              <span>${escapeHtml(t("editor.enabled"))}</span>
            </label>
            <button type="button" class="btn btn-ghost btn-sm" data-act="dock-engine-main">${escapeHtml(
              t("engine.dockMain")
            )}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="dock-engine-bridge">${escapeHtml(
              t("engine.dockBridge")
            )}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="edit-engine">${escapeHtml(
              t("editor.editBtn")
            )}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="delete-engine">${escapeHtml(
              t("common.delete")
            )}</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderWorkflowTables() {
    renderUserEnginesTable();
    renderFeaturesWorkflowTable();
    renderEditorsWorkflowTable();
    syncEditorProviderRows();
    fillEngineSelects();
  }

  function renderEditorsSettings() {
    renderWorkflowTables();
  }

  function syncEditorProviderRows() {
    const providerEl = document.getElementById("editorProvider");
    const rhRow = document.getElementById("editorRhWorkflowRow");
    if (!providerEl || !rhRow) return;
    rhRow.classList.toggle("hidden", providerEl.value !== "runninghub");
  }

  function showWorkflowDockDrawer() {
    const drawer = document.getElementById("workflowDockDrawer");
    if (!drawer) return;
    drawer.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
  }

  function updateEditorDockStatus() {
    const st = document.getElementById("editorDockStatus");
    if (!st) return;
    if (
      pendingEditorWorkflow ||
      (pendingEditorBindings && Object.keys(pendingEditorBindings).length)
    ) {
      st.textContent = t("editor.dockStatusReady");
    } else {
      st.textContent = t("editor.dockStatusEmpty");
    }
  }

  function closeWorkflowDock() {
    dockTarget = null;
    pendingDockWorkflow = null;
    pendingDockParams = [];
    const drawer = document.getElementById("workflowDockDrawer");
    if (drawer) {
      drawer.classList.add("hidden");
      drawer.setAttribute("aria-hidden", "true");
    }
    const st = document.getElementById("dockAdapterStatus");
    const ta = document.getElementById("dockAdapterJson");
    const wid = document.getElementById("dockWorkflowId");
    if (st) st.textContent = "";
    if (ta) ta.value = "";
    if (wid) wid.value = "";
    renderParamsVisibilityList(
      document.getElementById("dockParamsVisibility"),
      []
    );
  }

  function openFeatureDock(featureId) {
    const F = window.VflowFeatures;
    const feature = F && F.getFeature(featureId);
    if (!feature) return;
    const cfg = getVideoChannelConfig();
    if (cfg.channel === "platform") {
      alert(t("workflow.platformReadonly"));
      return;
    }
    showEditorAddForm(false);
    showEngineAddForm(false);
    const form = document.getElementById("featureAddForm");
    if (form) form.classList.add("hidden");
    dockTarget = { kind: "feature", id: feature.id };
    pendingDockWorkflow = null;
    pendingDockParams = [];
    const title = document.getElementById("workflowDockTitle");
    const hint = document.getElementById("workflowDockHint");
    const rhRow = document.getElementById("dockRhWorkflowRow");
    const wid = document.getElementById("dockWorkflowId");
    const ta = document.getElementById("dockAdapterJson");
    const st = document.getElementById("dockAdapterStatus");
    if (title) {
      title.textContent = t("workflow.dockTitleNamed", {
        name: F.displayName(feature),
      });
    }
    if (hint) hint.textContent = t("workflow.dockHint");
    const provider = cfg.channel === "comfyui" ? "comfyui" : "runninghub";
    if (rhRow) rhRow.classList.toggle("hidden", provider !== "runninghub");
    const adapter = getActiveChannelAdapter(cfg);
    const mode =
      adapter && adapter.modes && adapter.modes[feature.id]
        ? adapter.modes[feature.id]
        : null;
    if (wid) wid.value = (mode && mode.workflowId) || "";
    if (mode) {
      pendingDockParams = mode.params || [];
      if (mode.workflowUi || mode.workflow) {
        pendingDockWorkflow = mode.workflowUi || mode.workflow;
      }
      if (ta) {
        ta.value = JSON.stringify(
          {
            version: 1,
            provider,
            name: (adapter && adapter.name) || "",
            modes: { [feature.id]: mode },
          },
          null,
          2
        );
      }
    } else if (ta) {
      ta.value = "";
    }
    renderParamsVisibilityList(
      document.getElementById("dockParamsVisibility"),
      pendingDockParams
    );
    if (st) st.textContent = "";
    showWorkflowDockDrawer();
  }

  function clearFeatureDock(featureId) {
    const cfg = readVideoChannelForm();
    const adapter = getActiveChannelAdapter(cfg);
    if (!adapter || !adapter.modes || !adapter.modes[featureId]) return;
    const next = {
      ...adapter,
      modes: { ...adapter.modes },
    };
    delete next.modes[featureId];
    setActiveChannelAdapter(next, cfg);
    closeWorkflowDock();
    renderWorkflowTables();
  }

  function showEngineAddForm(show) {
    const form = document.getElementById("engineAddForm");
    if (!form) return;
    form.classList.toggle("hidden", !show);
    const toggle = document.getElementById("btnEngineAddToggle");
    if (toggle) toggle.classList.toggle("hidden", !!show);
    if (show) {
      closeWorkflowDock();
      showEditorAddForm(false);
      showFeatureAddForm(false);
    }
  }

  function setEngineFormValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value == null ? "" : String(value);
  }

  function getEngineTimingModeFromForm() {
    const checked = document.querySelector(
      'input[name="engineTimingMode"]:checked'
    );
    const mode = checked && checked.value === "duration" ? "duration" : "frames";
    return mode;
  }

  function setEngineTimingModeOnForm(mode) {
    const want = mode === "duration" ? "duration" : "frames";
    document.querySelectorAll('input[name="engineTimingMode"]').forEach((el) => {
      el.checked = el.value === want;
    });
  }

  function resetEngineAddForm() {
    editingUserEngineId = null;
    pendingEngineSlots = { main: null, bridge: null };
    setEngineFormValue("engineName", "");
    setEngineFormValue("engineProvider", "runninghub");
    setEngineTimingModeOnForm("frames");
    const st = document.getElementById("engineSaveStatus");
    if (st) st.textContent = "";
    syncEngineDockPreview();
  }

  function fillEngineAddForm(eng) {
    if (!eng) return;
    editingUserEngineId = eng.id;
    pendingEngineSlots = {
      main: eng.main || null,
      bridge: eng.bridge || null,
    };
    setEngineFormValue("engineName", eng.name || "");
    setEngineFormValue("engineProvider", eng.provider || "runninghub");
    const U = window.VflowUserEngines;
    const mode =
      U && typeof U.detectTimingMode === "function"
        ? U.detectTimingMode(eng)
        : eng.usesDurationSeconds
          ? "duration"
          : "frames";
    setEngineTimingModeOnForm(mode);
    syncEngineDockPreview();
    showEngineAddForm(true);
  }

  function readEngineAddForm() {
    const U = window.VflowUserEngines;
    const mode = getEngineTimingModeFromForm();
    const caps =
      U && typeof U.capsForTimingMode === "function"
        ? U.capsForTimingMode(mode)
        : (U && U.defaultCaps()) || {};
    return {
      id: editingUserEngineId || (U && U.uid ? U.uid() : undefined),
      name: ((document.getElementById("engineName") || {}).value || "").trim(),
      provider:
        ((document.getElementById("engineProvider") || {}).value || "runninghub"),
      enabled: true,
      timingMode: caps.timingMode || mode,
      mainMinSec: caps.mainMinSec,
      mainMaxSec: caps.mainMaxSec,
      mainDefaultSec: caps.mainDefaultSec,
      bridgeMinSec: caps.bridgeMinSec,
      bridgeMaxSec: caps.bridgeMaxSec,
      bridgeDefaultSec: caps.bridgeDefaultSec,
      softChainUnitSec: caps.softChainUnitSec,
      defaultFps: caps.defaultFps,
      nativeFps: caps.nativeFps,
      defaultLength: caps.defaultLength,
      maxRefImages: caps.maxRefImages || 0,
      maxRefVideos: caps.maxRefVideos || 0,
      maxRefAudios: caps.maxRefAudios || 0,
      durationChoices: caps.durationChoices,
      usesDurationSeconds: !!caps.usesDurationSeconds,
      supportsMultiRef: !!caps.supportsMultiRef,
      allowAudioInPrompt: !!caps.allowAudioInPrompt,
      allowTimedBeats: !!caps.allowTimedBeats,
      main: pendingEngineSlots.main,
      bridge: pendingEngineSlots.bridge,
    };
  }

  function syncEngineDockPreview() {
    const el = document.getElementById("engineDockPreview");
    const U = window.VflowUserEngines;
    if (!el || !U) return;
    const provider =
      ((document.getElementById("engineProvider") || {}).value || "runninghub");
    const mainOk = U.slotConfigured(pendingEngineSlots.main, provider);
    const bridgeOk = U.slotConfigured(pendingEngineSlots.bridge, provider);
    el.textContent =
      t("engine.slotMain") +
      " " +
      (mainOk ? t("workflow.statusDocked") : t("workflow.statusUndocked")) +
      " · " +
      t("engine.slotBridge") +
      " " +
      (bridgeOk ? t("workflow.statusDocked") : t("workflow.statusUndocked"));
  }

  function persistEngineDraftForDock() {
    const U = window.VflowUserEngines;
    if (!U) throw new Error(t("common.localModuleMissing"));
    const draft = readEngineAddForm();
    if (!draft.name) throw new Error(t("engine.needName"));
    const saved = U.upsert(draft);
    editingUserEngineId = saved.id;
    pendingEngineSlots = { main: saved.main, bridge: saved.bridge };
    refreshTimingAfterEngineCapsChange(saved.id);
    return saved;
  }

  function openEngineDock(engineId, slot) {
    const U = window.VflowUserEngines;
    if (!U) return;
    let id = engineId;
    if (!id) {
      try {
        id = persistEngineDraftForDock().id;
      } catch (e) {
        alert(e.message || String(e));
        return;
      }
    }
    const eng = U.get(id);
    if (!eng) return;
    showEditorAddForm(false);
    const form = document.getElementById("featureAddForm");
    if (form) form.classList.add("hidden");
    dockTarget = { kind: "engine", id: eng.id, slot: slot === "bridge" ? "bridge" : "main" };
    pendingDockWorkflow = null;
    pendingDockParams = [];
    const title = document.getElementById("workflowDockTitle");
    const hint = document.getElementById("workflowDockHint");
    const rhRow = document.getElementById("dockRhWorkflowRow");
    const wid = document.getElementById("dockWorkflowId");
    const ta = document.getElementById("dockAdapterJson");
    const st = document.getElementById("dockAdapterStatus");
    const slotCfg = slot === "bridge" ? eng.bridge : eng.main;
    if (title) {
      title.textContent = t("engine.dockTitleNamed", {
        name: eng.name,
        slot: slot === "bridge" ? t("engine.slotBridge") : t("engine.slotMain"),
      });
    }
    if (hint) hint.textContent = t("workflow.dockHint");
    if (rhRow) rhRow.classList.toggle("hidden", eng.provider !== "runninghub");
    if (wid) wid.value = (slotCfg && slotCfg.workflowId) || "";
    if (slotCfg && (slotCfg.bindings || slotCfg.workflow || slotCfg.workflowUi)) {
      pendingDockParams = slotCfg.params || [];
      pendingDockWorkflow = slotCfg.workflowUi || slotCfg.workflow || null;
      if (ta) {
        ta.value = JSON.stringify(
          {
            version: 1,
            provider: eng.provider,
            name: eng.name,
            modes: {
              [slot === "bridge" ? "flf" : "i2v"]: slotCfg,
            },
          },
          null,
          2
        );
      }
    } else if (ta) {
      ta.value = "";
    }
    renderParamsVisibilityList(
      document.getElementById("dockParamsVisibility"),
      pendingDockParams
    );
    if (st) st.textContent = "";
    showWorkflowDockDrawer();
  }

  function openEditorDock() {
    const form = document.getElementById("editorAddForm");
    if (form) form.classList.remove("hidden");
    const toggle = document.getElementById("btnEditorAddToggle");
    if (toggle) toggle.classList.add("hidden");
    const engineForm = document.getElementById("engineAddForm");
    if (engineForm) engineForm.classList.add("hidden");
    const engineToggle = document.getElementById("btnEngineAddToggle");
    if (engineToggle) engineToggle.classList.remove("hidden");
    const featureForm = document.getElementById("featureAddForm");
    if (featureForm) featureForm.classList.add("hidden");
    const featureToggle = document.getElementById("btnFeatureAddToggle");
    if (featureToggle) {
      const vCh =
        (document.querySelector('input[name="videoChannel"]:checked') || {})
          .value || videoChannel;
      featureToggle.classList.toggle("hidden", vCh === "platform");
    }
    const providerEl = document.getElementById("editorProvider");
    const provider =
      (providerEl && providerEl.value) || "runninghub";
    const name =
      ((document.getElementById("editorName") || {}).value || "").trim() ||
      t("editor.untitled");
    dockTarget = { kind: "editor", id: editingUserEditorId || null };
    pendingDockWorkflow = pendingEditorWorkflow;
    pendingDockParams = Array.isArray(pendingEditorParams)
      ? pendingEditorParams.slice()
      : [];
    const title = document.getElementById("workflowDockTitle");
    const hint = document.getElementById("workflowDockHint");
    const rhRow = document.getElementById("dockRhWorkflowRow");
    const wid = document.getElementById("dockWorkflowId");
    const ta = document.getElementById("dockAdapterJson");
    const st = document.getElementById("dockAdapterStatus");
    if (title) {
      title.textContent = t("workflow.dockTitleNamed", { name });
    }
    if (hint) hint.textContent = t("editor.dockHint");
    if (rhRow) rhRow.classList.add("hidden");
    if (wid) {
      wid.value =
        ((document.getElementById("editorWorkflowId") || {}).value || "").trim();
    }
    if (ta) {
      ta.value = JSON.stringify(
        {
          workflowId:
            ((document.getElementById("editorWorkflowId") || {}).value || "").trim(),
          bindings: pendingEditorBindings || {},
          params: pendingDockParams,
          hasWorkflow: !!pendingDockWorkflow,
          provider,
        },
        null,
        2
      );
    }
    renderParamsVisibilityList(
      document.getElementById("dockParamsVisibility"),
      pendingDockParams
    );
    if (st) st.textContent = "";
    updateEditorDockStatus();
    showWorkflowDockDrawer();
  }

  function applyEditorDetectResult(manifest, statusKey) {
    const st = document.getElementById("dockAdapterStatus");
    const ta = document.getElementById("dockAdapterJson");
    const draft = readEditorAddForm();
    pendingEditorWorkflow =
      (manifest.adapter &&
        (manifest.adapter.workflowUi || manifest.adapter.workflow)) ||
      pendingEditorWorkflow;
    pendingDockWorkflow = pendingEditorWorkflow;
    let params = Array.isArray(manifest.params) ? manifest.params : [];
    const W = window.VflowAdapter;
    const bindings =
      (manifest.adapter && manifest.adapter.bindings) || {};
    if (
      pendingEditorWorkflow &&
      W &&
      typeof W.fillParamDefaultsFromWorkflow === "function"
    ) {
      params = W.fillParamDefaultsFromWorkflow(
        params,
        bindings,
        pendingEditorWorkflow
      );
    }
    pendingEditorParams = params;
    pendingDockParams = params;
    pendingEditorBindings = bindings;
    if (manifest.adapter) {
      manifest.adapter.bindings = bindings;
    }
    manifest.params = params;
    if (ta) {
      ta.value = JSON.stringify(
        {
          workflowId:
            (manifest.adapter && manifest.adapter.workflowId) ||
            draft.adapter.workflowId ||
            "",
          bindings,
          params: pendingEditorParams,
          hasWorkflow: !!(
            manifest.adapter &&
            (manifest.adapter.workflow || manifest.adapter.workflowUi)
          ),
          provider: draft.provider,
        },
        null,
        2
      );
    }
    const nameEl = document.getElementById("editorName");
    if (nameEl && !nameEl.value.trim()) {
      nameEl.value = manifest.name || "";
    }
    const inputEl = document.getElementById("editorInput");
    const outputEl = document.getElementById("editorOutput");
    if (inputEl && manifest.input) inputEl.value = manifest.input;
    if (outputEl && manifest.output) outputEl.value = manifest.output;
    if (Array.isArray(manifest.accepts)) {
      const af = document.getElementById("editorAcceptFrame");
      const ar = document.getElementById("editorAcceptRange");
      const ac = document.getElementById("editorAcceptClip");
      if (af) af.checked = manifest.accepts.includes("frame");
      if (ar) ar.checked = manifest.accepts.includes("range");
      if (ac) ac.checked = manifest.accepts.includes("clip");
    }
    renderParamsVisibilityList(
      document.getElementById("dockParamsVisibility"),
      pendingEditorParams
    );
    if (st) st.textContent = t(statusKey);
    updateEditorDockStatus();
  }

  function showEditorAddForm(show) {
    const form = document.getElementById("editorAddForm");
    if (!form) return;
    form.classList.toggle("hidden", !show);
    const toggle = document.getElementById("btnEditorAddToggle");
    if (toggle) toggle.classList.toggle("hidden", !!show);
    if (show) {
      closeWorkflowDock();
      showEngineAddForm(false);
      updateEditorDockStatus();
    }
  }

  function showFeatureAddForm(show) {
    const form = document.getElementById("featureAddForm");
    if (!form) return;
    form.classList.toggle("hidden", !show);
    const toggle = document.getElementById("btnFeatureAddToggle");
    if (toggle) {
      const vCh =
        (document.querySelector('input[name="videoChannel"]:checked') || {})
          .value || videoChannel;
      toggle.classList.toggle("hidden", !!show || vCh === "platform");
    }
    if (show) {
      closeWorkflowDock();
      showEditorAddForm(false);
      showEngineAddForm(false);
    }
  }

  function resetFeatureAddForm() {
    const idEl = document.getElementById("featureId");
    const nameEl = document.getElementById("featureName");
    const descEl = document.getElementById("featureDesc");
    const st = document.getElementById("featureSaveStatus");
    if (idEl) idEl.value = "";
    if (nameEl) nameEl.value = "";
    if (descEl) descEl.value = "";
    if (st) st.textContent = "";
    document.querySelectorAll('input[name="featureBind"]').forEach((el) => {
      el.checked = el.value === "startImage" || el.value === "prompt";
    });
  }

  function resetEditorAddForm() {
    editingUserEditorId = null;
    pendingEditorWorkflow = null;
    pendingEditorParams = [];
    pendingEditorBindings = {};
    const nameEl = document.getElementById("editorName");
    const providerEl = document.getElementById("editorProvider");
    const categoryEl = document.getElementById("editorCategory");
    const inputEl = document.getElementById("editorInput");
    const outputEl = document.getElementById("editorOutput");
    const widEl = document.getElementById("editorWorkflowId");
    const saveSt = document.getElementById("editorSaveStatus");
    if (nameEl) nameEl.value = "";
    if (providerEl) providerEl.value = "runninghub";
    if (categoryEl) categoryEl.value = "custom";
    if (inputEl) inputEl.value = "image";
    if (outputEl) outputEl.value = "video";
    if (widEl) widEl.value = "";
    if (saveSt) saveSt.textContent = "";
    const af = document.getElementById("editorAcceptFrame");
    const ar = document.getElementById("editorAcceptRange");
    const ac = document.getElementById("editorAcceptClip");
    if (af) af.checked = true;
    if (ar) ar.checked = true;
    if (ac) ac.checked = true;
    syncEditorProviderRows();
    updateEditorDockStatus();
  }

  function fillEditorAddForm(manifest) {
    if (!manifest) return;
    editingUserEditorId = manifest.id || null;
    pendingEditorWorkflow =
      (manifest.adapter &&
        (manifest.adapter.workflowUi || manifest.adapter.workflow)) ||
      null;
    pendingEditorParams = Array.isArray(manifest.params)
      ? manifest.params
      : [];
    pendingEditorBindings =
      (manifest.adapter && manifest.adapter.bindings) || {};
    const nameEl = document.getElementById("editorName");
    const providerEl = document.getElementById("editorProvider");
    const categoryEl = document.getElementById("editorCategory");
    const inputEl = document.getElementById("editorInput");
    const outputEl = document.getElementById("editorOutput");
    const widEl = document.getElementById("editorWorkflowId");
    if (nameEl) nameEl.value = manifest.name || "";
    if (providerEl) providerEl.value = manifest.provider || "runninghub";
    if (categoryEl) categoryEl.value = manifest.category || "custom";
    if (inputEl) inputEl.value = manifest.input || "image";
    if (outputEl) outputEl.value = manifest.output || "video";
    if (widEl)
      widEl.value =
        (manifest.adapter && manifest.adapter.workflowId) || "";
    const accepts = new Set(manifest.accepts || []);
    const af = document.getElementById("editorAcceptFrame");
    const ar = document.getElementById("editorAcceptRange");
    const ac = document.getElementById("editorAcceptClip");
    if (af) af.checked = accepts.has("frame");
    if (ar) ar.checked = accepts.has("range");
    if (ac) ac.checked = accepts.has("clip");
    syncEditorProviderRows();
    updateEditorDockStatus();
    showEditorAddForm(true);
  }

  function deriveEditorNeedsFlags(bindings, params) {
    const list = Array.isArray(params) ? params : [];
    const b = bindings && typeof bindings === "object" ? bindings : {};
    const needsPrompt =
      !!b.prompt ||
      list.some(
        (p) =>
          p &&
          (String(p.type || "") === "prompt" ||
            String(p.bind || "") === "prompt")
      );
    const needsAudio =
      !!b.inputAudio ||
      list.some((p) => p && String(p.type || "") === "audio");
    return { needsPrompt, needsAudio };
  }

  function readEditorAddForm() {
    const name =
      (document.getElementById("editorName") || {}).value || "";
    const provider =
      (document.getElementById("editorProvider") || {}).value || "runninghub";
    const input =
      (document.getElementById("editorInput") || {}).value || "image";
    const output =
      (document.getElementById("editorOutput") || {}).value || "video";
    const category =
      (document.getElementById("editorCategory") || {}).value || "custom";
    const workflowId =
      (document.getElementById("editorWorkflowId") || {}).value || "";
    const accepts = [];
    if ((document.getElementById("editorAcceptFrame") || {}).checked)
      accepts.push("frame");
    if ((document.getElementById("editorAcceptRange") || {}).checked)
      accepts.push("range");
    if ((document.getElementById("editorAcceptClip") || {}).checked)
      accepts.push("clip");

    let bindings =
      pendingEditorBindings && typeof pendingEditorBindings === "object"
        ? pendingEditorBindings
        : {};
    let workflow = pendingEditorWorkflow;
    const params = Array.isArray(pendingEditorParams)
      ? pendingEditorParams
      : [];
    pendingEditorParams = params;
    const { needsPrompt, needsAudio } = deriveEditorNeedsFlags(
      bindings,
      params
    );
    const W = window.VflowAdapter;
    let workflowUi = null;
    let workflowApi = workflow;
    if (workflow && W) {
      if (W.isComfyUiWorkflow(workflow)) {
        workflowUi = workflow;
        workflowApi = W.uiWorkflowToApiPrompt(workflow);
      } else {
        workflowApi = W.normalizeWorkflowGraph(workflow) || workflow;
      }
    }

    return {
      id: editingUserEditorId || undefined,
      name: name.trim(),
      provider,
      input,
      output,
      accepts,
      needsPrompt,
      needsAudio,
      params,
      enabled: true,
      category,
      adapter: {
        workflowId: workflowId.trim(),
        workflowUi,
        workflow: workflowApi,
        bindings,
      },
    };
  }

  function wireEditorsSettingsUi() {
    const btnEngineToggle = document.getElementById("btnEngineAddToggle");
    if (btnEngineToggle) {
      btnEngineToggle.addEventListener("click", () => {
        resetEngineAddForm();
        showEngineAddForm(true);
      });
    }
    const btnEngineCancel = document.getElementById("btnEngineCancel");
    if (btnEngineCancel) {
      btnEngineCancel.addEventListener("click", () => {
        resetEngineAddForm();
        showEngineAddForm(false);
      });
    }
    const btnEngineSave = document.getElementById("btnEngineSave");
    if (btnEngineSave) {
      btnEngineSave.addEventListener("click", () => {
        const U = window.VflowUserEngines;
        const st = document.getElementById("engineSaveStatus");
        if (!U) return;
        try {
          const saved = U.upsert(readEngineAddForm());
          editingUserEngineId = saved.id;
          pendingEngineSlots = { main: saved.main, bridge: saved.bridge };
          if (st) st.textContent = t("engine.saved");
          renderWorkflowTables();
          fillEngineSelects();
          syncStoryboardEngineUi();
          refreshTimingAfterEngineCapsChange(saved.id);
        } catch (e) {
          if (st) st.textContent = e.message || String(e);
          alert(e.message || String(e));
        }
      });
    }
    const btnDockMain = document.getElementById("btnEngineDockMain");
    if (btnDockMain) {
      btnDockMain.addEventListener("click", () => openEngineDock(editingUserEngineId, "main"));
    }
    const btnDockBridge = document.getElementById("btnEngineDockBridge");
    if (btnDockBridge) {
      btnDockBridge.addEventListener("click", () =>
        openEngineDock(editingUserEngineId, "bridge")
      );
    }
    const enginesBody = document.getElementById("userEnginesBody");
    if (enginesBody) {
      enginesBody.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-act]");
        if (!btn) return;
        const row = btn.closest("[data-user-engine-id]");
        const id = row && row.getAttribute("data-user-engine-id");
        const U = window.VflowUserEngines;
        if (!U || !id) return;
        const act = btn.getAttribute("data-act");
        if (act === "edit-engine") {
          fillEngineAddForm(U.get(id));
          return;
        }
        if (act === "delete-engine") {
          if (!confirm(t("engine.confirmDelete"))) return;
          U.remove(id);
          if (editingUserEngineId === id) {
            resetEngineAddForm();
            showEngineAddForm(false);
          }
          if (normalizeEngineId(storyboardEngineProfile) === id) {
            applyStoryboardEngineProfile("wan");
          }
          renderWorkflowTables();
          fillEngineSelects();
          return;
        }
        if (act === "dock-engine-main") {
          openEngineDock(id, "main");
          return;
        }
        if (act === "dock-engine-bridge") {
          openEngineDock(id, "bridge");
        }
      });
      enginesBody.addEventListener("change", (ev) => {
        const input = ev.target;
        if (!input || input.getAttribute("data-act") !== "toggle-engine") return;
        const row = input.closest("[data-user-engine-id]");
        const id = row && row.getAttribute("data-user-engine-id");
        const U = window.VflowUserEngines;
        if (!U || !id) return;
        U.setEnabled(id, !!input.checked);
        fillEngineSelects();
        renderUserEnginesTable();
      });
    }
    const btnToggle = document.getElementById("btnEditorAddToggle");
    if (btnToggle) {
      btnToggle.addEventListener("click", () => {
        resetEditorAddForm();
        showEditorAddForm(true);
      });
    }
    const btnCancel = document.getElementById("btnEditorCancel");
    if (btnCancel) {
      btnCancel.addEventListener("click", () => {
        resetEditorAddForm();
        showEditorAddForm(false);
      });
    }
    const providerEl = document.getElementById("editorProvider");
    if (providerEl) {
      providerEl.addEventListener("change", syncEditorProviderRows);
    }
    const btnEditorDock = document.getElementById("btnEditorDock");
    if (btnEditorDock) {
      btnEditorDock.addEventListener("click", () => openEditorDock());
    }
    const btnSave = document.getElementById("btnEditorSave");
    if (btnSave) {
      btnSave.addEventListener("click", () => {
        const E = window.VflowEditors;
        const saveSt = document.getElementById("editorSaveStatus");
        if (!E) {
          alert(t("common.localModuleMissing"));
          return;
        }
        try {
          const draft = readEditorAddForm();
          if (
            draft.provider === "comfyui" &&
            !draft.adapter.workflow &&
            !draft.adapter.workflowUi &&
            pendingEditorWorkflow
          ) {
            const W = window.VflowAdapter;
            if (W && W.isComfyUiWorkflow(pendingEditorWorkflow)) {
              draft.adapter.workflowUi = pendingEditorWorkflow;
              draft.adapter.workflow = W.uiWorkflowToApiPrompt(pendingEditorWorkflow);
            } else {
              draft.adapter.workflow = pendingEditorWorkflow;
            }
          }
          draft.params = Array.isArray(pendingEditorParams)
            ? pendingEditorParams
            : draft.params || [];
          draft.adapter.bindings = pendingEditorBindings || draft.adapter.bindings || {};
          const saved = E.upsertUserEditor(draft);
          if (saveSt) saveSt.textContent = t("editor.saved");
          resetEditorAddForm();
          showEditorAddForm(false);
          renderWorkflowTables();
          void saved;
        } catch (e) {
          if (saveSt) saveSt.textContent = e.message || String(e);
          alert(e.message || String(e));
        }
      });
    }
    const editorsBody = document.getElementById("editorsWorkflowBody");
    if (editorsBody) {
      editorsBody.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-act]");
        const row = ev.target.closest("[data-user-editor-id]");
        if (!row) return;
        const id = row.getAttribute("data-user-editor-id");
        const E = window.VflowEditors;
        if (!E || !id) return;
        const act = btn && btn.getAttribute("data-act");
        if (act === "delete-user") {
          if (!confirm(t("editor.confirmDeleteUser"))) return;
          E.removeUserEditor(id);
          renderWorkflowTables();
          return;
        }
        if (act === "edit-user") {
          const hit = E.getUserEditors().find((e) => e.id === id);
          if (hit) fillEditorAddForm(hit);
        }
      });
      editorsBody.addEventListener("change", (ev) => {
        const input = ev.target;
        if (!input || input.getAttribute("data-act") !== "toggle-enabled")
          return;
        const row = input.closest("[data-user-editor-id]");
        if (!row) return;
        const id = row.getAttribute("data-user-editor-id");
        const E = window.VflowEditors;
        if (!E || !id) return;
        E.setUserEditorEnabled(id, !!input.checked);
        renderWorkflowTables();
      });
    }
    const featuresBody = document.getElementById("featuresWorkflowBody");
    if (featuresBody) {
      featuresBody.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.getAttribute("data-act");
        const id = btn.getAttribute("data-feature-id");
        if (!id) return;
        if (act === "dock-feature") {
          openFeatureDock(id);
          return;
        }
        if (act === "clear-feature") {
          if (!confirm(t("workflow.confirmClearDock"))) return;
          clearFeatureDock(id);
          return;
        }
        if (act === "delete-feature") {
          const F = window.VflowFeatures;
          if (!F) return;
          if (!confirm(t("workflow.confirmDeleteFeature"))) return;
          clearFeatureDock(id);
          F.removeCustomFeature(id);
          renderWorkflowTables();
        }
      });
    }
    const btnFeatToggle = document.getElementById("btnFeatureAddToggle");
    if (btnFeatToggle) {
      btnFeatToggle.addEventListener("click", () => {
        resetFeatureAddForm();
        showFeatureAddForm(true);
      });
    }
    const btnFeatCancel = document.getElementById("btnFeatureCancel");
    if (btnFeatCancel) {
      btnFeatCancel.addEventListener("click", () => {
        resetFeatureAddForm();
        showFeatureAddForm(false);
      });
    }
    const btnFeatSave = document.getElementById("btnFeatureSave");
    if (btnFeatSave) {
      btnFeatSave.addEventListener("click", () => {
        const F = window.VflowFeatures;
        const st = document.getElementById("featureSaveStatus");
        if (!F) return;
        try {
          const id = (document.getElementById("featureId") || {}).value || "";
          const name =
            (document.getElementById("featureName") || {}).value || "";
          const description =
            (document.getElementById("featureDesc") || {}).value || "";
          const requiredBindings = [];
          document
            .querySelectorAll('input[name="featureBind"]:checked')
            .forEach((el) => requiredBindings.push(el.value));
          F.upsertCustomFeature({
            id,
            name: name.trim() || id,
            description: description.trim(),
            requiredBindings,
          });
          if (st) st.textContent = t("workflow.featureSaved");
          resetFeatureAddForm();
          showFeatureAddForm(false);
          renderWorkflowTables();
        } catch (e) {
          if (st) st.textContent = e.message || String(e);
          alert(e.message || String(e));
        }
      });
    }
  }

  function openSettingsModal(tab) {
    if (!settingsModal) return;
    fillLlmConfigInputs();
    fillVideoChannelForm();
    loadLlmChannel();
    loadUseDuckEncrypt();
    const resolved =
      !tab || tab === "video" || tab === "editors" ? "workflows" : tab;
    setSettingsTab(resolved);
    settingsModal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    checkLocalAgent({ silent: true });
  }

  function closeSettingsModal() {
    if (!settingsModal) return;
    closeWorkflowDock();
    saveVideoChannelConfig(readVideoChannelForm());
    saveLlmLocalConfig();
    saveUseDuckEncrypt(isUseDuckEncrypt());
    saveLlmChannel();
    settingsModal.classList.add("hidden");
    const storyOpen =
      storyboardModal && !storyboardModal.classList.contains("hidden");
    const frameOpen =
      framePickerModal && !framePickerModal.classList.contains("hidden");
    if (!storyOpen && !frameOpen) {
      document.body.classList.remove("modal-open");
    }
    updateLlmButtonState();
  }

  function uniqueTrimmed(arr, max) {
    const out = [];
    const seen = Object.create(null);
    (arr || []).forEach((x) => {
      const s = typeof x === "string" ? x.trim() : "";
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(s);
    });
    return typeof max === "number" ? out.slice(0, max) : out;
  }

  function newLlmProviderId() {
    return (
      "lp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    );
  }

  function hostnameLabel(url) {
    try {
      const host = new URL(url).hostname || "";
      return host.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function isOpenRouterUrl(url) {
    return /openrouter\.ai/i.test(String(url || ""));
  }

  function providerDisplayName(p) {
    if (!p) return t("settings.llmProviderUntitled");
    return (
      (p.name || "").trim() ||
      hostnameLabel(p.baseUrl) ||
      t("settings.llmProviderUntitled")
    );
  }

  function llmOptionValue(providerId, modelId) {
    return String(providerId || "") + "::" + String(modelId || "");
  }

  function parseLlmOptionValue(value) {
    const s = String(value || "");
    const i = s.indexOf("::");
    if (i < 0) return { providerId: "", modelId: s.trim() };
    return {
      providerId: s.slice(0, i),
      modelId: s.slice(i + 2).trim(),
    };
  }

  function loadUserCustomModels() {
    const arr = loadJsonLocal(LLM_CUSTOM_MODELS_KEY, []);
    if (!Array.isArray(arr)) return [];
    return uniqueTrimmed(arr, 30);
  }

  function defaultLlmProvider() {
    return {
      id: newLlmProviderId(),
      name: "OpenRouter",
      baseUrl: llmBaseUrlDefault || LLM_DEFAULT_BASE_URL,
      apiKey: "",
      models: [],
    };
  }

  function normalizeLlmProvider(raw) {
    const p = raw && typeof raw === "object" ? raw : {};
    return {
      id: String(p.id || newLlmProviderId()),
      name: String(p.name || "").trim(),
      baseUrl: String(p.baseUrl || "").trim(),
      apiKey: String(p.apiKey || "").trim(),
      models: uniqueTrimmed(
        Array.isArray(p.models) ? p.models : [],
        LLM_MODELS_PER_PROVIDER
      ),
    };
  }

  function migrateLlmConfig(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    if (Array.isArray(src.providers)) {
      const providers = src.providers
        .map(normalizeLlmProvider)
        .slice(0, LLM_PROVIDERS_MAX);
      if (!providers.length) providers.push(defaultLlmProvider());
      let activeId = String(src.activeProviderId || providers[0].id);
      if (!providers.some((p) => p.id === activeId)) {
        activeId = providers[0].id;
      }
      const active =
        providers.find((p) => p.id === activeId) || providers[0];
      let model = String(src.model || "").trim();
      if (!model) model = active.models[0] || "";
      if (model && active.models.indexOf(model) < 0) {
        active.models.unshift(model);
        active.models = uniqueTrimmed(active.models, LLM_MODELS_PER_PROVIDER);
      }
      return { providers, activeProviderId: activeId, model };
    }
    const custom = loadUserCustomModels();
    const baseUrl =
      String(src.baseUrl || "").trim() ||
      llmBaseUrlDefault ||
      LLM_DEFAULT_BASE_URL;
    const apiKey = String(src.apiKey || "").trim();
    const model =
      String(src.model || "").trim() ||
      llmModelDefault ||
      LLM_DEFAULT_MODEL;
    const models = uniqueTrimmed([model].concat(custom), LLM_MODELS_PER_PROVIDER);
    const p = {
      id: newLlmProviderId(),
      name: hostnameLabel(baseUrl) || "OpenRouter",
      baseUrl,
      apiKey,
      models,
    };
    return { providers: [p], activeProviderId: p.id, model };
  }

  function loadLlmLocalConfig() {
    try {
      const raw = localStorage.getItem(LLM_CFG_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return migrateLlmConfig(parsed && typeof parsed === "object" ? parsed : {});
    } catch (e) {
      return migrateLlmConfig({});
    }
  }

  function persistLlmConfig(cfg) {
    const next = migrateLlmConfig(cfg);
    try {
      localStorage.setItem(LLM_CFG_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn("save llm config failed", e);
    }
    return next;
  }

  function getActiveLlmProvider(cfg) {
    const c = cfg || loadLlmLocalConfig();
    return (
      (c.providers || []).find((p) => p.id === c.activeProviderId) ||
      (c.providers && c.providers[0]) ||
      defaultLlmProvider()
    );
  }

  function flushLlmProviderForm(cfg) {
    if (!llmProvidersListEl) return cfg;
    llmProvidersListEl.querySelectorAll("[data-provider-id]").forEach((card) => {
      const id = card.getAttribute("data-provider-id");
      const p = cfg.providers.find((x) => x.id === id);
      if (!p) return;
      const nameEl = card.querySelector("[data-field='name']");
      const urlEl = card.querySelector("[data-field='baseUrl']");
      const keyEl = card.querySelector("[data-field='apiKey']");
      if (nameEl) p.name = nameEl.value.trim();
      if (urlEl) p.baseUrl = urlEl.value.trim();
      if (keyEl) p.apiKey = keyEl.value.trim();
    });
    return cfg;
  }

  function saveLlmLocalConfig() {
    const cfg = persistLlmConfig(flushLlmProviderForm(loadLlmLocalConfig()));
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    syncConfigToAgent({ llm: getLlmRequestConfig() });
    return cfg;
  }

  function getLlmRequestConfig() {
    const cfg = loadLlmLocalConfig();
    const p = getActiveLlmProvider(cfg);
    const model =
      (cfg.model || "").trim() ||
      (p.models && p.models[0]) ||
      llmModelDefault ||
      LLM_DEFAULT_MODEL;
    return {
      baseUrl:
        (p.baseUrl || "").trim() ||
        llmBaseUrlDefault ||
        LLM_DEFAULT_BASE_URL,
      apiKey: (p.apiKey || "").trim(),
      model,
    };
  }

  function syncLlmConfiguredFromLocal() {
    loadLlmChannel();
    const cfg = getLlmRequestConfig();
    llmConfigured = !!(cfg.apiKey && cfg.baseUrl);
  }

  function topFreeModels(models) {
    return (models || []).slice(0, LLM_PICKER_LIMIT);
  }

  function selectHasValue(selectEl, value) {
    if (!selectEl || !value) return false;
    return Array.prototype.some.call(
      selectEl.options,
      (opt) => opt.value === value
    );
  }

  function llmSelectGroups(cfg) {
    return (cfg.providers || []).map((p) => ({
      id: p.id,
      label: providerDisplayName(p),
      models: p.models || [],
    }));
  }

  function fillGroupedModelSelect(selectEl, opts) {
    if (!selectEl) return;
    const groups = opts.groups || [];
    const selectedPid = opts.selectedProviderId || "";
    const selectedModel = (opts.selected || "").trim();
    selectEl.innerHTML = "";
    groups.forEach((g) => {
      if (!g.models || !g.models.length) return;
      const og = document.createElement("optgroup");
      og.label = g.label;
      g.models.forEach((id) => {
        if (!id) return;
        const opt = document.createElement("option");
        opt.value = llmOptionValue(g.id, id);
        opt.textContent = id;
        og.appendChild(opt);
      });
      if (og.childElementCount) selectEl.appendChild(og);
    });
    if (!selectEl.options.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = t("settings.llmEmptySelect");
      selectEl.appendChild(opt);
      return;
    }
    const want =
      selectedPid && selectedModel
        ? llmOptionValue(selectedPid, selectedModel)
        : "";
    if (want && selectHasValue(selectEl, want)) {
      selectEl.value = want;
    } else {
      selectEl.selectedIndex = 0;
    }
  }

  function getSelectedLlmModel() {
    const cfg = getLlmRequestConfig();
    return cfg.model || llmModelDefault || LLM_DEFAULT_MODEL;
  }

  function populateLlmModelSelects(models) {
    if (Array.isArray(models)) llmFreeModels = models;
    const cfg = loadLlmLocalConfig();
    const args = {
      groups: llmSelectGroups(cfg),
      selected: cfg.model,
      selectedProviderId: cfg.activeProviderId,
    };
    fillGroupedModelSelect(llmActiveSelectEl, args);
    fillGroupedModelSelect(storyboardLlmModelEl, args);
    fillGroupedModelSelect(scriptLlmModelEl, args);
  }

  function populateLlmModelSuggestions(models) {
    populateLlmModelSelects(models);
    renderLlmProvidersUi();
  }

  function applyModelFromSelect(selectEl) {
    if (!selectEl) return;
    const parsed = parseLlmOptionValue(selectEl.value);
    if (!parsed.modelId) return;
    setActiveLlmSelection(parsed.providerId, parsed.modelId, {
      render: true,
    });
  }

  function setActiveLlmSelection(providerId, model, opts) {
    const cfg = loadLlmLocalConfig();
    if (providerId && cfg.providers.some((p) => p.id === providerId)) {
      cfg.activeProviderId = providerId;
    }
    const p = getActiveLlmProvider(cfg);
    const mid = (model || "").trim();
    if (mid && p.models.indexOf(mid) >= 0) {
      cfg.model = mid;
    } else if (mid && opts && opts.addIfMissing) {
      p.models.unshift(mid);
      p.models = uniqueTrimmed(p.models, LLM_MODELS_PER_PROVIDER);
      cfg.model = mid;
    } else {
      cfg.model = p.models[0] || "";
    }
    persistLlmConfig(cfg);
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    syncConfigToAgent({ llm: getLlmRequestConfig() });
    populateLlmModelSelects();
    if (!opts || opts.render !== false) renderLlmProvidersUi();
  }

  function showLlmAddProviderForm(show) {
    if (!llmAddProviderFormEl) return;
    llmAddProviderFormEl.classList.toggle("hidden", !show);
    if (show) {
      if (llmNewProviderNameEl) llmNewProviderNameEl.value = "";
      if (llmNewProviderUrlEl) {
        llmNewProviderUrlEl.value = "";
        llmNewProviderUrlEl.focus();
      }
      if (llmNewProviderKeyEl) llmNewProviderKeyEl.value = "";
      if (llmNewProviderModelEl) llmNewProviderModelEl.value = "";
    }
  }

  function addLlmProviderFromForm() {
    const baseUrl = llmNewProviderUrlEl
      ? llmNewProviderUrlEl.value.trim()
      : "";
    if (!baseUrl) {
      alert(t("settings.llmUrlRequired"));
      return;
    }
    const cfg = loadLlmLocalConfig();
    if (cfg.providers.length >= LLM_PROVIDERS_MAX) {
      alert(t("settings.llmProvidersMax"));
      return;
    }
    const model = llmNewProviderModelEl
      ? llmNewProviderModelEl.value.trim()
      : "";
    const p = {
      id: newLlmProviderId(),
      name:
        (llmNewProviderNameEl && llmNewProviderNameEl.value.trim()) ||
        hostnameLabel(baseUrl),
      baseUrl,
      apiKey: llmNewProviderKeyEl ? llmNewProviderKeyEl.value.trim() : "",
      models: model ? [model] : [],
    };
    cfg.providers.push(p);
    cfg.activeProviderId = p.id;
    if (model) cfg.model = model;
    persistLlmConfig(cfg);
    llmEditingProviderId = p.id;
    showLlmAddProviderForm(false);
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    syncConfigToAgent({ llm: getLlmRequestConfig() });
    populateLlmModelSelects();
    renderLlmProvidersUi();
  }

  function deleteLlmProvider(id) {
    const cfg = loadLlmLocalConfig();
    if (cfg.providers.length <= 1) {
      alert(t("settings.llmNeedOneProvider"));
      return;
    }
    const p = cfg.providers.find((x) => x.id === id);
    const name = providerDisplayName(p);
    if (!confirm(t("settings.llmDeleteProviderConfirm", { name }))) return;
    cfg.providers = cfg.providers.filter((x) => x.id !== id);
    if (cfg.activeProviderId === id) {
      cfg.activeProviderId = cfg.providers[0].id;
      cfg.model = cfg.providers[0].models[0] || cfg.model;
    }
    if (llmEditingProviderId === id) llmEditingProviderId = "";
    persistLlmConfig(cfg);
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    syncConfigToAgent({ llm: getLlmRequestConfig() });
    populateLlmModelSelects();
    renderLlmProvidersUi();
  }

  function addModelToProvider(id, modelId) {
    const mid = (modelId || "").trim();
    if (!mid) {
      alert(t("settings.llmAddModelEmpty"));
      return false;
    }
    const cfg = loadLlmLocalConfig();
    const p = cfg.providers.find((x) => x.id === id);
    if (!p) return false;
    p.models = uniqueTrimmed([mid].concat(p.models), LLM_MODELS_PER_PROVIDER);
    if (cfg.activeProviderId === id) cfg.model = mid;
    persistLlmConfig(cfg);
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    syncConfigToAgent({ llm: getLlmRequestConfig() });
    populateLlmModelSelects();
    renderLlmProvidersUi();
    const input = llmProvidersListEl
      ? llmProvidersListEl.querySelector(
          `[data-provider-id="${id}"] [data-act="new-model"]`
        )
      : null;
    if (input) input.focus();
    return true;
  }

  function removeModelFromProvider(id, modelId) {
    const cfg = loadLlmLocalConfig();
    const p = cfg.providers.find((x) => x.id === id);
    if (!p) return;
    p.models = p.models.filter((m) => m !== modelId);
    if (cfg.activeProviderId === id && cfg.model === modelId) {
      cfg.model = p.models[0] || "";
    }
    persistLlmConfig(cfg);
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    syncConfigToAgent({ llm: getLlmRequestConfig() });
    populateLlmModelSelects();
    renderLlmProvidersUi();
  }

  function patchLlmProviderFields(id) {
    const cfg = flushLlmProviderForm(loadLlmLocalConfig());
    persistLlmConfig(cfg);
    syncLlmConfiguredFromLocal();
    updateLlmButtonState();
    const active = getActiveLlmProvider(cfg);
    if (active && active.id === id) {
      syncConfigToAgent({ llm: getLlmRequestConfig() });
    }
    populateLlmModelSelects();
  }

  function renderLlmProvidersUi() {
    if (!llmProvidersListEl) return;
    const cfg = loadLlmLocalConfig();
    if (!cfg.providers.length) {
      llmProvidersListEl.innerHTML =
        '<p class="muted llm-providers-empty">' +
        escapeHtml(t("settings.llmNoProviders")) +
        "</p>";
      return;
    }
    llmProvidersListEl.innerHTML = cfg.providers
      .map((p) => {
        const active = p.id === cfg.activeProviderId;
        const open = p.id === llmEditingProviderId;
        const name = providerDisplayName(p);
        const keyOk = !!(p.apiKey && p.apiKey.trim());
        const chips = (p.models || [])
          .map((mid) => {
            const current = active && cfg.model === mid;
            return `<span class="llm-model-chip${
              current ? " is-current" : ""
            }" title="${escapeHtml(mid)}">
              <button type="button" class="llm-chip-pick" data-act="use-model" data-model="${escapeHtml(
                mid
              )}">
                <span class="llm-model-chip-id">${escapeHtml(mid)}</span>
              </button>
              <button type="button" class="llm-model-chip-remove" data-act="remove-model" data-model="${escapeHtml(
                mid
              )}" aria-label="${escapeHtml(t("common.delete"))}">×</button>
            </span>`;
          })
          .join("");
        const showPopular =
          isOpenRouterUrl(p.baseUrl) || !p.baseUrl;
        return `<article class="llm-provider-card${active ? " is-active" : ""}${
          open ? " is-open" : ""
        }" data-provider-id="${escapeHtml(p.id)}">
          <div class="llm-provider-head">
            <input type="radio" class="llm-provider-radio" name="llmActiveProvider" value="${escapeHtml(
              p.id
            )}" ${active ? "checked" : ""} data-act="activate" />
            <div class="llm-provider-titles" data-act="toggle">
              <span class="llm-provider-name">${escapeHtml(name)}</span>
              <span class="llm-provider-meta">${escapeHtml(
                p.baseUrl || t("settings.llmBaseUrlPlaceholder")
              )}</span>
              <span class="llm-provider-badges">
                <span class="llm-provider-badge ${
                  keyOk ? "is-ok" : "is-warn"
                }">${escapeHtml(
          keyOk ? t("settings.llmKeyReady") : t("settings.llmKeyMissing")
        )}</span>
                <span class="llm-provider-badge">${escapeHtml(
                  p.models.length
                    ? t("settings.llmModelCount", { n: p.models.length })
                    : t("settings.llmNoModels")
                )}</span>
              </span>
            </div>
            <div class="llm-provider-head-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-act="delete">${escapeHtml(
                t("common.delete")
              )}</button>
            </div>
          </div>
          <div class="llm-provider-body">
            <label class="field-label muted">${escapeHtml(
              t("settings.llmProviderName")
            )}</label>
            <input type="text" class="llm-config-input" data-field="name" value="${escapeHtml(
              p.name
            )}" autocomplete="off" spellcheck="false" />
            <label class="field-label muted">${escapeHtml(
              t("settings.llmBaseUrl")
            )}</label>
            <input type="url" class="llm-config-input" data-field="baseUrl" value="${escapeHtml(
              p.baseUrl
            )}" placeholder="${escapeHtml(
          t("settings.llmBaseUrlPlaceholder")
        )}" autocomplete="off" spellcheck="false" />
            <label class="field-label muted">${escapeHtml(
              t("settings.llmApiKey")
            )}</label>
            <input type="password" class="llm-config-input" data-field="apiKey" value="${escapeHtml(
              p.apiKey
            )}" placeholder="${escapeHtml(
          t("settings.llmApiKeyPlaceholder")
        )}" autocomplete="off" spellcheck="false" />
            <label class="field-label muted">${escapeHtml(
              t("settings.llmModel")
            )}</label>
            <div class="llm-model-chips">${
              chips ||
              `<span class="muted">${escapeHtml(
                t("settings.llmNoModels")
              )}</span>`
            }</div>
            <div class="row gap llm-add-model-row">
              <input type="text" class="llm-config-input llm-model-input" data-act="new-model" placeholder="${escapeHtml(
                t("settings.llmModelPlaceholder")
              )}" autocomplete="off" spellcheck="false" />
              <button type="button" class="btn btn-ghost btn-sm" data-act="add-model">${escapeHtml(
                t("settings.llmAddModel")
              )}</button>
              ${
                showPopular
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-act="fill-popular" title="${escapeHtml(
                      t("settings.llmRefreshModelsTitle")
                    )}">${escapeHtml(t("settings.llmFillPopular"))}</button>`
                  : ""
              }
            </div>
          </div>
        </article>`;
      })
      .join("");
  }

  function fillLlmConfigInputs() {
    const cfg = loadLlmLocalConfig();
    if (!llmEditingProviderId && cfg.providers && cfg.providers.length) {
      llmEditingProviderId = cfg.activeProviderId || cfg.providers[0].id;
    }
    populateLlmModelSelects();
    renderLlmProvidersUi();
    syncLlmConfiguredFromLocal();
  }

  async function refreshLlmFreeModels(providerId) {
    try {
      const res = await fetch("/api/llm/models?refresh=1", {
        credentials: "same-origin",
      });
      const json = await res.json();
      if (!(json && json.success && json.data)) {
        throw new Error((json && json.error) || t("settings.modelsLoadFailed"));
      }
      llmFreeModels = json.data.models || [];
      if (json.data.baseUrlDefault) {
        llmBaseUrlDefault = json.data.baseUrlDefault;
      }
      if (json.data.defaultModel) {
        llmModelDefault = json.data.defaultModel;
      }
      const ids = topFreeModels(llmFreeModels)
        .map((m) => (m && m.id) || "")
        .filter(Boolean);
      const cfg = loadLlmLocalConfig();
      const orProv = cfg.providers.find((x) => isOpenRouterUrl(x.baseUrl));
      const pid = providerId || (orProv && orProv.id) || cfg.activeProviderId;
      const p = cfg.providers.find((x) => x.id === pid);
      if (p && ids.length) {
        p.models = uniqueTrimmed(p.models.concat(ids), LLM_MODELS_PER_PROVIDER);
        if (!p.baseUrl) p.baseUrl = llmBaseUrlDefault || LLM_DEFAULT_BASE_URL;
        if (!cfg.model && p.models[0]) cfg.model = p.models[0];
        persistLlmConfig(cfg);
      }
      populateLlmModelSelects();
      renderLlmProvidersUi();
      saveLlmLocalConfig();
      if (llmStatus) {
        llmStatus.textContent = ids.length
          ? t("settings.modelsUpdated", {
              model: getSelectedLlmModel() || llmModelDefault,
            })
          : t("settings.modelsEmpty");
      }
    } catch (e) {
      if (llmStatus) llmStatus.textContent = "";
      alert(e.message || String(e));
    }
  }

  function stripPromptMetaGuides(text) {
    let s = String(text == null ? "" : text).trim();
    if (!s) return "";
    const label =
      "(?:" +
      "前段|后段|前半(?:段)?|后半(?:段)?|" +
      "接上一段|继续上一段|承接上一段|接续上一段|" +
      "恢复上一段(?:的)?状态|" +
      "从上一段(?:末|结束)?(?:状态)?(?:开始|继续)?|" +
      "从首帧开始|" +
      "first\\s+half|second\\s+half|" +
      "previous(?:\\s+segment|\\s+part)?|next(?:\\s+segment|\\s+part)?|" +
      "continue\\s+from\\s+(?:the\\s+)?previous|" +
      "restore\\s+(?:the\\s+)?previous\\s+state|" +
      "start\\s+from\\s+(?:the\\s+)?(?:first|start)\\s+frame" +
      ")";
    const prefixRe = new RegExp("^" + label + "\\s*[:：\\-–—]?\\s*", "i");
    const lineRe = new RegExp("^(?:" + label + ")\\s*[:：]\\s*", "gim");
    const inlineRe = new RegExp(
      "(?<=[。．.!?\n；;])\\s*(?:" + label + ")\\s*[:：]\\s*",
      "gi"
    );
    while (true) {
      const next = s.replace(prefixRe, "").trim();
      if (next === s) break;
      s = next;
    }
    s = s.replace(lineRe, "");
    s = s.replace(inlineRe, " ");
    s = s.replace(/([。．])\s+/g, "$1");
    s = s.replace(/([.!?])(?=[A-Za-z「『"'])/g, "$1 ");
    s = s.replace(/[ \t]{2,}/g, " ");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.replace(/[。．]{2,}/g, "。");
    return s.trim();
  }

  function parseLlmPromptsContent(content) {
    let text = String(content || "").trim();
    if (!text) throw new Error(t("errors.llmEmptyResponse"));
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error(t("errors.llmNotJson"));
      data = JSON.parse(text.slice(start, end + 1));
    }
    const prompts = data && data.prompts;
    if (!Array.isArray(prompts) || !prompts.length) {
      throw new Error(t("errors.llmMissingPrompts"));
    }
    const cleaned = prompts
      .map((p) => (p != null ? stripPromptMetaGuides(p) : ""))
      .filter(Boolean);
    if (!cleaned.length) throw new Error(t("errors.llmPromptsEmpty"));
    return cleaned;
  }

  function clampStoryboardDurationSec(
    value,
    fallback,
    allowZero = false,
    maxSec = BRIDGE_MAX_SEC,
    minSec = 2
  ) {
    let n = Number(value);
    if (!Number.isFinite(n)) n = fallback;
    n = Math.round(n * 10) / 10;
    if (allowZero) return Math.max(0, Math.min(maxSec, n));
    return Math.max(minSec, Math.min(maxSec, n));
  }

  function clampTargetDurationSec(value, fallback = 30) {
    let n = Number(value);
    if (!Number.isFinite(n)) n = fallback;
    return Math.max(10, Math.min(120, Math.round(n)));
  }

  function isStoryboardSegmentCountManual() {
    return !(llmPickCountEl && llmPickCountEl.checked);
  }

  function getStoryboardSegmentCountValue() {
    let n = Number(segmentCountEl && segmentCountEl.value);
    if (!Number.isFinite(n)) n = 3;
    return Math.max(2, Math.min(8, Math.round(n)));
  }

  /** When count is user-set, total duration is count × main duration. */
  function derivedTargetDurationFromCount() {
    const product =
      getStoryboardSegmentCountValue() * getStoryboardMainDurationSec();
    return Math.round(product * 10) / 10;
  }

  function getStoryboardTargetDurationSec() {
    if (isStoryboardSegmentCountManual()) {
      return derivedTargetDurationFromCount();
    }
    return clampTargetDurationSec(
      storyboardTargetDurationEl && storyboardTargetDurationEl.value,
      30
    );
  }

  function syncStoryboardTargetDurationUi() {
    if (!storyboardTargetDurationEl) return;
    const manualCount = isStoryboardSegmentCountManual();
    storyboardTargetDurationEl.disabled = manualCount;
    if (manualCount) {
      storyboardTargetDurationEl.value = String(derivedTargetDurationFromCount());
    }
  }

  /** User-set default main duration (engine-clamped). MiniMax default 10, Wan 5. */
  function getStoryboardMainDurationSec() {
    const E = window.VflowStoryboardEngines;
    const raw =
      storyboardMainDurationEl && storyboardMainDurationEl.value != null
        ? storyboardMainDurationEl.value
        : MAIN_DEFAULT_SEC;
    if (E && typeof E.clampMainSec === "function") {
      return E.clampMainSec(raw, storyboardEngineProfile);
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return MAIN_DEFAULT_SEC;
    return Math.max(MAIN_MIN_SEC, Math.min(MAIN_MAX_SEC, Math.round(n * 10) / 10));
  }

  /** MiniMax: main and bridge share the same user-set segment duration. */
  function getStoryboardSegmentDurationSec() {
    return getStoryboardMainDurationSec();
  }

  /** Bridge duration fallback: MiniMax follows main; Wan uses bridge default. */
  function getStoryboardBridgeDurationSec() {
    if (getStoryboardEngine().usesDurationSeconds) {
      return getStoryboardSegmentDurationSec();
    }
    return BRIDGE_DEFAULT_SEC;
  }

  /** Max bridge duration when stretching soft chains toward target total. */
  function storyboardBridgeStretchSec() {
    return getStoryboardEngine().usesDurationSeconds
      ? getStoryboardSegmentDurationSec()
      : BRIDGE_MAX_SEC;
  }

  /**
   * Durations to force onto LLM shots: per-card override when useGlobalTiming=false,
   * else fill with user default main duration.
   */
  function resolveShotDurationsForLlm(segmentCount) {
    const def = getStoryboardMainDurationSec();
    const fromMains = (mains || []).map((m) => {
      if (
        m &&
        m.useGlobalTiming === false &&
        m.durationSec != null &&
        Number(m.durationSec) > 0
      ) {
        return Math.max(
          MAIN_MIN_SEC,
          Math.min(MAIN_MAX_SEC, Number(m.durationSec))
        );
      }
      return null;
    });
    if (segmentCount != null && Number.isFinite(Number(segmentCount))) {
      const n = Math.max(1, Math.round(Number(segmentCount)));
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(fromMains[i] != null ? fromMains[i] : def);
      }
      return out;
    }
    if (fromMains.some((x) => x != null)) {
      return fromMains.map((x) => (x != null ? x : def));
    }
    return [def];
  }

  /** Max wall-clock seconds for n mains with all soft bridges at full duration. */
  function maxSoftChainWallSec(mainCount) {
    const n = Math.max(0, Math.floor(Number(mainCount) || 0));
    if (n <= 0) return 0;
    if (n === 1) return MAIN_MAX_SEC;
    const bridgeNet = BRIDGE_MAX_SEC - 2 * BRIDGE_OVERLAP_SEC;
    return n * MAIN_MAX_SEC + (n - 1) * Math.max(0, bridgeNet);
  }

  /**
   * Minimum mains to approach target T with full soft chain (main+bridge+main units).
   * ceil((T + bridgeNet) / (MAIN_MAX + bridgeNet)), clamped to 2..8.
   */
  function minMainsForTargetDuration(targetSec) {
    const T = Number(targetSec);
    if (!Number.isFinite(T) || T <= 0) return 2;
    const bridgeNet = Math.max(0, BRIDGE_MAX_SEC - 2 * BRIDGE_OVERLAP_SEC);
    const denom = MAIN_MAX_SEC + bridgeNet;
    const nFull = Math.ceil((T + bridgeNet) / denom);
    const nUnit = Math.ceil(T / SOFT_CHAIN_UNIT_SEC) + 1;
    return Math.max(2, Math.min(8, Math.max(nFull, nUnit)));
  }

  function estimateStoryboardWallSec(shots, bridges) {
    let estimated = (shots || []).reduce(
      (sum, s) => sum + (Number(s.durationSec) || 0),
      0
    );
    (bridges || []).forEach((b) => {
      if (b && b.needBridge) {
        estimated += Math.max(0, (Number(b.durationSec) || 0) - 2 * BRIDGE_OVERLAP_SEC);
      }
    });
    return estimated;
  }

  /**
   * Stretch already-soft bridges when under target duration.
   * Only force all seams soft when even a full soft pack cannot reach ~85%
   * (physical under-capacity for this main count). Never convert intentional
   * hard camera-change seams to soft just to pad time in the reachable case.
   */
  function enforceSoftChainDurationBudget(shots, bridges, targetSec) {
    const T = Number(targetSec);
    if (!Number.isFinite(T) || T <= 0 || !shots || shots.length < 2) {
      return { shots, bridges };
    }
    const stretchSec = storyboardBridgeStretchSec();
    const maxPossible = maxSoftChainWallSec(shots.length);
    if (maxPossible < T * 0.85) {
      for (let i = 0; i < shots.length - 1; i++) {
        shots[i].cutToNext = "soft";
      }
      shots[shots.length - 1].cutToNext = "hard";
      for (let i = 0; i < bridges.length; i++) {
        const shot = shots[i];
        if (!shot || shot.cutToNext === "hard") {
          bridges[i] = {
            afterShot: shot ? shot.id : bridges[i].afterShot,
            needBridge: false,
            durationSec: 0,
            prompt: "",
          };
          continue;
        }
        const prev = bridges[i] || {};
        bridges[i] = {
          afterShot: shot.id,
          needBridge: true,
          durationSec: stretchSec,
          prompt: prev.prompt || "",
        };
      }
    } else {
      // Stretch existing soft bridges only; preserve hard camera-change seams.
      let estimated = estimateStoryboardWallSec(shots, bridges);
      if (estimated < T * 0.85) {
        for (let i = 0; i < bridges.length; i++) {
          if (shots[i].cutToNext === "hard") continue;
          const prev = bridges[i] || {};
          bridges[i] = {
            afterShot: shots[i].id,
            needBridge: true,
            durationSec: clampStoryboardDurationSec(
              Math.max(Number(prev.durationSec) || 0, stretchSec * 0.7),
              getStoryboardBridgeDurationSec(),
              false,
              stretchSec,
              BRIDGE_MIN_SEC
            ),
            prompt: prev.prompt || "",
          };
        }
        estimated = estimateStoryboardWallSec(shots, bridges);
        if (estimated < T * 0.85) {
          for (let i = 0; i < bridges.length; i++) {
            if (bridges[i].needBridge) bridges[i].durationSec = stretchSec;
          }
        }
      }
    }
    return { shots, bridges };
  }

  function shotFrameLengthFromDuration(durationSec, fps) {
    const eng = getStoryboardEngine(resolveActiveInspectorEngineId());
    if (engineUsesLengthLattice(eng)) {
      return framesFromDurationSec(
        durationSec,
        eng.nativeFps || eng.defaultFps || fps || 24
      );
    }
    const safeFps = clampFps(fps, vflowDefaults.fps || 16);
    const rawFrames = Math.max(17, Math.round(durationSec * safeFps));
    return snapLength(rawFrames, vflowDefaults.length, eng);
  }

  /** Align MiniMax prompt header seconds with forced durationSec when LLM drifts. */
  function fixMinimaxPromptDuration(prompt, durationSec) {
    const text = String(prompt || "");
    const dur = Number(durationSec);
    if (!text || !Number.isFinite(dur) || dur <= 0) return text;
    if (!usesTimedStoryboardEngine()) return text;
    return text
      .replace(/制作\s*\d+(?:\.\d+)?\s*秒/g, `制作${dur}秒`)
      .replace(/Make\s*\d+(?:\.\d+)?\s*-?\s*sec(?:ond)?s?/gi, `Make ${dur}-sec`);
  }

  /** Extra refs as slot tags (Picture 2+ / Video N / Audio N). Picture 1 = shared start. */
  function listStoryboardRefSlots(assets) {
    let imgN = 1;
    let vidN = 0;
    let audN = 0;
    const slots = [];
    (assets || []).forEach((a) => {
      if (!a) return;
      let tag;
      if (a.kind === "video") tag = `Video ${++vidN}`;
      else if (a.kind === "audio") tag = `Audio ${++audN}`;
      else tag = `Picture ${++imgN}`;
      slots.push({
        tag,
        content: String(a.content || a.note || "").trim(),
        purpose: String(a.purpose || "").trim(),
        kind: a.kind || "image",
      });
    });
    return slots;
  }

  function canonicalRefCite(tag, content, purpose, locale) {
    const c = String(content || "").trim();
    const p = String(purpose || "").trim();
    const isEn = String(locale || "").toLowerCase().startsWith("en");
    if (isEn) {
      if (p) return `reference <${tag}>{${c}} (role: ${p})`;
      return c ? `reference <${tag}>{${c}}` : `reference <${tag}>`;
    }
    if (p) return `参考<${tag}>{${c}}（作用：${p}）`;
    return c ? `参考<${tag}>{${c}}` : `参考<${tag}>`;
  }

  function normalizeUsedRefsList(raw, validTags) {
    const valid = new Set(validTags || []);
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
      let s = String(item || "").trim();
      if (!s) return;
      s = s.replace(/^<|>$/g, "").replace(/\s+/g, " ").trim();
      const m = s.match(/^(picture|video|audio)\s*(\d+)$/i);
      if (!m) return;
      const kind = m[1].toLowerCase();
      const name =
        kind === "picture" ? "Picture" : kind === "video" ? "Video" : "Audio";
      const tag = `${name} ${m[2]}`;
      if (tag === "Picture 1") return; // start frame is always present
      if (valid.has(tag) && !out.includes(tag)) out.push(tag);
    });
    return out;
  }

  function inferUsedRefsFromPrompt(prompt, validTags) {
    const valid = new Set(validTags || []);
    const found = [];
    const re = /<(Picture|Video|Audio)\s+(\d+)>/gi;
    let m;
    while ((m = re.exec(String(prompt || "")))) {
      const name =
        m[1].toLowerCase() === "picture"
          ? "Picture"
          : m[1].toLowerCase() === "video"
            ? "Video"
            : "Audio";
      const tag = `${name} ${m[2]}`;
      if (tag === "Picture 1") continue;
      if (valid.has(tag) && !found.includes(tag)) found.push(tag);
    }
    return found;
  }

  function stripExtraRefCites(prompt) {
    let text = String(prompt || "");
    // Remove LLM-written / stale cite phrases for extra refs (keep <Picture 1> opener).
    // Match through the next Chinese/ASCII clause break so paraphrased free text is cleared.
    text = text.replace(
      /参考\s*<(Picture|Video|Audio)\s+([2-9]|\d{2,})>[^；;]*/gi,
      ""
    );
    text = text.replace(
      /reference\s+<(Picture|Video|Audio)\s+([2-9]|\d{2,})>[^;；]*/gi,
      ""
    );
    // Collapse leftover duplicate separators from removals
    text = text.replace(/；\s*；+/g, "；");
    text = text.replace(/;\s*;+/g, ";");
    text = text.replace(/\s{2,}/g, " ");
    return text;
  }

  function injectCanonicalRefCitesIntoPrompt(prompt, tags, slotByTag, locale) {
    let text = stripExtraRefCites(prompt);
    const cites = (tags || [])
      .map((tag) => {
        const slot = slotByTag.get(tag);
        if (!slot) return "";
        return canonicalRefCite(tag, slot.content, slot.purpose, locale);
      })
      .filter(Boolean);
    if (!cites.length) return text;
    const citeBlock = cites.join("；") + "；";
    const isEn = String(locale || "").toLowerCase().startsWith("en");
    if (isEn) {
      const re =
        /(With\s+<Picture\s+1>\s+as(?:\s+the)?\s+sole\s+start\s+frame,\s*make\s+\d+(?:\.\d+)?-?\s*sec(?:ond)?s?\s*[^;；]*[;；])/i;
      if (re.test(text)) {
        return text.replace(re, (m) => m.replace(/\s*$/, "") + " " + citeBlock);
      }
      // Fallback: after first semicolon / after Make N-sec clause
      const makeRe = /(Make\s+\d+(?:\.\d+)?-?\s*sec(?:ond)?s?\s*[^;；]*[;；])/i;
      if (makeRe.test(text)) {
        return text.replace(makeRe, (m) => m.replace(/\s*$/, "") + " " + citeBlock);
      }
      return citeBlock + text;
    }
    const zhRe =
      /(以\s*<Picture\s+1>\s*为唯一首帧，制作\s*\d+(?:\.\d+)?\s*秒[^；;]*[；;])/;
    if (zhRe.test(text)) {
      return text.replace(zhRe, (m) => m.replace(/\s*$/, "") + citeBlock);
    }
    const makeZh = /(制作\s*\d+(?:\.\d+)?\s*秒[^；;]*[；;])/;
    if (makeZh.test(text)) {
      return text.replace(makeZh, (m) => m.replace(/\s*$/, "") + citeBlock);
    }
    return citeBlock + text;
  }

  /**
   * Deterministic MiniMax ref cites: LLM chooses usedRefs; code injects fixed content/purpose.
   * @returns {{ shots: object[], missingFallback: boolean }}
   */
  function applyCanonicalRefCites(shots, refAssets) {
    const list = Array.isArray(shots) ? shots : [];
    if (
      !usesTimedStoryboardEngine() ||
      !storyboardUseMultiRef ||
      !(refAssets && refAssets.length)
    ) {
      return {
        shots: list.map((s) => ({
          ...s,
          usedRefs: Array.isArray(s && s.usedRefs) ? s.usedRefs.slice() : [],
        })),
        missingFallback: false,
      };
    }
    const slots = listStoryboardRefSlots(refAssets);
    if (!slots.length) {
      return {
        shots: list.map((s) => ({
          ...s,
          usedRefs: Array.isArray(s && s.usedRefs) ? s.usedRefs.slice() : [],
        })),
        missingFallback: false,
      };
    }
    const validTags = slots.map((s) => s.tag);
    const slotByTag = new Map(slots.map((s) => [s.tag, s]));
    const locale = currentLocale();
    const usedAnywhere = new Set();
    const next = list.map((shot) => {
      let used = normalizeUsedRefsList(shot && shot.usedRefs, validTags);
      if (!used.length) {
        used = inferUsedRefsFromPrompt(shot && shot.prompt, validTags);
      }
      used.forEach((tag) => usedAnywhere.add(tag));
      return { ...shot, usedRefs: used };
    });
    let missingFallback = false;
    const unused = validTags.filter((tag) => !usedAnywhere.has(tag));
    if (unused.length && next.length) {
      missingFallback = true;
      const first = next[0];
      const merged = first.usedRefs.slice();
      unused.forEach((tag) => {
        if (!merged.includes(tag)) merged.push(tag);
      });
      next[0] = { ...first, usedRefs: merged };
    }
    const out = next.map((shot) => {
      const prompt = injectCanonicalRefCitesIntoPrompt(
        shot.prompt || "",
        shot.usedRefs,
        slotByTag,
        locale
      );
      return {
        ...shot,
        prompt: fixMinimaxPromptDuration(prompt, shot.durationSec),
        usedRefs: shot.usedRefs.slice(),
      };
    });
    return { shots: out, missingFallback };
  }

  /** Client-side MiniMax ref constraint for custom LLM channel (mirrors server block). */
  function buildClientMinimaxRefConstraintBlock() {
    if (!usesTimedStoryboardEngine()) return "";
    const locale = currentLocale();
    const isEn = String(locale || "").toLowerCase().startsWith("en");
    const lines = [];
    if (!storyboardUseMultiRef || !storyboardRefAssets.length) {
      if (isEn) {
        lines.push(
          "【References】<Picture 1> is the sole shared start frame; do not invent other <Picture N>. Open with <Picture 1> as sole start frame."
        );
      } else {
        lines.push(
          "【参考素材】共用首帧为 <Picture 1>；未列出额外参考时勿编造其他 <Picture N>。开篇须写 以<Picture 1>为唯一首帧。"
        );
      }
      return lines.join("\n");
    }
    const slots = listStoryboardRefSlots(storyboardRefAssets);
    if (isEn) {
      lines.push(
        "【References】<Picture 1>=shared start frame; extra stills from <Picture 2>; videos/audio as <Video N>/<Audio N> from 1."
      );
      lines.push("  <Picture 1> shared start / first frame");
      slots.forEach((s) => {
        const content = s.content || "(no content)";
        const purpose = s.purpose || "(no role)";
        lines.push(
          `  <${s.tag}> content: ${content} | role: ${purpose}`
        );
      });
      lines.push(
        "【Reference placement】For each extra ref, choose which main shot(s) need it from the plot (usually one; more only if still relevant). Put those tags in that shot's usedRefs (e.g. [\"Picture 2\"]). Do NOT write or paraphrase reference <Picture N>… in prompt body — the system injects fixed content/role verbatim. Omit unused slots from usedRefs and prompts. Every extra ref must appear in at least one shot's usedRefs."
      );
    } else {
      lines.push(
        "【参考素材】<Picture 1>=共用首帧；额外参考图从 <Picture 2> 起；视频/音频为 <Video N>/<Audio N> 从 1 起。"
      );
      lines.push("  <Picture 1> 共用首帧");
      slots.forEach((s) => {
        const content = s.content || "（无说明）";
        const purpose = s.purpose || "（无作用）";
        lines.push(`  <${s.tag}> 内容：${content}｜作用：${purpose}`);
      });
      lines.push(
        "【参考段落选用】按剧情为每个额外参考选择放在哪些主段（通常 1 段；剧情持续相关时可多段）。将该槽位写入对应 shot 的 usedRefs（如 [\"Picture 2\"]）。禁止在 prompt 正文自行撰写或改写 参考<Picture N>…——系统会按用户填写的内容/作用原样注入。未选用的槽位不要进 usedRefs，也不要在正文提。每个额外参考至少出现在一个主段的 usedRefs。"
      );
    }
    return lines.join("\n");
  }

  function warnIfRefContentMissing() {
    if (
      !usesTimedStoryboardEngine() ||
      !storyboardUseMultiRef ||
      !storyboardRefAssets.length
    ) {
      return false;
    }
    return storyboardRefAssets.some(
      (a) => a && !(String(a.content || a.note || "").trim())
    );
  }

  function normalizeStoryboardResult(
    data,
    segmentCount,
    targetDurationSec,
    { strict = true, shotDurations = null } = {}
  ) {
    const raw = data && typeof data === "object" ? data : {};
    const preferredDurs = Array.isArray(shotDurations)
      ? shotDurations
          .map((x) => {
            const n = Number(x);
            return Number.isFinite(n) && n > 0
              ? Math.max(MAIN_MIN_SEC, Math.min(MAIN_MAX_SEC, n))
              : null;
          })
          .filter((x) => x != null)
      : [];
    const fallbackDur = getStoryboardMainDurationSec();
    let shots = Array.isArray(raw.shots) ? raw.shots.slice() : [];
    if (!shots.length && Array.isArray(raw.prompts)) {
      shots = raw.prompts
        .map((prompt, i, arr) => {
          const cleaned = stripPromptMetaGuides(prompt);
          if (!cleaned) return null;
          return {
            id: `s${i + 1}`,
            title: t("storyboard.defaultShotTitle", { n: i + 1 }),
            beat: cleaned,
            prompt: cleaned,
            durationSec: preferredDurs[i] != null ? preferredDurs[i] : fallbackDur,
            camera: "",
            cutToNext: i < arr.length - 1 ? "soft" : "hard",
          };
        })
        .filter(Boolean);
    }
    shots = shots
      .map((shot, i) => {
        const prompt = stripPromptMetaGuides((shot && shot.prompt) || "");
        // LLM output must include prompts; drafts may keep empty placeholder slots.
        if (!prompt && strict) return null;
        const cutRaw = String((shot && shot.cutToNext) || "soft")
          .trim()
          .toLowerCase();
        const forced =
          preferredDurs[i] != null
            ? preferredDurs[i]
            : preferredDurs.length === 1
              ? preferredDurs[0]
              : null;
        const durationSec = clampStoryboardDurationSec(
          forced != null ? forced : shot && shot.durationSec,
          fallbackDur,
          false,
          MAIN_MAX_SEC,
          MAIN_MIN_SEC
        );
        return {
          id: String((shot && shot.id) || `s${i + 1}`),
          title:
            String((shot && shot.title) || "").trim() ||
            t("storyboard.defaultShotTitle", { n: i + 1 }),
          beat: String((shot && shot.beat) || "").trim() || prompt,
          prompt: fixMinimaxPromptDuration(prompt, durationSec),
          durationSec,
          camera: String((shot && shot.camera) || "").trim(),
          cutToNext: cutRaw === "hard" ? "hard" : "soft",
          usedRefs: Array.isArray(shot && shot.usedRefs)
            ? shot.usedRefs.slice()
            : [],
        };
      })
      .filter(Boolean);
    if (segmentCount != null) {
      if (shots.length > segmentCount) shots = shots.slice(0, segmentCount);
      else if (shots.length < segmentCount) {
        throw new Error(
          t("llm.promptCountMismatch", {
            got: shots.length,
            expected: segmentCount,
          })
        );
      }
    } else if (strict) {
      if (shots.length < 2) throw new Error(t("errors.llmTooFewSegments"));
      if (shots.length > 8) shots = shots.slice(0, 8);
    }
    // Structural trailer only (no next seam); not a creative hard-cut signal.
    if (shots.length) shots[shots.length - 1].cutToNext = "hard";

    const planTarget =
      targetDurationSec != null
        ? Number(targetDurationSec)
        : raw.totalDurationSec != null
          ? Number(raw.totalDurationSec)
          : null;
    // Only when even a full soft pack cannot reach ~85% of target, force soft seams.
    if (Number.isFinite(planTarget) && planTarget > 0) {
      if (maxSoftChainWallSec(shots.length) < planTarget * 0.85) {
        for (let i = 0; i < shots.length - 1; i++) {
          shots[i].cutToNext = "soft";
        }
        shots[shots.length - 1].cutToNext = "hard";
      }
    }

    const bridgeMap = new Map();
    if (Array.isArray(raw.bridges)) {
      raw.bridges.forEach((bridge) => {
        if (!bridge || typeof bridge !== "object") return;
        const afterShot = String(bridge.afterShot || "").trim();
        if (!afterShot) return;
        bridgeMap.set(afterShot, {
          afterShot,
          durationSec: bridge.durationSec,
          prompt: stripPromptMetaGuides(bridge.prompt || ""),
        });
      });
    }
    let bridges = [];
    for (let i = 0; i < Math.max(0, shots.length - 1); i++) {
      const shot = shots[i];
      const existing = bridgeMap.get(shot.id) || {};
      const needBridge = shot.cutToNext !== "hard";
      if (needBridge) {
        const rawDur = Number(existing.durationSec);
        bridges.push({
          afterShot: shot.id,
          needBridge: true,
          durationSec: clampStoryboardDurationSec(
            Number.isFinite(rawDur) && rawDur > 0
              ? rawDur
              : getStoryboardBridgeDurationSec(),
            getStoryboardBridgeDurationSec(),
            false,
            BRIDGE_MAX_SEC,
            BRIDGE_MIN_SEC
          ),
          prompt: existing.prompt || "",
        });
      } else {
        bridges.push({
          afterShot: shot.id,
          needBridge: false,
          durationSec: 0,
          prompt: "",
        });
      }
    }

    if (Number.isFinite(planTarget) && planTarget > 0) {
      const enforced = enforceSoftChainDurationBudget(shots, bridges, planTarget);
      shots = enforced.shots;
      bridges = enforced.bridges;
    }

    let estimated = estimateStoryboardWallSec(shots, bridges);
    const maxPossible = maxSoftChainWallSec(shots.length);
    let desiredTotal =
      raw.totalDurationSec != null
        ? Number(raw.totalDurationSec)
        : targetDurationSec != null
          ? Number(targetDurationSec)
          : estimated;
    // Do not claim a total longer than physically reachable with current mains.
    if (Number.isFinite(desiredTotal) && desiredTotal > maxPossible) {
      desiredTotal = maxPossible;
    }
    const total = clampTargetDurationSec(desiredTotal, estimated || 30);
    const cited = applyCanonicalRefCites(shots, storyboardRefAssets);
    if (cited.missingFallback && typeof llmStatus !== "undefined" && llmStatus) {
      try {
        llmStatus.textContent = t("storyboard.refUnusedFallback");
      } catch (e) {
        /* ignore */
      }
    }
    return {
      totalDurationSec: total,
      script_synopsis: String(
        raw.script_synopsis || raw.scriptSynopsis || ""
      ).trim(),
      shots: cited.shots,
      bridges,
    };
  }

  function parseLlmStoryboardContent(
    content,
    segmentCount,
    targetDurationSec,
    opts = {}
  ) {
    const data = parseLlmJsonObject(content);
    return normalizeStoryboardResult(
      data,
      segmentCount,
      targetDurationSec,
      opts
    );
  }

  function buildStoryboardStateFromClips() {
    const layerMains = mainsOnLayer1();
    const clips = collectLayer12Clips();
    const shots = layerMains.map((m, i) => ({
      id: m.id,
      title:
        String(m.title || "").trim() || t("storyboard.defaultShotTitle", { n: i + 1 }),
      beat: String(m.beat || m.prompt || "").trim(),
      prompt: String(m.prompt || "").trim(),
      durationSec: Math.round(clipDuration(m) * 10) / 10,
      camera: String(m.camera || "").trim(),
      cutToNext: String(m.cutToNext || "hard"),
      usedRefs: Array.isArray(m.usedRefs)
        ? m.usedRefs.slice()
        : (() => {
            const prev =
              storyboardState &&
              Array.isArray(storyboardState.shots) &&
              storyboardState.shots.find((s) => s && s.id === m.id);
            return prev && Array.isArray(prev.usedRefs) ? prev.usedRefs.slice() : [];
          })(),
    }));
    mains.forEach((m) => {
      if (clipStoryboardLayer(m) !== 2) return;
      shots.push({
        id: m.id,
        title: String(m.title || "").trim() || t("storyboard.layer2Main"),
        beat: String(m.beat || m.prompt || "").trim(),
        prompt: String(m.prompt || "").trim(),
        durationSec: Math.round(clipDuration(m) * 10) / 10,
        camera: String(m.camera || "").trim(),
        cutToNext: String(m.cutToNext || "hard"),
        usedRefs: Array.isArray(m.usedRefs) ? m.usedRefs.slice() : [],
        layer: 2,
      });
    });
    const usedBridgeIds = new Set();
    const bridgesState = [];
    for (let i = 0; i < Math.max(0, layerMains.length - 1); i++) {
      const left = layerMains[i];
      const right = layerMains[i + 1];
      const physical = findPhysicalBridgeForSeam(left, right, usedBridgeIds);
      if (physical) {
        usedBridgeIds.add(physical.id);
        if (shots[i]) shots[i].cutToNext = "soft";
        bridgesState.push({
          id: physical.id,
          afterShot: left.id,
          needBridge: true,
          durationSec: Math.round(clipDuration(physical) * 10) / 10,
          prompt: String(physical.prompt || "").trim(),
        });
      } else {
        bridgesState.push({
          afterShot: left.id,
          needBridge: false,
          durationSec: 0,
          prompt: "",
        });
      }
    }
    if (shots.length) {
      const lastLayer1 = layerMains[layerMains.length - 1];
      const lastShot = shots.find((s) => lastLayer1 && s.id === lastLayer1.id);
      if (lastShot) lastShot.cutToNext = "hard";
    }
    bridges.forEach((b) => {
      if (usedBridgeIds.has(b.id)) return;
      if (clipStoryboardLayer(b) !== 1 && clipStoryboardLayer(b) !== 2) return;
      bridgesState.push({
        id: b.id,
        afterShot: b.afterShot || b.leftMainId || null,
        needBridge: b.needBridge !== false,
        durationSec: Math.round(clipDuration(b) * 10) / 10,
        prompt: String(b.prompt || "").trim(),
      });
    });
    return {
      scriptSynopsis:
        storyboardState && storyboardState.scriptSynopsis
          ? storyboardState.scriptSynopsis
          : shots.map((s) => s.beat).filter(Boolean).slice(0, 3).join(" / "),
      totalDurationSec: clampTargetDurationSec(
        storyboardState && storyboardState.totalDurationSec,
        getStoryboardTargetDurationSec()
      ),
      shots,
      bridges: bridgesState,
      clips,
      lastPolishSummary: storyboardState && storyboardState.lastPolishSummary
        ? storyboardState.lastPolishSummary
        : "",
    };
  }

  function storyboardStateToPayload(state, polishTargetIds) {
    const base = state || buildStoryboardStateFromClips();
    const clips = Array.isArray(base.clips) ? base.clips : collectLayer12Clips();
    const targets =
      Array.isArray(polishTargetIds) && polishTargetIds.length
        ? polishTargetIds.slice()
        : getPolishTargetIds(clips);
    return {
      totalDurationSec: clampTargetDurationSec(
        base.totalDurationSec != null
          ? base.totalDurationSec
          : getStoryboardTargetDurationSec(),
        getStoryboardTargetDurationSec()
      ),
      script_synopsis: String(base.scriptSynopsis || "").trim(),
      shots: Array.isArray(base.shots) ? base.shots.map((shot) => ({ ...shot })) : [],
      bridges: Array.isArray(base.bridges) ? base.bridges.map((bridge) => ({ ...bridge })) : [],
      clips: clips.map((c) => ({ ...c })),
      polishTargetIds: targets,
      engineProfile: storyboardEngineProfile,
      useMultiRef: !!storyboardUseMultiRef,
      refAssets: storyboardRefAssets.map((a) => refAssetPayload(a)),
    };
  }

  function findStoryboardBridgeSpec(afterShotId) {
    return (
      (storyboardState.bridges || []).find((bridge) => bridge.afterShot === afterShotId) ||
      null
    );
  }

  async function browserLlmChat({ system, userMsg }) {
    const cfg = getLlmRequestConfig();
    if (!cfg.apiKey) throw new Error(t("settings.fillLlmApiKey"));
    if (!window.VflowLocal || !window.VflowLocal.llmChatViaAgent) {
      throw new Error(t("common.localModuleMissing"));
    }
    try {
      await window.VflowLocal.syncConfig({ llm: cfg });
    } catch (e) {
      /* run will re-check health */
    }
    try {
      return await window.VflowLocal.llmChatViaAgent({
        system,
        userMsg,
        llm: cfg,
        temperature: 0.7,
      });
    } catch (e) {
      throw new Error(e.message || String(e));
    }
  }

  let llmPromptTemplatesCache = null;
  let llmPromptTemplatesLocale = null;

  async function getLlmPromptTemplates() {
    const loc = currentLocale();
    if (llmPromptTemplatesCache && llmPromptTemplatesLocale === loc) {
      return llmPromptTemplatesCache;
    }
    const data = await apiJson(`/api/llm/prompt-templates?locale=${encodeURIComponent(loc)}`);
    llmPromptTemplatesCache = data || {};
    llmPromptTemplatesLocale = loc;
    return llmPromptTemplatesCache;
  }

  function buildClientEngineConstraintBlock() {
    const eng = getStoryboardEngine();
    const loc = currentLocale();
    const isEn = String(loc || "").toLowerCase().startsWith("en");
    const lines = [];
    lines.push(isEn ? "【Engine】" + (eng.name || eng.id) : "【引擎】" + (eng.name || eng.id));
    lines.push(
      isEn
        ? `Main duration ${eng.mainMinSec}–${eng.mainMaxSec}s (default ${eng.mainDefaultSec}); bridge ${eng.bridgeMinSec}–${eng.bridgeMaxSec}s.`
        : `主段时长 ${eng.mainMinSec}–${eng.mainMaxSec} 秒（默认 ${eng.mainDefaultSec}）；桥 ${eng.bridgeMinSec}–${eng.bridgeMaxSec} 秒。`
    );
    if (eng.allowTimedBeats) {
      lines.push(
        isEn
          ? "Write timed beats 0—Ns matching each shot's durationSec; audio/dialogue/SFX allowed."
          : "主段 prompt 按本段 durationSec 写 0—N 秒节拍；允许台词/配乐/音效。"
      );
    } else {
      lines.push(
        isEn
          ? "Do NOT write seconds, dialogue, voice-over, or music in prompts."
          : "禁止在提示词中写秒数、配音、说话或配乐。"
      );
    }
    return "\n" + lines.join("\n");
  }

  async function callLlmPrompts({ scene, plot, segmentCount, targetDurationSec, episodeScript, episodeBeats }) {
    const targetSec = isStoryboardSegmentCountManual()
      ? getStoryboardTargetDurationSec()
      : clampTargetDurationSec(targetDurationSec, 30);
    const shotDurations = resolveShotDurationsForLlm(segmentCount);
    const activeEng = getStoryboardEngine();
    const useTimedLlm = !!(activeEng && (activeEng.id === "minimax" || activeEng.allowTimedBeats));
    if (llmChannel === "custom") {
      const tpl = await getLlmPromptTemplates();
      const countNote =
        segmentCount == null
          ? t("llm.countNoteAuto", {
              min: 2,
              max: 8,
              suggest: minMainsForTargetDuration(targetSec),
            })
          : t("llm.countNoteExact", { n: segmentCount });
      const engKey = useTimedLlm
        ? "storyboard_system_minimax"
        : "storyboard_system";
      const userKey = useTimedLlm
        ? "storyboard_user_template_minimax"
        : "storyboard_user_template";
      const system =
        tpl[engKey] || tpl.storyboard_system || tpl.main_system || "";
      const userTpl =
        tpl[userKey] ||
        tpl.storyboard_user_template ||
        tpl.main_user_template ||
        "{scene}\n{plot}\n{count_note}";
      const userMsg =
        userTpl
          .replace(/\{scene\}/g, scene)
          .replace(/\{plot\}/g, plot)
          .replace(/\{count_note\}/g, countNote)
          .replace(/\{target_duration\}/g, String(targetSec)) +
        "\n\n【用户指定各段时长】" +
        shotDurations.join("、") +
        "（各主段 durationSec 必须原样使用，勿改写）" +
        (usesTimedStoryboardEngine()
          ? "\n【桥段时长】与主段相同：" +
            shotDurations[0] +
            "秒（软桥 needBridge=true 时 bridges[].durationSec 同此值）" +
            (window.VflowStoryboardEngines &&
            typeof window.VflowStoryboardEngines.buildMinimaxBeatSkeleton ===
              "function"
              ? "\n【节拍骨架示例】" +
                window.VflowStoryboardEngines.buildMinimaxBeatSkeleton(
                  shotDurations[0],
                  currentLocale()
                )
              : "") +
            "\n" +
            buildClientMinimaxRefConstraintBlock()
          : "") +
        (activeEng && activeEng.source === "user"
          ? buildClientEngineConstraintBlock()
          : "");
      if (episodeScript) {
        userMsg += "\n\n【本集可读剧本】\n" + episodeScript;
        if (Array.isArray(episodeBeats) && episodeBeats.length) {
          userMsg +=
            "\n\n【本集场次】\n" +
            episodeBeats
              .map((b, i) => {
                const title = (b && b.title) || "";
                const desc = (b && (b.description || b.text)) || "";
                return `${i + 1}. ${title ? title + " — " : ""}${desc}`;
              })
              .join("\n");
        }
        userMsg += "\n请按本集可读内容规划分镜，不要另编无关剧情。";
      }
      const content = await browserLlmChat({ system, userMsg });
      return parseLlmStoryboardContent(content, segmentCount, targetSec, {
        shotDurations,
      });
    }
    const data = await postJson("/api/llm/prompts", {
      sceneDescription: scene,
      plotDirection: plot,
      episodeScript: episodeScript || "",
      episodeBeats: episodeBeats || [],
      segmentCount,
      targetDurationSec: targetSec,
      llmModel: getSelectedLlmModel(),
      locale: currentLocale(),
      engineProfile: storyboardEngineProfile,
      engineCaps: buildEngineCapsPayload(),
      useMultiRef: storyboardUseMultiRef,
      refAssets: storyboardRefAssets.map((a) => refAssetLlmPayload(a)),
      shotDurations,
      defaultMainDurationSec: getStoryboardMainDurationSec(),
    });
    return normalizeStoryboardResult(
      data && (data.storyboard || data),
      segmentCount,
      targetSec,
      { shotDurations }
    );
  }

  async function callLlmBridges(pairs) {
    if (llmChannel === "custom") {
      const tpl = await getLlmPromptTemplates();
      const n = pairs.length;
      const pairTpl =
        tpl.bridge_pair_template ||
        "[{i}/{n}]\n{left}\n{right}";
      const blocks = pairs
        .map((p, i) =>
          pairTpl
            .replace(/\{i\}/g, String(i + 1))
            .replace(/\{n\}/g, String(n))
            .replace(/\{left\}/g, p.leftPrompt)
            .replace(/\{right\}/g, p.rightPrompt)
        )
        .join("\n\n");
      const intro = (tpl.bridge_user_intro || "").replace(/\{n\}/g, String(n));
      const system = tpl.bridge_system || "";
      const userMsg = `${intro}\n\n${blocks}`;
      const content = await browserLlmChat({ system, userMsg });
      let prompts = parseLlmPromptsContent(content);
      if (prompts.length > n) prompts = prompts.slice(0, n);
      else if (prompts.length < n) {
        throw new Error(
          t("llm.promptCountMismatch", { got: prompts.length, expected: n })
        );
      }
      return prompts;
    }
    const data = await postJson("/api/llm/bridges", {
      pairs,
      llmModel: getSelectedLlmModel(),
      locale: currentLocale(),
    });
    return (data && data.prompts) || [];
  }

  async function callStoryboardPolish({ scope, instruction, storyboard }) {
    if (llmChannel === "custom") {
      const tpl = await getLlmPromptTemplates();
      const polishKey =
        usesTimedStoryboardEngine()
          ? "storyboard_polish_system_minimax"
          : "storyboard_polish_system";
      const system =
        tpl[polishKey] ||
        tpl.storyboard_polish_system ||
        tpl.storyboard_system ||
        tpl.main_system ||
        "";
      const userTpl =
        tpl.storyboard_polish_user_template ||
        "[Polish scope]\n{scope}\n\n[Instruction]\n{instruction}\n\n[Current storyboard JSON]\n{storyboard_json}";
      const userMsg =
        userTpl
          .replace(/\{scope\}/g, scope)
          .replace(/\{instruction\}/g, instruction)
          .replace(/\{storyboard_json\}/g, JSON.stringify(storyboard, null, 2)) +
        (usesTimedStoryboardEngine()
          ? "\n\n" + buildClientMinimaxRefConstraintBlock()
          : "");
      const content = await browserLlmChat({ system, userMsg });
      const data = parseLlmJsonObject(content);
      if (!data || typeof data !== "object" || !data.patch || typeof data.patch !== "object") {
        throw new Error(t("storyboard.polishPatchInvalid"));
      }
      return data;
    }
    return postJson("/api/llm/storyboard-polish", {
      scope,
      instruction,
      storyboard,
      llmModel: getSelectedLlmModel(),
      locale: currentLocale(),
      engineProfile: storyboardEngineProfile,
      engineCaps: buildEngineCapsPayload(),
      useMultiRef: storyboardUseMultiRef,
      refAssets: storyboardRefAssets.map((a) => refAssetLlmPayload(a)),
      shotDurations: resolveShotDurationsForLlm(
        storyboard && Array.isArray(storyboard.shots)
          ? storyboard.shots.length
          : null
      ),
      defaultMainDurationSec: getStoryboardMainDurationSec(),
    });
  }

  function stripLlmPlainPrompt(content) {
    let text = String(content || "").trim();
    if (!text) return "";
    const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))
    ) {
      text = text.slice(1, -1).trim();
    }
    return text.trim();
  }

  async function callT2iExpand(prompt) {
    const src = String(prompt || "").trim();
    if (!src) throw new Error(t("firstFrame.needPrompt"));
    if (llmChannel === "custom") {
      const tpl = await getLlmPromptTemplates();
      const system = tpl.t2i_expand_system || "";
      const userTpl = tpl.t2i_expand_user_template || "[Request]\n{prompt}";
      const userMsg = userTpl.replace(/\{prompt\}/g, src);
      const content = await browserLlmChat({ system, userMsg });
      const expanded = stripLlmPlainPrompt(content);
      if (!expanded) throw new Error(t("firstFrame.expandFailed"));
      return expanded;
    }
    const data = await postJson("/api/llm/t2i-expand", {
      prompt: src,
      llmModel: getSelectedLlmModel(),
      locale: currentLocale(),
    });
    const expanded = stripLlmPlainPrompt((data && data.prompt) || "");
    if (!expanded) throw new Error(t("firstFrame.expandFailed"));
    return expanded;
  }

  function describeStoryboardPatch(draft) {
    if (!draft || !draft.patch || typeof draft.patch !== "object") {
      return t("storyboard.polishDiffEmpty");
    }
    const lines = [];
    const patch = draft.patch;
    if (patch.script_synopsis) lines.push(`• ${t("storyboard.patchSynopsis")}`);
    if (Array.isArray(patch.shots)) {
      patch.shots.forEach((shot) => {
        const bits = [];
        if ("title" in shot) bits.push(t("storyboard.patchFieldTitle"));
        if ("beat" in shot) bits.push(t("storyboard.patchFieldBeat"));
        if ("prompt" in shot) bits.push(t("storyboard.patchFieldPrompt"));
        if ("camera" in shot) bits.push(t("storyboard.patchFieldCamera"));
        if ("durationSec" in shot) bits.push(`${t("storyboard.patchFieldDuration")}=${shot.durationSec}s`);
        if ("cutToNext" in shot) bits.push(`${t("storyboard.patchFieldCut")}=${shot.cutToNext}`);
        if (bits.length) lines.push(`• ${shot.id}: ${bits.join(" / ")}`);
      });
    }
    if (Array.isArray(patch.bridges)) {
      patch.bridges.forEach((bridge) => {
        const bits = [];
        if ("needBridge" in bridge) bits.push(bridge.needBridge ? t("storyboard.softCut") : t("storyboard.hardCut"));
        if ("durationSec" in bridge) bits.push(`${t("storyboard.patchFieldDuration")}=${bridge.durationSec}s`);
        if ("prompt" in bridge) bits.push(t("storyboard.patchFieldPrompt"));
        if (bits.length) {
          lines.push(`• ${bridge.id || bridge.afterShot}: ${bits.join(" / ")}`);
        }
      });
    }
    return lines.length ? lines.join("\n") : t("storyboard.polishDiffEmpty");
  }

  function applyStoryboardPatchDraft(draft) {
    if (!draft || !draft.patch || typeof draft.patch !== "object") return false;
    const allowed = new Set(
      Array.isArray(draft.polishTargetIds) && draft.polishTargetIds.length
        ? draft.polishTargetIds
        : getPolishTargetIds()
    );
    const patch = { ...draft.patch };
    if (Array.isArray(patch.shots)) {
      patch.shots = patch.shots.filter((s) => s && allowed.has(s.id));
    }
    if (Array.isArray(patch.bridges)) {
      patch.bridges = patch.bridges.filter((b) => {
        if (!b) return false;
        if (b.id && allowed.has(b.id)) return true;
        if (b.id) return false;
        if (b.afterShot && allowed.has(b.afterShot)) return true;
        const byAfter = b.afterShot
          ? mains.find((item) => item.id === b.afterShot)
          : null;
        if (byAfter) {
          const rightIndex = mainsOnLayer1().findIndex((item) => item.id === byAfter.id);
          const right = rightIndex >= 0 ? mainsOnLayer1()[rightIndex + 1] : null;
          const br = right ? findBridgeBetween(byAfter.id, right.id) : null;
          return !!(br && allowed.has(br.id));
        }
        return false;
      });
    }
    if ("script_synopsis" in patch) {
      storyboardState.scriptSynopsis = String(patch.script_synopsis || "").trim();
    }
    if (Array.isArray(patch.shots)) {
      patch.shots.forEach((shotPatch) => {
        const m = mains.find((item) => item.id === shotPatch.id);
        if (!m) return;
        if ("title" in shotPatch) m.title = String(shotPatch.title || "").trim();
        if ("beat" in shotPatch) m.beat = String(shotPatch.beat || "").trim();
        if ("prompt" in shotPatch) {
          m.prompt = stripPromptMetaGuides(shotPatch.prompt || "");
          m.dirty = true;
          if (m.status === "success") m.label = t("status.promptChanged");
        }
        if ("usedRefs" in shotPatch) {
          m.usedRefs = Array.isArray(shotPatch.usedRefs)
            ? shotPatch.usedRefs.slice()
            : [];
        }
        if ("camera" in shotPatch) m.camera = String(shotPatch.camera || "").trim();
        if ("cutToNext" in shotPatch) m.cutToNext = shotPatch.cutToNext === "soft" ? "soft" : "hard";
        if ("durationSec" in shotPatch) {
          const sec = clampStoryboardDurationSec(
            shotPatch.durationSec,
            Math.min(7, clipDuration(m)),
            false,
            7
          );
          m.useGlobalTiming = false;
          m.fps = getGlobalFps();
          m.length = shotFrameLengthFromDuration(sec, m.fps);
          m.outSec = sec;
        }
      });
      // Re-apply fixed content/purpose cites after polish may rewrite prompts/usedRefs.
      if (usesTimedStoryboardEngine() && storyboardUseMultiRef) {
        const layer = mainsOnLayer1();
        const asShots = layer.map((m) => ({
          id: m.id,
          prompt: m.prompt || "",
          durationSec: clipDuration(m),
          usedRefs: Array.isArray(m.usedRefs) ? m.usedRefs.slice() : [],
        }));
        const cited = applyCanonicalRefCites(asShots, storyboardRefAssets);
        cited.shots.forEach((s) => {
          const m = mains.find((item) => item.id === s.id);
          if (!m) return;
          if (s.prompt && s.prompt !== m.prompt) {
            m.prompt = s.prompt;
            m.dirty = true;
          }
          m.usedRefs = Array.isArray(s.usedRefs) ? s.usedRefs.slice() : [];
        });
        if (cited.missingFallback && llmStatus) {
          llmStatus.textContent = t("storyboard.refUnusedFallback");
        }
      }
    }
    if (Array.isArray(patch.bridges)) {
      patch.bridges.forEach((bridgePatch) => {
        let bridge = bridgePatch.id
          ? bridges.find((item) => item.id === bridgePatch.id) || null
          : null;
        const left =
          (bridge && bridge.leftMainId
            ? mains.find((item) => item.id === bridge.leftMainId)
            : null) ||
          mains.find((item) => item.id === bridgePatch.afterShot) ||
          null;
        const rightIndex = left
          ? mainsOnLayer1().findIndex((item) => item.id === left.id)
          : -1;
        const right = rightIndex >= 0 ? mainsOnLayer1()[rightIndex + 1] : null;
        if (!bridge && left && right) {
          bridge = findBridgeBetween(left.id, right.id);
        }
        const explicitCut =
          "cutToNext" in bridgePatch || "needBridge" in bridgePatch;
        let needBridge;
        if ("cutToNext" in bridgePatch) {
          needBridge = String(bridgePatch.cutToNext).toLowerCase() !== "hard";
        } else if ("needBridge" in bridgePatch) {
          needBridge = !!bridgePatch.needBridge;
        } else {
          needBridge = true;
        }
        if (left && explicitCut) {
          left.cutToNext = needBridge ? "soft" : "hard";
        }
        if (explicitCut && !needBridge) {
          if (bridge) {
            const idx = bridges.findIndex((item) => item.id === bridge.id);
            if (idx >= 0) bridges.splice(idx, 1);
          }
          return;
        }
        if (!bridge && left && right) {
          bridge = emptyBridge(left.id, right.id, {
            trackId: ensureBridgeTrack(),
            startSec: 0,
          });
          bridges.push(bridge);
        }
        if (!bridge) return;
        bridge.needBridge = true;
        if (left) {
          bridge.afterShot = left.id;
          bridge.leftMainId = left.id;
          if (right) bridge.rightMainId = right.id;
        }
        if ("prompt" in bridgePatch) {
          bridge.prompt = stripPromptMetaGuides(bridgePatch.prompt || "");
          bridge.dirty = true;
          if (bridge.status === "success") bridge.label = t("status.promptChanged");
        }
        const sec = clampStoryboardDurationSec(
          "durationSec" in bridgePatch ? bridgePatch.durationSec : clipDuration(bridge),
          getStoryboardBridgeDurationSec(),
          false,
          BRIDGE_MAX_SEC,
          BRIDGE_MIN_SEC
        );
        bridge.useGlobalTiming = false;
        bridge.fps = getGlobalFps();
        bridge.length = shotFrameLengthFromDuration(Math.max(sec, 0.5), bridge.fps);
        bridge.outSec = Math.max(sec, 0.5);
      });
    }
    layoutLayer1UnderLayer2Bridges();
    storyboardState = buildStoryboardStateFromClips();
    storyboardState.lastPolishSummary = String(draft.summary || "").trim();
    renderAll();
    scheduleSaveDraft();
    return true;
  }

  function parseLlmJsonObject(content) {
    let text = String(content || "").trim();
    if (!text) throw new Error(t("errors.llmEmptyResponse"));
    text = text.replace(/^\uFEFF/, "");
    text = text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(t("errors.llmNotJson"));
    let slice = text.slice(start, end + 1);
    // Drop trailing commas before } or ] (common LLM mistake)
    slice = slice.replace(/,\s*([}\]])/g, "$1");
    // Fix accidental union syntax copied from docs: "runninghub"|"comfyui"
    slice = slice.replace(
      /"provider"\s*:\s*"(runninghub|comfyui)"\s*\|\s*"(runninghub|comfyui)"/gi,
      '"provider":"$1"'
    );
    try {
      return JSON.parse(slice);
    } catch (e1) {
      const detail = e1 && e1.message ? e1.message : String(e1);
      const m = detail.match(/position\s+(\d+)/i);
      let hint = "";
      if (m) {
        const pos = Number(m[1]);
        const a = Math.max(0, pos - 40);
        const b = Math.min(slice.length, pos + 40);
        hint = ` …${slice.slice(a, b)}…`;
      }
      throw new Error(t("errors.llmJsonParseFailed", { detail }) + hint);
    }
  }

  function finalizeLlmAdapter(adapter, opts) {
    const W = window.VflowAdapter;
    if (!W || typeof W.finalizeLlmDraft !== "function") {
      throw new Error(t("common.vflowAdapterMissing"));
    }
    return W.finalizeLlmDraft(adapter, opts);
  }

  async function generateWorkflowDraftWithLlm({
    provider,
    mode,
    workflow,
    workflowId,
  }) {
    const W = window.VflowAdapter;
    if (!W) throw new Error(t("common.vflowAdapterMissing"));
    const llmMode = mode === "editor" ? "editor" : mode || "i2v";
    const candidates =
      typeof W.extractLocalCandidates === "function"
        ? W.extractLocalCandidates(workflow)
        : [];
    const nodesSummary =
      typeof W.slimSummaryForLlm === "function"
        ? W.slimSummaryForLlm(candidates)
        : typeof W.summarizeWorkflowForLlm === "function"
          ? W.summarizeWorkflowForLlm(workflow)
          : [];
    const finalizeOpts = {
      provider,
      mode: llmMode,
      target: llmMode,
      workflow,
      workflowId,
      candidates,
    };
    if (llmChannel === "custom") {
      const system =
        typeof W.workflowExtractSystemPrompt === "function"
          ? W.workflowExtractSystemPrompt(currentLocale())
          : t("llm.adapterFallbackSystem");
      const userMsg =
        `provider=${provider}\ntarget=${llmMode}\nworkflowId=${workflowId || ""}\n` +
        `Label binds only. Do not echo nodes.\n\n` +
        `nodes:\n${JSON.stringify(nodesSummary).slice(0, 24000)}`;
      const content = await browserLlmChat({ system, userMsg });
      const raw = parseLlmJsonObject(content);
      if (typeof W.finalizeExtractToAdapter === "function") {
        return W.finalizeExtractToAdapter(raw, finalizeOpts);
      }
      return finalizeLlmAdapter(raw, finalizeOpts);
    }
    const data = await postJson("/api/llm/adapter", {
      provider,
      mode: "extract",
      target: llmMode,
      nodes: nodesSummary,
      workflowId,
      llmModel: getSelectedLlmModel(),
      locale: currentLocale(),
    });
    const draft = data.draft || data.adapter;
    if (typeof W.finalizeExtractToAdapter === "function") {
      return W.finalizeExtractToAdapter(draft, finalizeOpts);
    }
    return finalizeLlmAdapter(draft, finalizeOpts);
  }

  async function generateAdapterWithLlm(opts) {
    return generateWorkflowDraftWithLlm(opts);
  }

  function renderParamsVisibilityList(container, params) {
    if (!container) return;
    const list = Array.isArray(params) ? params : [];
    container.innerHTML = "";
    if (!list.length) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");
    const head = document.createElement("div");
    head.className = "params-visibility-head row gap";
    const title = document.createElement("p");
    title.className = "field-label muted";
    title.textContent = t("settings.paramsVisibility");
    head.appendChild(title);
    const actions = document.createElement("div");
    actions.className = "params-visibility-actions row gap";
    const btnAll = document.createElement("button");
    btnAll.type = "button";
    btnAll.className = "btn btn-ghost btn-sm";
    btnAll.textContent = t("settings.paramsVisibilitySelectAll");
    btnAll.addEventListener("click", () => {
      container.querySelectorAll(".params-visibility-select").forEach((sel) => {
        sel.value = "shown";
      });
    });
    const btnNone = document.createElement("button");
    btnNone.type = "button";
    btnNone.className = "btn btn-ghost btn-sm";
    btnNone.textContent = t("settings.paramsVisibilityDeselectAll");
    btnNone.addEventListener("click", () => {
      container.querySelectorAll(".params-visibility-select").forEach((sel) => {
        sel.value = "hidden";
      });
    });
    actions.appendChild(btnAll);
    actions.appendChild(btnNone);
    head.appendChild(actions);
    container.appendChild(head);
    list.forEach((p) => {
      const row = document.createElement("div");
      row.className = "params-visibility-row row gap";
      row.dataset.paramId = p.id;
      const labelWrap = document.createElement("div");
      labelWrap.className = "params-visibility-label-wrap";
      const label = document.createElement("span");
      label.className = "params-visibility-label";
      label.textContent = p.label || p.id;
      labelWrap.appendChild(label);
      const nodeId = String(p.nodeId || "").trim();
      const fieldName = String(p.fieldName || "").trim();
      if (nodeId) {
        const ref = document.createElement("code");
        ref.className = "params-visibility-node muted";
        ref.textContent = t("settings.paramsNodeRef", {
          nodeId,
          field: fieldName || "?",
        });
        labelWrap.appendChild(ref);
      }
      if (
        p.default === 0 ||
        p.default === false ||
        (p.default != null && p.default !== "")
      ) {
        const def = document.createElement("span");
        def.className = "params-visibility-default muted";
        let preview = String(p.default);
        if (preview.length > 48) preview = `${preview.slice(0, 45)}…`;
        def.textContent = t("settings.paramsCachedDefault", { value: preview });
        labelWrap.appendChild(def);
      }
      const sel = document.createElement("select");
      sel.className = "params-visibility-select";
      ["shown", "collapsed", "hidden"].forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = t(`settings.visibility.${v}`);
        if ((p.visibility || "shown") === v) opt.selected = true;
        sel.appendChild(opt);
      });
      row.appendChild(labelWrap);
      row.appendChild(sel);
      container.appendChild(row);
    });
  }

  function readParamsVisibilityFromList(container, baseParams) {
    const list = Array.isArray(baseParams) ? baseParams.map((p) => ({ ...p })) : [];
    if (!container) return list;
    list.forEach((p) => {
      const row = container.querySelector(`[data-param-id="${p.id}"]`);
      const sel = row && row.querySelector(".params-visibility-select");
      if (sel) p.visibility = sel.value || "shown";
    });
    return list;
  }

  function channelParamsContainerId(provider, mode) {
    return provider === "runninghub"
      ? `rhParamsVisibility${mode === "flf" ? "Flf" : "I2v"}`
      : `comfyParamsVisibility${mode === "flf" ? "Flf" : "I2v"}`;
  }

  function renderChannelParamsVisibilityFromAdapter(adapter, provider) {
    const paramsMap =
      provider === "runninghub" ? pendingRhParamsByMode : pendingComfyParamsByMode;
    ["i2v", "flf"].forEach((mode) => {
      const m = adapter && adapter.modes && adapter.modes[mode];
      const params = m && Array.isArray(m.params) ? m.params : [];
      paramsMap[mode] = params;
      renderParamsVisibilityList(
        document.getElementById(channelParamsContainerId(provider, mode)),
        params
      );
    });
  }

  function mergeParamsVisibilityIntoAdapter(adapter, provider, paramsMap) {
    if (!adapter || !adapter.modes) return adapter;
    ["i2v", "flf"].forEach((mode) => {
      const m = adapter.modes[mode];
      if (!m) return;
      const base =
        (paramsMap[mode] && paramsMap[mode].length
          ? paramsMap[mode]
          : m.params) || [];
      if (!base.length) return;
      m.params = readParamsVisibilityFromList(
        document.getElementById(channelParamsContainerId(provider, mode)),
        base
      );
      paramsMap[mode] = m.params;
    });
    return adapter;
  }

  function syncLlmCountUi() {
    if (segmentCountEl && llmPickCountEl) {
      segmentCountEl.disabled = !!llmPickCountEl.checked;
    }
    syncStoryboardTargetDurationUi();
  }

  function updateLlmButtonState() {
    syncLlmConfiguredFromLocal();
    updateChannelSummary();
    if (btnLlmGenerate) {
      btnLlmGenerate.disabled = !llmConfigured || llmGenerating;
    }
    const btnDockLlm = document.getElementById("btnDockLlm");
    if (btnDockLlm) {
      btnDockLlm.disabled = !llmConfigured || llmGenerating;
    }
    ["btnRhLlmI2v", "btnRhLlmFlf", "btnComfyLlmI2v", "btnComfyLlmFlf"].forEach(
      (id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = !llmConfigured || llmGenerating;
      }
    );
    if (btnRegenBridges) {
      const layerMains = mainsOnLayer1();
      const canRegen =
        llmConfigured &&
        !llmGenerating &&
        layerMains.length >= 2 &&
        layerMains.every((m) => (m.prompt || "").trim());
      btnRegenBridges.disabled = !canRegen;
    }
    if (btnStoryboardPolish) {
      const clips = collectLayer12Clips();
      const targets = getPolishTargetIds(clips);
      btnStoryboardPolish.disabled =
        !llmConfigured ||
        llmGenerating ||
        storyboardPolishBusy ||
        !clips.length ||
        !targets.length;
    }
    if (btnStoryboardApplyPatch) {
      btnStoryboardApplyPatch.disabled =
        storyboardPolishBusy || !storyboardPolishDraft;
    }
    if (llmHint) {
      llmHint.classList.remove("hidden");
      if (!llmConfigured) {
        llmHint.textContent = t("common.configureCustomLlm") + LLM_LAYOUT_HINT;
      } else {
        const ch = t("common.customLlm");
        llmHint.textContent = t("storyboard.currentChannel", { ch }) + LLM_LAYOUT_HINT;
      }
    }
  }

  async function fetchSiteConfig() {
    try {
      const res = await fetch("/api/site-config", { cache: "no-cache" });
      const json = await res.json();
      if (json && json.success && json.data && json.data.siteConfig) {
        if (
          window.VflowI18n &&
          typeof window.VflowI18n.setSiteConfig === "function"
        ) {
          window.VflowI18n.setSiteConfig(json.data.siteConfig);
        }
      }
    } catch (e) {
      console.warn("fetch /api/site-config failed", e);
    }
  }

  async function fetchServerConfig() {
    try {
      const res = await fetch("/api/config");
      const json = await res.json();
      if (json && json.success && json.data) {
        serverLlmConfigured = false;
        platformRhAvailable = false;
        allowSelfRegister = !!json.data.allowSelfRegister;
        if (json.data.llmBaseUrlDefault) {
          llmBaseUrlDefault = json.data.llmBaseUrlDefault;
        }
        if (json.data.llmModelDefault || json.data.llmModel) {
          llmModelDefault =
            json.data.llmModelDefault || json.data.llmModel || llmModelDefault;
        }
        if (Array.isArray(json.data.llmFreeModels)) {
          llmFreeModels = json.data.llmFreeModels;
          populateLlmModelSuggestions(llmFreeModels);
        }
        fillLlmConfigInputs();
        loadLlmChannel();
        getVideoChannelConfig();
        if (videoChannel === "platform") {
          const cfg = getVideoChannelConfig();
          cfg.channel = "custom_rh";
          saveVideoChannelConfig(cfg);
          fillVideoChannelForm(cfg);
        }
        saveLlmChannel();
        updateChannelSummary();
        if (json.data.vflowDefaults || json.data.wfDefaults) {
          const vd = json.data.vflowDefaults || json.data.wfDefaults;
          vflowDefaults = {
            length: vd.length || 113,
            fps: vd.fps || 16,
            landscape: vd.landscape || vflowDefaults.landscape,
            portrait: vd.portrait || vflowDefaults.portrait,
          };
          if (projectTiming.length == null || projectTiming.length === 113) {
            projectTiming.length = vflowDefaults.length;
          }
          if (projectTiming.fps == null || projectTiming.fps === 16) {
            projectTiming.fps = vflowDefaults.fps;
          }
          if (vflowFpsEl && !vflowFpsEl.value) {
            vflowFpsEl.value = String(projectTiming.fps);
          }
          syncInspectorLocaleLabels();
        }
      }
    } catch (e) {
      console.warn("fetch /api/config failed", e);
      serverLlmConfigured = false;
      fillLlmConfigInputs();
    }
    if (editorShell && !editorShell.classList.contains("hidden")) {
      updateLlmButtonState();
      syncLengthPresetActive();
    }
  }

  /**
   * Replace 层1 mains (and clear 层2 storyboard clips). Preserve higher video
   * tracks, audio tracks, and clips on those tracks.
   */
  function applyLlmPrompts(storyboard) {
    const shotDurations = resolveShotDurationsForLlm(
      storyboard && Array.isArray(storyboard.shots)
        ? storyboard.shots.length
        : null
    );
    const normalized = normalizeStoryboardResult(storyboard, null, null, {
      shotDurations,
    });
    ensureDefaultTrack();
    const clearIds = storyboardLayerTrackIds(false);
    clearClipsOnTracks(clearIds);
    const tid = layer1VideoTrackId();
    let cursor = 0;
    const newMains = normalized.shots.map((shot) => {
      const m = emptyMain(shot.prompt, { trackId: tid, startSec: cursor });
      m.title = shot.title || "";
      m.beat = shot.beat || shot.prompt || "";
      m.camera = shot.camera || "";
      m.cutToNext = shot.cutToNext === "soft" ? "soft" : "hard";
      m.usedRefs = Array.isArray(shot.usedRefs) ? shot.usedRefs.slice() : [];
      m.durationSec =
        shot.durationSec != null && Number(shot.durationSec) > 0
          ? Number(shot.durationSec)
          : getStoryboardMainDurationSec();
      m.useGlobalTiming = true;
      m.fps = null;
      m.length = null;
      m.outSec = (Number(m.inSec) || 0) + Number(m.durationSec);
      cursor = clipTimelineEnd(m);
      return m;
    });
    mains = newMains.concat(mains);
    storyboardState = {
      scriptSynopsis: normalized.script_synopsis || "",
      totalDurationSec: clampTargetDurationSec(
        normalized.totalDurationSec,
        getStoryboardTargetDurationSec()
      ),
      shots: normalized.shots.map((shot) => ({ ...shot })),
      bridges: normalized.bridges.map((bridge) => ({ ...bridge })),
      lastPolishSummary: "",
    };
    // 新主段 id 会使旧选中失效；清空后由 ensureValidSelection 自动点选第一段
    selectedClip = null;
    scheduleIndex = -1;
    playheadSec = 0;
    renderAll();
    scheduleSaveDraft();
    updateLlmButtonState();
  }

  async function regenerateBridgePrompts() {
    syncLlmConfiguredFromLocal();
    if (!llmConfigured || llmGenerating) return;
    const layerMains = mainsOnLayer1();
    if (layerMains.length < 2) {
      alert(t("storyboard.needTwoMains"));
      return;
    }
    if (layerMains.some((m) => !(m.prompt || "").trim())) {
      alert(t("storyboard.needAdjacentPrompts"));
      return;
    }
    if (!llmConfigured) {
      alert(t("storyboard.configureLlm"));
      openSettingsModal("llm");
      return;
    }
    llmGenerating = true;
    updateLlmButtonState();
    const modelLabel = getSelectedLlmModel() || "platform";
    if (llmStatus) llmStatus.textContent = t("storyboard.regenBridgesProgress", { model: modelLabel });
    try {
      const br = await applyAutoBridges({ withLlm: true });
      renderAll();
      scheduleSaveDraft();
      updateLlmButtonState();
      if (!br.bridgeCount) {
        if (llmStatus) llmStatus.textContent = t("storyboard.noBridgesGenerated");
        return;
      }
      if (br.llmOk) {
        if (llmStatus) {
          llmStatus.textContent = `已更新 ${br.bridgeCount} 条桥提示词并重排层2`;
        }
      } else {
        const errText = br.llmError || t("common.unknownError");
        if (llmStatus) {
          llmStatus.textContent = `已铺 ${br.bridgeCount} 桥槽，桥提示词失败（可再试或手改）`;
        }
        alert(`桥提示词生成失败：${errText}`);
        console.warn("bridge LLM failed:", br.llmError);
      }
    } catch (e) {
      if (llmStatus) llmStatus.textContent = "";
      alert(formatBridgeLlmError(e));
    } finally {
      llmGenerating = false;
      updateLlmButtonState();
    }
  }

  async function generateLlmPrompts() {
    syncLlmConfiguredFromLocal();
    if (!llmConfigured || llmGenerating) return;
    const ep = currentEpisode();
    const episodeScript = ep && (ep.script || "").trim();
    const episodeBeats = (ep && ep.beats) || [];
    const scene =
      (sceneDescriptionEl ? sceneDescriptionEl.value.trim() : "") ||
      (currentScript && (currentScript.sceneBible || "").trim()) ||
      "";
    const plot =
      (plotDirectionEl ? plotDirectionEl.value.trim() : "") ||
      episodeScript ||
      (currentScript && (currentScript.plotDirection || "").trim()) ||
      "";
    if (!scene) {
      alert(t("storyboard.fillScene"));
      if (sceneDescriptionEl) sceneDescriptionEl.focus();
      return;
    }
    if (!plot && !episodeScript) {
      alert(t("storyboard.needEpisodeScript"));
      setStoryboardStep("script");
      return;
    }

    if (!llmConfigured) {
      alert(t("storyboard.configureLlm"));
      openSettingsModal("llm");
      return;
    }

    const wantBridges = isAutoBridgeEnabled();
    const confirmMsg = wantBridges
      ? t("storyboard.confirmLlmWithBridge")
      : t("storyboard.confirmLlmNoBridge");
    if (!confirm(confirmMsg)) {
      return;
    }

    const pick = llmPickCountEl && llmPickCountEl.checked;
    let segmentCount = null;
    if (!pick) {
      const n = getStoryboardSegmentCountValue();
      if (segmentCountEl) segmentCountEl.value = String(n);
      segmentCount = n;
    }
    const targetDurationSec = getStoryboardTargetDurationSec();
    if (storyboardTargetDurationEl) {
      storyboardTargetDurationEl.value = String(targetDurationSec);
    }
    const mainDurationSec = getStoryboardMainDurationSec();
    if (storyboardMainDurationEl) {
      storyboardMainDurationEl.value = String(mainDurationSec);
    }

    llmGenerating = true;
    updateLlmButtonState();
    const modelLabel = getSelectedLlmModel() || "platform";
    if (llmStatus) {
      llmStatus.textContent = warnIfRefContentMissing()
        ? t("storyboard.refContentMissingWarn")
        : t("storyboard.genMainsProgress", { model: modelLabel });
      if (warnIfRefContentMissing()) {
        // Soft warn then continue with normal progress text after a tick
        setTimeout(() => {
          if (llmGenerating && llmStatus) {
            llmStatus.textContent = t("storyboard.genMainsProgress", {
              model: modelLabel,
            });
          }
        }, 1600);
      }
    }
    try {
      const storyboard = await callLlmPrompts({
        scene,
        plot,
        segmentCount,
        targetDurationSec,
        episodeScript,
        episodeBeats,
      });
      if (!storyboard || !Array.isArray(storyboard.shots) || !storyboard.shots.length) {
        throw new Error(t("storyboard.noPromptsReturned"));
      }
      applyLlmPrompts(storyboard);

      let bridgeNote = "";
      let bridgeFailedDetail = "";
      if (wantBridges && mainsOnLayer1().length >= 2) {
        if (llmStatus) llmStatus.textContent = `主段已就绪，正在生成桥提示词…`;
        const br = await applyAutoBridges({ withLlm: true });
        renderAll();
        scheduleSaveDraft();
        updateLlmButtonState();
        if (br.bridgeCount > 0) {
          if (br.llmOk) {
            bridgeNote = ` + ${br.bridgeCount} 桥`;
          } else {
            bridgeNote = ` + ${br.bridgeCount} 桥槽（桥提示词失败，可点「重新生成桥提示词」）`;
            bridgeFailedDetail = br.llmError || t("common.unknownError");
            console.warn("bridge LLM failed:", br.llmError);
          }
        }
      }

      if (llmStatus) {
        llmStatus.textContent = bridgeFailedDetail
          ? `已生成 ${storyboard.shots.length} 主${bridgeNote}：${bridgeFailedDetail}`
          : `已生成 ${storyboard.shots.length} 主${bridgeNote}，可点「生成待跑主段」；主段出片后可点「生成待跑桥段」`;
      }
    } catch (e) {
      if (llmStatus) llmStatus.textContent = "";
      alert(e.message || String(e));
    } finally {
      llmGenerating = false;
      updateLlmButtonState();
    }
  }

  // —— Auth / boot helpers ——

  async function doLogin() {
    const username = (loginUsername && loginUsername.value || "").trim();
    const password = (loginPassword && loginPassword.value) || "";
    try {
      const data = await postJson("/api/auth/login", { username, password });
      currentUser = data.user;
      await bootEditor();
    } catch (e) {
      showLogin(e.message || String(e));
    }
  }

  async function doRegister() {
    if (!allowSelfRegister) {
      showLogin(t("auth.selfRegisterDisabled"));
      return;
    }
    const username = (loginUsername && loginUsername.value || "").trim();
    const password = (loginPassword && loginPassword.value) || "";
    const confirm = (loginPasswordConfirm && loginPasswordConfirm.value) || "";
    if (username.length < 2) {
      showLogin(t("auth.usernameTooShort"));
      return;
    }
    if (password.length < 6) {
      showLogin(t("auth.passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      showLogin(t("auth.passwordMismatch"));
      return;
    }
    try {
      const data = await postJson("/api/auth/register", { username, password });
      currentUser = data.user;
      await bootEditor();
    } catch (e) {
      showLogin(e.message || String(e));
    }
  }

  async function doLogout() {
    try {
      await postJson("/api/auth/logout", {});
    } catch (e) {
      console.warn(e);
    }
    stopJobPolling();
    currentUser = null;
    currentProjectId = null;
    userJobsCache = [];
    renderJobsPanel();
    setAuthMode("login");
    showLogin("");
  }

  async function ensureSession() {
    try {
      // Avoid apiJson 401 → showLogin side effects while the user may be typing.
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success || !json.data || !json.data.user) return false;
      currentUser = json.data.user;
      return true;
    } catch (e) {
      return false;
    }
  }

  let editorShellInitialized = false;

  function initEditorShell() {
    if (editorShellInitialized) return;
    editorShellInitialized = true;
    setActivePhase(1);
    setPreviewSource(null, "");
    syncLlmCountUi();
    syncOrientButtonsFromSize();
    syncLengthPresetActive();
    updateLlmButtonState();
  }

  async function bootEditor() {
    initEditorShell();
    showEditor();
    await fetchServerConfig();
    await fetchPlatformEditors().catch(() => {});
    await refreshProjectList();
    await refreshAssetLibrary();
    refreshUserJobs().catch(() => {});
    resumeLocalJobs().catch((e) => console.warn(e));
    const remembered = Number(localStorage.getItem(PROJECT_KEY) || 0);
    let targetId = null;
    if (remembered && projectList.some((p) => p.id === remembered)) {
      targetId = remembered;
    } else if (projectList.length) {
      targetId = projectList[0].id;
    }
    if (targetId) {
      await loadProject(targetId, { skipSave: true });
    } else {
      await createProjectAndOpen();
      resetEditorState();
      await saveDraftImmediate();
    }
  }

    // —— Events ——

  imageInput.addEventListener("change", () => {
    const file = imageInput.files && imageInput.files[0];
    if (file) setImageFile(file);
  });

  function isImageFile(file) {
    return file && /^image\/(jpeg|png|webp|jpg)/i.test(file.type);
  }

  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const file =
      e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!isImageFile(file)) {
      alert(t("common.invalidImageType"));
      return;
    }
    setImageFile(file);
  });

  btnAddPrompt.addEventListener("click", () => {
    addMain("");
  });
  btnImport.addEventListener("click", () => {
    importBox.classList.remove("hidden");
    importActions.classList.remove("hidden");
    importBox.focus();
  });
  btnCancelImport.addEventListener("click", () => {
    importBox.classList.add("hidden");
    importActions.classList.add("hidden");
    importBox.value = "";
  });
  btnConfirmImport.addEventListener("click", async () => {
    const lines = importBox.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) {
      alert(t("common.noImportPrompts"));
      return;
    }
    applyLlmPrompts({ prompts: lines });
    importBox.classList.add("hidden");
    importActions.classList.add("hidden");
    importBox.value = "";

    if (isAutoBridgeEnabled() && mainsOnLayer1().length >= 2) {
      syncLlmConfiguredFromLocal();
      const withLlm = !!llmConfigured;
      const br = await applyAutoBridges({ withLlm });
      renderAll();
      scheduleSaveDraft();
      if (withLlm && !br.llmOk && br.bridgeCount > 0) {
        alert(
          `已导入主段并铺好 ${br.bridgeCount} 个桥槽，但桥提示词生成失败：${
            br.llmError || t("common.unknownError")
          }\n可点「重新生成桥提示词」重试，或在列表中手改。`
        );
      }
    }
  });

  if (llmPickCountEl) {
    llmPickCountEl.addEventListener("change", () => {
      syncLlmCountUi();
      scheduleSaveDraft();
    });
  }
  if (llmAutoBridgeEl) {
    llmAutoBridgeEl.addEventListener("change", scheduleSaveDraft);
  }
  if (segmentCountEl) {
    segmentCountEl.addEventListener("change", () => {
      segmentCountEl.value = String(getStoryboardSegmentCountValue());
      syncStoryboardTargetDurationUi();
      scheduleSaveDraft();
    });
    segmentCountEl.addEventListener("input", () => {
      syncStoryboardTargetDurationUi();
      scheduleSaveDraft();
    });
  }
  if (storyboardTargetDurationEl) {
    storyboardTargetDurationEl.addEventListener("change", () => {
      if (isStoryboardSegmentCountManual()) {
        syncStoryboardTargetDurationUi();
      } else {
        storyboardTargetDurationEl.value = String(getStoryboardTargetDurationSec());
      }
      scheduleSaveDraft();
    });
    storyboardTargetDurationEl.addEventListener("input", scheduleSaveDraft);
  }
  if (storyboardMainDurationEl) {
    storyboardMainDurationEl.addEventListener("change", () => {
      storyboardMainDurationEl.value = String(getStoryboardMainDurationSec());
      syncStoryboardTargetDurationUi();
      const segDur = getStoryboardSegmentDurationSec();
      let changed = false;
      mains.forEach((m) => {
        if (m.useGlobalTiming === false) return;
        m.durationSec = segDur;
        m.fps = null;
        m.length = null;
        if (syncPendingClipOutSec(m)) changed = true;
      });
      bridges.forEach((b) => {
        if (b.needBridge === false || b.useGlobalTiming === false) return;
        b.durationSec = null;
        b.fps = null;
        b.length = null;
        b.inSec = 0;
        b.outSec = segDur;
        changed = true;
      });
      if (changed) {
        try {
          relayoutStoryboardTracks(true);
        } catch (e) {
          /* ignore before clips ready */
        }
        renderAll();
      }
      syncStoryboardEngineUi();
      syncDurationPresetActive();
      scheduleSaveDraft();
    });
    storyboardMainDurationEl.addEventListener("input", () => {
      syncStoryboardTargetDurationUi();
      scheduleSaveDraft();
    });
  }

  (function wireStoryboardEngineUi() {
    const engineEl = document.getElementById("storyboardEngine");
    const useMultiEl = document.getElementById("storyboardUseMultiRef");
    const fileInput = document.getElementById("storyboardRefFileInput");
    const btnImg = document.getElementById("btnAddStoryboardRefImage");
    const btnVid = document.getElementById("btnAddStoryboardRefVideo");
    const btnAud = document.getElementById("btnAddStoryboardRefAudio");
    const btnSkeleton = document.getElementById("btnInsertPromptSkeleton");
    const mediaBinUseMultiEl = document.getElementById("mediaBinUseMultiRef");
    const mediaBinFileInput = document.getElementById("mediaBinRefFileInput");
    const btnMediaBinImg = document.getElementById("btnAddMediaBinRefImage");
    const btnMediaBinVid = document.getElementById("btnAddMediaBinRefVideo");
    const btnMediaBinAud = document.getElementById("btnAddMediaBinRefAudio");
    if (engineEl) {
      engineEl.addEventListener("change", () => {
        applyStoryboardEngineProfile(engineEl.value);
        try {
          relayoutStoryboardTracks(true);
        } catch (e) {
          /* ignore before clips ready */
        }
        renderPromptList();
        syncTimingInspectorUI();
        scheduleSaveDraft();
      });
    }
    function onUseMultiRefChange(checked) {
      storyboardUseMultiRef = !!checked;
      syncStoryboardEngineUi();
      scheduleSaveDraft();
    }
    if (useMultiEl) {
      useMultiEl.addEventListener("change", () => {
        onUseMultiRefChange(useMultiEl.checked);
      });
    }
    if (mediaBinUseMultiEl) {
      mediaBinUseMultiEl.addEventListener("change", () => {
        onUseMultiRefChange(mediaBinUseMultiEl.checked);
      });
    }
    function pickRefFile(kind, inputEl) {
      if (!inputEl) return;
      storyboardRefPickKind = kind;
      inputEl.accept =
        kind === "video" ? "video/*" : kind === "audio" ? "audio/*" : "image/*";
      inputEl.click();
    }
    if (btnImg && fileInput) {
      btnImg.addEventListener("click", () => pickRefFile("image", fileInput));
    }
    if (btnVid && fileInput) {
      btnVid.addEventListener("click", () => pickRefFile("video", fileInput));
    }
    if (btnAud && fileInput) {
      btnAud.addEventListener("click", () => pickRefFile("audio", fileInput));
    }
    if (btnMediaBinImg && mediaBinFileInput) {
      btnMediaBinImg.addEventListener("click", () =>
        pickRefFile("image", mediaBinFileInput)
      );
    }
    if (btnMediaBinVid && mediaBinFileInput) {
      btnMediaBinVid.addEventListener("click", () =>
        pickRefFile("video", mediaBinFileInput)
      );
    }
    if (btnMediaBinAud && mediaBinFileInput) {
      btnMediaBinAud.addEventListener("click", () =>
        pickRefFile("audio", mediaBinFileInput)
      );
    }
    function onRefFileChosen(inputEl) {
      const f = inputEl.files && inputEl.files[0];
      inputEl.value = "";
      if (f) uploadStoryboardRefFile(f, storyboardRefPickKind);
    }
    if (fileInput) {
      fileInput.addEventListener("change", () => onRefFileChosen(fileInput));
    }
    if (mediaBinFileInput) {
      mediaBinFileInput.addEventListener("change", () =>
        onRefFileChosen(mediaBinFileInput)
      );
    }
    if (btnSkeleton) {
      btnSkeleton.addEventListener("click", () => {
        const E = window.VflowStoryboardEngines;
        const hints = E
          ? E.writingHints(storyboardEngineProfile, storyboardUseMultiRef)
          : null;
        if (!hints || !hints.skeleton) return;
        const sk = String(hints.skeleton).replace(
          "{duration}",
          String(getStoryboardMainDurationSec())
        );
        const target =
          selectedClip && selectedClip.kind === "main"
            ? mains.find((m) => m.id === selectedClip.id)
            : mains[0];
        if (!target) return;
        target.prompt = sk;
        target.dirty = true;
        renderPromptList();
        scheduleSaveDraft();
      });
    }
    syncStoryboardEngineUi();
  })();
  if (sceneDescriptionEl) {
    sceneDescriptionEl.addEventListener("input", scheduleSaveDraft);
  }
  if (plotDirectionEl) {
    plotDirectionEl.addEventListener("input", scheduleSaveDraft);
  }
  if (btnLlmGenerate) {
    btnLlmGenerate.addEventListener("click", () => {
      generateLlmPrompts();
    });
  }
  if (btnRegenBridges) {
    btnRegenBridges.addEventListener("click", () => {
      regenerateBridgePrompts();
    });
  }
  if (btnStoryboardPolish) {
    btnStoryboardPolish.addEventListener("click", async () => {
      syncLlmConfiguredFromLocal();
      if (!llmConfigured || storyboardPolishBusy) return;
      const instruction = (storyboardPolishInputEl && storyboardPolishInputEl.value || "").trim();
      if (!instruction) {
        alert(t("storyboard.polishNeedInstruction"));
        return;
      }
      storyboardState = buildStoryboardStateFromClips();
      const clips = collectLayer12Clips();
      const targets = getPolishTargetIds(clips);
      if (!clips.length) {
        alert(t("storyboard.polishNeedClips"));
        return;
      }
      if (!targets.length) {
        alert(t("storyboard.polishNeedSegment"));
        return;
      }
      const scope =
        polishScopeMode === "all"
          ? "all"
          : `selected:${targets.join(",")}`;
      storyboardPolishBusy = true;
      if (storyboardPolishStatusEl) {
        storyboardPolishStatusEl.textContent = t("storyboard.polishBusy");
      }
      updateLlmButtonState();
      try {
        const draft = await callStoryboardPolish({
          scope,
          instruction,
          storyboard: storyboardStateToPayload(storyboardState, targets),
        });
        storyboardPolishDraft = draft;
        if (storyboardPolishDraft && typeof storyboardPolishDraft === "object") {
          storyboardPolishDraft.polishTargetIds = targets;
        }
        if (storyboardPolishDiffEl) {
          storyboardPolishDiffEl.textContent = describeStoryboardPatch(draft);
        }
        if (storyboardPolishStatusEl) {
          storyboardPolishStatusEl.textContent =
            draft.summary || t("storyboard.polishReady");
        }
        if (btnStoryboardApplyPatch) btnStoryboardApplyPatch.disabled = false;
      } catch (e) {
        if (storyboardPolishStatusEl) {
          storyboardPolishStatusEl.textContent = e.message || String(e);
        }
      } finally {
        storyboardPolishBusy = false;
        updateLlmButtonState();
      }
    });
  }
  document.querySelectorAll("[data-polish-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-polish-scope") === "selected" ? "selected" : "all";
      if (mode === polishScopeMode) return;
      polishScopeMode = mode;
      if (mode === "selected") {
        collectLayer12Clips().forEach((c) => polishSelectedIds.add(c.id));
      }
      renderPromptList();
      updateLlmButtonState();
    });
  });
  if (btnStoryboardApplyPatch) {
    btnStoryboardApplyPatch.addEventListener("click", () => {
      if (!storyboardPolishDraft) return;
      applyStoryboardPatchDraft(storyboardPolishDraft);
      if (storyboardPolishStatusEl) {
        storyboardPolishStatusEl.textContent =
          storyboardPolishDraft.summary || t("storyboard.polishApplied");
      }
      if (storyboardPolishDiffEl) {
        storyboardPolishDiffEl.textContent = t("storyboard.polishDiffEmpty");
      }
      storyboardPolishDraft = null;
      btnStoryboardApplyPatch.disabled = true;
    });
  }
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener("click", () =>
      openSettingsModal("workflows")
    );
  }
  if (btnOpenAdmin) {
    btnOpenAdmin.addEventListener("click", () => {
      location.href = "/admin";
    });
  }
  if (settingsModal) {
    settingsModal.querySelectorAll("[data-close-settings]").forEach((el) => {
      el.addEventListener("click", () => closeSettingsModal());
    });
    settingsModal.querySelectorAll(".settings-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        setSettingsTab(btn.getAttribute("data-settings-tab") || "workflows");
      });
    });
    settingsModal.querySelectorAll("[data-goto-settings-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setSettingsTab(btn.getAttribute("data-goto-settings-tab") || "agent");
      });
    });
    document.querySelectorAll('input[name="videoChannel"]').forEach((el) => {
      el.addEventListener("change", () => {
        saveVideoChannelConfig(readVideoChannelForm());
        if (el.value === "custom_rh" || el.value === "comfyui") {
          checkLocalAgent({ silent: true });
        }
        renderWorkflowTables();
        closeWorkflowDock();
      });
    });
    document.querySelectorAll('input[name="llmChannel"]').forEach((el) => {
      el.addEventListener("change", () => {
        saveLlmChannel(el.value);
        syncSettingsChannelPanels();
        if (el.value === "custom") {
          checkLocalAgent({ silent: true });
        }
      });
    });
  }
  function llmProviderIdFromEvent(ev) {
    const card = ev.target && ev.target.closest("[data-provider-id]");
    return card ? card.getAttribute("data-provider-id") : "";
  }

  if (llmActiveSelectEl) {
    llmActiveSelectEl.addEventListener("change", () => {
      applyModelFromSelect(llmActiveSelectEl);
    });
  }
  if (storyboardLlmModelEl) {
    storyboardLlmModelEl.addEventListener("change", () => {
      applyModelFromSelect(storyboardLlmModelEl);
    });
  }
  if (scriptLlmModelEl) {
    scriptLlmModelEl.addEventListener("change", () => {
      applyModelFromSelect(scriptLlmModelEl);
    });
  }
  if (btnLlmAddProvider) {
    btnLlmAddProvider.addEventListener("click", () => {
      const showing =
        llmAddProviderFormEl &&
        !llmAddProviderFormEl.classList.contains("hidden");
      showLlmAddProviderForm(!showing);
    });
  }
  if (btnLlmSaveProvider) {
    btnLlmSaveProvider.addEventListener("click", () => {
      addLlmProviderFromForm();
    });
  }
  if (btnLlmCancelProvider) {
    btnLlmCancelProvider.addEventListener("click", () => {
      showLlmAddProviderForm(false);
    });
  }
  if (llmProvidersListEl) {
    llmProvidersListEl.addEventListener("click", (ev) => {
      const actEl = ev.target.closest("[data-act]");
      const id = llmProviderIdFromEvent(ev);
      if (!id || !actEl) return;
      const act = actEl.getAttribute("data-act");
      if (act === "delete") {
        ev.preventDefault();
        deleteLlmProvider(id);
        return;
      }
      if (act === "activate") {
        const cfg = loadLlmLocalConfig();
        const p = cfg.providers.find((x) => x.id === id);
        const keep =
          cfg.activeProviderId === id
            ? cfg.model
            : (p && p.models[0]) || "";
        setActiveLlmSelection(id, keep);
        return;
      }
      if (act === "toggle") {
        llmEditingProviderId = llmEditingProviderId === id ? "" : id;
        renderLlmProvidersUi();
        return;
      }
      if (act === "add-model") {
        const card = actEl.closest("[data-provider-id]");
        const input = card && card.querySelector("[data-act='new-model']");
        addModelToProvider(id, input && input.value);
        return;
      }
      if (act === "remove-model") {
        removeModelFromProvider(id, actEl.getAttribute("data-model"));
        return;
      }
      if (act === "use-model") {
        setActiveLlmSelection(id, actEl.getAttribute("data-model"));
        return;
      }
      if (act === "fill-popular") {
        refreshLlmFreeModels(id);
      }
    });
    llmProvidersListEl.addEventListener("change", (ev) => {
      const field = ev.target.getAttribute("data-field");
      const id = llmProviderIdFromEvent(ev);
      if (!field || !id) return;
      patchLlmProviderFields(id);
      renderLlmProvidersUi();
    });
    llmProvidersListEl.addEventListener(
      "blur",
      (ev) => {
        const field =
          ev.target && ev.target.getAttribute
            ? ev.target.getAttribute("data-field")
            : "";
        const id = llmProviderIdFromEvent(ev);
        if (field && id) patchLlmProviderFields(id);
      },
      true
    );
    llmProvidersListEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (ev.target.getAttribute("data-act") !== "new-model") return;
      ev.preventDefault();
      addModelToProvider(llmProviderIdFromEvent(ev), ev.target.value);
    });
  }

  function wireWorkflowDockUi() {
    const W = window.VflowAdapter;
    const fileEl = document.getElementById("dockWorkflowFile");
    if (fileEl) {
      fileEl.addEventListener("change", async () => {
        const f = fileEl.files && fileEl.files[0];
        fileEl.value = "";
        if (!f) return;
        const st = document.getElementById("dockAdapterStatus");
        try {
          const parsed = JSON.parse(await f.text());
          if (W && typeof W.assertValidWorkflow === "function") {
            W.assertValidWorkflow(parsed);
          }
          pendingDockWorkflow = parsed;
          if (st) st.textContent = t("settings.workflowLoaded", { name: f.name });
        } catch (e) {
          pendingDockWorkflow = null;
          if (st) st.textContent = e.message || String(e);
          alert(t("common.workflowJsonInvalidPrefix") + (e.message || String(e)));
        }
      });
    }
    const btnClose = document.getElementById("btnWorkflowDockClose");
    if (btnClose) btnClose.addEventListener("click", () => closeWorkflowDock());

    const btnLlm = document.getElementById("btnDockLlm");
    if (btnLlm) {
      btnLlm.addEventListener("click", async () => {
        const F = window.VflowFeatures;
        const E = window.VflowEditors;
        const st = document.getElementById("dockAdapterStatus");
        if (
          !dockTarget ||
          (dockTarget.kind !== "feature" &&
            dockTarget.kind !== "engine" &&
            dockTarget.kind !== "editor")
        ) {
          alert(t("workflow.pickFeatureFirst"));
          return;
        }
        if (!pendingDockWorkflow) {
          alert(t("settings.uploadRhWorkflowFirst"));
          return;
        }
        syncLlmConfiguredFromLocal();
        if (!llmConfigured) {
          openSettingsModal("llm");
          alert(t("settings.configureLlmFirst"));
          return;
        }
        if (!W) {
          alert(t("common.vflowAdapterMissing"));
          return;
        }

        if (dockTarget.kind === "editor") {
          if (!E) {
            alert(t("common.localModuleMissing"));
            return;
          }
          const draft = readEditorAddForm();
          try {
            btnLlm.disabled = true;
            if (st) st.textContent = t("editor.llmBusy");
            W.assertValidWorkflow(pendingDockWorkflow);
            const raw = await generateWorkflowDraftWithLlm({
              provider: draft.provider,
              mode: "editor",
              workflow: pendingDockWorkflow,
              workflowId: draft.adapter.workflowId || "",
            });
            const manifest = E.manifestFromLlmDraft(raw, {
              provider: draft.provider,
              name: draft.name || undefined,
              workflowId: draft.adapter.workflowId,
              category: draft.category || "custom",
            });
            applyEditorDetectResult(manifest, "editor.llmOk");
          } catch (e) {
            if (st) st.textContent = e.message || String(e);
            alert(e.message || String(e));
          } finally {
            updateLlmButtonState();
          }
          return;
        }

        let provider;
        let llmMode;
        let modeKey;
        if (dockTarget.kind === "engine") {
          const U = window.VflowUserEngines;
          const eng = U && U.get(dockTarget.id);
          if (!eng) return;
          provider = eng.provider === "comfyui" ? "comfyui" : "runninghub";
          llmMode = dockTarget.slot === "bridge" ? "flf" : "i2v";
          modeKey = llmMode;
        } else {
          if (!F) {
            alert(t("common.vflowAdapterMissing"));
            return;
          }
          const feature = F.getFeature(dockTarget.id);
          if (!feature) return;
          const cfg = getVideoChannelConfig();
          provider = cfg.channel === "comfyui" ? "comfyui" : "runninghub";
          llmMode = F.llmModeForFeature(feature);
          modeKey = feature.id;
        }
        const wid =
          provider === "runninghub"
            ? ((document.getElementById("dockWorkflowId") || {}).value || "").trim()
            : "";
        try {
          btnLlm.disabled = true;
          if (st) st.textContent = t("editor.llmBusy");
          W.assertValidWorkflow(pendingDockWorkflow);
          const raw = await generateWorkflowDraftWithLlm({
            provider,
            mode: llmMode === "editor" ? "editor" : llmMode,
            workflow: pendingDockWorkflow,
            workflowId: wid,
          });
          let modeCfg = null;
          if (llmMode === "editor" && raw && raw.adapter) {
            modeCfg = {
              workflowId: wid || raw.adapter.workflowId || "",
              bindings: raw.adapter.bindings || {},
              params: raw.params || [],
              workflowUi: raw.adapter.workflowUi || null,
              workflow: raw.adapter.workflow || null,
            };
          } else if (raw && raw.modes) {
            modeCfg =
              raw.modes[llmMode] ||
              raw.modes[modeKey] ||
              Object.values(raw.modes)[0] ||
              null;
          }
          if (!modeCfg || !modeCfg.bindings) {
            throw new Error(t("settings.adapterLlmMissingMode", { mode: modeKey }));
          }
          if (wid) modeCfg.workflowId = wid;
          let params = Array.isArray(modeCfg.params) ? modeCfg.params : [];
          if (
            pendingDockWorkflow &&
            typeof W.fillParamDefaultsFromWorkflow === "function"
          ) {
            params = W.fillParamDefaultsFromWorkflow(
              params,
              modeCfg.bindings || {},
              pendingDockWorkflow
            );
          }
          modeCfg.params = params;
          pendingDockParams = params;
          renderParamsVisibilityList(
            document.getElementById("dockParamsVisibility"),
            pendingDockParams
          );
          const draftAdapter = {
            version: 1,
            provider,
            name: (raw && raw.name) || modeKey,
            modes: { [modeKey]: modeCfg },
          };
          const ta = document.getElementById("dockAdapterJson");
          if (ta) ta.value = JSON.stringify(draftAdapter, null, 2);
          if (st) st.textContent = t("settings.adapterModeWritten", { mode: modeKey });
        } catch (e) {
          if (st) st.textContent = e.message || String(e);
          alert(e.message || String(e));
        } finally {
          updateLlmButtonState();
        }
      });
    }

    const btnSave = document.getElementById("btnDockSave");
    if (btnSave) {
      btnSave.addEventListener("click", () => {
        const F = window.VflowFeatures;
        const st = document.getElementById("dockAdapterStatus");
        try {
          if (
            !dockTarget ||
            (dockTarget.kind !== "feature" &&
              dockTarget.kind !== "engine" &&
              dockTarget.kind !== "editor")
          ) {
            throw new Error(t("workflow.pickFeatureFirst"));
          }
          if (dockTarget.kind === "editor") {
            const ta = document.getElementById("dockAdapterJson");
            let bindings = pendingEditorBindings || {};
            if (ta && ta.value.trim()) {
              try {
                const parsed = JSON.parse(ta.value);
                if (parsed.bindings) bindings = parsed.bindings;
                else if (parsed.adapter && parsed.adapter.bindings)
                  bindings = parsed.adapter.bindings;
              } catch (e) {
                /* keep pending */
              }
            }
            pendingEditorParams = readParamsVisibilityFromList(
              document.getElementById("dockParamsVisibility"),
              pendingDockParams.length ? pendingDockParams : pendingEditorParams
            );
            pendingDockParams = pendingEditorParams;
            pendingEditorBindings = bindings;
            if (pendingDockWorkflow) {
              pendingEditorWorkflow = pendingDockWorkflow;
            }
            if (!pendingEditorWorkflow && !Object.keys(bindings).length) {
              throw new Error(t("editor.needUploadWorkflow"));
            }
            if (st) st.textContent = t("settings.adapterSavedLocal");
            updateEditorDockStatus();
            closeWorkflowDock();
            return;
          }
          if (dockTarget.kind === "engine") {
            const U = window.VflowUserEngines;
            if (!U) throw new Error(t("common.localModuleMissing"));
            const eng = U.get(dockTarget.id);
            if (!eng) throw new Error(t("engine.invalid"));
            const provider = eng.provider === "comfyui" ? "comfyui" : "runninghub";
            const modeKey = dockTarget.slot === "bridge" ? "flf" : "i2v";
            const ta = document.getElementById("dockAdapterJson");
            const draft = JSON.parse((ta && ta.value) || "");
            const modeCfg =
              (draft &&
                draft.modes &&
                (draft.modes[modeKey] || draft.modes.i2v || draft.modes.flf)) ||
              null;
            if (!modeCfg) {
              throw new Error(t("settings.adapterLlmMissingMode", { mode: modeKey }));
            }
            const wid = (
              (document.getElementById("dockWorkflowId") || {}).value || ""
            ).trim();
            if (provider === "runninghub") {
              modeCfg.workflowId = wid || modeCfg.workflowId || "";
              if (!modeCfg.workflowId) throw new Error(t("editor.needWorkflowId"));
            }
            if (
              provider === "comfyui" &&
              !modeCfg.workflow &&
              !modeCfg.workflowUi &&
              pendingDockWorkflow
            ) {
              if (W.isComfyUiWorkflow(pendingDockWorkflow)) {
                modeCfg.workflowUi = pendingDockWorkflow;
                modeCfg.workflow = W.uiWorkflowToApiPrompt(pendingDockWorkflow);
              } else {
                modeCfg.workflow = pendingDockWorkflow;
              }
            }
            modeCfg.params = readParamsVisibilityFromList(
              document.getElementById("dockParamsVisibility"),
              pendingDockParams.length ? pendingDockParams : modeCfg.params || []
            );
            const updated = U.setSlot(eng.id, dockTarget.slot, modeCfg);
            pendingEngineSlots[dockTarget.slot] =
              (updated && updated[dockTarget.slot]) || modeCfg;
            if (st) st.textContent = t("settings.adapterSavedLocal");
            closeWorkflowDock();
            renderWorkflowTables();
            fillEngineSelects();
            syncEngineDockPreview();
            return;
          }
          const feature = F && F.getFeature(dockTarget.id);
          if (!feature) throw new Error(t("workflow.pickFeatureFirst"));
          const cfg = readVideoChannelForm();
          if (cfg.channel === "platform") {
            throw new Error(t("workflow.platformReadonly"));
          }
          const provider = cfg.channel === "comfyui" ? "comfyui" : "runninghub";
          const ta = document.getElementById("dockAdapterJson");
          const draft = JSON.parse((ta && ta.value) || "");
          if (!draft || !draft.modes || !draft.modes[feature.id]) {
            throw new Error(t("settings.adapterLlmMissingMode", { mode: feature.id }));
          }
          const modeCfg = draft.modes[feature.id];
          const wid = (
            (document.getElementById("dockWorkflowId") || {}).value || ""
          ).trim();
          if (provider === "runninghub") {
            modeCfg.workflowId = wid || modeCfg.workflowId || "";
            if (!modeCfg.workflowId) throw new Error(t("editor.needWorkflowId"));
          }
          if (
            provider === "comfyui" &&
            !modeCfg.workflow &&
            !modeCfg.workflowUi &&
            pendingDockWorkflow
          ) {
            if (W.isComfyUiWorkflow(pendingDockWorkflow)) {
              modeCfg.workflowUi = pendingDockWorkflow;
              modeCfg.workflow = W.uiWorkflowToApiPrompt(pendingDockWorkflow);
            } else {
              modeCfg.workflow = pendingDockWorkflow;
            }
          }
          modeCfg.params = readParamsVisibilityFromList(
            document.getElementById("dockParamsVisibility"),
            pendingDockParams.length ? pendingDockParams : modeCfg.params || []
          );
          pendingDockParams = modeCfg.params;
          const existing = getActiveChannelAdapter(cfg) || {
            version: 1,
            provider,
            name: "",
            modes: {},
          };
          const merged = W.mergeModeAdapters(existing, {
            version: 1,
            provider,
            name: draft.name || existing.name || "",
            modes: { [feature.id]: modeCfg },
          });
          merged.provider = provider;
          const v = W.validateAdapter(merged);
          if (!v.ok) throw new Error(v.error);
          setActiveChannelAdapter(merged, cfg);
          if (st) st.textContent = t("settings.adapterSavedLocal");
          closeWorkflowDock();
          renderWorkflowTables();
        } catch (e) {
          if (st) st.textContent = e.message || String(e);
          alert(e.message || String(e));
        }
      });
    }

    const btnClear = document.getElementById("btnDockClear");
    if (btnClear) {
      btnClear.addEventListener("click", () => {
        if (!dockTarget) return;
        if (!confirm(t("workflow.confirmClearDock"))) return;
        if (dockTarget.kind === "engine") {
          const U = window.VflowUserEngines;
          if (U) U.clearSlot(dockTarget.id, dockTarget.slot);
          if (pendingEngineSlots) pendingEngineSlots[dockTarget.slot] = null;
          closeWorkflowDock();
          renderWorkflowTables();
          fillEngineSelects();
          syncEngineDockPreview();
          return;
        }
        if (dockTarget.kind === "editor") {
          pendingEditorWorkflow = null;
          pendingEditorParams = [];
          pendingEditorBindings = {};
          updateEditorDockStatus();
          closeWorkflowDock();
          return;
        }
        if (dockTarget.kind === "feature") clearFeatureDock(dockTarget.id);
      });
    }
  }
  wireWorkflowDockUi();
  wireLocalAgentUi();
  wireEditorsSettingsUi();

  btnStop.addEventListener("click", async () => {
    globalStatus.textContent = t("storyboard.stoppingQueue");
    try {
      if (currentProjectId) {
        const data = await cancelWaitingJobs(currentProjectId);
        await syncActiveJobs();
        await refreshUserJobs();
        const left = batchRunning;
        if (left) {
          globalStatus.textContent = `已取消等待 ${data.canceled || 0} 个；仍有进行中任务`;
          await promptForceFailProject();
        } else {
          globalStatus.textContent = `已取消等待 ${data.canceled || 0} 个任务`;
        }
      }
    } catch (e) {
      alert(e.message || String(e));
    }
  });
  btnSavePreset.addEventListener("click", () => saveCurrentProject());
  negativeInput.addEventListener("input", scheduleSaveDraft);
  concurrencyEl.addEventListener("change", () => {
    persistConcurrencyPref(concurrencyEl.value);
    scheduleSaveDraft();
  });
  if (duckPasswordEl) {
    duckPasswordEl.addEventListener("input", scheduleSaveDraft);
  }
  if (useDuckEncryptEl) {
    useDuckEncryptEl.addEventListener("change", () => {
      saveUseDuckEncrypt(useDuckEncryptEl.checked);
    });
  }
  loadUseDuckEncrypt();

  document.querySelectorAll(".phase-step").forEach((el) => {
    el.addEventListener("click", () => {
      const step = Number(el.dataset.step);
      setActivePhase(step);
      if (step === 1) {
        openStoryboardModal();
      }
    });
  });

  if (btnOpenStoryboard) {
    btnOpenStoryboard.addEventListener("click", () => openStoryboardModal());
  }

  if (storyboardModal) {
    storyboardModal.querySelectorAll("[data-close-storyboard]").forEach((el) => {
      el.addEventListener("click", () => closeStoryboardModal());
    });
  }

  if (btnPresetToggle) {
    btnPresetToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePresetDropdown();
    });
  }

  if (btnJobsToggle) {
    btnJobsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleJobsDropdown();
    });
  }
  if (btnJobsRefresh) {
    btnJobsRefresh.addEventListener("click", (e) => {
      e.stopPropagation();
      refreshUserJobs().catch((err) => alert(err.message || String(err)));
    });
  }
  if (btnJobsStopWaiting) {
    btnJobsStopWaiting.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        if (!currentProjectId) {
          alert(t("jobs.openProjectFirst"));
          return;
        }
        const data = await cancelWaitingJobs(currentProjectId);
        await syncActiveJobs();
        await refreshUserJobs();
        alert(`已取消等待中任务 ${data.canceled || 0} 个`);
      } catch (err) {
        alert(err.message || String(err));
      }
    });
  }
  if (btnJobsClearFinished) {
    btnJobsClearFinished.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(t("jobs.confirmClearFinished"))) {
        return;
      }
      try {
        const data = await postJson("/api/jobs/delete", { scope: "finished" });
        const before = localJobsCache.length;
        localJobsCache = localJobsCache.filter((j) =>
          isActiveJobStatus(j.status)
        );
        const localDeleted = before - localJobsCache.length;
        await refreshUserJobs();
        alert(
          t("jobs.clearedFinishedCount", {
            n: (data.deleted || 0) + localDeleted,
          })
        );
      } catch (err) {
        alert(err.message || String(err));
      }
    });
  }
  if (btnJobsForceAll) {
    btnJobsForceAll.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (
        !confirm(
          t("jobs.confirmForceAll")
        )
      ) {
        return;
      }
      try {
        await forceFailJobs({ scopeAll: true, projectId: null });
        await syncActiveJobs();
        await refreshUserJobs();
      } catch (err) {
        alert(err.message || String(err));
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (
      presetDropdown &&
      !presetDropdown.contains(e.target) &&
      presetDropdownPanel &&
      !presetDropdownPanel.classList.contains("hidden")
    ) {
      closePresetDropdown();
    }
    if (
      jobsDropdown &&
      !jobsDropdown.contains(e.target) &&
      jobsDropdownPanel &&
      !jobsDropdownPanel.classList.contains("hidden")
    ) {
      closeJobsDropdown();
    }
  });

  function getSelectedBridge() {
    if (!selectedClip || selectedClip.kind !== "bridge") return null;
    return bridges.find((x) => x.id === selectedClip.id) || null;
  }

  if (btnFlfPickStart) {
    btnFlfPickStart.addEventListener("click", () => {
      const b = getSelectedBridge();
      if (!b) return;
      openFramePicker(b.id, "start", b.leftMainId);
    });
  }

  if (btnFlfPickEnd) {
    btnFlfPickEnd.addEventListener("click", () => {
      const b = getSelectedBridge();
      if (!b) return;
      openFramePicker(b.id, "end", b.rightMainId);
    });
  }

  if (flfStartUpload) {
    flfStartUpload.addEventListener("change", () => {
      const b = getSelectedBridge();
      const file = flfStartUpload.files && flfStartUpload.files[0];
      flfStartUpload.value = "";
      if (!b || !file) return;
      assignUploadedFrame(b.id, "start", file);
    });
  }

  if (flfEndUpload) {
    flfEndUpload.addEventListener("change", () => {
      const b = getSelectedBridge();
      const file = flfEndUpload.files && flfEndUpload.files[0];
      flfEndUpload.value = "";
      if (!b || !file) return;
      assignUploadedFrame(b.id, "end", file);
    });
  }

  if (btnPickSharedFromLibrary) {
    btnPickSharedFromLibrary.addEventListener("click", () => {
      enterFrameAssetPick("shared");
    });
  }

  if (btnFlfLibStart) {
    btnFlfLibStart.addEventListener("click", () => {
      const b = getSelectedBridge();
      if (!b) return;
      enterFrameAssetPick({ bridgeId: b.id, side: "start" });
    });
  }

  if (btnFlfLibEnd) {
    btnFlfLibEnd.addEventListener("click", () => {
      const b = getSelectedBridge();
      if (!b) return;
      enterFrameAssetPick({ bridgeId: b.id, side: "end" });
    });
  }

  if (btnReplaceStart) {
    btnReplaceStart.addEventListener("click", () => imageInput.click());
  }

  if (selectedPromptEl) {
    selectedPromptEl.addEventListener("input", () => {
      if (!selectedClip) return;
      const text = selectedPromptEl.value;
      if (selectedClip.kind === "main") {
        const m = findMain(selectedClip.id);
        if (!m) return;
        if (m.prompt === text) return;
        m.prompt = text;
        m.dirty = true;
        if (m.status === "success") m.label = t("status.promptChanged");
        renderJobList();
        updatePhaseSteps();
        renderSelectionUI();
        scheduleSaveDraft();
      } else if (selectedClip.kind === "edit") {
        const ed = findEdit(selectedClip.id);
        if (!ed) return;
        if (ed.prompt === text) return;
        ed.prompt = text;
        ed.dirty = true;
        if (ed.status === "success") ed.label = t("status.promptChanged");
        renderSelectionUI();
        scheduleSaveDraft();
      } else {
        const b = bridges.find((x) => x.id === selectedClip.id);
        if (!b) return;
        if (b.prompt === text) return;
        b.prompt = text;
        b.dirty = true;
        if (b.status === "success") b.label = t("status.promptChanged");
        renderBridges();
        renderSelectionUI();
        scheduleSaveDraft();
      }
    });
  }

  if (btnOrientLandscape) {
    btnOrientLandscape.addEventListener("click", () => {
      applyOrientPreset("landscape");
      renderSelectionUI();
      updateFirstFrameSizeHint();
    });
  }
  if (btnOrientPortrait) {
    btnOrientPortrait.addEventListener("click", () => {
      applyOrientPreset("portrait");
      renderSelectionUI();
      updateFirstFrameSizeHint();
    });
  }
  if (btnWfReset) {
    btnWfReset.addEventListener("click", () => {
      resetWfToDefaults();
      renderSelectionUI();
      updateFirstFrameSizeHint();
    });
  }
  document.querySelectorAll("[data-vflow-length]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.vflowLength);
      if (!Number.isFinite(n) || !vflowLengthEl) return;
      vflowLengthEl.value = String(snapLength(n, vflowDefaults.length));
      applyTimingInputsFromUI();
      if (typeof rebuildTimeline === "function") rebuildTimeline();
      syncLengthPresetActive();
      scheduleSaveDraft();
      renderSelectionUI();
    });
  });
  document.querySelectorAll("[data-vflow-duration]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.vflowDuration);
      if (!Number.isFinite(n)) return;
      applyDurationInputsFromUI(n);
      scheduleSaveDraft();
      renderSelectionUI();
    });
  });
  if (vflowTimingGlobalEl) {
    vflowTimingGlobalEl.addEventListener("change", () => {
      onTimingGlobalToggle();
    });
  }
  // Seed project timing from current DOM defaults (template / prior session).
  projectTiming.length = snapLength(
    vflowLengthEl && vflowLengthEl.value,
    vflowDefaults.length
  );
  projectTiming.fps = clampFps(
    vflowFpsEl && vflowFpsEl.value,
    vflowDefaults.fps || 16
  );
  if (vflowFpsEl) vflowFpsEl.value = String(projectTiming.fps);
  syncTimingInspectorUI();

  [vflowWidthEl, vflowHeightEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      commitWfSizeInputs();
      scheduleSaveDraft();
      renderSelectionUI();
      updateFirstFrameSizeHint();
    });
    el.addEventListener("blur", () => {
      commitWfSizeInputs();
      scheduleSaveDraft();
      renderSelectionUI();
      updateFirstFrameSizeHint();
    });
    el.addEventListener("input", () => {
      syncOrientButtonsFromSize();
      scheduleSaveDraft();
      updateFirstFrameSizeHint();
    });
  });
  [vflowLengthEl, vflowFpsEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      applyTimingInputsFromUI();
      if (typeof rebuildTimeline === "function") rebuildTimeline();
      scheduleSaveDraft();
      renderSelectionUI();
    });
    el.addEventListener("blur", () => {
      applyTimingInputsFromUI();
      if (typeof rebuildTimeline === "function") rebuildTimeline();
      scheduleSaveDraft();
      renderSelectionUI();
    });
    el.addEventListener("input", () => {
      if (timingUiSyncing) return;
      // Live preview: apply raw numbers without snap until blur/change.
      const rawL = Number(vflowLengthEl && vflowLengthEl.value);
      const rawF = Number(vflowFpsEl && vflowFpsEl.value);
      const clip = getSelectedTimingClip();
      if (clip && clip.useGlobalTiming === false) {
        if (Number.isFinite(rawL) && rawL >= 17) clip.length = rawL;
        if (Number.isFinite(rawF) && rawF >= 1) clip.fps = rawF;
        syncPendingClipOutSec(clip);
      } else {
        if (Number.isFinite(rawL) && rawL >= 17) projectTiming.length = rawL;
        if (Number.isFinite(rawF) && rawF >= 1) projectTiming.fps = rawF;
        relayoutAfterGlobalTimingChange();
      }
      if (typeof renderTimelineTrack === "function") renderTimelineTrack();
      syncLengthPresetActive();
      scheduleSaveDraft();
    });
  });

  btnStart.addEventListener("click", () => {
    runBatch().catch((e) => {
      console.error(e);
      globalStatus.textContent = t("common.batchTaskErrorPrefix") + e.message;
      batchRunning = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
      alert(t("common.batchTaskErrorPrefix") + (e.message || String(e)));
    });
  });

  if (btnStartBridges) {
    btnStartBridges.addEventListener("click", () => {
      runBridgeBatch().catch((e) => {
        console.error(e);
        if (globalStatus) {
          globalStatus.textContent = t("common.bridgeBatchErrorPrefix") + e.message;
        }
        batchRunning = false;
        if (btnStart) btnStart.disabled = false;
        btnStartBridges.disabled = false;
        if (btnStop) btnStop.disabled = true;
        alert(t("common.bridgeBatchErrorPrefix") + (e.message || String(e)));
      });
    });
  }

  // 固定按钮用委托，避免重渲染后丢失监听；按钮本身永不 disabled
  if (inspectorEngineEl) {
    inspectorEngineEl.addEventListener("change", () => {
      const id = normalizeEngineId(inspectorEngineEl.value);
      // Project-wide: stamp every clip so sticky per-clip Wan marks cannot override UI.
      applyStoryboardEngineProfile(id);
      syncTimingInspectorUI();
      if (typeof rebuildTimeline === "function") rebuildTimeline();
      else if (typeof renderTimelineTrack === "function") renderTimelineTrack();
      renderSelectionUI();
      scheduleSaveDraft();
    });
  }
  if (selectionActions) {
    selectionActions.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const btn = t.closest("#btnGenerateSelected");
      if (!btn) return;
      onGenerateSelectedClick().catch((err) => {
        console.error(err);
        alert(err.message || String(err));
      });
    });
  }
  ensureGenerateSelectedButton();
  syncSelectionActionButtons();

  if (assetOriginTabs) {
    assetOriginTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-origin]");
      if (!btn) return;
      setAssetLibraryOrigin(btn.dataset.origin);
    });
    assetOriginTabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tabs = Array.from(assetOriginTabs.querySelectorAll("[data-origin]"));
      const current = tabs.findIndex((tab) => tab.dataset.origin === assetLibraryOrigin);
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(current + delta + tabs.length) % tabs.length];
      if (next) {
        e.preventDefault();
        setAssetLibraryOrigin(next.dataset.origin);
        next.focus();
      }
    });
  }
  if (btnVideoThumbPreview) {
    syncVideoThumbPreviewButton();
    btnVideoThumbPreview.addEventListener("click", () => {
      setAssetVideoThumbPreview(!assetVideoThumbPreview);
    });
  }
  if (btnImportAssets && importAssetsInput) {
    btnImportAssets.addEventListener("click", () => {
      const projectId = importTargetProjectId();
      if (!projectId) {
        alert(t("bins.importNeedProject"));
        return;
      }
      if (
        assetLibraryOrigin === "local" &&
        (!agentConnected || !window.VflowLocal || !window.VflowLocal.putBlob)
      ) {
        alert(t("bins.importNeedAgent"));
        return;
      }
      importAssetsInput.click();
    });
    importAssetsInput.addEventListener("change", () => {
      const files = importAssetsInput.files;
      importLocalAssets(files)
        .catch((err) => {
          console.error(err);
          alert((err && err.message) || String(err));
        })
        .finally(() => {
          importAssetsInput.value = "";
        });
    });
  }
  if (btnAssetFolderUp) {
    btnAssetFolderUp.addEventListener("click", () => {
      assetLibraryGoUp();
    });
  }
  updateAssetLibraryChrome();

  btnPlaylistPlay.addEventListener("click", () => {
    toggleTimelinePlayback();
  });
  btnPlaylistPrev.addEventListener("click", () => {
    if (exportState) return;
    if (isComposePlayMode()) playTimelinePrev();
    else stepSlotClip(-1);
  });
  btnPlaylistNext.addEventListener("click", () => {
    if (exportState) return;
    if (isComposePlayMode()) playTimelineNext();
    else stepSlotClip(1);
  });
  if (chkComposePlay) {
    chkComposePlay.addEventListener("change", () => {
      if (timelinePlaying) stopTimelinePlayback();
      updatePlaylistMeta();
    });
  }
  if (btnExportVideo) {
    btnExportVideo.addEventListener("click", () => {
      runTimelineExport().catch((err) => {
        console.error(err);
        alert(err.message || String(err));
      });
    });
  }
  function bindPreviewVideoTransportEvents(el) {
    if (!el) return;
    el.addEventListener("pause", () => {
      if (el !== playlistVideo) return;
      if (mediaSyncLock) return;
      // End-of-media fires pause before/alongside "ended"; ignore it so the
      // schedule can advance (full-length segments like bridges hit EOF).
      if (playlistVideo.ended) return;
      if (timelinePlaying) stopTimelinePlayback();
    });
    el.addEventListener("play", () => {
      if (el !== playlistVideo) return;
      if (mediaSyncLock) return;
      if (timelinePlaying) return;
      if (!previewLoadedUrl && !playlistVideo.getAttribute("src")) return;
      // Slot mode / standalone clip preview: leave native playback alone.
      if (!isComposePlayMode()) return;
      buildSchedule();
      if (!schedule.length) return;
      playTimelineFromStart();
    });
    el.addEventListener("ended", () => {
      if (el !== playlistVideo) return;
      if (!timelinePlaying) return;
      // Prefer schedule advance (handles layer fallback / gaps) over raw next index.
      // Ignore stale ended after rAF already moved playhead onto the next segment.
      const item = activeSegment;
      if (!item) {
        if (isComposePlayMode()) playTimelineNext();
        else stopTimelinePlayback();
        return;
      }
      if (playheadSec < item.gEnd - 0.05) return;
      advanceFromSegment();
    });
  }
  previewVideoElements().forEach(bindPreviewVideoTransportEvents);

  if (btnTlZoomIn) {
    btnTlZoomIn.addEventListener("click", () => setPxPerSec(pxPerSec * 1.25));
  }
  if (btnTlZoomOut) {
    btnTlZoomOut.addEventListener("click", () => setPxPerSec(pxPerSec / 1.25));
  }
  if (btnTlFit) {
    btnTlFit.addEventListener("click", () => fitTimelineZoom());
  }
  if (btnTlAddVideoTrack) {
    btnTlAddVideoTrack.addEventListener("click", () => addVideoTrack());
  }
  if (btnTlAddAudioTrack) {
    btnTlAddAudioTrack.addEventListener("click", () => addAudioTrack());
  }
  if (timelineLabels) {
    // Click anywhere on the track labels column to exit ruler range selection
    timelineLabels.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (!timelineSelection) return;
      clearTimelineSelection();
    });
  }
  if (timelineTracks) {
    // Click empty track area outside the box selection to exit
    timelineTracks.addEventListener("click", (e) => {
      if (e.target.closest(".tl-clip")) return;
      clearTimelineSelectionIfOutsideSec(timelineSecFromClientX(e.clientX));
    });
  }
  if (timelineRuler) {
    timelineRuler.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (!timelineScroll) return;
      const startSec = timelineSecFromClientX(e.clientX);
      scrubFromRulerEvent(e);
      rangeDragState = {
        dragging: true,
        startSec,
        endSec: startSec,
      };
      const onMove = (ev) => {
        scrubFromRulerEvent(ev);
        if (!rangeDragState) return;
        rangeDragState.endSec = timelineSecFromClientX(ev.clientX);
        const a = rangeDragState.startSec;
        const b = rangeDragState.endSec;
        if (Math.abs(b - a) >= 0.05) {
          setTimelineSelection(selectionFromRange(a, b));
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (rangeDragState) {
          const a = rangeDragState.startSec;
          const b = rangeDragState.endSec;
          if (Math.abs(b - a) >= 0.05) {
            setTimelineSelection(selectionFromRange(a, b));
          } else {
            // Click (no drag): clear selection when outside the current box
            clearTimelineSelectionIfOutsideSec(a);
          }
          rangeDragState = null;
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    timelineRuler.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (
        !timelineSelection ||
        (timelineSelection.kind !== "range" &&
          timelineSelection.kind !== "frame")
      ) {
        setTimelineSelection(selectionFromPlayhead());
      }
      openTimelineContextMenu(e.clientX, e.clientY, {});
    });
  }
  if (timelineScroll) {
    timelineScroll.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setPxPerSec(pxPerSec * factor);
      },
      { passive: false }
    );
    timelineScroll.addEventListener(
      "scroll",
      () => {
        if (clipCtxMenuEl) closeClipContextMenu();
      },
      { passive: true }
    );
  }
  window.addEventListener("resize", () => {
    if (timelineCanvas) renderTimelineTrack();
  });

  framePickerModal.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => closeFramePicker());
  });
  btnPickerBack.addEventListener("click", () => seekPicker(-0.2));
  btnPickerFwd.addEventListener("click", () => seekPicker(0.2));
  btnCaptureFrame.addEventListener("click", () => {
    captureCurrentFrame().catch((e) => alert(e.message || e));
  });
  function isTypingTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return !!el.closest("[contenteditable='true']");
  }

  function toggleTimelinePlayback() {
    if (exportState) return;
    if (timelinePlaying) {
      stopTimelinePlayback();
      return;
    }
    if (isComposePlayMode()) playTimelineFromStart();
    else playSelectedSlot(true);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (clipCtxMenuEl) {
        closeClipContextMenu();
        return;
      }
      if (!framePickerModal.classList.contains("hidden")) {
        closeFramePicker();
        return;
      }
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) {
        if (
          window.VflowEditorInputModal &&
          typeof window.VflowEditorInputModal.close === "function"
        ) {
          window.VflowEditorInputModal.close();
        }
        return;
      }
      if (settingsModal && !settingsModal.classList.contains("hidden")) {
        closeSettingsModal();
        return;
      }
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) {
        closeStoryboardModal();
        return;
      }
      if (presetDropdownPanel && !presetDropdownPanel.classList.contains("hidden")) {
        closePresetDropdown();
        return;
      }
      if (jobsDropdownPanel && !jobsDropdownPanel.classList.contains("hidden")) {
        closeJobsDropdown();
        return;
      }
      if (timelineSelection) {
        clearTimelineSelection();
      }
      return;
    }

    // PC: Delete selected timeline clip
    if (e.key === "Delete") {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      if (settingsModal && !settingsModal.classList.contains("hidden")) return;
      if (!selectedClip) return;
      e.preventDefault();
      deleteSelectedTimelineClip();
      return;
    }

    // Split selected slot at playhead (S)
    if (e.key === "s" || e.key === "S") {
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      if (settingsModal && !settingsModal.classList.contains("hidden")) return;
      if (!selectedClip) return;
      e.preventDefault();
      if (!splitClipAtPlayhead(selectedClip.kind, selectedClip.id)) {
        alert(t("timeline.splitDisabled"));
      }
      return;
    }

    // Copy / paste timeline slots (app clipboard)
    if (
      (e.key === "c" || e.key === "C") &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey
    ) {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      if (settingsModal && !settingsModal.classList.contains("hidden")) return;
      if (!selectedClip) return;
      e.preventDefault();
      copyTimelineClip(selectedClip.kind, selectedClip.id);
      return;
    }
    if (
      (e.key === "v" || e.key === "V") &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey
    ) {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      if (settingsModal && !settingsModal.classList.contains("hidden")) return;
      e.preventDefault();
      if (!pasteTimelineClip()) {
        alert(t("timeline.pasteEmpty"));
      }
      return;
    }

    // Timeline undo / redo
    if (
      (e.key === "z" || e.key === "Z") &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey
    ) {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      if (settingsModal && !settingsModal.classList.contains("hidden")) return;
      e.preventDefault();
      if (e.shiftKey) redoTimeline();
      else undoTimeline();
      return;
    }
    if (
      (e.key === "y" || e.key === "Y") &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey
    ) {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      if (settingsModal && !settingsModal.classList.contains("hidden")) return;
      e.preventDefault();
      redoTimeline();
      return;
    }

    // Desktop: Space toggles preview play / pause (ignore while typing or in modals).
    if (e.key === " " || e.code === "Space") {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (!framePickerModal.classList.contains("hidden")) return;
      if (editorInputModal && !editorInputModal.classList.contains("hidden")) return;
      if (storyboardModal && !storyboardModal.classList.contains("hidden")) return;
      // Don't steal Space from other focused controls; handle our play button ourselves
      // so keydown+click doesn't toggle twice.
      if (e.target instanceof HTMLElement) {
        const interactive = e.target.closest(
          "button, a, summary, [role='button']"
        );
        if (interactive && interactive.id !== "btnPlaylistPlay") return;
      }
      e.preventDefault();
      toggleTimelinePlayback();
    }
  });

  function submitAuthForm() {
    if (loginCard && loginCard.dataset.authMode === "register") doRegister();
    else doLogin();
  }

  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitAuthForm();
    });
  }
  if (btnLogin) {
    btnLogin.addEventListener("click", () => doLogin());
  }
  if (btnRegister) {
    btnRegister.addEventListener("click", () => doRegister());
  }
  if (btnShowLogin) {
    btnShowLogin.addEventListener("click", () => {
      authModeApplied = null;
      setAuthMode("login");
      showLogin("");
    });
  }
  if (btnShowRegister) {
    btnShowRegister.addEventListener("click", () => {
      authModeApplied = null;
      setAuthMode("register");
      showLogin("");
    });
  }
  if (loginPassword) {
    loginPassword.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (loginCard && loginCard.dataset.authMode === "register") doRegister();
      else doLogin();
    });
  }
  if (loginPasswordConfirm) {
    loginPasswordConfirm.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doRegister();
    });
  }
  if (btnLogout) {
    btnLogout.addEventListener("click", () => doLogout());
  }
  if (btnNewProject) {
    btnNewProject.addEventListener("click", async () => {
      await createProjectAndOpen();
      resetEditorState();
      await saveDraftImmediate();
    });
  }
  if (btnApplyAsset) {
    btnApplyAsset.addEventListener("click", () => applyBrowsedAssetToSlot());
  }
  if (btnSetSharedFromBrowse) {
    btnSetSharedFromBrowse.addEventListener("click", () => {
      setBrowsedAssetAsSharedStart().catch((err) => {
        alert((err && err.message) || String(err));
      });
    });
  }
  if (btnGenerateFirstFrame) {
    btnGenerateFirstFrame.addEventListener("click", () => {
      runFirstFrameGenerate().catch((err) => {
        alert((err && err.message) || String(err));
      });
    });
  }
  if (btnExpandFirstFramePrompt) {
    btnExpandFirstFramePrompt.addEventListener("click", () => {
      runFirstFrameExpand().catch((err) => {
        alert((err && err.message) || String(err));
      });
    });
  }
  if (btnGoFirstFrameGen) {
    btnGoFirstFrameGen.addEventListener("click", () => focusFirstFrameGenerator());
  }
  if (firstFramePrompt) {
    firstFramePrompt.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runFirstFrameGenerate().catch((err) => {
          alert((err && err.message) || String(err));
        });
      }
    });
  }
  updateFrameAssetPickUi();
  syncFirstFrameGenBar();
  try {
    const U = window.VflowUserEngines;
    if (U && typeof U.migrateFromChannelConfig === "function") {
      U.migrateFromChannelConfig(getVideoChannelConfig());
    }
    fillEngineSelects();
    syncStoryboardEngineUi();
  } catch (e) {
    /* engines module optional during early boot */
  }

  function syncLangButtons() {
    const loc = currentLocale();
    document.querySelectorAll(".lang-btn[data-set-locale]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-set-locale") === loc);
    });
  }

  function refreshLocaleDependentUi() {
    syncLangButtons();
    try {
      syncInspectorLocaleLabels();
    } catch (e) {}
    try {
      relocalizeDefaultTrackNames();
    } catch (e) {}
    try {
      fillEngineSelects();
      updateChannelSummary();
      renderWorkflowTables();
    } catch (e) {}
    try {
      populateLlmModelSelects();
      renderLlmProvidersUi();
      updateLlmButtonState();
    } catch (e) {}
    try {
      syncDuckEncryptTip();
    } catch (e) {}
    try {
      renderJobsPanel();
    } catch (e) {}
    try {
      renderSelectionUI();
    } catch (e) {}
    try {
      renderTimelineTrack();
    } catch (e) {}
    try {
      if (typeof renderStoryboardList === "function") renderStoryboardList();
    } catch (e) {}
    try {
      if (typeof renderProjectsPanel === "function") renderProjectsPanel();
    } catch (e) {}
    try {
      if (typeof renderAssetLibrary === "function") renderAssetLibrary();
    } catch (e) {}
    try {
      if (typeof updatePreviewTransportUi === "function") updatePreviewTransportUi();
    } catch (e) {}
    try {
      syncFirstFrameGenBar();
      updateFirstFrameSizeHint();
      if (btnGenerateFirstFrame && !firstFrameGenBusy) {
        btnGenerateFirstFrame.textContent = t("firstFrame.generate");
      }
      if (btnExpandFirstFramePrompt && !firstFrameExpandBusy) {
        btnExpandFirstFramePrompt.textContent = t("firstFrame.expand");
      }
    } catch (e) {}
  }

  document.querySelectorAll(".lang-btn[data-set-locale]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lang = btn.getAttribute("data-set-locale");
      if (window.VflowI18n && typeof window.VflowI18n.setLocale === "function") {
        await window.VflowI18n.setLocale(lang);
      }
    });
  });
  if (window.VflowI18n && typeof window.VflowI18n.onChange === "function") {
    window.VflowI18n.onChange(() => {
      llmPromptTemplatesCache = null;
      llmPromptTemplatesLocale = null;
      refreshLocaleDependentUi();
    });
  }
  if (window.VflowI18n && window.VflowI18n.ready) {
    window.VflowI18n.ready
      .then(() => {
        syncLangButtons();
        syncInspectorLocaleLabels();
      })
      .catch(() => {
        syncLangButtons();
        syncInspectorLocaleLabels();
      });
  } else {
    syncLangButtons();
    syncInspectorLocaleLabels();
  }

  (async () => {
    if (window.VflowI18n && window.VflowI18n.ready) {
      try {
        await window.VflowI18n.ready;
      } catch (e) {
        /* ignore */
      }
    }
    await fetchSiteConfig();
    await fetchServerConfig();
    await ensureSession();
    await bootEditor();
  })();
})();
