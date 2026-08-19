/**
 * Storyboard engine capability envelopes (Wan / MiniMax).
 * Exposes window.VflowStoryboardEngines
 */
(() => {
  const REF_IMAGE_KEYS = [];
  const REF_VIDEO_KEYS = [];
  const REF_AUDIO_KEYS = ["refAudio0"];
  const REF_ENABLE_KEYS = [
    "refImage1Enable",
    "refImage2Enable",
    "refImage3Enable",
    "refVideo0Enable",
    "refVideoAudio0Enable",
    "refAudio0Enable",
  ];
  for (let i = 0; i <= 8; i++) {
    REF_IMAGE_KEYS.push("refImage" + i);
    if (i <= 2) REF_VIDEO_KEYS.push("refVideo" + i);
  }

  const SEMANTIC_EXTRA = ["duration"].concat(
    REF_IMAGE_KEYS,
    REF_VIDEO_KEYS,
    REF_AUDIO_KEYS,
    REF_ENABLE_KEYS
  );

  const ENGINES = {
    wan: {
      id: "wan",
      mainMinSec: 2,
      mainMaxSec: 7,
      mainDefaultSec: 5,
      bridgeMinSec: 3.4,
      bridgeMaxSec: 12,
      bridgeDefaultSec: 7,
      softChainUnitSec: 21,
      supportsMultiRef: false,
      allowAudioInPrompt: false,
      allowTimedBeats: false,
      nativeFps: null,
      defaultFps: 16,
      usesDurationSeconds: false,
      mainFeatureId: "i2v",
      bridgeFeatureId: "flf",
      maxRefImages: 0,
      maxRefVideos: 0,
      maxRefAudios: 0,
    },
    minimax: {
      id: "minimax",
      mainMinSec: 10,
      mainMaxSec: 15,
      mainDefaultSec: 10,
      /** MiniMax generation only allows 10s or 15s. */
      durationChoices: [10, 15],
      bridgeMinSec: 10,
      bridgeMaxSec: 15,
      bridgeDefaultSec: 10,
      softChainUnitSec: 22,
      supportsMultiRef: true,
      allowAudioInPrompt: true,
      allowTimedBeats: true,
      nativeFps: 24,
      defaultFps: 24,
      /** MiniMaxH3 T8 graph native length (not Wan 4n+1). */
      defaultLength: 243,
      usesDurationSeconds: true,
      mainFeatureId: "minimax_i2v",
      bridgeFeatureId: "minimax_flf",
      maxRefImages: 5,
      maxRefVideos: 0,
      maxRefAudios: 0,
    },
  };

  const MINIMAX_REF2VA_CORE = {};

  /** Filled at runtime on the official host via /api/config. */
  const PLATFORM_MINIMAX_REF2VA_VARIANTS = {
    5: {
      workflowId: "",
      bindings: {},
    },
  };

  /** Fixed MiniMax multi-reference workflow snapshot. */
  const PLATFORM_MINIMAX_REF2VA = {
    workflowId: "",
    bindings: {},
    params: [],
  };

  const PLATFORM_MINIMAX_FLF = {
    workflowId: "",
    bindings: {},
    params: [],
  };

  function setPlatformWorkflows(data) {
    const mm = data && data.minimax;
    if (!mm || typeof mm !== "object") return;
    const refId = String(mm.ref2va || "").trim();
    const flfId = String(mm.flf || "").trim();
    const refB =
      mm.ref2vaBindings && typeof mm.ref2vaBindings === "object"
        ? mm.ref2vaBindings
        : {};
    const flfB =
      mm.flfBindings && typeof mm.flfBindings === "object" ? mm.flfBindings : {};
    PLATFORM_MINIMAX_REF2VA_VARIANTS[5] = {
      workflowId: refId,
      bindings: Object.assign({}, MINIMAX_REF2VA_CORE, refB),
    };
    PLATFORM_MINIMAX_REF2VA.workflowId = refId;
    PLATFORM_MINIMAX_REF2VA.bindings = Object.assign(
      {},
      PLATFORM_MINIMAX_REF2VA_VARIANTS[5].bindings
    );
    PLATFORM_MINIMAX_FLF.workflowId = flfId;
    PLATFORM_MINIMAX_FLF.bindings = Object.assign({}, flfB);
  }

  function resolveMiniMaxRef2vaVariant(nImages, hasVideo, hasAudio) {
    if (hasVideo || hasAudio) {
      throw new Error(
        "当前 MiniMax 多工作流仅支持参考图（首帧+最多4张额外），暂不支持参考视频/音频"
      );
    }
    const n = Number(nImages) || 0;
    if (n < 1 || n > 5) {
      throw new Error(
        "MiniMax 主段需要 1~5 张参考图（首帧为 Picture 1），当前数量为 " + n
      );
    }
    const variant = PLATFORM_MINIMAX_REF2VA_VARIANTS[5];
    if (!variant || !String(variant.workflowId || "").trim()) {
      throw new Error("MiniMax 平台工作流未配置，请对接自定义 RunningHub / ComfyUI");
    }
    const bindings = Object.assign({}, variant.bindings);
    const bLen = bindings.length || {};
    const bFps = bindings.fps || {};
    const params = [
      {
        id: "length",
        type: "number",
        label: "Length (frames)",
        bind: "length",
        nodeId: bLen.nodeId || "",
        fieldName: bLen.fieldName || "length",
        default: 81,
        visibility: "shown",
      },
      {
        id: "fps",
        type: "number",
        label: "Frame rate (fps)",
        bind: "fps",
        nodeId: bFps.nodeId || "",
        fieldName: bFps.fieldName || "fps",
        default: 16,
        visibility: "shown",
      },
    ];
    for (let i = 0; i < 5; i++) {
      const key = "refImage" + i;
      const b = bindings[key];
      if (!b) continue;
      params.push({
        id: key,
        type: "image",
        label: "Picture " + (i + 1),
        bind: key,
        nodeId: b.nodeId,
        fieldName: b.fieldName,
        visibility: i === 0 ? "shown" : "collapsed",
      });
    }
    return {
      workflowId: variant.workflowId,
      bindings,
      params,
      nImages: 5,
    };
  }

  function isUserEngineId(id) {
    return String(id || "").indexOf("user.engine.") === 0;
  }

  function isPlatformEngineId() {
    return false;
  }

  function firstUserEngineId() {
    const U = window.VflowUserEngines;
    if (U && typeof U.listSelectable === "function") {
      const list = U.listSelectable();
      if (list && list[0] && list[0].id) return list[0].id;
    }
    return "";
  }

  function emptyEnvelope() {
    return Object.assign({}, ENGINES.wan, {
      id: "",
      source: "user",
      configured: false,
      name: "",
      provider: "",
    });
  }

  function normalizeEngineId(profile) {
    const raw = String(profile == null ? "" : profile).trim();
    if (isUserEngineId(raw)) {
      const U = window.VflowUserEngines;
      if (U && typeof U.get === "function" && U.get(raw)) return raw;
      return firstUserEngineId();
    }
    return firstUserEngineId();
  }

  function listEngines() {
    return [];
  }

  function listSelectableEngines() {
    const out = [];
    const U = window.VflowUserEngines;
    if (U && typeof U.listSelectable === "function") {
      U.listSelectable().forEach((eng) => {
        const env =
          typeof U.toRuntimeEnvelope === "function"
            ? U.toRuntimeEnvelope(eng)
            : null;
        if (env) out.push(env);
      });
    }
    return out;
  }

  function getEngine(profile) {
    const id = normalizeEngineId(profile);
    if (isUserEngineId(id)) {
      const U = window.VflowUserEngines;
      const raw = U && typeof U.get === "function" ? U.get(id) : null;
      if (raw && typeof U.toRuntimeEnvelope === "function") {
        return U.toRuntimeEnvelope(raw);
      }
    }
    return emptyEnvelope();
  }

  /** Snap MiniMax duration to allowed choices (10 or 15). */
  function snapDurationChoice(sec, profile) {
    const e = getEngine(profile);
    const choices = Array.isArray(e.durationChoices) ? e.durationChoices : null;
    const n = Number(sec);
    if (!choices || !choices.length) {
      if (!Number.isFinite(n)) return e.mainDefaultSec;
      return Math.max(e.mainMinSec, Math.min(e.mainMaxSec, n));
    }
    if (!Number.isFinite(n)) return e.mainDefaultSec;
    let best = choices[0];
    let bestDist = Math.abs(n - best);
    for (let i = 1; i < choices.length; i++) {
      const d = Math.abs(n - choices[i]);
      if (d < bestDist) {
        best = choices[i];
        bestDist = d;
      }
    }
    return best;
  }

  function clampMainSec(sec, profile) {
    const e = getEngine(profile);
    if (e.durationChoices && e.durationChoices.length) {
      return snapDurationChoice(sec, profile);
    }
    const n = Number(sec);
    if (!Number.isFinite(n)) return e.mainDefaultSec;
    return Math.max(e.mainMinSec, Math.min(e.mainMaxSec, n));
  }

  function clampBridgeSec(sec, profile, allowZero) {
    const e = getEngine(profile);
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) {
      return allowZero ? 0 : e.bridgeDefaultSec;
    }
    if (e.durationChoices && e.durationChoices.length) {
      return snapDurationChoice(n, profile);
    }
    return Math.max(e.bridgeMinSec, Math.min(e.bridgeMaxSec, n));
  }

  /**
   * MiniMax timed-beat skeleton for duration N (e.g. 10s → 0—3秒；3—7秒；7—10秒).
   * @param {number} durationSec
   * @param {string} [locale]
   */
  function buildMinimaxBeatSkeleton(durationSec, locale) {
    const N = Math.round(Number(durationSec));
    if (!Number.isFinite(N) || N <= 0) return "";
    const anchors = [0];
    anchors.push(Math.min(3, N));
    while (anchors[anchors.length - 1] < N) {
      const cur = anchors[anchors.length - 1];
      const remaining = N - cur;
      if (remaining <= 4) {
        anchors.push(N);
      } else {
        const next = cur + 4;
        anchors.push(next >= N ? N : next);
      }
    }
    const isEn = String(locale || "")
      .trim()
      .toLowerCase()
      .startsWith("en");
    const unit = isEn ? "s" : "秒";
    const parts = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      parts.push(`${anchors[i]}—${anchors[i + 1]}${unit}…`);
    }
    return parts.join(isEn ? "; " : "；");
  }

  function featureIdForRole(profile, role) {
    return role === "bridge" || role === "storyboard_bridge" ? "flf" : "i2v";
  }

  function platformAdapterMode() {
    return null;
  }

  /** Prompt-writing hints (few-shot skeletons), locale-aware via caller. */
  function writingHints(profile, useMultiRef) {
    const e = getEngine(profile);
    if (e.source === "user") {
      if (e.allowTimedBeats) {
        return {
          titleKey: "storyboard.hintMiniMaxTitle",
          bullets: useMultiRef && e.supportsMultiRef
            ? [
                "storyboard.hintMiniMaxLock",
                "storyboard.hintMiniMaxReanchor",
                "storyboard.hintMiniMaxBeats",
                "storyboard.hintMiniMaxRefTag",
                "storyboard.hintMiniMaxAudio",
                "storyboard.hintMiniMaxConstraints",
              ]
            : [
                "storyboard.hintMiniMaxLock",
                "storyboard.hintMiniMaxReanchor",
                "storyboard.hintMiniMaxBeats",
                "storyboard.hintMiniMaxAudio",
                "storyboard.hintMiniMaxConstraints",
              ],
          skeleton: useMultiRef && e.supportsMultiRef
            ? "以<Picture 1>为唯一首帧，制作{duration}秒…视频；开始时锁定人物五官、外貌、着装…；{beats}（需要处写景别/状态与具体台词）。配乐…；音效…。全程少量自然口语，无Logo、水印或新文字，避免人物漂移、脸部崩坏。（额外参考由系统按 usedRefs 原样注入）"
            : "以<Picture 1>为唯一首帧，制作{duration}秒…视频；开始时锁定人物五官、外貌、着装…；{beats}（需要处写景别/状态与具体台词）。配乐…；音效…。全程少量自然口语，无Logo、水印或新文字，避免人物漂移、脸部崩坏。",
        };
      }
      return {
        titleKey: "storyboard.hintWanTitle",
        bullets: [
          "storyboard.hintWanReanchor",
          "storyboard.hintWanAdvance",
          "storyboard.hintWanNoAudio",
          "storyboard.hintWanNoSeconds",
        ],
        skeleton:
          "主体动作/姿态/表情…。起始镜头景别与机位…。随后推进动作链与表情变化…（勿写秒数、配音、说话）",
      };
    }
    if (e.id === "minimax") {
      return {
        titleKey: "storyboard.hintMiniMaxTitle",
        bullets: useMultiRef
          ? [
              "storyboard.hintMiniMaxLock",
              "storyboard.hintMiniMaxReanchor",
              "storyboard.hintMiniMaxBeats",
              "storyboard.hintMiniMaxRefTag",
              "storyboard.hintMiniMaxAudio",
              "storyboard.hintMiniMaxConstraints",
            ]
          : [
              "storyboard.hintMiniMaxLock",
              "storyboard.hintMiniMaxReanchor",
              "storyboard.hintMiniMaxBeats",
              "storyboard.hintMiniMaxAudio",
              "storyboard.hintMiniMaxConstraints",
            ],
        skeleton: useMultiRef
          ? "以<Picture 1>为唯一首帧，制作{duration}秒…视频；开始时锁定人物五官、外貌、着装…；{beats}（需要处写景别/状态与具体台词）。配乐…；音效…。全程少量自然口语，无Logo、水印或新文字，避免人物漂移、脸部崩坏。（额外参考由系统按 usedRefs 原样注入）"
          : "以<Picture 1>为唯一首帧，制作{duration}秒…视频；开始时锁定人物五官、外貌、着装…；{beats}（需要处写景别/状态与具体台词）。配乐…；音效…。全程少量自然口语，无Logo、水印或新文字，避免人物漂移、脸部崩坏。",
      };
    }
    return {
      titleKey: "storyboard.hintWanTitle",
      bullets: [
        "storyboard.hintWanReanchor",
        "storyboard.hintWanAdvance",
        "storyboard.hintWanNoAudio",
        "storyboard.hintWanNoSeconds",
      ],
      skeleton:
        "主体动作/姿态/表情…。起始镜头景别与机位…。随后推进动作链与表情变化…（勿写秒数、配音、说话）",
    };
  }

  window.VflowStoryboardEngines = {
    ENGINES,
    SEMANTIC_EXTRA,
    REF_IMAGE_KEYS,
    REF_VIDEO_KEYS,
    PLATFORM_MINIMAX_REF2VA,
    PLATFORM_MINIMAX_REF2VA_VARIANTS,
    PLATFORM_MINIMAX_FLF,
    setPlatformWorkflows,
    listEngines,
    listSelectableEngines,
    getEngine,
    normalizeEngineId,
    isUserEngineId,
    isPlatformEngineId,
    clampMainSec,
    clampBridgeSec,
    snapDurationChoice,
    buildMinimaxBeatSkeleton,
    featureIdForRole,
    platformAdapterMode,
    resolveMiniMaxRef2vaVariant,
    writingHints,
  };
})();
