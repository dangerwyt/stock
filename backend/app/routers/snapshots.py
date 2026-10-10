"""REST snapshot endpoints backed by the original 智策研究 fixture data.

Every route mirrors a real endpoint of the reference app so the Vue port can
render identical business content.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app import fixtures
from app import tushare_client
from app import news_aggregate
from app import top50_engine
from app import agents

logger = logging.getLogger(__name__)

router = APIRouter()


# --- 平台状态 / 行情 / TOP50 / 新闻 / 验证 / 运行 ---------------------------

@router.get("/api/status")
def status():
    return fixtures.load("status")


@router.get("/api/market")
def market(refresh: int = 0):
    return fixtures.load("market")


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
        payload = await top50_engine.get_top50_snapshot()
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

@router.get("/api/top50/evidence")
def top50_evidence(predictionId: str = Query(default="")):
    return {"status": "empty", "predictionId": predictionId, "evidence": None}


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
