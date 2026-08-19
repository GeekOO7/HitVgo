# HitVgo · 影高（单机开源版）

> 作者：**Geek007** · 官方站点：[hitvgo.geek007.com](https://hitvgo.geek007.com) · GitHub：[GeekOO7/HitVgo](https://github.com/GeekOO7/HitVgo)

本机 AI 视频创作界面——对接你自己的 RunningHub 或 ComfyUI 工作流，用 LLM 自动绑定参数，分镜写词、批量生成、时间轴剪接一站完成。所有 API Key 留在本机，不经过任何第三方。

这是**打开即用的单机版**：无登录、无注册、无管理后台、无云存储配额。
需要多用户、云素材库或平台通道？请使用官方服务 [https://hitvgo.geek007.com](https://hitvgo.geek007.com)。

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

## 仓库里不会出现的内容

密钥与运行时数据已忽略：`key.txt`、`llm_key.txt`、`session_secret.txt`、`data/`、`decoded/`。ComfyUI 工作流参考目录 `wf/` 也不入库。

网络上提供修改版时，AGPL 要求向用户提供对应源码。

---

## English

> Author: **Geek007** · Site: [hitvgo.geek007.com](https://hitvgo.geek007.com) · GitHub: [GeekOO7/HitVgo](https://github.com/GeekOO7/HitVgo)

HitVgo standalone — a local AI video creation UI that connects to your own RunningHub or ComfyUI workflows. Auto-bind parameters with LLM, write storyboards, batch-generate clips, and edit on a timeline. All API keys stay on your machine.

No login, no admin, no cloud storage quota. For multi-user, cloud assets, or platform channels, use the official site [https://hitvgo.geek007.com](https://hitvgo.geek007.com). Open `http://127.0.0.1:5000` after:

```bash
pip install -r requirements.txt
python app.py
```

Use the [local agent](local_agent/README.md) for custom RunningHub / ComfyUI / LLM. Licensed under AGPL-3.0-or-later.
