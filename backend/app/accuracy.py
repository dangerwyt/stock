"""准确率聚合引擎 —— 忠实镜像 reference-react ``worker/index.js`` 的 ``calculateAccuracy``。

原版准确率来自一条「冻结预测 → 到期验证 → 聚合」的管道，端点返回预计算的
``accuracy:latest`` 快照。我们后端暂无真实预测管道，这里用
``fixtures/predictions.json``（确定性脚本生成的已评估记录，见
``scripts/gen_accuracy_predictions.py``）作为数据源，按原版口径现算：

- 只统计 ``status=="evaluated" && evidenceCompleteness=="complete"`` 的记录；
- 按 7 个维度累加（horizons / cycles / directions / industries / marketRegimes /
  byAgent / byStock）+ overall；
- ``count < 30``（ACCURACY_MINIMUM_SAMPLE）时 ``hitRate`` 等一律 ``null`` +
  ``sampleStatus:"insufficient"``，不披露（与前端「满30条才披露」一致）；
- 配对基准指标（benchmarkAverageReturn / averageExcessReturn）另需 ``pairedCount >= 30``。

这样 /api/accuracy 返回的是**由记录真实派生**的快照，不再是写死假数据。
"""
from __future__ import annotations

from typing import Any

from app import fixtures

MINIMUM_SAMPLE = 30
HORIZONS = [("1d", "1日"), ("5d", "5日"), ("20d", "20日"), ("60d", "60日")]
CYCLES = ["超短", "短线", "波段", "中长线"]
TEACHERS = [
    "陈江挺", "养家", "谭琦", "曹名长", "产业调研凌", "曹靖楠",
    "产业调研福总", "菠萝", "曾剑枫", "寻龙一手", "龙一", "短线委员会",
]
FACTOR_VERSION = "agent-factor-v3-zero-preserving"
METHODOLOGY = "仅统计证据完整且已到期验证的冻结预测；各分组满30条后才披露命中率、Brier、收益与不利波动。"


def load_predictions() -> list[dict]:
    """已评估冻结预测记录（lru_cache 共享，本模块只读不修改）。"""
    return fixtures.load("predictions")


def _empty_aggregate() -> dict:
    return {
        "count": 0,
        "hits": 0,
        "brierSum": 0.0,
        "returnSum": 0.0,
        "minMAE": None,
        "pairedCount": 0,
        "benchmarkSum": 0.0,
        "excessSum": 0.0,
    }


def _is_number(x: Any) -> bool:
    try:
        return x is not None and float(x) == float(x)  # NaN 排除
    except (TypeError, ValueError):
        return False


def _add(agg: dict, item: dict) -> None:
    agg["count"] += 1
    agg["hits"] += 1 if item.get("hit") else 0
    if _is_number(item.get("brierScore")):
        agg["brierSum"] += float(item["brierScore"])
    if _is_number(item.get("actualReturn")):
        agg["returnSum"] += float(item["actualReturn"])
    br, er = item.get("benchmarkReturn"), item.get("excessReturn")
    if _is_number(br) and _is_number(er):
        agg["pairedCount"] += 1
        agg["benchmarkSum"] += float(br)
        agg["excessSum"] += float(er)
    if _is_number(item.get("maximumAdverseExcursion")):
        mae = float(item["maximumAdverseExcursion"])
        agg["minMAE"] = mae if agg["minMAE"] is None else min(agg["minMAE"], mae)


def _metric(agg: dict, minimum: int = MINIMUM_SAMPLE) -> dict:
    sufficient = agg["count"] >= minimum
    paired = agg["pairedCount"] >= minimum
    return {
        "sampleCount": agg["count"],
        "sampleStatus": "sufficient" if sufficient else "insufficient",
        "hitRate": round(agg["hits"] / agg["count"] * 100, 1) if sufficient else None,
        "brierScore": round(agg["brierSum"] / agg["count"], 4) if sufficient else None,
        "averageReturn": round(agg["returnSum"] / agg["count"], 6) if sufficient else None,
        "maximumAdverseExcursion": agg["minMAE"] if sufficient else None,
        "pairedSampleCount": agg["pairedCount"],
        "benchmarkAverageReturn": round(agg["benchmarkSum"] / agg["pairedCount"], 6) if paired else None,
        "averageExcessReturn": round(agg["excessSum"] / agg["pairedCount"], 6) if paired else None,
    }


def _add_group(groups: dict, key: str, item: dict) -> None:
    groups.setdefault(key, _empty_aggregate())
    _add(groups[key], item)


def calculate_accuracy(forecasts: list[dict]) -> dict:
    """等价于 reference-react ``calculateAccuracy(forecasts)``，返回前端所需的快照形状。"""
    evaluated = [
        it for it in (forecasts or [])
        if it.get("status") == "evaluated" and it.get("evidenceCompleteness") == "complete"
    ]

    overall = _empty_aggregate()
    horizons: dict = {}
    cycles: dict = {}
    directions: dict = {}
    industries: dict = {}
    market_regimes: dict = {}
    by_agent: dict = {}
    factor_versions: dict = {}
    by_stock: dict = {}

    for it in evaluated:
        _add(overall, it)
        hid = it.get("horizon") or "unknown"
        _add_group(horizons, hid, it)
        _add_group(cycles, it.get("cycle") or "未分类", it)
        _add_group(directions, it.get("predictedDirection") or "unknown", it)
        _add_group(industries, it.get("industry") or "未分类", it)
        _add_group(market_regimes, it.get("marketRegime") or "unknown", it)
        _add_group(factor_versions, it.get("factorVersion") or "unknown", it)
        for name in it.get("topAgents") or []:
            _add_group(by_agent, name, it)
        stock = by_stock.get(it.get("code"))
        if stock is None:
            stock = {"code": it.get("code"), "name": it.get("name"), "aggregate": _empty_aggregate()}
            by_stock[it.get("code")] = stock
        _add(stock["aggregate"], it)

    # 各维度指标（horizons 带 label；cycles/directions 用原版固定键）
    horizon_metrics = {
        hid: {"label": label, **_metric(horizons.get(hid, _empty_aggregate()))}
        for hid, label in HORIZONS
    }
    cycle_metrics = {c: _metric(cycles.get(c, _empty_aggregate())) for c in CYCLES}
    direction_metrics = {
        "up": _metric(directions.get("up", _empty_aggregate())),
        "down": _metric(directions.get("down", _empty_aggregate())),
    }
    industry_metrics = {k: _metric(v) for k, v in industries.items()}
    regime_metrics = {k: _metric(v) for k, v in market_regimes.items()}
    agent_metrics = {name: _metric(by_agent.get(name, _empty_aggregate())) for name in TEACHERS}
    version_metrics = {k: _metric(v) for k, v in factor_versions.items()}

    by_stock_metrics = sorted(
        (
            {"code": s["code"], "name": s["name"], **_metric(s["aggregate"])}
            for s in by_stock.values()
        ),
        key=lambda m: m["sampleCount"],
        reverse=True,
    )[:20]

    recent = sorted(
        evaluated,
        key=lambda it: str(it.get("evaluatedAt") or ""),
        reverse=True,
    )[:20]
    recent_evaluations = [
        {
            "id": it.get("id") or None,
            "code": it.get("code"),
            "name": it.get("name"),
            "cycle": it.get("cycle") or None,
            "horizon": it.get("horizon"),
            "factorVersion": it.get("factorVersion") or "unknown",
            "predictedDirection": it.get("predictedDirection"),
            "probabilityUp": float(it["probabilityUp"]) if _is_number(it.get("probabilityUp")) else None,
            "actualDirection": it.get("actualDirection") or None,
            "actualReturn": float(it["actualReturn"]) if _is_number(it.get("actualReturn")) else None,
            "hit": bool(it.get("hit")),
            "brierScore": float(it["brierScore"]) if _is_number(it.get("brierScore")) else None,
            "maturityTradeDate": it.get("maturityTradeDate") or None,
            "evaluatedAt": it.get("evaluatedAt"),
        }
        for it in recent
    ]

    trade_dates = {it.get("tradeDate") for it in evaluated if it.get("tradeDate")}
    evaluated_dates = [str(it.get("evaluatedAt") or "") for it in evaluated if it.get("evaluatedAt")]
    last_evaluated = max(evaluated_dates) if evaluated_dates else None

    # 最近一期验证轮次摘要（前端「本轮统计」展开用）
    latest_eval_date = last_evaluated[:10] if last_evaluated else None
    newly = sum(1 for it in evaluated if str(it.get("evaluatedAt") or "").startswith(latest_eval_date or ""))

    return {
        "status": "ready" if evaluated else "collecting",
        "minimumSample": MINIMUM_SAMPLE,
        "coverage": {
            "stocks": len({it.get("code") for it in evaluated if it.get("code")}),
            "tradeDates": len(trade_dates),
            "note": "周期、期限和老师组可能重叠；记录条数不是独立实验次数。",
        },
        "methodology": METHODOLOGY,
        "overall": _metric(overall),
        "horizons": horizon_metrics,
        "cycles": cycle_metrics,
        "directions": direction_metrics,
        "industries": industry_metrics,
        "marketRegimes": regime_metrics,
        "byAgent": agent_metrics,
        "factorVersions": version_metrics,
        "byStock": by_stock_metrics,
        "recentEvaluations": recent_evaluations,
        "lastEvaluatedAt": last_evaluated,
        "evaluation": {
            "newlyEvaluated": newly,
            "missingCloseQueueCount": 0,
            "scope": "本轮统计汇总全部已到期且证据完整的冻结预测；不代表全部历史预测覆盖率。",
        },
        "hasMore": False,
        "nextCursor": None,
        "currentFactorVersion": FACTOR_VERSION,
    }


def get_prediction_evidence(prediction_id: str | None) -> dict | None:
    """按 predictionId 返回冻结预测的证据块；未命中返回 None（前端显示「证据暂不可用」）。"""
    if not prediction_id:
        return None
    for it in load_predictions():
        if it.get("id") == prediction_id:
            return it.get("evidence")
    return None
