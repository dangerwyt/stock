"""REST snapshot endpoints backed by the original 智策研究 fixture data.

Every route mirrors a real endpoint of the reference app so the Vue port can
render identical business content.
"""
from __future__ import annotations

import json
import asyncio
import logging
from datetime import date
from typing import Literal
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app import fixtures
from app import market_clock
from app import market_state
from app import market_dashboard
from app import concepts
from app import financials
from app import tushare_client
from app import news_aggregate
from app import review_engine
from app import top50_engine
from app import quant_tools
from app import agents
from app import accuracy as accuracy_module
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()

# post-close 调度任务落盘的真实收盘行情快照（仅当与当前数据窗口的交易日一致时才优先服务，
# 否则回落静态 fixtures，避免用旧值冒充实时）。
# ⚠️ 本文件在 ``app/routers/`` 下，数据目录在上一级 ``app/data``，所以是 ``.parent.parent``。
_MARKET_SNAPSHOT_PATH = Path(__file__).resolve().parent.parent / "data" / "market_snapshot.json"


def _load_market_snapshot() -> dict | None:
    if not _MARKET_SNAPSHOT_PATH.exists():
        return None
    try:
        data = json.loads(_MARKET_SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _live_session() -> dict:
    """页头「当前交易日时段」标签 —— 复用 :mod:`app.market_clock` 的统一时钟。

    之前这里自己算了一遍上海时间，调度器又算一遍，两处口径容易漂。现在时钟来源只有
    ``market_clock`` 一处，页头用 :func:`market_clock.header_session`（简化标签集），
    调度用 ``market_clock.shanghai_session``（8 段完整口径）。

    注意 ``session`` 只是**时钟派生**的展示标签（日期/时刻/上下午），不是行情数据，
    所以不需要 Tushare 交易日历；周末/非交易时段如实标「休市」，不冒充交易中。
    """
    return market_clock.header_session()


# --- 平台状态 / 行情 / TOP50 / 新闻 / 验证 / 运行 ---------------------------


def _live_market_snapshot() -> dict | None:
    """命中当前数据窗口的新鲜真实行情快照（post-close / 8 轮 tick 落盘的 market_snapshot.json）。

    只有它的 ``tradeDate`` 与 Tushare 当前窗口交易日一致时才视为有效；否则回落静态样例，
    避免用旧值冒充实时。
    """
    snapshot = _load_market_snapshot()
    if not snapshot:
        return None
    latest = tushare_client._LATEST_CACHE.get("trade_date")
    if snapshot.get("meta", {}).get("tradeDate") != latest:
        return None
    return snapshot


def _derive_market_health() -> dict:
    """行情健康度：忠实移植 reference-react ``marketSnapshotState`` 状态机派生，不再冻结 fixture。

    输入是当前数据窗口命中的真实快照（post-close 落盘的 ``market_snapshot.json``）+ 最近一次
    抓取状态记录（``market_source_state.json``）+ 当前上海会话（由 ``market_clock`` 统一口径）。

    - 命中真实快照 → 交给 ``market_state.build_market_health`` 按原版状态机如实算
      ``status/label/isIntraday``（daily_close → 过期 → 盘中延迟 → rt_k → 兜底 等分支级联）。
    - 否则（本机未跑 tick / 无 market_snapshot.json）→ 明确标 ``fixtures``，
      不再把"没实时数据"伪装成"部分行情已更新"的永久延迟。
    """
    snap = _live_market_snapshot()
    if snap:
        return market_state.build_market_health(
            snap,
            source_state=market_state.load_market_source_state(),
        )
    return {
        "status": "fixtures",
        "label": "演示快照 · 待接入真实行情（行情中心未产出实时快照）",
        "isIntraday": False,
        "sourceState": None,
    }


def _subsystems() -> dict:
    """已接入的外部子系统清单，供前端决定「量化工具」这个入口怎么走。

    ``url`` 为 ``None`` 表示没配（``QUANT_SUBSYSTEM_URL`` 为空）——前端据此提示未接入，
    而不是打开一个空白页。只暴露地址，不含任何凭据：TSP 自己有访问密码体系。
    """
    url = (settings.quant_subsystem_url or "").strip().rstrip("/")
    return {"quant": {"label": "量化工作台", "url": url or None}}


@router.get("/api/status")
def status():
    # fixtures.load 是 lru_cache 的共享对象，**不能原地改**；这里重建外层 dict。
    payload = fixtures.load("status")
    # ⚠️ health.market 改为由真实快照派生（见 _derive_market_health），不再读死 fixture 的 partial。
    health = dict(payload.get("health") or {})
    health["market"] = _derive_market_health()
    return {
        **payload,
        "health": health,
        "session": _live_session(),
        "subsystems": _subsystems(),
    }


@router.get("/api/market")
async def market(refresh: int = 0, scope: str = "snapshot", supplement: bool = True):
    """行情快照：优先服务 post-close 落盘的真实收盘行情，否则回落 fixtures 静态样例。

    ⚠️ 只在本进程已拉过当天行情（``_LATEST_CACHE.trade_date`` 指向当前窗口交易日）且
    快照的 ``tradeDate`` 与之相符时才用真实数据；其余情况一律回落 fixtures，决不用旧值冒充。

    ⚠️ 回落时显式打 ``meta.sourceMode='fixtures'`` + ``meta.status='fixtures'``（对齐
    /api/top50 的口径），让前端能区分"真实快照"与"种子样例"，不再把 2026-10-08 的种子
    数据误标成 ``live``。
    """
    if scope == "all":
        try:
            trade_date, rows = await asyncio.wait_for(tushare_client._latest_market_trade_date(), timeout=75)
            try:
                universe = await tushare_client._stock_basic_universe()
            except tushare_client.TushareError:
                universe = []
            payload = market_dashboard.build_snapshot(trade_date, rows, universe)
            if not payload["quotes"]:
                raise tushare_client.TushareError("无可核验的当日行情")
            if supplement:
                payload.update(await market_dashboard.fetch_supplement(trade_date))
            return payload
        except (tushare_client.TushareError, asyncio.TimeoutError) as exc:
            logger.warning("市场看板行情不可用：%s", exc)
            return JSONResponse(status_code=503, content={
                "meta": {"status": "unavailable", "sourceMode": "none"},
                "quotes": [], **tushare_client.public_error(exc),
            })
    snap = _live_market_snapshot()
    if snap:
        return snap
    base = fixtures.load("market")
    meta = {**(base.get("meta") or {}), "sourceMode": "fixtures", "status": "fixtures"}
    return {**base, "meta": meta}


@router.get("/api/market/supplement")
async def market_supplement(trade_date: date):
    # 与基础日线独立请求，慢指数或连板接口不阻塞全市场统计。
    payload = await market_dashboard.fetch_supplement(trade_date.strftime("%Y%m%d"))
    return {"tradeDate": trade_date.isoformat(), **payload}


async def _concept_response(request):
    try:
        return await asyncio.wait_for(request, timeout=65)
    except Exception as exc:
        logger.warning("概念数据不可用 (%s)", type(exc).__name__)
        return JSONResponse(status_code=503, content={"message": "概念数据源暂不可用或返回不完整，请稍后重试。"})


@router.get("/api/concepts")
async def concept_snapshot():
    return await _concept_response(concepts.snapshot())


@router.get("/api/concepts/{section}")
async def concept_detail(section: Literal["flows", "history", "members"], trade_date: date,
                         code: str | None = Query(default=None, pattern=r"^BK\d{4,6}\.DC$"),
                         days: int = Query(default=60, ge=10, le=180)):
    day = trade_date.strftime("%Y%m%d")
    if section == "flows":
        return await _concept_response(concepts.flows(day))
    if not code:
        return JSONResponse(status_code=422, content={"message": "请选择概念板块"})
    if section == "history":
        return await _concept_response(concepts.history(code, day, days))
    return await _concept_response(concepts.members(code, day))


@router.get("/api/top50")
async def top50(cycle: str | None = Query(default=None), mergeAgents: int = Query(default=1)):
    """TOP50 榜单：走真实量化引擎（Tushare 全市场 → 硬门槛 → 内置画像 + AI 学习画像周期加权）。

    行情不可用时回落 fixtures 静态快照并标 ``meta.sourceMode='fixtures'``（前端会显示
    「演示快照 · 待接入真实行情」，不冒充实时）。

    自建老师（AI 学习画像）由**引擎自己**按画像提炼出的 ``factorWeights`` 算进
    ``agentScores`` 并参与加权，所以不再需要这里的分数合并 —— ``mergeAgents``
    参数保留仅为兼容既有前端调用，行为上已不再生效。
    """
    try:
        status, payload = await top50_engine.ensure_top50_snapshot()
    except tushare_client.TushareError as exc:
        logger.warning("TOP50 实时引擎不可用，回落 fixtures：%s", exc)
        base = fixtures.load("top50")
        payload = {
            **base,
            "meta": {
                **(base.get("meta") or {}),
                "sourceMode": "fixtures",
                "reason": f"实时行情不可用：{exc}",
            },
        }
        return payload
    if status == "computing":
        # 缓存未命中（首次计算 / 窗口切换 / 画像变了）：立即返回占位，由后台任务算，
        # 前端 useSnapshot 检测到 meta.status=="computing" 后短轮询即可，避免请求超时。
        return {
            "meta": {
                "status": "computing",
                "sourceMode": "live",
                "message": "榜单计算中（首次拉取全市场行情，约需 20-40 秒）",
            }
        }
    # 停用 agent_docs.merge_agent_scores：它会把「LLM 主观分」覆盖到「引擎确定性分」上，
    # 正好把「AI 学习改分」这件事抹掉。引擎已在 score_universe 里完成这件事。
    _ = mergeAgents
    return payload


@router.get("/api/top50/evidence")
def top50_evidence(predictionId: str = Query(default="")):
    """按 predictionId 读取冻结选股证据；未命中返回 ``{"evidence": null}``。"""
    evidence = top50_engine.get_evidence(predictionId) if predictionId else None
    if not evidence:
        return JSONResponse(status_code=200, content={"evidence": None})
    return {"evidence": evidence}


@router.get("/api/news")
async def news():
    """实时资讯快照：晴红50+（优先）→ NewsAPI（备选）→ fixtures 回落。

    返回 ``{items, meta}``，实时数据时 ``meta.sourceMode == "live"``；全部实时源
    不可用则回落静态快照并标 ``sourceMode == "fixtures"``（前端显示「待配置API」）。
    """
    return await news_aggregate.build_news_snapshot()


@router.get("/api/accuracy")
def accuracy():
    """预测验证：由已评估冻结预测记录真实派生（不再读死假 fixture）。

    走 ``app.accuracy.calculate_accuracy`` —— 只统计 ``evaluated`` + 证据完整的记录，
    按 7 维聚合，满 30 条才披露命中率等指标，与原版 ``calculateAccuracy`` 口径一致。
    """
    return accuracy_module.calculate_accuracy(accuracy_module.load_predictions())


@router.get("/api/operations")
def operations():
    return fixtures.load("operations")


@router.get("/api/notifications")
def notifications():
    return fixtures.load("notifications")


# --- 老师 Agent / 行业 / 风险 / 映射 / 复盘 / 源质量 / 验收 -------------------

# ⚠️ 遗留端点：前端已统一改用 ``GET /api/agents``（见 ``routers/agents.py``）。
# 保留它只是为了兼容旧调用方，因此**也必须**只返回用户自己创建的角色 ——
# 内置 12 位 mock 人设已从产品里去掉，不能从这个口子漏出去。
# 包封形状 ``{"items": [...]}`` 与原来的 fixtures 保持一致。
@router.get("/api/teachers")
def teachers():
    return {"items": agents.visible_agents()}


@router.get("/api/industries")
def industries():
    return fixtures.load("industries")


@router.get("/api/risk")
def risk():
    return fixtures.load("risk")


@router.get("/api/us-etf-map")
def us_etf_map():
    return fixtures.load("us-etf-map")


@router.get("/api/review")
def review(date: str | None = Query(default=None)):
    """盘后复盘报告：读 ``data/review/`` 下按日期存档的真实报告。

    对齐 reference-react ``GET /api/review``：返回 ``{date, report, attempt, dates}``。
    与原来那份 ``fixtures/review.json`` 占位桩的关键差别是**会认 ``date`` 参数** ——
    前端拿 ``review.date === 选中日期`` 判断"读到了没"，占位桩永远返回固定日期，
    于是页面恒显示「正在读取报告」。

    这里**只读不生成**：生成有副作用（打 Tushare、写文件），走
    ``POST /api/review/refresh`` 或调度任务 ``post-close``。

    唯一的例外是"把今天的冻结榜单存档"（:func:`review_engine.ensure_today_board_frozen`）：
    那是幂等的本地记录，只在当天第一次访问时做一次。不加这一步的话，"当天没打开过生成、
    隔天再补看"就会因为榜单已被重算而彻底失去参考价。
    """
    review_engine.ensure_today_board_frozen()
    target = (date or "").strip() or market_clock.shanghai_clock()["date"]
    return review_engine.snapshot_payload(target)


@router.post("/api/review/refresh")
async def review_refresh(date: str | None = Query(default=None), force: bool = Query(default=False)):
    """生成/校准某一天的复盘报告（有副作用）。

    与 ``/api/quant/{tool}`` 同级：都是本地单用户研究工具里的"主动算一次"，因此不做
    token 鉴权（reference 的 ``POST /api/admin/review`` 在公网 Worker 上必须鉴权，
    本项目若对公网开放，请在外层 nginx 或 ``ADMIN_API_TOKEN`` 网关上拦掉这个路径）。

    ``force=true`` 会忽略"已有完整报告就复用"的短路，强制重算一次 —— 用于校准轮次。
    """
    target = (date or "").strip() or market_clock.shanghai_clock()["date"]
    result = await review_engine.generate(target, force=force)
    if result.get("status") == "invalid":
        return JSONResponse(status_code=400, content=result)
    return {**result, **review_engine.snapshot_payload(target)}


@router.get("/api/source-quality")
def source_quality():
    return fixtures.load("source-quality")


@router.get("/api/acceptance")
def acceptance():
    """冻结管线状态：``pipeline`` 块由已评估预测真实派生（不再手写 mock 元数据）。

    其余顶层字段（status / observedAt / schedulerAt / jobs 等）仍来自
    ``fixtures/acceptance.json`` 的静态元信息；只有 pipeline 这份「每期冻结概况」
    改为从 ``predictions.json`` 现算，保证与 /api/accuracy 同源自洽。
    """
    base = fixtures.load("acceptance")
    pipeline = accuracy_module.build_acceptance_pipeline(accuracy_module.load_predictions())
    return {**base, "pipeline": pipeline}


@router.get("/api/preferences")
def get_preferences():
    return {"status": "ready", "preferences": {}}


# --- 证据 / 量化工具（占位，按需扩展）--------------------------------------

# ⚠️ ``GET /api/top50/evidence`` 的**真实现**在上面的「平台状态 / 行情 / TOP50」段里
# （走 ``top50_engine.get_evidence``）。这里**不要**再定义一个同名占位路由 ——
# Starlette 按注册顺序匹配，先注册的生效，后定义的会变成永远跑不到的死代码，
# 而且读代码的人会以为这个端点还是占位。
@router.get("/api/accuracy/evidence")
def accuracy_evidence(predictionId: str = Query(default="")):
    """按 predictionId 返回冻结预测的证据块；未命中返回 ``evidence: null``。"""
    evidence = accuracy_module.get_prediction_evidence(predictionId)
    if not evidence:
        return {"status": "empty", "predictionId": predictionId, "evidence": None}
    return {"status": "ready", "predictionId": predictionId, "evidence": evidence}


@router.post("/api/quant/{tool}")
async def quant(tool: str, payload: dict | None = None):
    """内置量化工具（行情/分析/回测/信号/选股/预判/评估），照原版 ``runBuiltInQuant``。

    数据源是**真实**的冻结 TOP50 快照（回测额外拉 Tushare 真实历史行情）。
    快照未就绪 / 历史不足 / 行情不可用时返回明确 ``reason``，**绝不返回占位假结果** ——
    页面会把这个 reason 显示成「量化计算未运行」，不会拿静态样例冒充运行结果。
    """
    try:
        result = await quant_tools.run_tool(tool, payload or {})
    except quant_tools.QuantError as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "tool": tool, "result": None, "reason": str(exc)},
        )
    return {"status": "ready", "tool": tool, "result": result}


# --- 个股目录 / 指标 --------------------------------------------------------

@router.get("/api/stocks/search")
async def stocks_search(q: str = Query(default="")):
    # 实时搜索：直接打 Tushare stock_basic 全市场池（24h 内存缓存）。
    # 按「必须实时」策略，无 TUSHARE_TOKEN 或调用失败时返回 503，不回落 fixtures。
    try:
        items = await tushare_client.search_stock_basic(q)
    except tushare_client.TushareError as exc:
        detail = tushare_client.public_error(exc)
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "error": detail["message"], **detail},
        )
    return {"status": "ready", "items": items}


@router.get("/api/stocks/{code}/metrics")
def stock_metrics(code: str):
    return {"status": "empty", "code": code, "metrics": None}


@router.get("/api/stocks/{code}/financials")
async def stock_financials(code: str):
    try:
        return await financials.snapshot(code)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"message": str(exc), "retryable": False})
    except tushare_client.TushareError as exc:
        return JSONResponse(status_code=503, content=tushare_client.public_error(exc))


@router.get("/api/stocks/{code}/quote")
async def stock_quote(code: str):
    """按 6 位代码取实时行情快照（价/涨跌幅/量比/换手/PE/振幅/成交额），不含 TOP50 因子。

    用于「自选股 / 搜索加入但不在 TOP50 榜单」的标的，补全单股决策弹窗的行情块
    （这类标的走 ``/api/stocks/search`` 只能拿到 code/name/industry，没有行情价）。
    复用 ``research._build_live_stock`` 同一条 Tushare 路径（5 分钟窗口内进程内缓存），
    Tushare 不可用时返回 503，不编造价格（与 ``/api/stocks/search`` 同策略）。
    """
    try:
        snap = await tushare_client.get_stock_snapshot(code)
    except tushare_client.TushareError as exc:
        detail = tushare_client.public_error(exc)
        logger.warning("股票 %s 报价不可用：%s", code, detail["errorCode"])
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "error": detail["message"], **detail},
        )
    return {"status": "ready", "quote": snap}


@router.post("/api/stocks/enrich")
async def stocks_enrich(payload: dict):
    """给任意股票代码（通常是自选股里不在 TOP50 榜单的标的）补上与 TOP50 完全同口径的
    四周期因子字段：综合分 / 因子支持 / 状态 / 为什么入选 / 失效条件 / 行情日。

    数据来自当前窗口已算好的全量 universe（``top50_engine.enrich_watchlist`` 复用引擎内部
    ``_CACHE["universe"]``，不重新拉行情、不重新归一化，因此分数与 TOP50 完全一致）。
    冷启动时 universe 尚未在内存（只从落盘快照恢复了前 50），``enrich_watchlist`` 会强制
    重算一次补全再打分。行情（Tushare）不可用时按与 ``/api/stocks/search`` 同策略回落 503，
    **不编造分数**。
    """
    codes = payload.get("codes") or []
    try:
        # 确保全量 universe 已算好：命中当前窗口缓存则秒回，否则阻塞计算一次。
        await top50_engine.get_top50_snapshot()
        result = await top50_engine.enrich_watchlist(codes)
        return {"status": "ready", "result": result}
    except tushare_client.TushareError as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "error": str(exc)},
        )
