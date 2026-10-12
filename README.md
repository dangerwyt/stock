# 智策研究 · A 股智能投研平台

一个「AI 投研工作台」：把**真实行情数据**、**可解释的量化榜单**和**可学习的 AI 角色**串成一条链路 ——
用户上传资料、创建自己的「老师」，AI 从中提炼出持仓周期、因子偏好与风控纪律，最终**真实影响 TOP50 榜单的打分与排名**。

> 本仓库是对 `reference-react/`（原 React 19 + Cloudflare Worker 原型）的一次**前后端分离重构**，
> 技术栈对齐 KnowPilot：Vue 3 + Element Plus 前端，FastAPI 后端，单进程部署，无 broker / 无 worker。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5 · Vite 6 · Element Plus 2.8 · Pinia 2.2 · Vue Router 4.4 · ECharts 5.5 · axios |
| 后端 | FastAPI 0.115 · uvicorn 0.32 · Pydantic 2.9 · sse-starlette（NDJSON/SSE 流式）· httpx |
| LLM | **MiniMax-M3**，经 `langchain-openai` 打 OpenAI 兼容端点（`LLM_BACKEND=minimax_v2` 可切原生端点） |
| 调度 | APScheduler `AsyncIOScheduler`（**进程内** cron，每天 9:00 Asia/Shanghai） |
| 存储 | 进程内缓存 + 各自独立的 JSON 存储（`backend/app/data/`）；内置样例数据在 `backend/app/fixtures/` |
| 文档解析 | `pypdf`（PDF ≤ 30 页 / ≤ 5 MB / ≤ 20000 字符） |

> 说明：**没有 Celery / Redis / 数据库**。这是刻意的 —— demo 阶段单进程 uvicorn 即可支撑，
> 少一层基础设施就少一处「消息丢失 / worker 卡死」的故障面。

---

## 目录结构

```
.
├── frontend/            # Vue 3 SPA（13 个页面），vite proxy 把 /api 转发到 :8000
│   ├── src/views/       # Overview / Top50 / Market / Portfolio / News / AILab /
│   │                    # Industries / Strategies / Quant / Review / Accuracy / Risk / Operations
│   ├── src/api/         # axios 封装
│   ├── src/stores/      # Pinia
│   ├── src/utils/ui.js  # 模板里禁止内联三元/比较，统一抽到这里
│   └── public/design-reference/   # 设计稿（被页面真引用）
├── backend/             # FastAPI 单进程
│   └── app/
│       ├── main.py          # 应用入口；/health 会带 scheduler 下次运行时间
│       ├── config.py        # pydantic-settings，只读**仓库根** .env
│       ├── routers/         # agents / agent_documents / research / snapshots
│       ├── top50_engine.py  # TOP50 量化引擎（移植自 reference-react 的 reference 引擎）
│       ├── tushare_client.py# Tushare 主源 + ProMax 备用源，双源同构解析
│       ├── news_aggregate.py# 晴红 → NewsAPI → Tushare major_news → fixtures 逐级降级
│       ├── agent_*.py       # 资料 → 画像 → 打分 → 因子映射 的 AI 链路
│       ├── llm.py           # init_chat_model 懒单例（MiniMax-M3，关思考）
│       ├── scheduler.py     # 每天 9:00 巡检自建角色，带指纹变更检测
│       ├── guardrails.py    # 话题守门（AI 只答股票财经）
│       ├── fixtures/        # 内置样例 JSON（**仅作降级兜底**）
│       └── data/            # 运行态存储（custom_agents / ai_threads / agent_docs），已 gitignore
├── reference-react/     # 原 React + Cloudflare Worker 原型，仅作设计/逻辑参考
└── docs/                # 需求、设计规范、技术架构、AI 研究待办（T0–T6）
```

---

## 本地启动

**前置**：Python 3.13、Node 22+。凭据统一写在**仓库根** `.env`（见下节），不要引入第二个 env 文件。

```bash
# 1) 后端（在 backend/ 下启动，:8000）
cd backend
python -m uvicorn app.main:app --port 8000

# 2) 前端（在 frontend/ 下启动，:5173；/api 经 vite proxy 转发到 :8000）
cd frontend
npm install          # 沙箱环境可加 --ignore-scripts
npm run dev
```

打开 <http://localhost:5173>。后端健康检查：`curl --noproxy '*' http://localhost:8000/health`。

> ⚠️ 改完根 `.env` **必须重启 uvicorn**（非 `--reload` 时不会自动重载）。
> ⚠️ 若前端 esbuild 报错，见 `.workbuddy/memory/MEMORY.md` 里的「esbuild 假死坑」：
> `frontend/node_modules/@esbuild/` 平台包缺失时要 `npm install --no-save --ignore-scripts @esbuild/win32-x64@0.25.12` 显式补装。

---

## 部署

已提供 Docker Compose 部署（两容器：nginx 托管前端 + `/api` 反代 → FastAPI 单进程）。
数据全落 JSON 文件、无外部中间件，因此**不需要** PG / Redis / Milvus。

```bash
cp .env.example .env      # 填凭据（怎么填见下节）
bash scripts/preflight.sh # 部署前预检：Docker/端口/凭据/网络/磁盘，只读不改
docker compose up -d --build
docker compose exec backend python -m app.scripts.check_connectivity   # 先自检再使用
```

访问 `http://<服务器IP>:8080`。

⚠️ 两个关键约束：

- **后端必须单进程**：定时任务（每天 09:00 自动提炼画像）跑在进程内的 APScheduler 上，多 worker 会重复执行。
- **数据挂 volume**：`./backend/app/data`，否则 `up --build` 重建容器会丢角色与会话。

> 配置生效路径：凭据写在根目录 `.env`，由 compose 以**环境变量**注入容器（环境变量优先级高于
> `app/config.py` 里那个 env_file 路径 —— 容器内它会指向 `/.env` 而找不到，属预期行为）。
> 改完 `.env` 要 `docker compose up -d` 让它重新注入。

完整步骤（含 Mac 服务器、自检判读、排障表）见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**。

---

## 环境变量（仓库根 `.env`）

`backend/app/config.py` 的 `env_file` **只认仓库根 `.env`**；要覆盖就用**环境变量**（优先级高于 `.env`）。

| 变量 | 作用 |
| --- | --- |
| `MINIMAX_API_KEY` / `MINIMAX_BASE_URL` / `MINIMAX_MODEL` | LLM 主通道（默认 `MiniMax-M3`） |
| `LLM_BACKEND` | `langchain`（默认，OpenAI 兼容端点）/ `minimax_v2`（原生端点） |
| `AI_DAILY_CALL_LIMIT` | LLM 每自然日调用上限（进程内计数），默认 200 |
| `TUSHARE_TOKEN` / `TUSHARE_API_URL` | Tushare **主源**（ProMax 中继，POST 到根） |
| `TUSHARE_VERIFY_SSL` | 主源为自签证书时置 `false` |
| `TUSHARE_FALLBACK_URL` / `TUSHARE_FALLBACK_API_KEY` | **备用源**（ProMax 接口聚合，GET + `X-API-Key`） |
| `NEWSAPI_KEY` | 新闻聚合（为空则跳过新闻块，**不造假数据**） |
| `QINGHONG_BASE_URL` / `QINGHONG_API_KEY` | 晴红财经资讯（资讯链首源） |
| `ADMIN_API_TOKEN` | 管理员接口鉴权 |
| `CUSTOM_TEACHER_WEIGHT_SHARE` | 自建老师合计权重份额：`1.0` = 完全接管（当前口径），`0.0` = 回到内置基线 |
| `CYCLE_TILT_STRENGTH` | 周期先验混合强度 λ（默认 `0.5`），决定四个周期榜单的区分度 |
| `MIN_CONSENSUS_PARTICIPANTS` | 构成「共识」所需的最少**参与打分**画像数（默认 3） |
| `AUTO_EXTRACT_ENABLED` / `AUTO_EXTRACT_HOUR` / `AUTO_EXTRACT_MINUTE` | 每天定时更新画像（默认 9:00） |
| `DOC_RELEVANCE_ENABLED` | 上传资料相关性过滤开关 |

> 没配数据源时应显示「缺配置 / 缺数据」，**不允许编造数字**。Tushare 无 token 或失效 → 接口返回 **503**（不静默回落样例数据）。

---

## 关键机制（读代码前先看这几条）

- **TOP50 榜单**（`top50_engine.py`）：硬门槛筛选 → 7 因子归一化 → 内置基线打分 + 自建老师画像打分
  → 四周期加权 → 取前 50。榜单分数**唯一权威**是这里；LLM 给的分数只补理由、**不参与排名**。
- **AI 学习真的会改分**（与原版的有意分歧）：`agent_factor_score.py` 把 AI 提炼出的 8 类抽象因子
  映射到量化因子（趋势→动量/振幅、资金→流动性/换手、情绪→量能、估值→PE/PB），再按
  `CUSTOM_TEACHER_WEIGHT_SHARE` 与内置基线加权。
- **两个分母别混**：`meta.teacherCount` = 自建老师**总数**（界面「x/N」）；
  `meta.agentCount` = **参与打分**的画像数（没学出画像的角色不投票）。
- **话题守门**（`guardrails.py`）：AI 只答股票财经相关问题；拦截时走流式 `refused` 帧，**不返回 HTTP 400**。
- **内置 12 位老师已从产品移除**：界面里不存在，只在后端引擎内部作**兜底基线**与防重名。
- **运行态数据不入库**：`backend/app/data/` 下的三个 JSON 存储已 gitignore，缺失时会自动重建（返回空列表）。

---

## 文档

- [`docs/AI_RESEARCH_BACKLOG.md`](docs/AI_RESEARCH_BACKLOG.md) —— AI 研究能力待办（T0–T6）与完成记录
- [`docs/TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) —— 架构说明
- [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md) —— 页面设计规范
- [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) —— 产品需求
- `docs/REPAIR_HANDOFF_2026-09-07.md` —— 交接说明
- `.workbuddy/memory/` —— 项目记忆与踩坑记录（**本地保留，不入 git**）

---

## 免责声明

本项目为**技术演示**，不构成任何投资建议。榜单基于公开数据与规则画像计算，可能存在数据延迟、
供应商口径差异与模型误差；请勿据此进行真实交易决策。
