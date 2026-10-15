"""REST snapshot endpoints backed by the original 智策研究 fixture data.

Every route mirrors a real endpoint of the reference app so the Vue port can
render identical business content.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app import fixtures
from app import market_clock
from app import market_state
from app import tushare_client
from app import news_aggregate
from app import top50_engine
from app import agents

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


@router.get("/api/status")
def status():
    # fixtures.load 是 lru_cache 的共享对象，**不能原地改**；这里重建外层 dict。
    payload = fixtures.load("status")
    # ⚠️ health.market 改为由真实快照派生（见 _derive_market_health），不再读死 fixture 的 partial。
    health = dict(payload.get("health") or {})
    health["market"] = _derive_market_health()
    return {**payload, "health": health, "session": _live_session()}


@router.get("/api/market")
def market(refresh: int = 0):
    """行情快照：优先服务 post-close 落盘的真实收盘行情，否则回落 fixtures 静态样例。

    ⚠️ 只在本进程已拉过当天行情（``_LATEST_CACHE.trade_date`` 指向当前窗口交易日）且
    快照的 ``tradeDate`` 与之相符时才用真实数据；其余情况一律回落 fixtures，决不用旧值冒充。

    ⚠️ 回落时显式打 ``meta.sourceMode='fixtures'`` + ``meta.status='fixtures'``（对齐
    /api/top50 的口径），让前端能区分"真实快照"与"种子样例"，不再把 2026-10-08 的种子
    数据误标成 ``live``。
    """
    snap = _live_market_snapshot()
    if snap:
        return snap
    base = fixtures.load("market")
    meta = {**(base.get("meta") or {}), "sourceMode": "fixtures", "status": "fixtures"}
    return {**base, "meta": meta}


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
    return fixtures.load("accuracy")


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
    return fixtures.load("review")


@router.get("/api/source-quality")
def source_quality():
    return fixtures.load("source-quality")


@router.get("/api/acceptance")
def acceptance():
    return fixtures.load("acceptance")


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
    return {"status": "empty", "predictionId": predictionId, "evidence": None}


@router.post("/api/quant/{tool}")
def quant(tool: str, payload: dict | None = None):
    return {"status": "empty", "tool": tool, "result": None,
            "message": "量化工具结果占位，接入真实因子引擎后填充。"}


# --- 个股目录 / 指标 --------------------------------------------------------

@router.get("/api/stocks/search")
async def stocks_search(q: str = Query(default="")):
    # 实时搜索：直接打 Tushare stock_basic 全市场池（24h 内存缓存）。
    # 按「必须实时」策略，无 TUSHARE_TOKEN 或调用失败时返回 503，不回落 fixtures。
    try:
        items = await tushare_client.search_stock_basic(q)
    except tushare_client.TushareError as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "error": str(exc)},
        )
    return {"status": "ready", "items": items}


@router.get("/api/stocks/{code}/metrics")
def stock_metrics(code: str):
    return {"status": "empty", "code": code, "metrics": None}


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
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "error": str(exc)},
        )
    return {"status": "ready", "quote": snap}
