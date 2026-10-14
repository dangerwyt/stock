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
| `TUSHARE_TOKEN` | 主源（第三方中继）。**日额度有限**，见第五节「额度与缓存」 | 回落到 B 套 |
| `TUSHARE_FALLBACK_URL` / `TUSHARE_FALLBACK_API_KEY` | B 套备用源 | 主源挂了就没有退路 |
| `TUSHARE_VERIFY_SSL` | 主源用自签证书 → 填 `false` | 主源连接失败 |
| `QINGHONG_API_KEY` | 资讯首选源 | 资讯回落到 NewsAPI / Tushare |
| `NEWSAPI_KEY` | 资讯次选源 | 可留空（会跳过，不会造假） |
| `ADMIN_API_TOKEN` | 管理接口 + 外部 tick 调度鉴权 | 管理接口不可用；**且外部 tick 调度整体静默失效、定时任务全不跑**（tick 脚本读不到 token 直接退出，后端对空 token 一律 401） |
| `TOP50_SNAPSHOT_PATH` | TOP50 快照落盘路径 | 用默认 `backend/app/data/top50_snapshot.json` |

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
自动画像更新已启动：每天 00:30（Asia/Shanghai）巡检一轮
下次巡检时间：2026-10-13T00:30:00+08:00
```

看到这两行就说明 FastAPI 与定时任务都起来了。

（交易日轮次调度是**外部 tick**，后端启动日志里没有它的痕迹 —— 想确认它通了，
curl 一下 `/health` 看 `jobRuns` 字段，或在宿主机上跑一次
`bash scripts/scheduler-tick.sh --once`，见第八节「定时任务」。）

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
├── custom_agents.json       # 自建角色（运行态，不入库；缺失时用种子自动注入）
├── custom_agents.seed.json  # ← 原版 12 位策略画像的种子（**入库**，随代码部署）
├── ai_threads.json          # 会话与消息
├── job_runs.json            # 交易日调度的运行记录（per-round 去重锁 + 最近一轮结果）
├── top50_snapshot.json      # TOP50 快照（同一「数据窗口」内复用，重启不重算）
└── agent_docs/<角色id>/     # 画像 meta.json + 上传的资料原文（运行态）
```

备份就是拷这个目录：

```bash
tar czf sip-data-$(date +%Y%m%d).tar.gz backend/app/data
```

#### 12 位老师怎么上去的（种子机制）

原版 12 位策略画像**不是内置角色**，而是以「自建角色」形式存在的（`custom_agents.json`
+ `agent_docs/<id>/meta.json`）。这两个路径都在 `.gitignore` 里 —— 所以初始值另存了一份
**入库**的种子 `custom_agents.seed.json`：

- **运行态文件不存在时**（新机器 / 重建容器 / 清空数据）→ 首次读取自动注入并落盘
- 之后就和普通自建角色一样，**可增删改**；删掉的老师**不会**被下次启动加回来
  （判据是「文件不存在」而不是「列表为空」，这一点很关键）
- 想强制恢复出厂：删掉 `custom_agents.json` 与 `agent_docs/<12个id>/` 后重启后端

> ⚠️ 画像（`meta.json` 里的 `factorWeights`）是 TOP50 的**打分依据**，和角色记录缺一不可：
> `agent_factor_score.custom_teacher_specs()` 要求画像非空才把角色纳入打分。
> 种子文件里两者都带了，所以新环境一次到位。

> ⚠️ 服务器上**自建的角色与上传的资料**仍是从零开始的（那才是真正的用户数据，
> 不入库）—— 需要时自行搬运 `custom_agents.json` 与 `agent_docs/<你的角色id>/`。

#### 清理失败上传 + 还原 12 位老师画像

**症状**：早期容器没装 rapidocr / opencv 时上传的图片会 OCR 失败（`ocrStatus:failed`）。
而 `add_document` 每次上传都会把该角色的 `profile` 置空、OCR 失败又不会重跑提炼
→ 12 位老师的画像变 `null` → 引擎要求画像非空才纳入打分，老师们直接退出 TOP50。
上传了一堆 OCR 失败的图后，用这个脚本还原：

```bash
# 脚本不在镜像里，cp 进容器再跑（无需 --build）
docker compose cp scripts/clean_failed_docs.py backend:/tmp/clean_failed_docs.py

# 先看清单（dry-run，不落盘）：会列出每个角色「删 N 份垃圾 / 画像已还原(seed)」
docker compose exec backend python /tmp/clean_failed_docs.py
# 确认无误再真正执行
docker compose exec backend python /tmp/clean_failed_docs.py --apply
```

- **默认（surgical）**：删掉所有 `ocrStatus:failed` / `status:rejected` 的文档（含 `files/` `texts/` 文件），并把因此变空的画像从种子 `custom_agents.seed.json` 还原，使老师们重新参与 TOP50 打分。非种子角色（自己建的）profile 仍为空 —— 它们需重跑提炼，不强行还原。
- **`--reset`**：对 12 位种子老师**整份还原**（清空所有上传资料 + 写回种子画像/分数）。想彻底清零上传资料时用 `docker compose exec backend python /tmp/clean_failed_docs.py --reset --apply`。
- 还原后老师们画像恢复，TOP50 立刻重新纳入；想让画像更贴合你的资料，可在前端对老师们跑一次「提炼画像」，或等每天 00:30 的定时提炼。

> ⚠️ 脚本默认只**删失败/被拒的垃圾**，正常上传（已 `ready`）不受影响；先跑一次 dry-run 看清单最稳。

### 额度与缓存

Tushare 主源的**日额度很紧**，而全市场拉取（一次 5000+ 行）是最大的消耗点。
代码里有三层防护，理解它们能帮你判断"榜单为什么没更新"：

| 层 | 机制 | 效果 |
|---|---|---|
| 股票池缓存 | `stock_basic` 进程内缓存 24h | 全市场股票池每天只拉一次 |
| **数据窗口缓存** | 「最近交易日全市场行情」按窗口缓存（见下） | `top50` 与 `market-close` 共用一份，一天只真拉 2 次 |
| **TOP50 快照** | 按「数据窗口 + 画像指纹」冻结，并**落盘** | 同窗口内无论请求多少次、重启多少次都不重算 |

**「数据窗口」是什么**：A 股 15:00 收盘、Tushare 全市场 `daily` 通常 15:30 前后落库。
所以 15:30 是分界线 —— 之前「最近有数据的交易日」是上一交易日，之后是当日。
同一窗口内答案稳定，可以放心复用缓存；跨过 15:30 会自动换窗口重算。

> 这**不是** TTL。用「自然日」或「5 分钟」当键都不对：前者会让早晨缓存的昨日数据
> 一直用到深夜，后者会让同一份榜单被无谓地重算几十次（每次都是一轮全市场拉取）。

**怎么确认缓存生效**：看页面 TOP50 顶部的「数据窗口 `20261012` 内复用」，或：

```bash
docker compose logs backend | grep -E "落盘|恢复|已生成"
# 想看是否真的没打 Tushare，直接找主源告警：
docker compose logs backend | grep "主源失败"
```

| 日志 | 含义 |
|---|---|
| `TOP50 快照已落盘` | 本轮真拉了一次并冻结 |
| `TOP50 已从落盘快照恢复` | 重启后直接复用，**零 Tushare 调用** |
| `窗口 ... 与当前 ... 不符，丢弃并重算` | 跨过 15:30 了，属正常 |
| `主源失败，尝试 B 套备用：... code=42901` | 主源日额度耗尽，已自动切备用源（业务不受影响） |

### 定时任务

本服务有**两套**互不干扰的定时机制：

| | 跑什么 | 谁在计时 | 频率 |
|---|---|---|---|
| 进程内 APScheduler | `auto-extract-profiles`：按「资料 + 会话历史」更新自建角色画像 | 后端进程自己 | 每天 **00:30**（Asia/Shanghai） |
| 外部 tick 调度 | 交易日 8 轮任务（TOP50 / 资讯 / 收盘刷新…） | **仓库外的计时器**每分钟敲一次接口 | 每 60s 一次「敲」，由服务端判定该不该跑 |

#### 1）画像自动更新（进程内，开箱即用）

- 时间是**绝对时刻**不是间隔，所以重启不会漂移；代价是进程若在当天 00:30 之后才启动，当天跳过。
- 时间点改了要动 `.env` 的 `AUTO_EXTRACT_HOUR` / `AUTO_EXTRACT_MINUTE` 并重启后端。
- 它有**指纹变更检测**：资料/会话没变就跳过，不会每天空烧模型额度。
- 觉得吵可以关：`.env` 里 `AUTO_EXTRACT_ENABLED=false`。

#### 2）交易日轮次调度（外部 tick）

**为什么要在外部计时**：tick 只负责"敲一下"，服务端根据上海时间和磁盘上的持久锁决定
"此刻该不该跑、这一轮跑没跑过"。进程重启后下一分钟自动接上，且同一轮不会被反复 tick 重复执行。

外部计时器只需要一条命令，每 60 秒执行一次：

```bash
bash scripts/scheduler-tick.sh --once
```

**上线前先手动验证一次**（这一步同时验证 `.env` 里的 `ADMIN_API_TOKEN` 是否被正确读取）：

```bash
# Docker 部署：backend 没有对外端口，走 nginx（8080）进
LOCAL_SCHEDULER_BASE_URL=http://127.0.0.1:8080 bash scripts/scheduler-tick.sh --once
echo "退出码 $?（0 = 通；1 = 鉴权或网络问题）"
```

然后再挂到系统计时器上（四种方式任选）：

```bash
# ① macOS —— 一条命令装成 launchd 服务（推荐，对齐本项目 v1 的模型）
bash scripts/install-mac-scheduler.sh                    # 默认打 :8080（Docker 部署）
bash scripts/install-mac-scheduler.sh --status           # 查状态 + 看日志
bash scripts/install-mac-scheduler.sh --uninstall        # 卸载
# 本机 uvicorn 而非 Docker 时：LOCAL_SCHEDULER_BASE_URL=http://127.0.0.1:8000 bash scripts/install-mac-scheduler.sh

# ② crontab（Linux / macOS 都行，最省事）
crontab -e
* * * * * /bin/bash /path/to/repo/scripts/scheduler-tick.sh --once >> /tmp/sip-tick.log 2>&1

# ③ systemd timer（Linux 服务器）
#    /etc/systemd/system/sip-tick.service :
#      [Service]
#      Type=oneshot
#      Environment=LOCAL_SCHEDULER_BASE_URL=http://127.0.0.1:8080
#      ExecStart=/bin/bash /path/to/repo/scripts/scheduler-tick.sh --once
#    /etc/systemd/system/sip-tick.timer :
#      [Timer]
#      OnBootSec=1min
#      OnUnitActiveSec=60s
#      [Install]
#      WantedBy=timers.target
#    systemctl enable --now sip-tick.timer

# ④ 前台常驻（调试用，Ctrl-C 退出）
LOCAL_SCHEDULER_BASE_URL=http://127.0.0.1:8080 bash scripts/scheduler-tick.sh
```

**Windows 开发机**（正式部署不在 Windows，但本地想让它自动跑）—— 用任务计划程序：

```powershell
# 先找到 Git Bash 的 bash.exe（一般是这个路径）
$bash = "C:\Program Files\Git\bin\bash.exe"
$repo = "E:\workspace\stock-intelligence-platform-v2"

schtasks /Create /TN "sip-scheduler-tick" /SC MINUTE /MO 1 /F `
  /TR "`"$bash`" `"$repo\scripts\scheduler-tick.sh`" --once"
schtasks /Run    /TN "sip-scheduler-tick"     # 立刻试跑一次
schtasks /Query  /TN "sip-scheduler-tick" /V /FO LIST   # 看上次结果码
schtasks /Delete /TN "sip-scheduler-tick" /F  # 卸载
```

> ⚠️ 任务计划程序跑的是**登录用户**上下文，仓库根 `.env` 必须存在（tick 要从里面读 `ADMIN_API_TOKEN`）。
> 另外注意 `schtasks` 的 `--once` 与 bash 路径都要带引号，否则含空格的路径会被截断。

轮次表（交易日，宽限窗 **5 分钟**：`07:20` 会在 07:20–07:24 之间被命中）：

| 时刻 | 任务 | 本项目状态 |
|---|---|---|
| 07:20 | us-etf-map · global-news · market-close · **top50** | top50 / news / market-close 已落地，us-etf-map 为占位 |
| 09:26 | opening-auction · global-news | opening-auction 占位 |
| 10:30 / 13:05 / 14:00 | market-pulse · intraday-news | market-pulse 占位，资讯已落地 |
| 11:35 | market-pulse · intraday-news · midday-review | 同上 |
| 17:40 | market-close · post-close · accuracy · global-news | post-close / accuracy 占位 |
| 22:00 | global-news · market-close · post-close · accuracy | 同上 |

- **非交易日**只跑 `08:30` 与 `22:00` 两轮 `global-news`；**周日 22:00** 额外追加 `teacher-distillation`（画像蒸馏）。
- 交易日判定优先查 Tushare `trade_cal`；查不到时退到「周末即休市」的近似。
- 占位任务会如实返回 `stubbed`（不是假装成功），在 tick 日志里能看到。
- **不补造数据**：错过的窗口就让它错过，等下一轮 —— 计划外请求会让快照时间戳和轮次表对不上。

想查「上一轮跑了什么」：

```bash
curl -s http://127.0.0.1:8080/health | python -m json.tool
# jobRuns.lastRunAt / jobRuns.lastSlot / jobRuns.lastResults 就是最近一次 tick 的记账
```

> 运行记录写在 `backend/app/data/job_runs.json`（同样在 volume 上）。
> 想看某个时刻会命中哪一轮（不改系统时钟）：
> `curl -s "http://127.0.0.1:8080/api/admin/scheduled?at=2026-10-12T14:01" -H "Authorization: Bearer $ADMIN_API_TOKEN"`
> —— 注意 `?at=` 只在 `APP_ENV=development` 生效，容器里是 `production`，所以这条要在本地 uvicorn 上试。

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
