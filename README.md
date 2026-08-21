# HitVgo · 影高（单机开源版）

> 作者：**Geek007** · 官方站点：[hitvgo.geek007.com](https://hitvgo.geek007.com) · GitHub：[GeekOO7/HitVgo](https://github.com/GeekOO7/HitVgo)

HitVgo 是一款生成式人工智能时间轴可视化视频编辑器，针对当前 AI 视频碎片化、不连贯的问题：让你把精力重新放回画面镜头与情节打磨。导入常用的 ComfyUI 工作流后，即可快速浏览生成结果、抽卡筛选，再在时间轴上剪辑，并对片段继续加工。

本仓库是**打开即用的单机开源版**：对接你自己的 RunningHub 或 ComfyUI，用 LLM 自动绑定参数；所有 API Key 留在本机，不经过任何第三方。无登录、无注册、无管理后台、无云存储配额。

日常创作更推荐官方平台版 [https://hitvgo.geek007.com](https://hitvgo.geek007.com)：预调好的专业能力与编辑器更完整，并提供多用户、云素材库与平台通道。

许可证：[GNU Affero GPL v3.0](LICENSE)（或更高版本）。

## 本地启动

需要 Python 3.10+。

```bash
pip install -r requirements.txt
python app.py
```

Windows 也可双击 `start.bat`。浏览器打开 `http://127.0.0.1:5000`。

- 视频走 **自定义 RunningHub**（你自己的 RH API Key）或 **本机 ComfyUI**。在设置里上传工作流并用 LLM 识别绑定。
- 语言模型走 **自定义（本地）**，经 [本机助手](local_agent/README.md) 转发，Key 不经过云端。
- 素材库只有本机（本机助手）与剧本；没有云端素材空间。

可选环境变量见 `.env.example`。

## 本机助手（RunningHub / ComfyUI / LLM）

把自定义任务放到本机执行、避免浏览器跨域：见 [local_agent/README.md](local_agent/README.md)。

```bash
cd local_agent
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py
```

默认监听 `0.0.0.0:39281`（本机 `http://127.0.0.1:39281`）。回到网页设置里检测连接。

---

## English

> Author: **Geek007** · Site: [hitvgo.geek007.com](https://hitvgo.geek007.com) · GitHub: [GeekOO7/HitVgo](https://github.com/GeekOO7/HitVgo)

HitVgo is a generative-AI timeline visual video editor. AI clips today are often fragmented and disconnected; HitVgo puts your attention back on shots and story. Import the ComfyUI workflows you already use, browse results, pick the best takes, then cut on the timeline and keep processing clips.

This repo is the **standalone open-source build**: connect your own RunningHub or ComfyUI, auto-bind parameters with an LLM; all API keys stay on your machine and never go through a third party. No login, no sign-up, no admin panel, no cloud storage quota.

For day-to-day work, we recommend the official platform at [https://hitvgo.geek007.com](https://hitvgo.geek007.com): professionally tuned features and a fuller editor, plus multi-user support, a cloud asset library, and platform channels.

License: [GNU Affero GPL v3.0](LICENSE) (or later).

### Run locally

Python 3.10+ is required.

```bash
pip install -r requirements.txt
python app.py
```

On Windows you can also double-click `start.bat`. Then open `http://127.0.0.1:5000` in a browser.

- Video runs through **custom RunningHub** (your own RH API key) or **local ComfyUI**. In Settings, upload a workflow and let the LLM detect and bind parameters.
- Language models use **custom (local)** routing via the [local agent](local_agent/README.md), so keys never leave your machine.
- The asset library is local only (via the local agent) plus scripts; there is no cloud asset space.

Optional environment variables are listed in `.env.example`.

### Local agent (RunningHub / ComfyUI / LLM)

Run custom jobs on your machine and avoid browser CORS issues: see [local_agent/README.md](local_agent/README.md).

```bash
cd local_agent
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py
```

Default listen address: `0.0.0.0:39281` (locally `http://127.0.0.1:39281`). Then go back to Settings in the web UI and test the connection.
