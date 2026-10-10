"""AI research endpoints.

The consultation stream is now a **real** LLM pipeline:

    POST /api/ai/jobs  →  ① accepted 帧（含 jobId + 每位老师的初始状态）
                          ② 每位老师一个 agent 帧（analyzing → completed/failed）
                          ③ summary 帧（主持人汇总）

每位老师按自己的画像（``agents`` 里的内置/自建 persona）独立回答，由
``agent_chat`` 渲染 prompt、``app.llm.chat`` 真正调模型；再让模型把 N 份
回答汇总成一段结论（共识 + 分歧）。

帧格式沿用前端 ``api/client.js`` 已有的 NDJSON 约定，所以前端无需改动。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse

from app import agent_chat, agents, guardrails, threads
from app import tushare_client, news_client, top50_engine
from app.config import settings
from app.llm import LlmError, chat

logger = logging.getLogger(__name__)

router = APIRouter()

_JOBS: dict[str, dict] = {}

# 一次会诊最多同时打几个模型请求。选中的老师会并行调用，但齐发 12 个容易撞上
# 网关限流，所以串行度压到 4；老师数量本身另有 _MAX_TEACHERS 限制。
_MAX_CONCURRENCY = 4
_MAX_TEACHERS = 6


async def _json_body(request: Request) -> dict:
    """Tolerant JSON body reader — returns {} instead of raising on bad input."""
    if "application/json" not in (request.headers.get("content-type") or ""):
        return {}
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


_TZ = timezone(timedelta(hours=8))


def _now() -> str:
    return datetime.now(_TZ).isoformat()


def _teacher_name(entry) -> str:
    """Normalise a teacher entry to its display name.

    The reference frontend sends full teacher objects (`{name, style, ...}`);
    accept plain strings too so both shapes work.
    """
    if isinstance(entry, dict):
        return entry.get("name") or entry.get("teacherName") or "未知老师"
    return str(entry or "未知老师")


def _persona_of(entry) -> dict | None:
    """把前端传来的老师条目解析成**真实存在的自建角色**；解析不到返回 ``None``。

    ⚠️ 只在 ``agents.visible_agents()``（= 用户自建角色）里找，**刻意不碰
    ``all_agents()``**。后者含内置 12 位原版 mock 人设 —— 若拿它来解析，客户端只要
    传一个 ``teachers: ["菠萝"]`` 就能让一个产品里根本不存在、界面上也点不到的老师
    开口回答（而且会照着内置画像的语气答），与「全链路只认自建老师」的口径直接冲突。
    ``all_agents()`` 只留给引擎的兜底基线与 ``find_duplicate`` 防同名撞键，属内部用途。

    名字与 id 都只用来**在自建角色里定位**，画像一律取后端自己的这份 —— 既防客户端
    伪造画像，也防前端拿的是过期缓存。
    """
    available = agents.visible_agents()
    name = _teacher_name(entry)
    for item in available:
        if (item.get("name") or "").strip() == name:
            return item
    if isinstance(entry, dict) and entry.get("id"):
        target = str(entry["id"])
        for item in available:
            if str(item.get("id") or "") == target:
                return item
    return None


def _new_job(personas: list[dict]) -> dict:
    job_id = uuid.uuid4().hex[:12]
    agent_states = [
        {
            "teacherName": p.get("name") or "未知老师",
            "status": "waiting",
            "answer": None,
            "error": None,
        }
        for p in personas
    ]
    job = {
        "id": job_id,
        "status": "running",
        "createdAt": _now(),
        "agentStates": agent_states,
        "summary": None,
        "summaryStatus": "pending",
        "fallbackMode": None,
    }
    _JOBS[job_id] = job
    return job


async def _ask_teacher(
    persona: dict,
    question: str,
    stock,
    semaphore: asyncio.Semaphore,
    news=None,
) -> dict:
    """One teacher's turn. Never raises — failures become ``error`` on the result."""
    name = persona.get("name") or "未知老师"
    messages = agent_chat.build_teacher_messages(persona, question, stock, news)
    async with semaphore:
        try:
            # llm.chat is synchronous (httpx / langchain), so keep it off the loop.
            answer = await asyncio.to_thread(
                chat,
                messages,
                max_tokens=agent_chat.TEACHER_MAX_TOKENS,
                temperature=agent_chat.TEACHER_TEMPERATURE,
            )
        except LlmError as exc:
            return {"name": name, "answer": None, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - 一位老师挂掉不该中断整场会诊
            logger.warning("teacher %s failed: %s", name, exc)
            return {"name": name, "answer": None, "error": f"{type(exc).__name__}: {exc}"}
    return {"name": name, "answer": answer, "error": None}


def _summarize(question: str, results: list[dict], stock, news=None) -> str:
    messages = agent_chat.build_summary_messages(question, results, stock, news)
    return chat(
        messages,
        max_tokens=agent_chat.SUMMARY_MAX_TOKENS,
        temperature=agent_chat.SUMMARY_TEMPERATURE,
    )


async def _run_stream(job: dict, question: str, personas: list[dict], stock, news=None):
    """NDJSON frames: accepted → per-teacher progress → summary."""
    yield json.dumps(
        {
            "accepted": True,
            "job": {k: job[k] for k in ("id", "status", "agentStates")},
        }
    ) + "\n"

    # 先把所有老师标成「分析中」，让进度条立刻有反馈。
    for index, state in enumerate(job["agentStates"]):
        state["status"] = "analyzing"
        yield json.dumps(
            {
                "type": "agent",
                "teacherName": state["teacherName"],
                "status": "analyzing",
                "index": index,
            }
        ) + "\n"

    semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)
    tasks = [
        asyncio.create_task(_ask_teacher(persona, question, stock, semaphore, news))
        for persona in personas
    ]
    results: list[dict] = []
    try:
        for finished in asyncio.as_completed(tasks):
            result = await finished
            results.append(result)
            status = "completed" if result["answer"] else "failed"
            index = 0
            for i, state in enumerate(job["agentStates"]):
                if state["teacherName"] == result["name"]:
                    state["status"] = status
                    state["answer"] = result["answer"]
                    state["error"] = result["error"]
                    index = i
                    break
            yield json.dumps(
                {
                    "type": "agent",
                    "teacherName": result["name"],
                    "status": status,
                    "error": result["error"],
                    # 把该老师的完整观点一起下发：前端目前只用 status 画进度，
                    # 但带上 answer 后将来想展开「每位老师说了什么」就不用改后端。
                    "answer": result["answer"],
                    "index": index,
                }
            ) + "\n"
    finally:
        # 客户端中途断开时，别把没跑完的模型调用留在后台。
        for task in tasks:
            if not task.done():
                task.cancel()

    job["status"] = "completed"
    valid = [r for r in results if r.get("answer")]
    if not valid:
        first_error = next((r["error"] for r in results if r["error"]), "未知原因")
        summary = f"本次会诊未能获得任何老师的有效回答：{first_error}"
        job["summaryStatus"] = "failed"
    elif len(valid) == 1:
        # 单人会话：这位老师的话本身就是最终回答。再调一次模型去「汇总一个人」既多花
        # 一次调用，又会把第一人称的对话腔改写成「××老师认为…」的报告腔，所以原样返回。
        summary = valid[0]["answer"]
        job["summaryStatus"] = "ok"
    else:
        try:
            summary = await asyncio.to_thread(_summarize, question, results, stock, news)
            job["summaryStatus"] = "ok"
        except LlmError as exc:
            summary = f"会诊已完成，但主持人汇总失败：{exc}"
            job["summaryStatus"] = "failed"

    job["summary"] = summary
    yield json.dumps(
        {
            "type": "summary",
            "status": "completed",
            "summary": summary,
            "summaryStatus": job["summaryStatus"],
        }
    ) + "\n"


async def _run_refused(job: dict, reason: str):
    """拒绝流：只发 accepted + refused 两帧，不调用任何老师。"""
    yield json.dumps(
        {
            "accepted": True,
            "job": {k: job[k] for k in ("id", "status", "agentStates")},
        }
    ) + "\n"
    job["status"] = "refused"
    job["summaryStatus"] = "refused"
    job["summary"] = guardrails.REFUSAL_MESSAGE
    yield json.dumps(
        {
            "type": "refused",
            "status": "refused",
            "reason": guardrails.REFUSAL_MESSAGE,
            "summary": guardrails.REFUSAL_MESSAGE,
            # 模型给的一句话理由，供排查用（前端不展示）。
            "detail": reason,
        }
    ) + "\n"


# ---------------------------------------------------------------- 通用研究会话

def _is_general_request(body: dict) -> bool:
    """本次会诊是否走「通用研究」链路。

    两个判据取或：前端显式传 ``general: true``；或 ``threadId`` 指向那条固定会话。
    以 threadId 为准是**兜底**——只要会话本身是固定会话，就算前端漏传标记也不会
    意外召集老师（固定会话不在 ``threads._belongs_to`` 的整条认领范围内）。
    """
    if body.get("general") is True:
        return True
    thread_id = str(body.get("threadId") or "").strip()
    if not thread_id:
        return False
    return threads.is_general(threads.get(thread_id))


def _general_roles(body: dict) -> list[dict]:
    """通用会话里用户本次选中的角色名单（persona 列表），没选返回空列表。

    语义与单选时代一致，只是把"一个"放宽成"多个"：
    - 字段缺失 → 回落会话上存的那份；
    - 显式传（哪怕传空列表）→ 以请求为准，**不能**再回落旧值 —— 否则用户把角色
      全部移除、而那一次 PATCH 恰好失败时，回答仍会由旧角色产出，用户看到的是
      "我明明删掉了，它还在扮演那些角色"。

    名字**必须在 ``agents.visible_agents()`` 里存在**才算数 —— 角色被删掉后残留的
    名字不能让一个"幽灵角色"开口说话。查不到的直接剔除（不是整体降级：多选时
    删掉其中一个，其余仍应正常回答）。上限与多老师会诊一致（``_MAX_TEACHERS``）。
    """
    raw = body.get("generalRoles")
    if isinstance(raw, list):
        names = [str(n).strip() for n in raw if str(n).strip()]
    else:
        thread_id = str(body.get("threadId") or "").strip()
        thread = threads.get(thread_id) if thread_id else None
        names = threads.general_roles(thread)

    available = {
        (item.get("name") or "").strip(): item for item in agents.visible_agents()
    }
    personas: list[dict] = []
    seen: set[str] = set()
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        persona = available.get(name)
        if persona is None:
            logger.info("通用会话选中的角色已不存在（%s），本次跳过", name)
            continue
        personas.append(persona)
        if len(personas) >= _MAX_TEACHERS:
            break
    return personas


async def _run_general(job: dict, question: str, stock, news=None, personas=None):
    """通用研究会话的流：``accepted`` →（可选 agent 帧）→ ``summary``。

    按选中的角色**个数**分三种走法：

    - **0 位** → 通用助手（无角色），一次调用直接产出最终回答；
    - **1 位** → 该角色的单人回答（``solo=True``，避免它脑补出并不存在的"其他老师"）；
    - **≥2 位** → 直接**复用多老师会诊链路** ``_run_stream``：各自独立发言（每人一个
      agent 帧）+ 主持人汇总。此时 ``job`` 必须是用同一批 personas 建出来的
      （``_new_job``），否则 agent 帧找不到对应的 agentState 会被丢掉。

    三种走法的帧协议完全一致，所以前端读流的代码不用分叉；``answeredRole`` 帧字段
    只在 0/1 位时由本函数给出（≥2 位时前端从 agent 帧收集到的参与者列表更准）。
    """
    personas = list(personas or [])

    if len(personas) >= 2:
        async for frame in _run_stream(job, question, personas, stock, news):
            yield frame
        return

    persona = personas[0] if personas else None
    role_name = str((persona or {}).get("name") or "").strip()
    yield json.dumps(
        {
            "accepted": True,
            "job": {k: job[k] for k in ("id", "status", "agentStates")},
        }
    ) + "\n"

    try:
        if persona:
            messages = agent_chat.build_teacher_messages(
                persona, question, stock, news, solo=True
            )
            temperature = agent_chat.TEACHER_TEMPERATURE
        else:
            messages = agent_chat.build_general_messages(question, stock, news)
            temperature = agent_chat.GENERAL_TEMPERATURE
        answer = await asyncio.to_thread(
            chat,
            messages,
            max_tokens=agent_chat.GENERAL_MAX_TOKENS,
            temperature=temperature,
        )
        job["summaryStatus"] = "ok"
    except LlmError as exc:
        answer = f"本次通用研究未能完成：{exc}"
        job["summaryStatus"] = "failed"
    except Exception as exc:  # noqa: BLE001 - 流已开，只能把错误写进 summary 帧
        logger.warning("general research failed: %s", exc)
        answer = f"本次通用研究未能完成：{type(exc).__name__}: {exc}"
        job["summaryStatus"] = "failed"

    job["status"] = "completed"
    job["summary"] = answer
    # 回答失败时不报角色名 —— 否则前端会把一条报错标成某位老师的发言。
    # 字段名叫 answeredRole 而不是 generalRole：后者是会话上那个"用户选的角色名单"，
    # 一个是"用户选的"、一个是"实际答的"，同名会读错。
    answered_role = role_name if job["summaryStatus"] == "ok" else ""
    yield json.dumps(
        {
            "type": "summary",
            "status": "completed",
            "summary": answer,
            "summaryStatus": job["summaryStatus"],
            "answeredRole": answered_role,
        }
    ) + "\n"


# ---------------------------------------------------------------- 研究标的

async def _top50_entry(code: str) -> dict | None:
    """按代码从**实时 TOP50 快照**里取全量条目（只读，不动缓存里的那份对象）。

    以前这里读的是 ``fixtures/top50.json`` —— 那是一份 2026-09-24 的静态 mock，
    里面全是 12 位内置老师（菠萝 / 陈江挺 / 曾剑枫 / 产业调研凌…）。于是用户在 AI
    里选一只股票时，喂给模型的因子拆解与「支持 / 反对的老师」都是**产品里已经不存在
    的老师名**，模型照着念就出现幽灵引用，还会被误当成榜单里真实存在的画像。
    现在改读引擎的实时快照，口径与前端榜单页完全一致。
    （``agent_scoring`` 早就修过同一个坑，这里漏了。）
    """
    if not code:
        return None
    try:
        snapshot = await top50_engine.get_top50_snapshot()
    except Exception as exc:  # noqa: BLE001 - 叠加榜单证据是锦上添花，失败不该挡住行情本身
        logger.warning("TOP50 快照不可用，跳过榜单证据叠加：%s", exc)
        return None
    for cycle in (snapshot.get("cycles") or {}).values():
        if not isinstance(cycle, dict):
            continue
        for entry in cycle.get("ranking") or []:
            if isinstance(entry, dict) and str(entry.get("code") or "") == code:
                return entry
    return None


async def _build_live_stock(stock):
    """用 Tushare 实时行情补全前端传来的标的，并叠加实时 TOP50 快照的排名/因子。

    与原项目一致：**只信 6 位代码，行情一律从 Tushare 实时重查**，前端传来的
    名称/价格/行业等一律不采用（原项目明确标注浏览器数据为 "not evidence"）。

    无 ``TUSHARE_TOKEN`` 或调用失败时抛 ``TushareError`` —— 由 ``create_job`` 转成 503，
    不回落假数据（「必须实时」策略）。
    """
    if not isinstance(stock, dict):
        return stock
    code = str(stock.get("code") or "").strip()
    if not code:
        return stock

    snap = await tushare_client.get_stock_snapshot(code)

    # 叠加实时榜单的排名/因子，只补 live 里没有的键。
    entry = await _top50_entry(code)
    if entry:
        overlay_keys = (
            "rank", "score", "agentVotes", "status", "risk", "trend",
            "triggerPrice", "invalidPrice", "reason", "selectionEvidence",
            "agentScores",
        )
        for key in overlay_keys:
            value = entry.get(key)
            if value not in (None, ""):
                snap.setdefault(key, value)
    return snap


def _news_query(question: str, stock) -> str:
    """新闻检索词：优先用选定股票名 + 代码，否则退回问题本身。"""
    if isinstance(stock, dict):
        name = str(stock.get("name") or "").strip()
        code = str(stock.get("code") or "").strip()
        if name:
            return f"{name} {code} A股".strip()
    return question.strip()


@router.post("/api/ai/jobs")
async def create_job(request: Request):
    body = await _json_body(request)
    question = str(body.get("question") or "").strip()
    if not question:
        return JSONResponse(status_code=400, content={"error": "缺少 question（本次提问内容）"})

    # 硬闸门：与股票财经无关的问题直接拒答，不进会诊流程（也就不花 N 位老师的调用）。
    # classify 内部会先做关键词粗筛，命中的问题不产生额外模型调用。
    in_scope, reason = await asyncio.to_thread(guardrails.classify, question)
    if not in_scope:
        logger.info("问题被话题守卫拦下（%s）", reason)
        refused_job = _new_job([])
        return StreamingResponse(
            _run_refused(refused_job, reason),
            media_type="application/x-ndjson",
            headers={"X-Job-Id": refused_job["id"]},
        )

    # 实时行情护栏：仅当本次选定了股票时才要求 Tushare。按「必须实时」策略，
    # 无 TUSHARE_TOKEN 直接 503，不回落 fixtures；未选股票的通用问题不需要行情，放行。
    requested_stock = body.get("stock")
    requested_code = str(requested_stock.get("code") or "").strip() if isinstance(requested_stock, dict) else ""
    if requested_code and not settings.tushare_token:
        return JSONResponse(
            status_code=503,
            content={"error": "TUSHARE_TOKEN 未配置：按「必须实时」策略无法回落假数据来回答选股分析。请在 .env 配置后重试。"},
        )

    # 通用研究会话：不绑定任何角色，因此**不需要**解析老师、也不会因为"一个角色都没有"
    # 而报错 —— 没有自建角色时，这条固定会话是唯一能用的入口。
    general = _is_general_request(body)

    personas: list[dict] = []
    if not general:
        selected = body.get("teachers")
        if not isinstance(selected, list) or not selected:
            # 内置 12 位是原版 mock 人设，已从产品里去掉；默认取用户自己的角色。
            # 一个都没有时无法会诊 —— 明确报错，而不是偷偷回落去用 mock 老师。
            available = agents.visible_agents()
            if not available:
                return JSONResponse(
                    status_code=400,
                    content={"error": "还没有创建任何角色（老师）：请先在 AI 研究室新建角色并上传资料，再进行会诊。"},
                )
            selected = [t["name"] for t in available[:_MAX_TEACHERS]]
        # 去重（按显示名）并限流，避免一次点击打出十几个模型请求。
        # 解析不到的角色**直接剔除**（留一条日志）—— 不能回落成"只留名字"的空壳
        # persona，那等于让一个产品里不存在的角色开口说话（只是少了画像语气而已）。
        seen: set[str] = set()
        for entry in selected:
            persona = _persona_of(entry)
            if persona is None:
                logger.info(
                    "会诊请求里的老师不是自建角色，已剔除：%r",
                    entry.get("name") if isinstance(entry, dict) else entry,
                )
                continue
            name = persona.get("name") or "未知老师"
            if name in seen:
                continue
            seen.add(name)
            personas.append(persona)
            if len(personas) >= _MAX_TEACHERS:
                break
        if not personas:
            # 一个都没解析出来（例如客户端传的全是内置 mock 名）：明确报错。
            # 不回落内置、也不静默变成"通用助手"，否则前端会以为会诊成功了。
            return JSONResponse(
                status_code=400,
                content={
                    "error": "本次会诊没有可用角色：请求里的角色都不是自建角色（内置 mock 老师已下线）。请先在 AI 研究室新建角色并上传资料。"
                },
            )

    # 实时行情 + 实时新闻，均在开流前完成；任一失败在 HTTP 层明确报错，不污染流。
    try:
        stock = await _build_live_stock(body.get("stock"))
    except tushare_client.TushareError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": f"实时行情获取失败：{exc}"},
        )
    # 新闻：有 NEWSAPI_KEY 才拉真实新闻；无 key 返回 None（不注入假新闻，也不中断会诊）。
    news = await news_client.fetch_news(_news_query(question, stock))

    if general:
        # 通用会话里用户可以在「搜索A股」旁边临时挑角色来回答这一问。
        # 0 位 → 通用助手；1 位 → 该角色单人回答；≥2 位 → 各自独立回答 + 汇总。
        # ⚠️ 选中的角色**会**因此拿到新的画像素材：这一问的问答按条归到它名下
        # （``threads.attributed_messages`` 认的是回答消息上的 teacherNames，
        # 即下面这批发出去的 personas 里真正答出来的那些）。0 位时不带任何名字，
        # 仍然完全不计入 —— 通用助手自己答的东西不喂给任何角色。
        general_personas = _general_roles(body)
        # ≥2 位走会诊链路，需要 agentStates 才能画进度；0/1 位只发 accepted + summary。
        consultation = len(general_personas) >= 2
        general_job = _new_job(general_personas if consultation else [])
        return StreamingResponse(
            _run_general(general_job, question, stock, news, general_personas),
            media_type="application/x-ndjson",
            headers={"X-Job-Id": general_job["id"]},
        )

    job = _new_job(personas)
    return StreamingResponse(
        _run_stream(job, question, personas, stock, news),
        media_type="application/x-ndjson",
        headers={"X-Job-Id": job["id"]},
    )


@router.get("/api/ai/jobs/{job_id}")
def get_job(job_id: str):
    job = _JOBS.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "job not found"})
    return job


@router.post("/api/ai/jobs/{job_id}/advance")
def advance_job(job_id: str):
    job = _JOBS.get(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "job not found"})
    return {"job": job}


@router.get("/api/ai/threads")
def list_threads(clientId: str = ""):
    # NOTE: the param must stay camelCase — the frontend sends ?clientId=… and
    # FastAPI does no snake_case conversion, so `client_id` would silently
    # receive "" and the per-client filter would never apply.
    return {"threads": threads.list_threads(clientId), "clientId": clientId}


@router.post("/api/ai/threads")
async def create_thread(request: Request):
    body = await _json_body(request)
    return {"thread": threads.create(body)}


@router.get("/api/ai/threads/{thread_id}")
def get_thread(thread_id: str, clientId: str = ""):
    thread = threads.get(thread_id)
    if not thread:
        return JSONResponse(status_code=404, content={"error": "thread not found"})
    return {"thread": thread, "clientId": clientId}


@router.patch("/api/ai/threads/{thread_id}")
async def patch_thread(thread_id: str, request: Request):
    body = await _json_body(request)
    updated = threads.update(thread_id, body)
    if not updated:
        return JSONResponse(status_code=404, content={"error": "thread not found"})
    return {"thread": updated}


@router.delete("/api/ai/threads/{thread_id}")
def delete_thread(thread_id: str):
    thread = threads.get(thread_id)
    if not thread:
        return JSONResponse(status_code=404, content={"error": "thread not found"})
    # 「通用研究」是固定会话，删掉它等于把"无角色入口"从产品里拿掉。
    # 单独判一次是为了给出 400 + 可读原因，而不是笼统的 404。
    if threads.is_general(thread):
        return JSONResponse(
            status_code=400,
            content={"error": "「通用研究」是固定会话，不能删除。"},
        )
    if not threads.remove(thread_id):
        return JSONResponse(status_code=404, content={"error": "thread not found"})
    return {"ok": True}


@router.post("/api/ai/threads/{thread_id}/messages")
async def append_thread_messages(thread_id: str, request: Request):
    body = await _json_body(request)
    messages = body.get("messages")
    updated = threads.append_messages(thread_id, messages if isinstance(messages, list) else [])
    if not updated:
        return JSONResponse(status_code=404, content={"error": "thread not found"})
    return {"thread": updated}


@router.post("/api/ai/feedback")
async def post_feedback(request: Request):
    body = await request.json()
    return {"ok": True, "received": body}
