"""量化工具引擎 —— 忠实复刻 reference-react ``runBuiltInQuant``（worker/index.js:4875-5015）。

原版 7 个内置工具全部从**冻结的 TOP50 快照**派生，只有回测额外拉 Tushare 真实历史行情：

- ``market``   冻结 TOP50 + 行情来源/新鲜度 + 该周期 TOP10；
- ``analysis`` 12 套因子画像得分 + 结论（概率 ≥0.6 偏强，否则分歧）；
- ``screener`` 该周期榜单前 N（硬风险门控在入池前已执行）；
- ``predict``  参考价/概率/目标区间/失效位（目标区间按概率偏离 0.5 的幅度动态给）；
- ``evaluate`` / ``signals`` 各因子得分 + 分歧度(max-min) + 允许/禁止动作；
- ``backtest``  **真实历史行情**运行可配置策略，含复权净值、成本、交易与持仓记录。

⚠️ 三条硬约束（与本项目「不伪造数据」原则一致）：
1. 快照不可用 → 抛错，不回落 fixtures；
2. 回测预热不足 / 价格或复权数据缺失 → 抛错；
3. 行情源不可用 → 抛 ``TushareError``，由路由转明确报错，不返回假净值。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app import top50_engine, tushare_client

logger = logging.getLogger(__name__)

_SHANGHAI = ZoneInfo("Asia/Shanghai")
CYCLES = ["超短", "短线", "波段", "中长线"]
ENGINE = "built-in-12-profile-factor-v1"


class QuantError(RuntimeError):
    """量化工具不可用（快照未就绪 / 标的不存在 / 历史不足）。"""


def _today() -> str:
    return datetime.now(_SHANGHAI).strftime("%Y-%m-%d")


def _compact(date_str: str) -> str:
    return (date_str or "").replace("-", "")


def _iso(date_str: str) -> str:
    """``YYYYMMDD`` → ``YYYY-MM-DD``（已是该格式则原样返回）。"""
    d = (date_str or "").replace("-", "")
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else date_str


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _to_ts_code(code: str) -> str:
    code = (code or "").strip()
    if "." in code:
        return code
    # 6 开头沪市、8/4 开头北交所、其余深市 —— 与 v2 tushare_client 的判定一致。
    if code.startswith(("6",)):
        return f"{code}.SH"
    if code.startswith(("4", "8")):
        return f"{code}.BJ"
    return f"{code}.SZ"


async def _stock_from_snapshot(snapshot: dict, stock_code: str, cycle: str) -> dict:
    """从快照挑标的：优先所选周期的这只，其次任意周期，再退到该周期第一只。

    对齐原版 ``quantStockFromSnapshot``（4864-4873）。
    """
    cycles = snapshot.get("cycles") or {}
    preferred = (cycles.get(cycle) or {}).get("ranking") or []
    all_items = [item for block in cycles.values() for item in (block.get("ranking") or [])]
    return (
        next((i for i in preferred if i.get("code") == stock_code), None)
        or next((i for i in all_items if i.get("code") == stock_code), None)
        or (preferred[0] if preferred else None)
        or (all_items[0] if all_items else None)
    )


async def _live_snapshot() -> dict:
    """取当前 TOP50 快照。不可用时抛错（**不回落 fixtures**）。

    ⚠️ 走 ``get_top50_snapshot(force=False)``：命中数据窗口+指纹缓存（或落盘恢复）就直接返回，
    不重拉全市场行情 —— 工具类请求不该抢调度的额度。
    """
    try:
        snapshot = await top50_engine.get_top50_snapshot()
    except tushare_client.TushareError as exc:
        raise QuantError(f"真实 TOP50 快照不可用：{exc}") from exc
    if not (snapshot.get("cycles") or {}):
        raise QuantError("真实 TOP50 快照尚未就绪（先跑 top50 调度任务）")
    return snapshot


def _common(snapshot: dict, cycle: str, stock: dict) -> dict:
    meta = snapshot.get("meta") or {}
    return {
        "engine": ENGINE,
        "sourceMode": "live",
        "generatedAt": datetime.now(_SHANGHAI).isoformat(),
        "tradeDate": meta.get("tradeDate"),
        "marketDataDate": meta.get("marketDataDate"),
        "rankingSource": {
            "provider": "Tushare daily + daily_basic + stock_basic",
            "dataDate": meta.get("marketDataDate"),
            "snapshotAt": meta.get("generatedAt"),
        },
        "cycle": cycle,
        "stock": {
            "code": stock.get("code"),
            "name": stock.get("name"),
            "close": stock.get("close"),
            "score": stock.get("score"),
            "probabilityUp": stock.get("probabilityUp"),
        },
    }


async def _market_quotes() -> dict:
    """行情来源与新鲜度（对齐原版读 ``market:latest`` 的 marketSource 块）。"""
    try:
        trade_date, rows = await tushare_client._latest_market_trade_date()
    except tushare_client.TushareError:
        return {"provider": "unavailable", "status": "unavailable", "snapshotAt": None}
    return {
        "provider": "Tushare daily",
        "status": "live" if len(rows) >= 50 else "partial",
        "tradeDate": trade_date,
        "universe": len(rows),
        "snapshotAt": datetime.now(_SHANGHAI).isoformat(),
    }


async def run_tool(tool: str, body: dict | None = None) -> dict:
    """执行单个内置量化工具。**未实现的工具抛错**，绝不返回占位假结果。"""
    body = body or {}
    snapshot = await _live_snapshot()
    raw_cycle = str(body.get("cycle") or "波段")
    cycle = raw_cycle if raw_cycle in CYCLES else "波段"
    stock_code = str(body.get("stockCode") or "")
    stock = await _stock_from_snapshot(snapshot, stock_code, cycle)
    if not stock:
        raise QuantError("快照里没有可用标的")
    if tool == "backtest" and (not stock_code or stock.get("code") != stock_code):
        raise QuantError("请选择当前榜单中的有效标的，不会替换为其它股票")
    common = _common(snapshot, cycle, stock)

    # ---- market：冻结 TOP50 + 行情来源 + 该周期 TOP10 ----
    if tool == "market":
        # ⚠️ 只调一次：_latest_market_trade_date 有「数据窗口」进程内缓存，但重复调用
        #   仍多一次字典访问；更重要的是别在一次请求里触发两次额度探测。
        market_source = await _market_quotes()
        return {
            **common,
            "market": market_source,
            "marketSource": market_source,
            "top10": ((snapshot.get("cycles") or {}).get(cycle) or {}).get("ranking", [])[:10],
        }

    # ---- analysis：12 套因子画像得分 + 结论 ----
    if tool == "analysis":
        prob = float(stock.get("probabilityUp") or 0.5)
        return {
            **common,
            "factorScores": stock.get("agentScores") or {},
            "topAgents": stock.get("topAgents") or [],
            "agentVotes": stock.get("agentVotes"),
            "conclusion": (
                "多因子偏强，等待价格触发确认" if prob >= 0.6 else "因子分歧较大，维持观察"
            ),
        }

    # ---- screener：该周期榜单前 N（硬风险门控在入池前已执行） ----
    if tool == "screener":
        limit = _clamp(int(body.get("limit") or 30), 1, 50)
        ranking = ((snapshot.get("cycles") or {}).get(cycle) or {}).get("ranking") or []
        return {**common, "items": ranking[:limit]}

    # ---- predict：参考价/概率/目标区间/失效位 ----
    if tool == "predict":
        reference_price = float(stock.get("close") or 0)
        probability_up = float(stock.get("probabilityUp") or 0.5)
        if not reference_price:
            raise QuantError("标的无有效收盘价，无法生成预判")
        predicted_up = probability_up >= 0.5
        # 概率越偏离 0.5，情景波动幅度越大（原版 4934 行公式）
        scenario_move = 0.03 + abs(probability_up - 0.5) * 0.2
        target_low = (
            reference_price * (1 + scenario_move * 0.7)
            if predicted_up
            else reference_price * (1 - scenario_move)
        )
        target_high = (
            reference_price * (1 + scenario_move)
            if predicted_up
            else reference_price * (1 - scenario_move * 0.7)
        )
        return {
            **common,
            "modelVersion": "agent-factor-v1",
            "referencePrice": reference_price,
            "probabilityUp": probability_up,
            "predictedDirection": "up" if predicted_up else "down",
            "targetRange": f"{target_low:.2f}—{target_high:.2f}",
            "invalidPrice": round(reference_price * (1.05 if predicted_up else 0.95), 2),
            "verification": "预测已在TOP50生成时冻结，将按目标交易日收盘验证",
        }

    # ---- evaluate / signals：各因子得分 + 分歧度 + 允许/禁止动作 ----
    if tool in ("evaluate", "signals"):
        scores = list((stock.get("agentScores") or {}).values())
        return {
            **common,
            "dimensions": stock.get("agentScores") or {},
            "dispersion": round(max(scores) - min(scores), 2) if scores else None,
            "allowedAction": "满足触发条件后小仓试错" if stock.get("score", 0) >= 60 else "待信号",
            "prohibitedAction": "未触发前追价、跌破失效位补仓",
        }

    # ---- backtest：真实历史行情与可配置策略 ----
    if tool == "backtest":
        return {**common, **(await _backtest(stock, body))}

    raise QuantError(f"暂不支持的内置量化工具：{tool}")


async def _backtest(stock: dict, body: dict) -> dict:
    from app import backtest
    import asyncio
    from datetime import date

    try:
        options = backtest.parameters(body, datetime.now(_SHANGHAI).date())
        code = stock.get("tsCode") or tushare_client._to_ts_code(stock.get("code") or "")
        start = date.fromisoformat(options["startDate"])
        period = options["maPeriod"] if options["strategyId"] == "ma" else options["slowPeriod"] if options["strategyId"] == "dual_ma" else 0
        ranges = [(options["startDate"], options["endDate"])]
        if period:
            ranges.insert(0, ((start - timedelta(days=min(365, period * 3 + 15))).isoformat(), (start - timedelta(days=1)).isoformat()))

        async def fetch(api, interval):
            fields = "ts_code,trade_date,open,close" if api == "daily" else "ts_code,trade_date,adj_factor"
            rows = await tushare_client._call(api, {"ts_code": code, "start_date": _compact(interval[0]), "end_date": _compact(interval[1])}, fields)
            if any(r.get("ts_code") != code or not _compact(interval[0]) <= str(r.get("trade_date", "")) <= _compact(interval[1]) for r in rows):
                raise ValueError("历史数据的股票或日期与请求不符")
            return rows

        results = await asyncio.gather(*(fetch(api, interval) for api in ("daily", "adj_factor") for interval in ranges))
        count = len(ranges)
        rows = [r for group in results[:count] for r in group]
        factors = [r for group in results[count:] for r in group]
        # 上游区间查询偶有漏行，按日补查；不推算或向前填充复权因子。
        dates = sorted({r["trade_date"] for r in rows})
        pre = [d for d in dates if d < _compact(options["startDate"])]
        required = (pre[-period:] if period else []) + [d for d in dates if d >= _compact(options["startDate"])]
        existing = {r["trade_date"] for r in factors}
        missing = [d for d in required if d not in existing]
        if len(missing) > 20:
            raise ValueError(f"复权因子缺少 {len(missing)} 个交易日，请缩短区间或更换标的")
        semaphore = asyncio.Semaphore(3)
        async def repair(day):
            async with semaphore:
                values = await tushare_client._call("adj_factor", {"ts_code": code, "trade_date": day}, "ts_code,trade_date,adj_factor")
                if any(r.get("ts_code") != code or r.get("trade_date") != day for r in values):
                    raise ValueError("补查复权因子的股票或日期与请求不符")
                return values
        for values in await asyncio.gather(*(repair(day) for day in missing)):
            factors.extend(values)
        return backtest.simulate(rows, factors, options)
    except (ValueError, tushare_client.TushareError) as exc:
        raise QuantError(f"回测未完成：{exc}") from exc
