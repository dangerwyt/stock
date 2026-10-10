# AI 研究模块 · 后续任务排期

> 记录时间：2026-10-09　｜　状态：**已排期，未开工**（用户明确「后面再改」）

## 进度

| 编号     | 状态           | 说明                                                                                                                                                                                |
| ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0** | ✅ 2026-10-09 | 会诊已接真 LLM（新增 `app/agent_chat.py`，重写 `routers/research.py`）。NDJSON 帧协议不变，前端零协议改动；帧里新增 `answer` 字段。                                                                                 |
| **T3** | ✅ 2026-10-09 | 随 T0 落地：老师 prompt 带域规则；汇总另用 `_SUMMARY_RULE`（**不复用**域规则 —— 见下方 T1 的风险说明）。                                                                                                          |
| **T1** | ✅ 2026-10-09 | 入口硬守卫：新增 `app/guardrails.py`（关键词粗筛 + 模型分类）+ `refused` 帧 + 前端「范围提示」气泡。                                                                                                             |
| **T2** | ✅ 2026-10-09 | 资料相关性过滤：新增 `app/relevance.py`（入库判定 + 提炼前段落筛选）；不相关标 `rejected`、留档但不参与提炼。                                                                                                           |
| **T4** | ✅ 2026-10-09 | 定时自动更新画像：新增 `app/scheduler.py`（APScheduler cron，**每天 9:00**）+ `app/agent_extract.py`（提炼逻辑抽出共用）+ 指纹变更检测。                                                                           |
| **T5** | ✅ 2026-10-10 | AI 学习参与排名：新增 `app/agent_factor_score.py`（抽象因子→量化因子映射）+ 改造 `top50_engine.py`（AI 老师真实参与加权、指纹驱动新 snapshotId）。**推翻原版「AI 不改分」铁律**，真实行情端到端验收通过（B vs A 逐票 score 一致 / C vs B 分数变化 199 条）。 |

## 依赖总览

四条任务不是平行的，先看依赖：

```
T0  聊天接真 LLM（隐含前置：当前会诊是 mock）
 ├─→ T1  AI 模块只回应股票财经（话题守卫）
 └─→ T3  system prompt 域约束（聊天只答财经）
T2  上传资料的相关性过滤（独立，随时可做）
T4  每天 9:00 自动更新老师画像（独立，依赖已有提炼链路）
```

**为什么 T1 / T3 必须先做 T0**

`backend/app/routers/research.py` 的 `POST /api/ai/jobs` 现在是**假流**：

```python
async def _run_stream(job):
    for i, state in enumerate(job["agentStates"]):
        state["status"] = "running"; yield ...
        await asyncio.sleep(0.25)          # ← 假进度
        state["status"] = "completed"; yield ...
    job["summary"] = "（演示综合）多老师会诊完成：…"   # ← 写死的结论
```

全程没有 import `app.llm`。**没有真实 LLM 调用，就谈不上「限制它只回答财经」或「完善它的 system prompt」**——  
现在没有 prompt 可完善，也没有模型会被越界诱导。所以 T1 / T3 的第一件事都是把 T0 做掉。

---

## T0（前置）· 把会诊/聊天接成真实 LLM ✅ 已完成（2026-10-09）

**目标**：`/api/ai/jobs` 从「假进度 + 写死 summary」变成「真调用模型 + 真流式」。

**现状**

- `research.py::_new_job` / `_run_stream` / `_JOBS` 全是进程内 mock，重启即丢。
- 前端 `AILabPage.vue` 已经在按 NDJSON 帧消费（`accepted` / `agent` / `summary`），**协议不用改**。
- 模型层已就绪：`app/llm.py` 的 `chat()`（langchain 通道 + 关思考 + 单例）可直接复用。

**方案**

1. `_run_stream` 里把 `asyncio.sleep(0.25)` 换成真实调用：
   - 选中的 N 位老师 → 读各自 `agents` 画像（内置 12 位走 fixtures，自建走 `agent_docs.profile()`）
   - `asyncio.gather` **并行**发起 N 个 `llm.chat()`（每位老师一个 prompt，注入自己的 decision/select/risk）
   - 每完成一个就跑 `yield` 一帧进度，最后再来一次「汇总」调用产出 summary
2. 汇总用一次单独的 prompt（把 N 份回答拼进去 → 输出综合结论），与 `agent_profile` 的死 schema 思路一致。
3. `_JOBS` 仍是进程内 dict —— demo 够用；要断点续传再考虑落库（那是上 LangGraph 的时机）。

**涉及文件**：`backend/app/routers/research.py`（主）、`backend/app/agents.py`（读画像）、  
新增 `backend/app/agent_chat.py`（prompt 模板 + 汇总逻辑）

**风险**：N 位老师 × 并行 = 一次提问 N+1 次 LLM 调用，`ai_daily_call_limit=200` 要重新算  
（3 位老师 × 20 个问题 = 80 次，还行；12 位就顶到 260 次，需要调限额或限流）。

**验收**：选 3 位老师提问 → NDJSON 帧里能看到每位老师的**真实不同回答** → summary 是汇总而非写死字符串。

---

## T1 · AI 研究模块只对股票财经类信息做出回应 ✅ 已完成（2026-10-09）

**依赖**：T0。

**现状**：无任何范围限制（也没有真实回答）。前端 composer 只做 UI 校验。

**方案：双层守卫**

| 层 | 位置              | 作用                     | 强度          |
| - | --------------- | ---------------------- | ----------- |
| 软 | system prompt   | 「你是股票投研助手，非财经话题一律礼貌拒绝」 | 可被绕过，不能单独依赖 |
| 硬 | `create_job` 入口 | 先跑一次分类调用，判定 `in_scope` | 真正的闸门       |

- 分类 prompt 极短（`{"in_scope": true/false, "reason": "..."}`），max_tokens 64 够用，约 0.5s。
- 非财经 → **不进入会诊流程**，直接 `yield` 一个 `{"type":"refused","reason":...}` 帧，  
  前端 `AILabPage.vue` 需要加一个分支渲染成提示气泡（不能让它当成正常回答）。
- 可选优化：关键词白名单（含「股票/基金/财报/板块/涨停…」）直接放行，省掉分类调用。

**涉及文件**：`research.py`（入口拦截 + refused 帧）、新增 `app/guardrails.py`（分类 + prompt）、  
`AILabPage.vue`（渲染 refused）

**风险**：误杀（把「半导体设备国产化率」这类问题判成非财经）。阈值要留「不确定时放行」的余地。

**验收**：问「今天天气怎样」→ 被拒并给出理由；问「半导体板块怎么看」→ 正常会诊。

---

## T2 · 上传资料时排除非股票财经内容 ✅ 已完成（2026-10-09）

**依赖**：无（可并行开工）。

**现状**：`agent_docs.add_document()` → `documents.extract_text()` 只做**纯文本抽取**  
（txt 五级编码回退 / PDF pypdf 取文本层），**完全不看内容是不是财经相关**；  
`add_document` 里没有任何内容判断。提炼时 `agent_profile.build_messages()` 把  
`read_documents()` 的全量正文一股脑塞进 prompt。

**方案：两层过滤**

1. **入库层**（`add_document` 内，解析成功后）：  
   整篇做一次相关性判定（`{"relevant": bool, "reason": "..."}`）。
   - 不相关 → 仍然落盘但在 `record` 里标 `"status": "rejected"` + `reason`，  
     **不计入 `read_documents()`**（即不参与提炼），前端列表里显示灰掉 + 原因。
   - 不建议直接 400 拒收：用户想知道「为什么没收」，落盘 + 标记更好排查。
2. **提炼层**（`build_messages` 之前）：  
   段落级筛选 —— 按空行/标题切段，一次调用让模型返回「要剔除的段号」，  
   把广告、目录、免责声明、公司八卦剔掉再拼 prompt。
   - 一次调用做完，不要「每段一次」。
   - 顺带解决 `max_document_chars=20000` 截断后仍混入无关内容的问题。

**涉及文件**：`backend/app/documents.py`（切段工具）、`agent_docs.py::add_document`、  
`agent_profile.py::build_messages`、新增 `app/relevance.py`

**风险**：多一次 LLM 调用 → 上传变慢（现在是同步返回，可能从 ~1s 变 ~3s）。  
若嫌慢，可把入库判定改成异步（先返回「解析完成，正在检查相关性」，前端轮询）。

**验收**：传一份《员工食堂菜单.pdf》→ 标记为不相关、不进提炼；  
传一份正经研报 → 正常提炼，且 evidence 里不再出现免责声明段落。

**实际实现（已完成）**

| 位置                           | 做法                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **新增** `app/relevance.py`    | `judge_document()` 整篇判定（取样「头 3000 + 尾 1000」字，理由是「这是什么资料」写在开头、免责声明在结尾）；`split_sections()` 按空行切段；`prune_document()` 一次调用返回要剔除的段号，段数 > 60 时只送「头 30 + 尾 30」、中间段一律保留                                                     |
| `agent_docs.py`              | `add_document()` 入库前判定，不相关写 `status="rejected"` + `relevanceReason`；新增 `effective_documents()`（排除 rejected）；`read_documents()` 跳过 rejected；`extraction.documentCount` 一律用有效资料数；`_default_meta()` 加 `autoExtract` 字段 |
| `agent_profile.py`           | 新增 `prune_documents()`，**并行**跑（`ThreadPoolExecutor`，串行的话 3 份资料要白等 3 倍时间）；`extract_profile()` 先筛后拼 prompt                                                                                                            |
| `routers/agent_documents.py` | `start_extraction` 用 `effective_documents` 判空，全是 rejected 时给专门的错误文案                                                                                                                                                 |
| `AgentDocsPanel.vue`         | `documentStatus` 区分「有效 N 份」与「另有 M 份因与股票财经无关被排除：文件名」；上传时若被拒给橙色 `warn` 提示（12s 自动消失）；提炼按钮按**有效**资料数解锁                                                                                                                  |
| `theme.css`                  | 新增 `.agent-docs-status.warn`                                                                                                                                                                                        |

**安全阀（都在 `relevance.py`）**

- 判定失败 → 按「相关」放行（守卫挂了不该让用户传不了资料）；
- 段落筛选失败 / 返回空 / 删过头（剩 < 30%）→ 回退原文；
- 段数 < 4 或正文 < 400 字 → 跳过筛选（没东西可剔）。

**验收记录**

```
入库判定 : menu.txt → rejected「菜谱内容，不属于财经研究范畴」；research-noisy.md → parsed
           上传耗时 3~4s（含一次判定调用）
read_documents : 只返回研报（菜谱被跳过）
段落筛选 : 20 段 → 剔 12 段（封面/目录/免责声明/联系方式/广告），866→507 字
           「ZZNOISEZZ」噪声标记消失，正文关键句与纪律段完整保留
提炼     : 11s 完成；evidence 4 条全部是正文关键句，无免责声明
前端     : 面板显示「另有 1 份因与股票财经无关被排除：menu.txt」；
           再传菜谱 → 橙色提示「以下资料与股票财经无关，已留档但不会参与画像提炼：…」
```

---

## T4 · 每天 9:00 按「会话历史 + 上传资料」更新老师画像 ✅ 已完成（2026-10-09）

**依赖**：提炼链路（已具备，`routers/agent_documents.py::_extract`）。

**现状**：提炼**只能手动触发**（前端点「提炼画像」→ `POST /api/agents/{id}/extract`）。  
项目**没有任何调度器**（无 celery / apscheduler，`requirements.txt` 里也没有）。

**方案**

1. **选型：APScheduler**（不是 Celery）
   - 单进程 uvicorn → `AsyncIOScheduler` 进程内跑最省事，不引入 broker/worker。
   - Celery 在 Windows 上要 `--pool=solo`、还要拉起 worker，对 demo 是过度设计（KnowPilot 踩过这坑）。
2. **调度体**：每天 9:00（`CronTrigger(hour=9, minute=0)`，时区 Asia/Shanghai）→ 遍历 `agents.list_custom()`  
   → 有资料的 → **变更检测** → 变了才 `_extract`
3. **变更检测（关键，别省）**：  
   `meta.json` 里新增 `autoExtract: {fingerprint, at, status}`，  
   fingerprint = `sorted(doc.id + doc.uploadedAt)` + 该角色近期会话的「条数 + 最后时间戳」。  
   指纹没变就跳过 —— 否则每天无脑重跑，白烧调用、还会覆盖用户手工改过的画像。
4. **启动方式**：`app/main.py` 的 lifespan 里 `scheduler.start()` / `shutdown()`。

**涉及文件**：新增 `backend/app/scheduler.py`、`app/main.py`（lifespan）、  
`agent_docs.py`（meta 加 `autoExtract` 字段 + fingerprint 计算）、`requirements.txt`（+apscheduler）

**风险**

- 进程若在当天 9:00 之后才启动，当天跳过、等第二天（cron 不补跑历史时刻）。  
  这也是选 cron 而非 interval 的原因：interval 会漂移成「从启动起算 24 小时」，cron 永远是 9:00。
- 若将来上多 worker，每个 worker 都会跑一遍 → 需要 DB 锁或单独跑一个调度进程。
- 日限额：N 个自建角色 × 1 次/天，目前 N=3，完全够。

**验收**：把时刻临时调到下一分钟 → 观察日志出现「跳过（指纹未变）」和「触发提炼」两种路径 →  
改回 9:00。

**实际实现（已完成）**

| 位置                            | 做法                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **新增** `app/agent_extract.py` | 把提炼核心从路由抽出来（`run_extraction()`），手动触发与定时任务**共用同一条链路**，避免两边漂移。不抽的话 `scheduler` 就得反过来 import 一个 router 模块                                                                                                                                                                                   |
| **新增** `app/scheduler.py`     | `AsyncIOScheduler` + `CronTrigger(hour=9, minute=0, tz=Asia/Shanghai)`；`compute_fingerprint()`；`refresh_all(force=False)` 巡检；`start()/shutdown()/is_running()/describe()`。job 配 `max_instances=1` + `coalesce=True`（上一轮没跑完就跳过这一轮）+ `misfire_grace_time=3600`（9:00 那一刻进程正忙的话，1 小时内补跑仍算这次） |
| `agent_docs.py`               | `_default_meta` 加 `autoExtract`；新增 `auto_extract_state()` / `save_auto_extract()`                                                                                                                                                                                                        |
| `threads.py`                  | 「会话属于该角色」的判断抽成 `_belongs_to()`（**指纹与捞历史必须同口径**，否则会出现「指纹说没变但提炼捞到的会话其实变了」这种查不出来的 bug）；新增 `history_stats()`                                                                                                                                                                                 |
| `main.py`                     | `lifespan` 里 start/shutdown，用 try 兜住（调度器是附属能力，不该阻断 API 启动）；`/health` 增加 `scheduler` 字段（`trigger` / `nextRunAt`，一眼看出「几点跑、下次什么时候」）；顺手放开 `app` 包的 INFO 日志                                                                                                                                   |
| `config.py`                   | `auto_extract_enabled` / `auto_extract_hour=9` / `auto_extract_minute=0`                                                                                                                                                                                                                 |
| `requirements.txt`            | `apscheduler==3.11.3`                                                                                                                                                                                                                                                                    |

**验收记录**（第一版是 interval，直调 `refresh_all()` 验三条路径；改 cron 后再验触发时刻）

```
预热 C老师 指纹（避免动用户数据）
第 1 轮 : {'checked': 4, 'skipped': 1, 'extracted': 1, 'failed': 0, 'noDocs': 2}   ← 未跑过的角色被触发
第 2 轮 : {'checked': 4, 'skipped': 2, 'extracted': 0, 'failed': 0, 'noDocs': 2}   ← 指纹未变 → 跳过
上传第三份资料改变指纹
第 3 轮 : {'checked': 4, 'skipped': 1, 'extracted': 1, ...}                        ← 资料变了 → 重新触发
第 4 轮 : {'checked': 4, 'skipped': 2, 'extracted': 0, ...}                        ← 又稳定
启动日志: 2026-10-09 17:02:09 INFO [app.scheduler] 自动画像更新已启动：每 720 分钟巡检一轮
```

- `noDocs: 2` 是 A老师 / B老师（没有资料），符合预期。

**改成「每天 9:00」后的验证**（重启后端，走 `/health`）

```
GET /health → "scheduler": {
                "running": true,
                "jobId": "auto-extract-profiles",
                "trigger": "cron[hour='9', minute='0']",
                "nextRunAt": "2026-10-10T09:00:00+08:00"   ← 今天 10-09 17:10 启动，下次是明早 9 点
              }
启动日志 : 17:10:02 INFO [app.scheduler] 自动画像更新已启动：每天 09:00（Asia/Shanghai）巡检一轮
           17:10:02 INFO [app.scheduler] 下次巡检时间：2026-10-10T09:00:00+08:00
```

---

## T5 · AI 学习参与排名（推翻原版「AI 不改分」铁律）✅ 已完成（2026-10-10）

**背景**：用户拍板「**逻辑前半段可以按照原版来，但是 AI 学习需要改变分数**」—— 保留原版的  
「硬门槛 → 因子归一 → 打分 → 冻结 → 只读消费 → 回验」前半段，但**推翻**原版「AI 学习永不改分」  
这条铁律。四项配套决策：`factorWeights` 真实算分 / 参与排名（真改分）/ 新 snapshotId 重新冻结 /  
缺数据因子剔除后重归一。

**原版事实（reference-react，先查清再动手）**

- 原版**没有「自建角色」概念**：`worker/index.js` 零处 `custom`，`src/data.js` 静态 12 位，  
  所有逻辑遍历常量 `TEACHER_PROFILES` → 矩阵列**永远 12 列**，不存在「新增老师后列数变化」。  
  我们的 `/api/agents` + custom + `agent_docs.merge_agent_scores` + `agent_scoring.py` 是移植新增能力。
- 原版 AI 学习走**旁路**：`distillTeacherKnowledge` 只产 `status:"candidate"`，需 admin +  
  `confirmation==="PUBLISH"` + `evidenceIds` 才发布，且只换 knowledge 版本，**12 套打分系数纹丝不动**。

**实现（新增 / 改动）**

| 位置                                 | 做法                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **新增** `app/agent_factor_score.py` | AI 8 类抽象因子 → 引擎量化因子映射：`趋势→(m,range)`、`资金→(l,t)`、`情绪→(v,strength)`、`估值→(pe,pb)`（组内等权、互不重叠，`cap` 故意不映射）。无行情数据的 `事件/业绩/政策/产业` **剔除后按原比例重归一**。`custom_teacher_specs()` 只收**已完成画像提炼**的自建角色                                                                                                                                                |
| `app/top50_engine.py`              | `score_universe(rows, custom_specs)` 用同一公式形状算 AI 老师分；新增 `_cycle_weights()`（内置等比缩放到 `1-share`，AI 老师均分 `share`，合计仍 100）；`build_top50` 注入 cycle_weights、`reason`/`agentVotes` 分母随实际画像数；`meta` 增 `builtinAgentCount/aiAgentCount/aiAgentNames/aiWeightShare`；新增 `_spec_signature()` 指纹 + `invalidate_cache()`；evidence **累积合并**（上限 4000） |
| `app/config.py`                    | `custom_teacher_weight_share: float = 0.3`（设 0 = 完全回到原版算分）                                                                                                                                                                                                                                                                           |
| `app/agent_extract.py`             | 提炼完成后 `top50_engine.invalidate_cache()`（指纹机制本可自动发现画像变化，这里只是同画像强制重算的入口）                                                                                                                                                                                                                                                               |
| `app/agent_scoring.py`             | 候选来源由 `fixtures.load("top50")`（假数据）改为**传入实时快照**；口径改写：榜单分数唯一权威是 `top50_engine`，LLM 分**只补理由不参与排名**（`role: auxiliary_reasoning_only`）                                                                                                                                                                                                   |
| `app/routers/agent_documents.py`   | `POST /api/agents/{id}/score` 先取实时快照（`TushareError`→503）再打分                                                                                                                                                                                                                                                                          |
| `app/routers/snapshots.py`         | `/api/top50` 摘掉 `merge_agent_scores`（它会把 LLM 主观分**覆盖**引擎确定性分）                                                                                                                                                                                                                                                                        |
| `app/agent_docs.py`                | `merge_agent_scores` / `custom_score_index` 标 `.. deprecated::`（注明不要接回排名链路）                                                                                                                                                                                                                                                          |


**验收记录（2026-10-10，真实 Tushare 行情）**

一次性拉取 universe（`marketUniverse=5559` → 初筛 `candidateCount=2991`，`marketDataDate=2026-10-09`），  
A/B/C 三组共用同一批行情，差异**只来自「是否注入 AI 画像」**：

| 组 | 配置                | agentCount | 波段 TOP1           |
| - | ----------------- | ---------- | ----------------- |
| A | 不注入 AI 画像（= 原版）   | 12         | 可孚医疗 score=**64** |
| B | 注入但 `share=0`     | 13         | 可孚医疗 score=**64** |
| C | `share=0.3`（当前配置） | 13         | 可孚医疗 score=**72** |

- **A vs B 逐票 score 完全相同**（4 个周期全部一致）→ 证实「前半段按原版」：`share=0` 时加权算分回到原版。
- **B vs C：分数变化 199 / 200 条、排名位次变化 130 条、波段榜单新进 11 只 / 掉出 11 只** → AI 学习真实改分改排名。
- 权重表（波段，C 组）：`陈江挺 14.0 / 产业调研凌 15.4 / 产业调研福总 14.0 / 菠萝 12.6 / 曾剑枫 14.0`  
  （= 原值 × 0.7）+ `C老师 30.0 (origin="ai")`，合计 **100.0**。
- 个股示例：永信至诚(688244.SH) A=52→C=**65**（Δ+13），rank 29→10，votes 6→7，C老师分 94.6。
- 证据链：新批次 `predictionId` 与旧批次**交集为空**（新 snapshotId 重新冻结、旧记录不被覆盖），  
  merge 后 400 条同时保留。
- **Live 交叉验证**（重启 uvicorn 后 `GET /api/top50?cycle=波段`）：`agentCount=13`  
  (`builtinAgentCount=12` + `aiAgentCount=1`, `aiAgentNames=['C老师']`, `aiWeightShare=0.3`)，  
  `selectionEngine="13套因子画像周期加权（内置12 + AI学习1）"`，波段 TOP1 可孚医疗 score=**72** votes=**6/13**，  
  证据链含 `C老师 weight=30.0 score=91.8 contribution=27.54 style="产业趋势共振"`。
- 🔎 **同构性证据**：离线 A 组（不注入）的 `TOP1 可孚医疗 64 / votes 5/12` 与**重启前的旧 live API 返回完全一致**  
  → 证明离线探针与线上 API 跑的是同一条代码路径，C 组结果可信。

**已知语义差异（需用户确认，暂未处理）**

- `share=0` 时 **score 回到原版，但 `agentVotes` / `agentAverage` 不回原版**：13 位老师里多的那 1 位  
  （C老师）仍在投票、仍进 `agentAverage` 分母。实测每周期 TOP1 票数 7→8 / 5→6（4 周期 votes 累计差 50/50/50/38）。  
  语义上「C老师是独立第 13 位老师、有独立投票权」是自洽的；若用户要「`share=0` 彻底回到原版」需要额外开关。
- `risk` 阈值 `votes>=7`（低）/ `>=6`（中）按 **12 位**设计，13 位后含义微变；前端 `votes>=6`（「过半」）  
  同样写死 → 归入「后续统一」。
- 改 `.env` / 改代码后**必须重启 uvicorn**（非 `--reload`）；否则 live 返回仍是旧 `selectionEngine` 文案。

**涉及文件**：`config.py`、`agent_factor_score.py`(新)、`top50_engine.py`、`agent_extract.py`、  
`agent_scoring.py`、`routers/agent_documents.py`、`routers/snapshots.py`、`agent_docs.py`

---

## 建议开工顺序

1. **T0**（接真 LLM）—— T1/T3 的地基，绕不过去
2. **T1 + T3 一起**（守卫 + prompt 是一件事的两层，拆开做会返工）
3. **T2**（可随时插入，不依赖别人）
4. **T4**（独立，但建议放最后——它会把「画像更新」变成自动行为，得先有稳定的提炼质量）

## 其他待办（之前挂起的）

- 「生成矩阵评分」后策略页矩阵不自动刷新（`useSnapshot('/api/top50', {refreshMs: 300000})` 5 分钟缓存）。
- **写死 `12` 的其余 5 个前端页面**（StrategiesPage 已改完）：`MarketCenterPage:188`、`OverviewPage:215`、  
  `PortfolioPage:87`、`QuantPage:148/175/246`、`Top50Page:187/238/324` —— 等「后续统一」。
- 待用户定：✅ 已确认「12 是原型 mock，口径跟实际老师数走」；仍待定：  
  ① 是否真的「只体现创建的老师」（现自建老师零 LLM 评分时会全空，故暂保留内置 12 位）；  
  ② 前端 `votes>=6`（「过半」）与后端 `risk` 的 `votes>=7/6` 是否改为按实际老师数过半。
- 可选（未启动）：前端展示自建老师的 `origin:"ai"` 权重与 `aiWeightShare`；对齐原版 `riskPresentation`  
  的两套不一致映射；原版「到期回验 + 样本 < 30 不发布」闭环（我们目前只做到 `evidence` 累积冻结）。
