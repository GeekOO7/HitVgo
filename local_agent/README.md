# HitVgo 本机助手（Local Agent）

> 作者：**Geek007** · 仓库：[GeekOO7/HitVgo](https://github.com/GeekOO7/HitVgo)

在用户电脑上运行，由网页把自定义 RunningHub / ComfyUI / LLM 任务交给本助手执行，**避免浏览器跨域**。

## 快速开始（Windows）

1. 解压本目录
2. 双击 `start.bat`（首次会自动创建虚拟环境并安装依赖）
3. 看到「已就绪，请回到网页点击检测连接」后，回到 HitVgo 设置页点 **检测连接**

默认监听全部网卡：`0.0.0.0:39281`（本机可用 `http://127.0.0.1:39281`，局域网/公网用本机 IP 或域名）。仅本机访问时设置 `VFLOW_AGENT_HOST=127.0.0.1`。

## 手动启动

```bash
cd local_agent
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py
```

环境变量（可选）：

- `VFLOW_AGENT_HOST`（默认 `0.0.0.0`，全部网卡；仅本机则设 `127.0.0.1`）
- `VFLOW_AGENT_PORT`（默认 `39281`）

配置文件：`~/.vflow-agent/config.json`（也可由网页「保存」同步）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET/PUT | `/config` | 读写本机配置 |
| POST | `/v1/video/run` | multipart：`meta` + 素材；阻塞至完成（兼容旧客户端） |
| POST | `/v1/video/create` | 同上素材；立即返回 `{ taskId }`，不落结果 |
| POST | `/v1/video/poll` | JSON：`channel` + `taskId`；进行中返回状态 JSON，成功返回视频字节 |
| POST | `/v1/llm/chat` | OpenAI 兼容转发 |

默认绑定全部网卡，防火墙需放行端口。公网暴露时请自行限制来源或加反向代理鉴权，助手接口本身无登录。仅本机使用请设 `VFLOW_AGENT_HOST=127.0.0.1`。

---

## English

> Author: **Geek007** · Repo: [GeekOO7/HitVgo](https://github.com/GeekOO7/HitVgo)

Runs on your computer. The HitVgo web UI hands custom RunningHub / ComfyUI / LLM jobs to this agent so they execute locally and **avoid browser CORS**.

### Quick start (Windows)

1. Unzip this folder
2. Double-click `start.bat` (first run creates a venv and installs dependencies)
3. When you see “ready, go back to the web UI and test the connection”, open HitVgo Settings and click **Test connection**

Default listen address: all interfaces `0.0.0.0:39281` (locally `http://127.0.0.1:39281`; on LAN/WAN use this machine’s IP or hostname). For localhost-only access set `VFLOW_AGENT_HOST=127.0.0.1`.

### Manual start

```bash
cd local_agent
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py
```

Optional environment variables:

- `VFLOW_AGENT_HOST` (default `0.0.0.0`, all interfaces; use `127.0.0.1` for localhost only)
- `VFLOW_AGENT_PORT` (default `39281`)

Config file: `~/.vflow-agent/config.json` (can also be synced when you click Save in the web UI).

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET/PUT | `/config` | Read/write local config |
| POST | `/v1/video/run` | multipart: `meta` + assets; blocks until done (legacy clients) |
| POST | `/v1/video/create` | same assets; returns `{ taskId }` immediately, does not persist the result |
| POST | `/v1/video/poll` | JSON: `channel` + `taskId`; in-progress returns status JSON, success returns video bytes |
| POST | `/v1/llm/chat` | OpenAI-compatible proxy |

Binds all interfaces by default; open the port in the firewall. If you expose it to the public internet, restrict sources yourself or put auth on a reverse proxy — the agent has no login. For local-only use, set `VFLOW_AGENT_HOST=127.0.0.1`.
