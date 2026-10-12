# 部署到 Mac 服务器（Docker Compose）

面向内网自用：不用域名、不做 HTTPS，浏览器直接访问 `IP:8080`。

架构很简单 —— 只有两个容器，没有任何外部中间件（无 PG / Redis / Milvus，数据全落 JSON 文件）：

```
浏览器 ──► sip-frontend (nginx :80)
                ├── 静态文件（Vue 构建产物）
                └── /api/* ──反代──► sip-backend (uvicorn :8000)
                                        └── 数据卷 ./backend/app/data
```

只有前端端口对外，后端留在 compose 内网里，因此**不需要配 CORS**，也不用把 8000 暴露出去。

---

## 一、服务器准备（Mac）

装 Docker Desktop：

```bash
# Apple Silicon（M 系列）或 Intel 都装同一个
brew install --cask docker
open -a Docker            # 首次启动，等菜单栏图标不再转圈
docker version            # 能看到 Server 段就是好了
```

不需要单独装 Python / Node —— 都在镜像里。

> 内网访问前先确认 Mac 的防火墙允许 8080 入站（系统设置 → 网络 → 防火墙）。

## 二、拉代码

```bash
git clone <你的仓库地址> stock-intelligence-platform-v2
cd stock-intelligence-platform-v2
```

## 三、创建 .env（**必做，且不要提交**）

`.env` 被 `.gitignore` 忽略，克隆下来是没有的。以 `.env.example` 为模板（它已按 `backend/app/config.py` 的字段逐项对齐，共 31 项）：

```bash
cp .env.example .env
vim .env
```

至少要填的内容（对照 `backend/app/config.py`）：

| 变量 | 说明 | 不填的后果 |
|---|---|---|
| `MINIMAX_API_KEY` | LLM 通道，AI 研究室与自动提炼画像都靠它 | AI 功能报错 |
| `TUSHARE_TOKEN` | 主源（第三方中继） | 回落到 B 套 |
| `TUSHARE_FALLBACK_URL` / `TUSHARE_FALLBACK_API_KEY` | B 套备用源 | 主源挂了就没有退路 |
| `TUSHARE_VERIFY_SSL` | 主源用自签证书 → 填 `false` | 主源连接失败 |
| `QINGHONG_API_KEY` | 资讯首选源 | 资讯回落到 NewsAPI / Tushare |
| `NEWSAPI_KEY` | 资讯次选源 | 可留空（会跳过，不会造假） |
| `ADMIN_API_TOKEN` | 管理接口鉴权 | 管理接口不可用 |

> ⚠️ **别把 `.env` 拷进镜像**：容器里 `app/config.py` 会去找 `/.env`（找不到，因为镜像里代码在 `/app/app`），
> 真正生效的是 compose 的 `env_file` 把 `.env` 作为**环境变量**注入 —— 环境变量优先级高于 `env_file` 文件读取。
> 所以：改配置 = 改根目录 `.env` + 重启容器（`docker compose up -d`），不要去动镜像内部。
> 想知道最终生效值，跑第六节的连通性自检。

## 四、部署前预检（建议先跑）

装完 Docker、填完 `.env` 后，**先跑这个再构建**，把"跑到一半才发现"的问题提前暴露：

```bash
bash scripts/preflight.sh
```

它只读不改，检查这些：

| 分组 | 检查项 |
|---|---|
| 系统 | 操作系统 / 架构 |
| Docker | `docker` 命令、**daemon 是否在跑**、`compose` 版本 |
| 端口 | `8080`（读到 compose 里的映射自动换）是否被占 |
| 配置文件 | `.env`、`docker-compose.yml`、两个 Dockerfile、`nginx.conf` 是否齐 |
| 凭据 | 从 `.env` 读取并脱敏显示，区分「必需」与「可选」 |
| 网络 | Docker Hub（拉基础镜像）、Tushare 主源、MiniMax 是否可达 |
| 磁盘 | 可用空间（构建缓存 + 镜像约需 3~5G） |
| 数据目录 | 是否存在、是否可写（volume 挂载前提） |

末尾给 `PASS / WARN / FAIL` 统计。有 `FAIL` 会以退出码 1 结束，先修完再来。

> 最常见的一条就是 **`docker daemon 连不上`** —— 说明 Docker Desktop 没启动。

## 五、启动

```bash
docker compose up -d --build
```

首次构建要拉基础镜像、装 pip/npm 依赖，**大概 5～10 分钟**（Apple Silicon 上 arm64 镜像更快）。

看状态：

```bash
docker compose ps          # 两个容器都应是 Up (healthy)
docker compose logs -f backend
```

`backend` 日志里应出现：

```
自动画像更新已启动：每天 09:00（Asia/Shanghai）巡检一轮
下次巡检时间：2026-10-13T09:00:00+08:00
```

看到这两行就说明 FastAPI 与定时任务都起来了。

## 六、连通性自检（**关键一步**）

本机能连的数据源，换了网络环境未必连得上。**先跑自检再打开页面**：

```bash
docker compose exec backend python -m app.scripts.check_connectivity
```

输出逐项 PASS / FAIL / SKIP，末尾给总结。想排查细节加 `--all`：

```bash
docker compose exec backend python -m app.scripts.check_connectivity --all
```

判读要点：

- **全 PASS** → 数据源可用，正常使用。
- **Tushare FAIL** → 最常见。主源是第三方中继（自签证书、非官方域名），容易被网络策略拦。先确认容器能出网，再看是不是 `TUSHARE_VERIFY_SSL` 没设成 `false`。
- **LLM FAIL 且报 401/403** → 网络通，是 key 的问题。
- **外部源全挂** → 应用仍能启动，页面走内置兜底数据（`sourceMode=fixtures`），不会白屏。

自检脚本是**只读**的：不写文件、不改数据，可以反复跑。

## 七、访问

同一局域网内用服务器的 IP：

```
http://<服务器IP>:8080
```

查 IP：`ipconfig getifaddr en0`（Wi-Fi）或 `ipconfig getifaddr en1`（有线）。

端口冲突想换：改 `docker-compose.yml` 里 frontend 的 `ports: "8080:80"` 左边那个数字，再 `docker compose up -d`。

若本机 Docker Desktop 跑（非局域网服务器），想只让本机访问就把 `"8080:80"` 改成 `"127.0.0.1:8080:80"`。

## 八、日常运维

```bash
# 更新代码后重建（数据不会丢 —— 挂在 volume 上）
git pull
docker compose up -d --build

# 重启
docker compose restart backend

# 停掉（保留数据）
docker compose down

# 看实时日志
docker compose logs -f --tail=100 backend
```

### 数据与备份

角色 / 会话 / 上传的资料都在 **`backend/app/data/`**（compose 里挂成 volume）：

```
backend/app/data/
├── custom_agents.json      # 自建角色
├── ai_threads.json         # 会话与消息
└── agent_docs/<角色id>/    # 上传的资料原文
```

备份就是拷这个目录：

```bash
tar czf sip-data-$(date +%Y%m%d).tar.gz backend/app/data
```

> ⚠️ 服务器上是从零开始的（本地数据没有搬过去）—— 需要先在页面上新建角色、上传资料。

### 定时任务

`auto-extract-profiles` 每天 **09:00（Asia/Shanghai）** 跑一轮，按「资料 + 会话历史」更新自建角色画像。

- 它是**进程内**调度（APScheduler），所以后端必须是**单进程** —— 镜像里已经是 `uvicorn` 单 worker，别改成 gunicorn 多 worker，否则每个 worker 各跑一遍，同一批角色被重复塞进模型。
- 时间点改了要动 `.env` 的 `AUTO_EXTRACT_HOUR` / `AUTO_EXTRACT_MINUTE` 并重启后端。
- 想看某天跑没跑：`docker compose exec backend ls -l --time-style=full-iso app/data/` —— `custom_agents.json` 的 mtime 就是最后一次巡检写盘的时间（09:00 触发，因为要调模型，通常 09:05 前落盘）。
- 觉得吵可以关：`.env` 里 `AUTO_EXTRACT_ENABLED=false`。

---

## 九、排障速查

| 现象 | 原因 / 处理 |
|---|---|
| `docker compose ps` 里 backend 一直 `starting` | 看 `logs backend`；多半是 `.env` 缺 `MINIMAX_API_KEY` 之外还少了必填项，或端口冲突 |
| 页面打开是空白 | `docker compose logs frontend`；通常是构建时 npm 装包失败（服务器出网问题） |
| 页面能开但没有数据 | 先跑第五节的连通性自检 |
| 页面某块一直转圈 | nginx 反代超时不够：AI 会诊是长请求，`frontend/nginx.conf` 里设的是 600s，确认没被改小 |
| 上传资料失败 | 数据卷挂载或写权限问题，自检里的「数据目录可写」会直接报出来 |
| 想彻底重置 | `docker compose down`，删掉 `backend/app/data` 下的文件，再 `up -d` |

## 十、安全提醒（内网也建议做）

- `ADMIN_API_TOKEN` 一定要设，别留空。
- `.env` 不要提交到 Git，也不要拷进镜像（`.dockerignore` 已经排除）。
- 内网也不是绝对安全：路由器的 Wi-Fi 一旦有外人接入，这个服务就是裸奔的。数据敏感的话，至少把前端端口绑定到局域网网段而不是 `0.0.0.0`。
