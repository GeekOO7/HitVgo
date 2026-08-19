import json
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

API_BASE = "https://www.runninghub.ai"
# Real RunningHub workflowId + node bindings live in gitignored
# platform_workflows.json (official host only). Public clones stay empty
# so users dock their own RH / ComfyUI graphs.
PLATFORM_WORKFLOWS_FILE = BASE_DIR / "platform_workflows.json"

WORKFLOW_ID = ""
WORKFLOW_ID_FLF = ""
WORKFLOW_ID_NOA = ""
WORKFLOW_ID_FLF_NOA = ""
WORKFLOW_ID_MINIMAX_REF2VA = ""
WORKFLOW_ID_MINIMAX_FLF = ""

_MINIMAX_REF2VA_CORE = {}
_MINIMAX_REF2VA_VARIANTS_LEGACY = {}
_MINIMAX_REF2VA_VARIANTS_NEW = {
    5: {"workflowId": "", "bindings": {}},
}
MINIMAX_REF2VA_BINDINGS = {}
MINIMAX_REF2VA_VARIANTS = _MINIMAX_REF2VA_VARIANTS_NEW
_WAN_I2V_BINDINGS = {}
_WAN_FLF_BINDINGS = {}
_PLATFORM_EDITORS_OVERLAY = []


def resolve_minimax_ref2va_variant(n_images, has_video=False, has_audio=False):
    # type: (int, bool, bool) -> dict
    """Use the fixed five-slot MiniMax workflow. Phase-1: images only."""
    if has_video or has_audio:
        raise ValueError(
            "当前 MiniMax 多工作流仅支持参考图（首帧+最多4张额外），暂不支持参考视频/音频"
        )
    try:
        n = int(n_images)
    except (TypeError, ValueError):
        n = 0
    if n < 1 or n > 5:
        raise ValueError(
            "MiniMax 主段需要 1~5 张参考图（首帧为 Picture 1，不足会用首帧垫齐到 5 槽），"
            "当前参考图数量为 {0}，无对应工作流".format(n)
        )
    variant = MINIMAX_REF2VA_VARIANTS[5]
    wid = str(variant.get("workflowId") or "").strip()
    binds = variant.get("bindings") if isinstance(variant.get("bindings"), dict) else {}
    if not wid or not binds:
        raise ValueError("MiniMax 平台工作流未配置，请对接自定义 RunningHub / ComfyUI")
    return {
        "workflowId": wid,
        "bindings": dict(binds),
        "nImages": 5,
    }


MINIMAX_FLF_BINDINGS = {}

# Storyboard engine capability envelopes (platform defaults).
STORYBOARD_ENGINES = {
    "wan": {
        "id": "wan",
        "mainMinSec": 2.0,
        "mainMaxSec": 7.0,
        "mainDefaultSec": 5.0,
        "bridgeMinSec": 3.4,
        "bridgeMaxSec": 12.0,
        "bridgeDefaultSec": 7.0,
        "softChainUnitSec": 21.0,
        "supportsMultiRef": False,
        "allowAudioInPrompt": False,
        "allowTimedBeats": False,
        "nativeFps": None,  # user-tunable on Wan
        "defaultFps": 16,
        "usesDurationSeconds": False,
        "mainFeatureId": "i2v",
        "bridgeFeatureId": "flf",
        "mainWorkflowId": WORKFLOW_ID_NOA,
        "bridgeWorkflowId": WORKFLOW_ID_FLF_NOA,
        "mainWorkflowIdDuck": WORKFLOW_ID,
        "bridgeWorkflowIdDuck": WORKFLOW_ID_FLF,
        "maxRefImages": 0,
        "maxRefVideos": 0,
        "maxRefAudios": 0,
    },
    "minimax": {
        "id": "minimax",
        # Generation duration is 10s or 15s (prompt); native graph length/fps stay fixed.
        "mainMinSec": 10.0,
        "mainMaxSec": 15.0,
        "mainDefaultSec": 10.0,
        "durationChoices": [10, 15],
        "bridgeMinSec": 10.0,
        "bridgeMaxSec": 15.0,
        "bridgeDefaultSec": 10.0,
        "softChainUnitSec": 22.0,
        "supportsMultiRef": True,
        "allowAudioInPrompt": True,
        "allowTimedBeats": True,
        "nativeFps": 24,
        "defaultFps": 24,
        # MiniMaxH3 graphs (T8): length=243, fps=24 — not Wan 4n+1.
        "defaultLength": 243,
        "usesDurationSeconds": True,
        "mainFeatureId": "minimax_i2v",
        "bridgeFeatureId": "minimax_flf",
        "mainWorkflowId": WORKFLOW_ID_MINIMAX_REF2VA,
        "bridgeWorkflowId": WORKFLOW_ID_MINIMAX_FLF,
        "mainWorkflowIdDuck": WORKFLOW_ID_MINIMAX_REF2VA,
        "bridgeWorkflowIdDuck": WORKFLOW_ID_MINIMAX_FLF,
        "maxRefImages": 5,  # shared start + up to 4 extra references
        "maxRefVideos": 0,  # phase-1: image-only fixed-slot workflows
        "maxRefAudios": 0,
    },
}


def get_storyboard_engine(profile="wan"):
    # type: (str) -> dict
    key = (profile or "wan").strip().lower()
    if key not in STORYBOARD_ENGINES:
        key = "wan"
    return dict(STORYBOARD_ENGINES[key])


def _apply_platform_workflows_file():
    # type: () -> None
    """Load official pairing from gitignored platform_workflows.json."""
    global WORKFLOW_ID, WORKFLOW_ID_FLF, WORKFLOW_ID_NOA, WORKFLOW_ID_FLF_NOA
    global WORKFLOW_ID_MINIMAX_REF2VA, WORKFLOW_ID_MINIMAX_FLF
    global MINIMAX_REF2VA_BINDINGS, MINIMAX_FLF_BINDINGS, _PLATFORM_EDITORS_OVERLAY
    global _WAN_I2V_BINDINGS, _WAN_FLF_BINDINGS
    if not PLATFORM_WORKFLOWS_FILE.exists():
        return
    try:
        data = json.loads(PLATFORM_WORKFLOWS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return
    if not isinstance(data, dict):
        return
    wan = data.get("wan") if isinstance(data.get("wan"), dict) else {}
    mm = data.get("minimax") if isinstance(data.get("minimax"), dict) else {}
    WORKFLOW_ID = str(wan.get("i2vDuck") or "").strip()
    WORKFLOW_ID_FLF = str(wan.get("flfDuck") or "").strip()
    WORKFLOW_ID_NOA = str(wan.get("i2v") or "").strip()
    WORKFLOW_ID_FLF_NOA = str(wan.get("flf") or "").strip()
    WORKFLOW_ID_MINIMAX_REF2VA = str(mm.get("ref2va") or "").strip()
    WORKFLOW_ID_MINIMAX_FLF = str(mm.get("flf") or "").strip()
    i2v_b = wan.get("i2vBindings") if isinstance(wan.get("i2vBindings"), dict) else {}
    flf_b = wan.get("flfBindings") if isinstance(wan.get("flfBindings"), dict) else {}
    _WAN_I2V_BINDINGS = dict(i2v_b)
    _WAN_FLF_BINDINGS = dict(flf_b)
    ref_b = mm.get("ref2vaBindings") if isinstance(mm.get("ref2vaBindings"), dict) else {}
    mm_flf_b = mm.get("flfBindings") if isinstance(mm.get("flfBindings"), dict) else {}
    MINIMAX_REF2VA_BINDINGS.clear()
    MINIMAX_REF2VA_BINDINGS.update(ref_b)
    MINIMAX_REF2VA_VARIANTS[5] = {
        "workflowId": WORKFLOW_ID_MINIMAX_REF2VA,
        "bindings": dict(ref_b),
    }
    MINIMAX_FLF_BINDINGS.clear()
    MINIMAX_FLF_BINDINGS.update(mm_flf_b)
    STORYBOARD_ENGINES["wan"]["mainWorkflowId"] = WORKFLOW_ID_NOA
    STORYBOARD_ENGINES["wan"]["bridgeWorkflowId"] = WORKFLOW_ID_FLF_NOA
    STORYBOARD_ENGINES["wan"]["mainWorkflowIdDuck"] = WORKFLOW_ID
    STORYBOARD_ENGINES["wan"]["bridgeWorkflowIdDuck"] = WORKFLOW_ID_FLF
    STORYBOARD_ENGINES["minimax"]["mainWorkflowId"] = WORKFLOW_ID_MINIMAX_REF2VA
    STORYBOARD_ENGINES["minimax"]["bridgeWorkflowId"] = WORKFLOW_ID_MINIMAX_FLF
    STORYBOARD_ENGINES["minimax"]["mainWorkflowIdDuck"] = WORKFLOW_ID_MINIMAX_REF2VA
    STORYBOARD_ENGINES["minimax"]["bridgeWorkflowIdDuck"] = WORKFLOW_ID_MINIMAX_FLF
    editors = data.get("editors")
    _PLATFORM_EDITORS_OVERLAY = editors if isinstance(editors, list) else []


_apply_platform_workflows_file()

KEY_FILE = BASE_DIR / "key.txt"
SESSION_SECRET_FILE = BASE_DIR / "session_secret.txt"
# Platform-owned editor workflow catalog (optional override file).
# Operators fill in real workflowId + node bindings here to enable each editor.
EDITORS_FILE = BASE_DIR / "editors.json"


def _env(name, default=""):
    # type: (str, str) -> str
    """Read VFLOW_{name}, then legacy WF_{name}, else default."""
    val = (os.environ.get("VFLOW_" + name) or "").strip()
    if val:
        return val
    val = (os.environ.get("WF_" + name) or "").strip()
    if val:
        return val
    return default


def _resolve_db_path():
    # type: () -> Path
    new_path = DATA_DIR / "vflow.db"
    old_path = DATA_DIR / "wf.db"
    if new_path.exists():
        return new_path
    if old_path.exists():
        try:
            old_path.rename(new_path)
            return new_path
        except OSError:
            return old_path
    return new_path


DB_PATH = _resolve_db_path()
DEBUG = _env("DEBUG", "").lower() in ("1", "true", "yes")
GLOBAL_MAX_RUNNING = max(1, int(_env("GLOBAL_MAX_RUNNING", "2") or "2"))
PER_USER_MAX_RUNNING = max(
    1, int(_env("PER_USER_MAX_RUNNING", "2") or "2")
)
WORKER_POLL_SECONDS = max(
    1.0, float(_env("WORKER_POLL_SECONDS", "2") or "2")
)
# Mark queued/running (and orphan statuses) failed after this many seconds without progress
JOB_STALE_SECONDS = max(
    60, int(_env("JOB_STALE_SECONDS", "2700") or "2700")
)

# WanImageToVideo (I2V node 63) / WanFirstLastFrameToVideo (FLF node 136)
VFLOW_I2V_SIZE_NODE = "63"
VFLOW_FLF_SIZE_NODE = "136"
VFLOW_DEFAULT_LENGTH = 113
VFLOW_DEFAULT_FPS = 16
VFLOW_FPS_NODE = "119"  # VHS_VideoCombine frame_rate (noa)
VFLOW_FPS_FIELD = "frame_rate"
VFLOW_FPS_NODE_DUCK = "185"  # DuckHideNode fps (encrypt)
VFLOW_FPS_FIELD_DUCK = "fps"
VFLOW_LANDSCAPE = (960, 544)  # I2V / MiniMax workflow default
VFLOW_PORTRAIT = (544, 960)  # portrait default

# OpenAI-compatible LLM — defaults to OpenRouter free models.
# Override via env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
# Users can also set per-browser API URL / key / model in the storyboard UI.
LLM_BASE_URL = os.environ.get(
    "LLM_BASE_URL", "https://openrouter.ai/api/v1"
).rstrip("/")
# Fallback when OpenRouter weekly ranking is unavailable
LLM_MODEL = os.environ.get(
    "LLM_MODEL", "nvidia/nemotron-3-ultra-550b-a55b:free"
)
LLM_KEY_FILE = BASE_DIR / "llm_key.txt"
LLM_PROMPTS_FILE = BASE_DIR / "llm_prompts.json"
LLM_PROMPTS_FILE_ZH = BASE_DIR / "llm_prompts_zh.json"
LLM_PROMPTS_FILE_EN = BASE_DIR / "llm_prompts_en.json"
LLM_SEGMENT_MIN = 2
LLM_SEGMENT_MAX = 8
LLM_SCRIPT_EPISODE_MIN = 1
LLM_SCRIPT_EPISODE_MAX = 12
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

# Defaults if locale JSON is missing or incomplete (edit llm_prompts_zh/en.json instead).
_LLM_PROMPTS_DEFAULTS = {
    "main_system": (
        "你是图生视频（image-to-video）分镜提示词助手。\n"
        "用户会提供共享首帧画面描述与剧情方向。你要输出多段正向提示词，每段不断推进达到要求的剧情结果。\n"
        "所有主段共用同一首帧做 I2V。每条主段 prompt 须「开篇 2 句状态回锚 + 后文约 5 秒密度的剧情推进」（勿写流程引导语）。\n\n"
        "硬性要求：\n"
        '1. 只输出一个 JSON 对象，不要 Markdown，不要解释。格式：{"prompts":["...","..."]}\n'
        "2. prompts 为字符串数组；每条是一段完整、连贯的图生视频正向提示词。正向提示词以中文为主，专有名词/镜头术语可用英文。\n"
        "3. 写作规则（每条主段均遵守，连续正文，不加小标题、不分栏）："
        "开篇正好约 2 句做状态回锚——第 1 句写人或物的动作/姿态/表情状态，第 2 句写本段起始镜头视觉状态（景别、机位、运动或固定等）。"
        "第 1 主段开篇概括共享首帧中的主体与镜头；第 2 主段起开篇概括上一主段结束时的主体与镜头。"
        "随后写本段剧情推进：须写清约 5 秒内可演完的动作链、表情变化，信息量要够撑满一段 I2V，禁止只有一句空泛推进。"
        "镜头须按剧情表达设计：当情节需要强调情绪、揭示、压迫、跟随等时，在对应剧情动作旁写入景别变化或运镜"
        "（推近、跟移、摇、升等），不要把镜头描写全部堆在段首或段尾，也不要通篇无镜头词。\n"
        "4. 段与段之间情节连贯，可自然衔接。\n"
        "5. 不要写视频时长、秒数、帧数（禁止如 2-3 seconds、几秒、N seconds、frames 等）；时长由系统另行控制。"
        "文案只表达约 5 秒可拍完的信息量，不要在正文写「5秒」等字样。\n"
        "6. 不要写负向提示词；不要编号前缀。禁止任何分段标签或流程引导"
        "（例如：前段:、后段:、前半、后半、接上一段、继续上一段、恢复上一段状态、从首帧开始）。"
        "开篇概括须直接写画面，不要写成「接上一段：…」。"
    ),
    "storyboard_system": (
        "你是图生视频分镜规划助手。\n"
        "用户会提供共享首帧、剧情方向，以及整片目标总时长。你要规划可落地的结构化分镜 JSON。\n\n"
        "角色分工（必须遵守）：\n"
        "- 主段(main)=图生视频 I2V 内容锚：开篇 2 句回锚状态，后文推进本段，补偿 FLF 漂移。所有主段共用同一首帧生成。\n"
        "- 桥(bridge)=首尾帧 FLF 过渡：只做平滑衔接与净时长延伸，不能单独撑满长情节。\n\n"
        "硬性要求：\n"
        "1. 只输出一个 JSON 对象，不要 Markdown，不要解释。"
        "必须包含 totalDurationSec、script_synopsis、shots、bridges。\n"
        "2. 按用户给出的目标总时长规划；totalDurationSec 应接近该目标。"
        "整片时长≈Σ主段 + Σ max(0, bridgeDur-3.4)。\n"
        "3. 每个主段 durationSec 必须在 2–7 秒。\n"
        "4. 软链单元：主+软桥+主≈≤21秒；更长连续情节必须再接软桥+主接续状态，"
        "禁止只加长桥或少主硬撑。需要一镜到底/长时连续动作时，应主动用「主+软桥+主…」循环拼出一气呵成，而不是硬切打断。\n"
        "5. shots 长度在 2–8；若用户指定段数则必须严格匹配。"
        "自动段数时优先按目标时长配够主段。每项含 id、title、beat、prompt、durationSec、camera、cutToNext。"
        "camera 为短标签概括本段主导镜头设计（如 close-up、medium tracking、wide push-in），"
        "须按剧情表达设计并与 prompt 正文一致，禁止空或与正文矛盾。\n"
        "6. cutToNext 只能是 soft 或 hard，表示本段结束后如何接到下一段："
        "soft=连续情节建桥；hard=换机位/换景/跳切，贴合不建桥。"
        "创作选择：剧情需要景别对比、换角度、换景或节奏跳切时，应主动在对应主段接缝用 hard，把硬切当作换镜头机位的手段；"
        "需要一气呵成/一镜到底时用 soft 链。硬切可出现在任意中间接缝；"
        "最后一段无下一段，cutToNext 填 hard 仅作结构收尾。\n"
        "7. soft 时 needBridge=true；hard 时 needBridge=false、prompt 空、durationSec=0。\n"
        "8. 用 soft 桥拉长连续情节以接近目标时长（一镜到底靠 soft 链加长）；"
        "不要为凑时长把本该换镜头的 hard 接缝改成 soft；目标很长则增加主段数。\n"
        "9. 主段 prompt（每条均遵守）：开篇约 2 句回锚——第 1 句人或物动作/姿态/表情，第 2 句本段起始镜头视觉状态；"
        "第 1 主段概括共享首帧，第 2 主段起概括上一主段末。"
        "随后写约 5 秒密度的剧情推进（够撑满一段 I2V，禁止一句空泛推进）。"
        "镜头按剧情设计：在情绪/揭示/压迫/跟随等需要处，于对应动作旁写入景别变化或运镜，勿仅堆在段首或通篇省略。"
        "camera 字段与 prompt 主导镜头一致。"
        "禁止「前段:」「后段:」「前半」「后半」「接上一段」「从首帧开始」等元标签；正文不要写秒数。"
        "bridge prompt 只写过渡；主段 prompt 为正向提示词，以中文为主。"
    ),
    "bridge_system": (
        "你是首尾帧图生视频（FLF / first-last-frame）桥接提示词助手。\n"
        "用户会给出多对「上一主段提示词 / 下一主段提示词」。首尾帧图片已包含人物、场景与起止姿态，无需复述。\n"
        "你只需读懂两侧主提示词的动作差异，为每一对写一句短桥接提示："
        "描述画面如何从上一段结束状态平滑过渡到下一段开始状态。\n\n"
        "硬性要求：\n"
        '1. 只输出一个 JSON 对象，不要 Markdown，不要解释。格式：{"prompts":["...","..."]}\n'
        "2. prompts 长度必须与输入的衔接对数量完全一致，顺序一一对应。\n"
        "3. 每条只需 1–2 句，只写过渡动作、表情变化或镜头运动；"
        "不要复述外貌、服装、场景细节，不要重复某一侧主段全文。"
        "桥接提示词以中文为主，专有名词/镜头术语可用英文。\n"
        "4. 不要写视频时长、秒数、帧数（禁止如 2-3 seconds、几秒、N seconds 等）。\n"
        "5. 不要写负向提示词；不要编号前缀；不要「接上一段」「前段」「后段」等流程引导语。"
    ),
    "main_user_template": (
        "【首帧画面描述】\n{scene}\n\n"
        "【剧情方向】\n{plot}\n\n"
        "【段数要求】\n{count_note}"
    ),
    "storyboard_user_template": (
        "【首帧画面描述】\n{scene}\n\n"
        "【剧情方向】\n{plot}\n\n"
        "【段数要求】\n{count_note}\n\n"
        "【目标总时长】\n约 {target_duration} 秒。"
        "单主段不超过 7 秒；连续情节以主+软桥+主≈21秒为单元，更长再接软桥+主，禁止只靠加长桥。\n"
        "按剧情表达选择 cutToNext：需要一镜到底/连续动作用 soft（主+软桥+主循环建桥）；"
        "需要景别对比、换机位/换景/跳切时主动用 hard（贴合不建桥，把硬切当换镜头手段），"
        "硬切可出现在任意中间接缝。不要为凑时长抹掉硬切。\n"
        "主段 prompt：开篇约 2 句回锚（第 1 句人或物动作状态，第 2 句起始镜头视觉状态；"
        "第 1 主段概括首帧，其后概括上一主段末）→ 后文写约 5 秒密度的剧情推进；"
        "镜头按剧情在需要处写入运镜/景别变化（勿只堆段首或通篇无镜头）。"
        "camera 短标签须与 prompt 主导镜头一致。"
        "禁止「前段:」「后段:」「接上一段」等元标签；正文不要写秒数。\n\n"
        "请输出结构化分镜 JSON：\n"
        "{\n"
        '  "totalDurationSec": {target_duration},\n'
        '  "script_synopsis": "便于阅读与修改的短剧本摘要",\n'
        '  "shots": [{"id":"s1","title":"...","beat":"...","prompt":"...","durationSec":5,"camera":"close-up","cutToNext":"soft"}],\n'
        '  "bridges": [{"afterShot":"s1","needBridge":true,"durationSec":7,"prompt":"平滑过渡动作…"}]\n'
        "}\n"
        "shots 与 bridges 必须按时间顺序对应；soft/hard 与 needBridge 保持一致。"
    ),
    "storyboard_polish_system": (
        "你是分镜打磨助手。\n"
        "用户会给出当前结构化分镜 JSON（含 clips 时间轴槽位）、打磨范围和修改指令。你只输出一个 patch JSON，不要解释。\n\n"
        "硬性要求：\n"
        '1. 只输出 JSON：{"summary":"...","patch":{"script_synopsis?":"...","totalDurationSec?":数字,"shots":[...],"bridges":[...]}}。\n'
        "2. patch 内只放需要改动的字段。主段按 shots[].id；桥段优先按 bridges[].id，其次 afterShot。\n"
        "3. 主段 durationSec 须在 2–7；连续情节/一镜到底按主+软桥+主≈21秒延长，更长再接软桥+主，禁止只加长桥。"
        "剧情需要换机位/景别对比时用硬切（贴合、needBridge=false 且 prompt 置空）；"
        "硬切可在任意接缝，不要为凑时长改成 soft。\n"
        "4. soft 与 needBridge 必须一致。仅当用户明确要求改切点时才写 needBridge/cutToNext。\n"
        "5. 改写主段 prompt 时须保持：开篇约 2 句回锚（第 1 句人或物动作/姿态/表情，第 2 句起始镜头视觉状态；"
        "第 1 主段概括首帧，其后概括上一主段末）→ 后文约 5 秒密度的剧情推进；"
        "镜头按剧情在需要处写入运镜/景别变化。若改 camera，须与 prompt 主导镜头一致。"
        "禁止「前段:」「后段:」「前半」「后半」「接上一段」等元标签；正文不要写秒数。\n"
        "6. 不要返回完整原文重抄；只返回变更项。\n"
        "7. clips 可能来自手动添加的层1/层2槽，prompt 可为空：按修改指令补全或改写。\n"
        "8. 只改 polishTargetIds 列出的 id；未点名的段不要写入 patch。"
    ),
    "storyboard_polish_user_template": (
        "【打磨范围】\n{scope}\n"
        "上下文为整条 clips；只改 polishTargetIds 中的条目。桥段 patch 优先写 id。\n\n"
        "【修改指令】\n{instruction}\n\n"
        "【当前分镜 JSON】\n{storyboard_json}"
    ),
    "storyboard_system_minimax": (
        "你是 MiniMax 图生视频分镜规划助手。\n"
        "用户会提供共享首帧、剧情方向、目标总时长，以及各主段秒数。输出可落地的结构化分镜 JSON。\n"
        "\n"
        "角色分工：\n"
        "- 主段(main)=I2V 内容锚，所有主段共用同一首帧；主段 durationSec 在 5–15（默认 10）。\n"
        "- 桥(bridge)=首尾帧过渡，软桥时 durationSec 与对应主段相同（默认 10）；只做衔接与净时长延伸。\n"
        "\n"
        "硬性要求：\n"
        "1. 只输出一个 JSON 对象，含 totalDurationSec、script_synopsis、shots、bridges。不要 Markdown/解释。\n"
        "2. 若 User/引擎约束给出各段时长，各主段 durationSec 必须原样使用，禁止改成 5–7 或其它值。\n"
        "3. 软链：主+软桥+主循环接近目标总时长；硬切=换机位/换景/跳切且不建桥。最后一段 cutToNext=hard 仅作结构收尾。\n"
        "4. shots 2–8（用户指定段数则严格匹配）。每项含 id、title、beat、prompt、durationSec、camera、cutToNext、usedRefs。\n"
        "5. soft→needBridge=true；hard→needBridge=false、prompt 空、durationSec=0。\n"
        "6. 主段 prompt：以<Picture 1>为唯一首帧，制作{N}秒…视频；开始时锁定…；状态回锚；0—A秒…覆盖满 N。配乐…；音效…。\n"
        "7. 额外参考写入 usedRefs（按剧情选段落）；禁止在 prompt 正文改写 参考<Picture N>…（系统原样注入内容/作用）。\n"
        "8. 镜头与状态按剧情按需：情绪/揭示/压迫/跟随时在对应节拍写景别运镜与姿态表情视线；勿堆套话或通篇省略。\n"
        "9. 台词按剧情按需：说话时写具体话语；无言不硬编；禁止只写「开口说话」而无内容。\n"
        "10. 软桥 bridges[].durationSec 与相邻主段 durationSec 相同。\n"
        "11. bridge prompt 只写过渡动作/情绪/镜头变化。"
    ),
    "storyboard_user_template_minimax": (
        "【首帧画面描述】\n"
        "{scene}\n"
        "\n"
        "【剧情方向】\n"
        "{plot}\n"
        "\n"
        "【段数要求】\n"
        "{count_note}\n"
        "\n"
        "【目标总时长】\n"
        "约 {target_duration} 秒。\n"
        "主段 durationSec 必须在 5–15（默认 10）；若下方/引擎约束给出各段秒数，必须原样写入 shots。\n"
        "软桥 bridges[].durationSec 与主段相同。连续情节用 soft 建桥；换机位/换景用 hard。\n"
        "主段 prompt：以<Picture 1>为唯一首帧，制作N秒…；锁定…；回锚；节拍覆盖满 N。"
        "景别/状态按需写入；说话写具体话语，无言不硬编。额外参考只写 usedRefs。\n"
        "\n"
        "请输出结构化分镜 JSON：\n"
        "{\n"
        "  \"totalDurationSec\": {target_duration},\n"
        "  \"script_synopsis\": \"便于阅读与修改的短剧本摘要\",\n"
        "  \"shots\": [{\"id\":\"s1\",\"title\":\"...\",\"beat\":\"...\",\"prompt\":\"以<Picture 1>为唯一首帧，制作10秒…；锁定…。0—3秒…。配乐…；音效…。\",\"durationSec\":10,\"camera\":\"close-up\",\"cutToNext\":\"soft\",\"usedRefs\":[\"Picture 2\"]}],\n"
        "  \"bridges\": [{\"afterShot\":\"s1\",\"needBridge\":true,\"durationSec\":10,\"prompt\":\"平滑过渡动作…\"}]\n"
        "}\n"
        "shots 与 bridges 必须按时间顺序对应；soft/hard 与 needBridge 保持一致。"
    ),
    "storyboard_polish_system_minimax": (
        "你是 MiniMax 分镜打磨助手。只输出一个 patch JSON，不要解释。\n"
        "\n"
        "硬性要求：\n"
        "1. 只输出 JSON：{\"summary\":\"...\",\"patch\":{...}}；只放变更项。\n"
        "2. 主段 durationSec 须在 5–15；若用户未要求改时长，保留原 durationSec。\n"
        "3. soft 与 needBridge 必须一致。仅当用户明确要求改切点时才写 needBridge/cutToNext。\n"
        "4. 改写主段 prompt 时必须保持 MiniMax 格式：以<Picture 1>为唯一首帧，制作N秒…；锁定…；回锚；节拍覆盖满 N。"
        "景别/状态按需写入；说话写具体话语，无言不硬编。配乐…；音效…。\n"
        "5. 可调整 usedRefs（换段落），禁止改写素材内容/作用；不要在 prompt 正文写 参考<Picture N>…（系统原样注入）。\n"
        "6. 不要返回完整原文重抄。\n"
        "7. clips 可能来自手动槽，prompt 可为空，按指令补全或改写；桥段优先用 id。\n"
        "8. 只改 polishTargetIds 列出的 id。"
    ),
    "bridge_user_intro": (
        "请为以下 {n} 对主段写出桥接正向提示词。"
        "prompts 数组长度必须正好为 {n}。"
    ),
    "bridge_pair_template": (
        "【衔接对 {i}/{n}】\n"
        "上一主段提示词：\n{left}\n\n"
        "下一主段提示词：\n{right}"
    ),
    "t2i_expand_system": (
        "你是文生图提示词扩写助手。用户给出短句需求或待润色提示词，"
        "你扩写/润色为可直接用于生图的中文提示词。\n\n"
        "硬性要求：\n"
        "1. 只输出提示词正文，禁止解释、标题、Markdown、代码块、中英对照。"
        "专有名词/技术词可用英文。\n"
        "2. 格式必须严格如下（换行分隔）：\n"
        "开篇一段：用 2–4 句连贯中文描写主体（身份外貌、服饰、姿态表情、动作与看向镜头的关系等）。\n"
        "然后依次五行短标签，每行一句至两句，勿再拉长：\n"
        "风格：…\n场景：…\n构图：…\n色彩：…\n光影：…\n"
        "3. 总长度对齐工作流默认正提示：全篇约 280–450 汉字（含标点），最多不超过 500 汉字。"
        "禁止 500 词级英文长文、禁止堆砌材质/限制词清单、禁止重复注水。\n"
        "4. 各标签只写关键信息：风格=媒介与质感；场景=地点与氛围；构图=景别/机位/主体位置；"
        "色彩=主色调；光影=光源方向与受光效果。\n"
        "5. 若输入已较长，按上述格式压缩润色，删冗余，保留用户核心意图。"
    ),
    "t2i_expand_user_template": "【需求】\n{prompt}",
}

_LLM_PROMPTS_DEFAULTS_EN = {
    "main_system": (
        "You are an image-to-video storyboard prompt assistant.\n"
        "The user provides a shared start-frame scene description and a plot direction. "
        "You output multiple positive prompts; each advances the story toward the requested outcome.\n"
        "All main segments share the same start frame for I2V. Every main prompt must follow: "
        "opening ~2 sentences of state re-anchor + then plot advance dense enough for ~5 seconds of I2V "
        "— never write meta process labels.\n\n"
        "Hard requirements:\n"
        '1. Output only one JSON object — no Markdown, no explanation. Format: {"prompts":["...","..."]}\n'
        "2. prompts is a string array; each item is one continuous full image-to-video positive prompt. "
        "Write prompts primarily in English (technical camera terms OK).\n"
        "3. Writing rule (every main segment; continuous prose, no section headers): "
        "Open with exactly about 2 sentences of state re-anchor — sentence 1: people/objects' "
        "action/pose/expression; sentence 2: this shot's starting camera visual state "
        "(framing, angle, move or locked). "
        "Segment 1 opens by summarizing the shared start frame; from segment 2 onward open by "
        "summarizing the previous main's end state. Then write this beat's advance: a clear action chain "
        "and expression change dense enough to fill ~5 seconds of I2V — never a single vague line. "
        "Design camera for storytelling: when the beat needs emotion, reveal, pressure, or following, "
        "place framing changes or camera moves beside the matching action — "
        "do not dump all camera language at the start/end, and do not omit camera entirely.\n"
        "4. Segments must be narratively coherent and naturally connectable.\n"
        "5. Do not mention video duration, seconds, or frame counts; timing is controlled elsewhere. "
        "Express ~5s density in content only — do not write \"5 seconds\" in the prompt body.\n"
        "6. No negative prompts; no numbered prefixes. Forbid meta labels or process cues "
        '(e.g. "previous:", "next:", "first half", "second half", "continue from previous", '
        '"restore previous state", "start from the first frame").'
    ),
    "storyboard_system": (
        "You are a storyboard planner for image-to-video generation.\n"
        "The user provides a shared start frame, plot direction, and a target total duration. "
        "Return structured storyboard JSON for timeline layout.\n\n"
        "Role split: main = I2V content anchor (2-sentence re-anchor then advance; all mains share the same start frame); "
        "bridge = FLF transition (cannot alone carry long continuous action).\n\n"
        "Hard requirements:\n"
        "1. Output only one JSON object with totalDurationSec, script_synopsis, shots, and bridges.\n"
        "2. Plan toward the user target duration; totalDurationSec should be close to it. "
        "Approx total ≈ Σ mains + Σ max(0, bridgeDur-3.4).\n"
        "3. Each main durationSec must be between 2 and 7.\n"
        "4. Soft-chain unit: main+soft-bridge+main ≈ ≤21s; longer continuous beats must append "
        "soft-bridge+main — do not pad with bridges alone. For a continuous one-shot / long-take feel, "
        "deliberately loop main+soft-bridge+main instead of interrupting with hard cuts.\n"
        "5. shots length is 2–8 and must match a requested count when specified. "
        "When auto, prefer enough mains for the target. "
        "Each shot needs id, title, beat, prompt, durationSec, camera, cutToNext. "
        "camera is a short label for the dominant camera design "
        "(e.g. close-up, medium tracking, wide push-in); design it for the story and keep it "
        "consistent with the prompt body — never empty or contradictory.\n"
        "6. cutToNext is soft or hard (how this shot connects to the next): "
        "soft = continuous beat with bridge; hard = camera/scene jump, abut, no bridge. "
        "Creative choice: when the story needs framing contrast, a new camera angle, a scene change, "
        "or a rhythmic jump cut, deliberately set hard on that main seam and treat hard as the camera-change tool; "
        "when you want one continuous take, use a soft chain. Hard cuts may appear on any mid seam; "
        "Last shot has no next seam — set hard as structural trailer only.\n"
        "7. soft → needBridge=true; hard → needBridge=false, empty prompt, durationSec 0.\n"
        "8. Use soft bridges to extend continuous action toward the target (one-shot length from soft chains); "
        "do not turn intentional hard camera-change seams into soft just to pad time; "
        "if the target is long, add more mains.\n"
        "9. Main prompts (every shot): open with ~2 re-anchor sentences — (1) people/object "
        "action/pose/expression, (2) starting camera visual state; shot 1 = shared start frame, "
        "later = previous main end. "
        "Then write ~5s-dense plot advance enough to fill one I2V clip. "
        "Design camera for the story: place framing changes or moves beside matching beats; "
        "do not only pile camera at the opening or omit it. Keep camera consistent with the prompt. "
        "Forbid meta labels such as previous:/next:/first half/second half/continue from previous; "
        "do not write seconds in the body. Bridge prompts only describe transitions."
    ),
    "bridge_system": (
        "You are a first-last-frame (FLF) bridge prompt assistant for image-to-video.\n"
        "The user gives pairs of previous/next main prompts. Start/end frame images already "
        "contain characters, scene, and poses — do not restate them.\n"
        "Write one short bridge prompt per pair describing a smooth transition "
        "from the end of the previous main to the start of the next.\n\n"
        "Hard requirements:\n"
        '1. Output only one JSON object — no Markdown, no explanation. Format: {"prompts":["...","..."]}\n'
        "2. prompts length must exactly match the number of pairs, in the same order.\n"
        "3. Each item is 1–2 sentences about transition motion only. "
        "Write bridge prompts primarily in English (technical camera terms OK).\n"
        "4. Do not mention duration, seconds, or frame counts.\n"
        "5. No negative prompts; no numbered prefixes; no meta cues like "
        '"continue from previous" / "previous segment" / "next segment".'
    ),
    "main_user_template": (
        "[Start-frame scene]\n{scene}\n\n"
        "[Plot direction]\n{plot}\n\n"
        "[Segment count]\n{count_note}"
    ),
    "storyboard_user_template": (
        "[Start-frame scene]\n{scene}\n\n"
        "[Plot direction]\n{plot}\n\n"
        "[Segment count]\n{count_note}\n\n"
        "[Target total duration]\nAbout {target_duration} seconds. "
        "Each main ≤ 7s; continuous action uses main+soft-bridge+main ≈ 21s units; "
        "longer beats append soft-bridge+main.\n"
        "Choose cutToNext by storytelling need: soft for one continuous take / continuous action "
        "(loop main+soft-bridge+main); deliberately use hard when you need framing contrast, "
        "a camera/scene jump, or a rhythmic cut (abut, no bridge — hard is the camera-change tool). "
        "Hard cuts may appear on any mid seam. Do not erase hard cuts just to pad time.\n"
        "Main prompts: open with ~2 re-anchor sentences (1: people/object action state; "
        "2: starting camera visual state; shot 1 = start frame, later = previous main end) → "
        "then ~5s-dense plot advance; place camera moves/framing beside story beats that need them. "
        "camera short label must match the prompt's dominant shot. "
        "No meta labels like previous:/next:/continue from previous; do not write seconds in the body.\n\n"
        "Return structured storyboard JSON:\n"
        "{\n"
        '  "totalDurationSec": {target_duration},\n'
        '  "script_synopsis": "readable short synopsis",\n'
        '  "shots": [{"id":"s1","title":"...","beat":"...","prompt":"...","durationSec":5,"camera":"close-up","cutToNext":"soft"}],\n'
        '  "bridges": [{"afterShot":"s1","needBridge":true,"durationSec":7,"prompt":"smooth transition…"}]\n'
        "}\n"
        "shots and bridges must be in timeline order; keep soft/hard consistent with needBridge."
    ),
    "storyboard_polish_system": (
        "You are a storyboard polish assistant.\n"
        "The user gives the current storyboard JSON (including clips on the timeline), "
        "a target scope, and an edit instruction. "
        "Return only a patch JSON.\n\n"
        "Hard requirements:\n"
        '1. Output only JSON: {"summary":"...","patch":{"script_synopsis?":"...","totalDurationSec?":number,"shots":[...],"bridges":[...]}}.\n'
        "2. patch must include only changed fields. Locate mains by shots[].id; "
        "locate bridges by bridges[].id first, then afterShot.\n"
        "3. Main durationSec must stay between 2 and 7; continuous action / one-shot extends via "
        "main+soft-bridge+main ≈ 21s units, then soft-bridge+main — do not only lengthen bridges. "
        "When the story needs a camera-angle or framing change, use a hard cut (abut, needBridge=false); "
        "may be on any seam — do not turn them into soft just to pad duration.\n"
        "4. soft and needBridge must agree. Write needBridge/cutToNext only when the user asks to change the cut.\n"
        "5. When rewriting a main prompt, keep: ~2 opening re-anchor sentences "
        "(1: people/object action/pose/expression; 2: starting camera visual state; "
        "shot 1 = start frame, later = previous main end) → then ~5s-dense plot advance; "
        "place camera moves/framing beside story beats that need them. "
        "If changing camera, keep it consistent with the prompt's dominant shot. "
        "Forbid meta labels such as previous:/next:/first half/second half/continue from previous; "
        "do not write seconds in the body.\n"
        "6. Do not echo unchanged content.\n"
        "7. clips may come from manually added layer-1/layer-2 slots; prompt may be empty — fill or rewrite from the instruction.\n"
        "8. Only change ids listed in polishTargetIds; do not patch unnamed clips."
    ),
    "storyboard_polish_user_template": (
        "[Polish scope]\n{scope}\n"
        "Use the full clips list as context; only patch ids in polishTargetIds. Prefer bridge id.\n\n"
        "[Instruction]\n{instruction}\n\n"
        "[Current storyboard JSON]\n{storyboard_json}"
    ),
    "storyboard_system_minimax": (
        "You are a MiniMax image-to-video storyboard planner.\n"
        "The user provides a shared start frame, plot, target total duration, and per-main seconds. Return structured storyboard JSON.\n"
        "\n"
        "Role split: main = I2V content anchor (shared start frame; durationSec 5–15, default 10); "
        "bridge = FLF transition (same durationSec as main when needBridge=true, default 10).\n"
        "\n"
        "Hard requirements:\n"
        "1. Output only one JSON object with totalDurationSec, script_synopsis, shots, bridges.\n"
        "2. If User/engine constraints list shot durations, each main durationSec MUST match exactly — never rewrite to 5–7 or other values.\n"
        "3. Soft chains extend continuous action; hard = camera/scene jump, no bridge. Last shot cutToNext=hard is structural only.\n"
        "4. shots length 2–8 (exact if requested). Each needs id, title, beat, prompt, durationSec, camera, cutToNext, usedRefs.\n"
        "5. soft→needBridge=true; hard→needBridge=false, empty prompt, durationSec 0.\n"
        "6. Main prompt: With <Picture 1> as sole start frame, make {N}-sec …; lock …; timed beats covering full N. Score …; SFX ….\n"
        "7. Extra refs go in usedRefs by plot; do NOT paraphrase reference <Picture N>… in prompt body (system injects fixed content/role).\n"
        "8. Framing/state when plot needs emotion/reveal/pressure/follow — write moves and pose/expression beside that beat; no empty boilerplate.\n"
        "9. Dialogue when plot needs speech — write actual lines; silent beats get none; never \"speaks\" without words.\n"
        "10. Soft-bridge bridges[].durationSec must match adjacent main durationSec.\n"
        "11. Bridge prompts only describe transitions."
    ),
    "storyboard_user_template_minimax": (
        "[Start-frame scene]\n"
        "{scene}\n"
        "\n"
        "[Plot direction]\n"
        "{plot}\n"
        "\n"
        "[Segment count]\n"
        "{count_note}\n"
        "\n"
        "[Target total duration]\n"
        "About {target_duration} seconds.\n"
        "Main durationSec must be 5–15 (default 10); if shot durations are listed below/in constraints, write them into shots unchanged.\n"
        "Soft-bridge durationSec matches main. Use soft for continuous action; hard for camera/scene jumps.\n"
        "Main prompt: Make N-sec … (N=durationSec); <Picture 1> sole start; lock …. Beats cover full N. "
        "Framing/state when needed; actual dialogue when speaking. Extra refs only via usedRefs.\n"
        "\n"
        "Return structured storyboard JSON:\n"
        "{\n"
        "  \"totalDurationSec\": {target_duration},\n"
        "  \"script_synopsis\": \"readable short synopsis\",\n"
        "  \"shots\": [{\"id\":\"s1\",\"title\":\"...\",\"beat\":\"...\",\"prompt\":\"Make 10-sec …; <Picture 1> as sole start; lock …. 0—3s …. Score …; SFX ….\",\"durationSec\":10,\"camera\":\"close-up\",\"cutToNext\":\"soft\",\"usedRefs\":[\"Picture 2\"]}],\n"
        "  \"bridges\": [{\"afterShot\":\"s1\",\"needBridge\":true,\"durationSec\":10,\"prompt\":\"smooth transition…\"}]\n"
        "}\n"
        "shots and bridges must be in timeline order; keep soft/hard consistent with needBridge."
    ),
    "storyboard_polish_system_minimax": (
        "You are a MiniMax storyboard polish assistant. Return only a patch JSON.\n"
        "\n"
        "Hard requirements:\n"
        "1. Output only JSON: {\"summary\":\"...\",\"patch\":{...}}; changed fields only.\n"
        "2. Main durationSec must stay 5–15; keep existing durationSec unless the user asks to change it.\n"
        "3. soft and needBridge must agree. Write needBridge/cutToNext only when the user asks to change the cut.\n"
        "4. Keep MiniMax format: Make N-sec …; <Picture 1> sole start; lock …; beats cover full N. "
        "Framing/state when needed; actual dialogue when speaking. Score …; SFX ….\n"
        "5. You may change usedRefs; never rewrite fixed content/role; do not write reference <Picture N>… in prompt body.\n"
        "6. Do not echo unchanged content.\n"
        "7. clips may be manual slots with empty prompts — fill or rewrite from the instruction; prefer bridge id.\n"
        "8. Only change ids listed in polishTargetIds."
    ),
    "bridge_user_intro": (
        "Write bridge positive prompts for the following {n} main-segment pairs. "
        "The prompts array length must be exactly {n}."
    ),
    "bridge_pair_template": (
        "[Pair {i}/{n}]\n"
        "Previous main prompt:\n{left}\n\n"
        "Next main prompt:\n{right}"
    ),
    "t2i_expand_system": (
        "You are a text-to-image prompt expansion assistant. "
        "The user gives a short request or a draft. Expand/polish it into a ready-to-use "
        "English image prompt. Output language follows the English UI locale.\n\n"
        "Hard requirements:\n"
        "1. Output only the prompt body — no explanations, titles, Markdown, code fences, "
        "or bilingual notes.\n"
        "2. Format must be exactly:\n"
        "Opening paragraph: 2–4 continuous sentences describing the subject "
        "(identity/look, wardrobe, pose/expression, action, relation to camera).\n"
        "Then exactly these five short labeled lines, one or two sentences each — "
        "do not inflate:\n"
        "Style: …\nScene: …\nComposition: …\nColor: …\nLighting: …\n"
        "3. Total length should match a compact default positive prompt: "
        "about 120–220 English words, never exceed 250. "
        "Do not produce 500–750-word essays, material laundry lists, or padded constraints.\n"
        "4. Labels only carry essentials: Style = medium/look; Scene = place/mood; "
        "Composition = framing/angle/subject placement; Color = palette; "
        "Lighting = source direction and how the subject is lit.\n"
        "5. If the input is already long, compress and polish into this format "
        "while keeping the user's intent."
    ),
    "t2i_expand_user_template": "[Request]\n{prompt}",
}

_LLM_PROMPTS_KEYS = (
    "main_system",
    "storyboard_system",
    "storyboard_system_minimax",
    "bridge_system",
    "main_user_template",
    "storyboard_user_template",
    "storyboard_user_template_minimax",
    "storyboard_polish_system",
    "storyboard_polish_system_minimax",
    "storyboard_polish_user_template",
    "bridge_user_intro",
    "bridge_pair_template",
    "t2i_expand_system",
    "t2i_expand_user_template",
    "script_system",
    "script_user_template",
    "script_polish_system",
    "script_polish_user_template",
)
_LLM_PROMPTS_CACHE = {}  # type: dict[str, dict]
# Snapshot of popular free models (updated periodically); live ranking preferred.
LLM_FALLBACK_FREE_MODELS = [
    {"id": "nvidia/nemotron-3-ultra-550b-a55b:free", "name": "NVIDIA: Nemotron 3 Ultra (free)"},
    {"id": "poolside/laguna-m.1:free", "name": "Poolside: Laguna M.1 (free)"},
    {"id": "nvidia/nemotron-3-super-120b-a12b:free", "name": "NVIDIA: Nemotron 3 Super (free)"},
    {"id": "openai/gpt-oss-20b:free", "name": "OpenAI: gpt-oss-20b (free)"},
    {"id": "google/gemma-4-31b-it:free", "name": "Google: Gemma 4 31B (free)"},
    {"id": "nvidia/nemotron-3-nano-30b-a3b:free", "name": "NVIDIA: Nemotron 3 Nano 30B (free)"},
    {"id": "openrouter/free", "name": "OpenRouter Free Models Router"},
]


def is_official_instance():
    # type: () -> bool
    """Always false in the standalone open-source build."""
    return False


def require_official_platform():
    # type: () -> None
    if not is_official_instance():
        raise ValueError(
            "Platform channel is only available on the official HitVgo site. "
            "Use custom RunningHub or ComfyUI locally."
        )


def get_api_key():
    # type: () -> str
    require_official_platform()
    if not KEY_FILE.exists():
        raise FileNotFoundError(f"API key file not found: {KEY_FILE}")
    key = KEY_FILE.read_text(encoding="utf-8").strip()
    if not key:
        raise ValueError("API key file is empty")
    return key


def get_llm_api_key():
    # type: () -> str
    """LLM key from env LLM_API_KEY, else llm_key.txt. Empty if not configured."""
    if not is_official_instance():
        return ""
    env_key = (os.environ.get("LLM_API_KEY") or "").strip()
    if env_key:
        return env_key
    if LLM_KEY_FILE.exists():
        key = LLM_KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            return key
    return ""


def _normalize_prompt_locale(locale=None):
    # type: (str | None) -> str
    s = (locale or "zh").strip().lower().replace("_", "-")
    if s.startswith("en"):
        return "en"
    return "zh"


def get_llm_prompts(locale=None, force_reload=False):
    # type: (str | None, bool) -> dict
    """Load storyboard LLM prompt templates for locale (zh/en); merge with defaults."""
    global _LLM_PROMPTS_CACHE
    lang = _normalize_prompt_locale(locale)
    if not force_reload and lang in _LLM_PROMPTS_CACHE:
        return _LLM_PROMPTS_CACHE[lang]
    defaults = _LLM_PROMPTS_DEFAULTS_EN if lang == "en" else _LLM_PROMPTS_DEFAULTS
    merged = dict(defaults)
    candidates = []
    if lang == "en":
        candidates = [LLM_PROMPTS_FILE_EN, LLM_PROMPTS_FILE]
    else:
        candidates = [LLM_PROMPTS_FILE_ZH, LLM_PROMPTS_FILE]
    for path in candidates:
        if not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for key in _LLM_PROMPTS_KEYS:
                    val = raw.get(key)
                    if isinstance(val, str) and val.strip():
                        merged[key] = val.strip()
            break
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    _LLM_PROMPTS_CACHE[lang] = merged
    return merged


def get_session_secret():
    # type: () -> str
    env_secret = _env("SESSION_SECRET")
    if env_secret:
        return env_secret
    if SESSION_SECRET_FILE.exists():
        secret = SESSION_SECRET_FILE.read_text(encoding="utf-8").strip()
        if secret:
            return secret
    secret = os.urandom(32).hex()
    SESSION_SECRET_FILE.write_text(secret, encoding="utf-8")
    return secret


def public_platform_workflows():
    # type: () -> dict | None
    """Official host only: pairing for the in-page adapter. Never sent by OSS clones."""
    if not is_official_instance():
        return None
    if not (
        WORKFLOW_ID_NOA
        or WORKFLOW_ID_MINIMAX_REF2VA
        or _WAN_I2V_BINDINGS
        or MINIMAX_REF2VA_BINDINGS
    ):
        return None
    return {
        "wan": {
            "i2v": WORKFLOW_ID_NOA,
            "flf": WORKFLOW_ID_FLF_NOA,
            "i2vDuck": WORKFLOW_ID,
            "flfDuck": WORKFLOW_ID_FLF,
            "i2vBindings": dict(_WAN_I2V_BINDINGS),
            "flfBindings": dict(_WAN_FLF_BINDINGS),
        },
        "minimax": {
            "ref2va": WORKFLOW_ID_MINIMAX_REF2VA,
            "flf": WORKFLOW_ID_MINIMAX_FLF,
            "ref2vaBindings": dict(MINIMAX_REF2VA_BINDINGS),
            "flfBindings": dict(MINIMAX_FLF_BINDINGS),
        },
    }


def llm_configured():
    # type: () -> bool
    if not is_official_instance():
        return False
    return bool(get_llm_api_key())


def platform_rh_available():
    # type: () -> bool
    if not is_official_instance():
        return False
    try:
        get_api_key()
        return True
    except (FileNotFoundError, ValueError, OSError):
        return False


def _pricing_is_free(value):
    # type: (object) -> bool
    if value is None:
        return False
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return str(value).strip() in ("0", "0.0")


def is_free_openrouter_model(model):
    # type: (dict) -> bool
    mid = str(model.get("id") or "")
    if mid.endswith(":free") or mid == "openrouter/free":
        return True
    pricing = model.get("pricing") or {}
    return _pricing_is_free(pricing.get("prompt")) and _pricing_is_free(
        pricing.get("completion")
    )


_FREE_MODELS_CACHE = {"ts": 0.0, "models": []}
_FREE_MODELS_TTL_SEC = 3600


def cached_openrouter_free_models(limit=30):
    # type: (int) -> list[dict]
    """Return cached free models or static fallback (no network)."""
    cached = _FREE_MODELS_CACHE.get("models") or []
    source = cached if cached else list(LLM_FALLBACK_FREE_MODELS)
    return source[: max(1, int(limit))]


def fetch_openrouter_free_models(limit=30, force=False):
    # type: (int, bool) -> list[dict]
    """Top-weekly free models from OpenRouter (id + name). Cached 1h."""
    import time
    import urllib.parse
    import urllib.request

    now = time.time()
    cached = _FREE_MODELS_CACHE.get("models") or []
    if (
        not force
        and cached
        and (now - float(_FREE_MODELS_CACHE.get("ts") or 0)) < _FREE_MODELS_TTL_SEC
    ):
        return cached[: max(1, int(limit))]

    url = OPENROUTER_MODELS_URL + "?" + urllib.parse.urlencode({"sort": "top-weekly"})
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "vflow-storyboard/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        import json as _json

        data = (_json.loads(raw) or {}).get("data") or []
    except Exception:
        return cached_openrouter_free_models(limit)

    free = []
    for m in data:
        if not isinstance(m, dict):
            continue
        if not is_free_openrouter_model(m):
            continue
        mid = (m.get("id") or "").strip()
        if not mid:
            continue
        free.append(
            {
                "id": mid,
                "name": (m.get("name") or mid).strip(),
            }
        )
    if free:
        _FREE_MODELS_CACHE["ts"] = now
        _FREE_MODELS_CACHE["models"] = free
        return free[: max(1, int(limit))]
    return cached_openrouter_free_models(limit)


def default_llm_model():
    # type: () -> str
    """Env LLM_MODEL if set; else top cached/fallback free model."""
    env_model = (os.environ.get("LLM_MODEL") or "").strip()
    if env_model:
        return env_model
    free = cached_openrouter_free_models(limit=1)
    if free:
        return free[0]["id"]
    return LLM_MODEL


DEFAULT_NEGATIVE = (
    "Blurry face, distorted features, extra fingers, poorly drawn hands, "
    "poorly drawn face, deformed limbs, fused fingers, incomplete body parts, "
    "three legs, walking backwards, crowded background, cluttered background, "
    "spots, blemishes, grayish tones, low quality, JPEG compression artifacts, "
    "static image,Rings, watches, nail art, tattoos"
)


# —— Editor workflow catalog (对时间轴素材做二次编辑：放大/补帧/重绘等) ——
# Platform-owned editors run server-side via RunningHub. Each entry keeps the
# real workflowId + node bindings on the server; clients only receive metadata.
# To enable an editor, set its workflowId (via editors.json override or the
# VFLOW_EDITOR_<KEY>_WORKFLOW_ID env). Disabled (empty workflowId) editors are
# still listed but flagged unconfigured. Add/remove capabilities here only —
# the timeline / menu code never hard-codes editor buttons.
_PLATFORM_EDITORS_DEFAULT = [
    {
        "id": "platform.upscale",
        "source": "platform",
        "name": "超分放大",
        "nameEn": "Upscale",
        "description": "对所选帧/片段做分辨率放大，输出新视频覆盖层",
        "descriptionEn": "Upscale the selected frame/clip; result overlays as a new segment",
        "category": "upscale",
        "provider": "runninghub",
        "input": "image",
        "output": "video",
        "accepts": ["frame", "range", "clip"],
        "needsPrompt": False,
        "needsAudio": False,
        "params": [],
        "workflowId": _env("EDITOR_UPSCALE_WORKFLOW_ID", ""),
        "bindings": {},
    },
    {
        "id": "platform.interpolate",
        "source": "platform",
        "name": "补帧（丝滑）",
        "nameEn": "Frame interpolation",
        "description": "对所选片段补帧，提升流畅度，输出新视频覆盖层",
        "descriptionEn": "Interpolate the selected clip for smoother motion",
        "category": "interpolate",
        "provider": "runninghub",
        "input": "video",
        "output": "video",
        "accepts": ["range", "clip"],
        "needsPrompt": False,
        "needsAudio": False,
        "params": [],
        "workflowId": _env("EDITOR_INTERPOLATE_WORKFLOW_ID", ""),
        "bindings": {},
    },
    {
        "id": "platform.talking",
        "source": "platform",
        "name": "口播（图生带语音）",
        "nameEn": "Talking (image + voice)",
        "description": "选帧人物图 + 指定语音，按提示词生成口型与画面配合的说话视频",
        "descriptionEn": "Frame image + voice file; generate a talking video matched to speech and prompt",
        "category": "custom",
        "provider": "runninghub",
        "input": "image",
        "output": "video",
        "accepts": ["frame", "clip"],
        "needsPrompt": True,
        "needsAudio": True,
        "params": [],
        "workflowId": _env("EDITOR_TALKING_WORKFLOW_ID", ""),
        "bindings": {},
    },
    {
        "id": "platform.t2i",
        "source": "platform",
        "name": "文生图（Krea2）",
        "nameEn": "Text-to-image (Krea2)",
        "description": "按提示词生成首帧图，结果进入素材库后可设为共用首帧或桥接帧",
        "descriptionEn": "Generate a first-frame image from a prompt; apply as shared start or FLF frame from the library",
        "category": "image_edit",
        "provider": "runninghub",
        "input": "image",
        "output": "image",
        # Empty accepts: generator-only (central first-frame UI), not timeline menu.
        "accepts": [],
        "needsPrompt": True,
        "needsAudio": False,
        "params": [],
        "workflowId": _env("EDITOR_T2I_WORKFLOW_ID", ""),
        "bindings": {},
    },
]

_PLATFORM_EDITORS_KEYS = (
    "id",
    "source",
    "name",
    "nameEn",
    "description",
    "descriptionEn",
    "category",
    "provider",
    "input",
    "output",
    "accepts",
    "needsPrompt",
    "needsAudio",
    "params",
    "workflowId",
    "bindings",
    "enabled",
)
_PLATFORM_EDITORS_CACHE = {"editors": None}


def _load_editors_override():
    # type: () -> list
    """Merge platform_workflows.json editors and editors.json onto the catalog."""
    editors = [dict(e) for e in _PLATFORM_EDITORS_DEFAULT]
    items = []
    if EDITORS_FILE.exists():
        try:
            raw = json.loads(EDITORS_FILE.read_text(encoding="utf-8"))
            extra = raw.get("editors") if isinstance(raw, dict) else raw
            if isinstance(extra, list):
                items = extra
        except (OSError, ValueError, json.JSONDecodeError):
            items = []
    by_id = {e.get("id"): e for e in editors}
    for item in list(_PLATFORM_EDITORS_OVERLAY) + items:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        clean = {k: item[k] for k in _PLATFORM_EDITORS_KEYS if k in item}
        clean["source"] = "platform"
        if clean["id"] in by_id:
            by_id[clean["id"]].update(clean)
        else:
            by_id[clean["id"]] = clean
            editors.append(by_id[clean["id"]])
    return editors


def get_platform_editors(force_reload=False):
    # type: (bool) -> list
    """Full platform editor catalog (includes server-only workflowId/bindings)."""
    if force_reload or _PLATFORM_EDITORS_CACHE["editors"] is None:
        _PLATFORM_EDITORS_CACHE["editors"] = _load_editors_override()
    return _PLATFORM_EDITORS_CACHE["editors"]


def get_platform_editor(editor_id):
    # type: (str) -> Optional[dict]
    for e in get_platform_editors():
        if e.get("id") == editor_id:
            return e
    return None


def editor_is_configured(editor):
    # type: (dict) -> bool
    if editor.get("enabled") is False:
        return False
    return bool(str(editor.get("workflowId") or "").strip())


def public_editor_manifest(editor):
    # type: (dict) -> dict
    """Strip server-only workflowId/bindings; keep metadata for the client menu."""
    accepts = editor.get("accepts")
    if not isinstance(accepts, list):
        accepts = ["frame"]
    return {
        "id": editor.get("id"),
        "source": "platform",
        "name": editor.get("name") or editor.get("id"),
        "nameEn": editor.get("nameEn") or editor.get("name") or editor.get("id"),
        "description": editor.get("description") or "",
        "descriptionEn": editor.get("descriptionEn") or editor.get("description") or "",
        "category": editor.get("category") or "custom",
        "provider": editor.get("provider") or "runninghub",
        "input": editor.get("input") or "image",
        "output": editor.get("output") or "video",
        "accepts": accepts,
        "needsPrompt": bool(editor.get("needsPrompt")),
        "needsAudio": bool(editor.get("needsAudio")),
        "params": editor.get("params") or [],
        "enabled": editor.get("enabled") is not False,
        "configured": editor_is_configured(editor),
    }
