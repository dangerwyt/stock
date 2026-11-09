"""单标的日线回测：复权价格、小数份额，昨日信号在下一根日线开盘执行。"""
from datetime import date, timedelta
import math
import statistics

STRATEGIES = {"ma": "均线趋势", "dual_ma": "双均线趋势", "buy_hold": "买入持有"}


def parameters(body, today=None):
    today = today or date.today()
    def number(key, default, low, high, integer=False):
        try:
            value = float(body.get(key, default))
        except (TypeError, ValueError):
            raise ValueError(f"{key} 必须为数字") from None
        if not math.isfinite(value) or not low <= value <= high or (integer and not value.is_integer()):
            raise ValueError(f"{key} 必须在 {low}–{high} 之间" + ("且为整数" if integer else ""))
        return int(value) if integer else value

    try:
        start = date.fromisoformat(str(body.get("startDate") or today - timedelta(days=180)))
        end = date.fromisoformat(str(body.get("endDate") or today))
    except ValueError:
        raise ValueError("请选择有效的开始与结束日期") from None
    if start >= end or end > today or (end - start).days > 365:
        raise ValueError("开始日期须早于结束日期，结束日期不可在未来，单次区间最长 365 天")
    strategy = body.get("strategyId", "ma")
    if strategy not in STRATEGIES:
        raise ValueError("不支持的策略")
    p = {"strategyId": strategy, "startDate": start.isoformat(), "endDate": end.isoformat(),
         "initialCapital": number("initialCapital", 100000, 1000, 100000000),
         "positionPct": number("positionPct", 100, 1, 100),
         "maPeriod": number("maPeriod", 20, 2, 120, True),
         "fastPeriod": number("fastPeriod", 5, 2, 119, True),
         "slowPeriod": number("slowPeriod", 20, 3, 120, True),
         "commissionBps": number("commissionBps", 3, 0, 100),
         "minCommission": number("minCommission", 5, 0, 100),
         "sellTaxBps": number("sellTaxBps", 5, 0, 100),
         "slippageBps": number("slippageBps", 5, 0, 100)}
    if strategy == "dual_ma" and p["fastPeriod"] >= p["slowPeriod"]:
        raise ValueError("快线周期必须小于慢线周期")
    return p


def simulate(rows, factors, p):
    def positive(value):
        try:
            value = float(value)
        except (ValueError, TypeError):
            raise ValueError("历史行情存在缺失价格或复权因子") from None
        if not math.isfinite(value) or value <= 0:
            raise ValueError("历史行情存在无效价格或复权因子")
        return value

    factor_map = {r["trade_date"]: positive(r.get("adj_factor")) for r in factors}
    if len(factor_map) != len(factors):
        raise ValueError("复权因子存在重复日期")
    ordered = sorted(rows, key=lambda r: r["trade_date"])
    if len({r["trade_date"] for r in ordered}) != len(ordered):
        raise ValueError("历史行情存在重复日期")
    start, end = p["startDate"].replace("-", ""), p["endDate"].replace("-", "")
    period = p["maPeriod"] if p["strategyId"] == "ma" else p["slowPeriod"] if p["strategyId"] == "dual_ma" else 0
    evaluated = [i for i, r in enumerate(ordered) if start <= r["trade_date"] <= end]
    if len(evaluated) < 2 or evaluated[0] < period:
        raise ValueError(f"有效历史不足：需要至少 {period} 根预热日线及 2 根区间内日线")
    ordered = ordered[evaluated[0] - period:evaluated[-1] + 1]
    evaluated = list(range(period, len(ordered)))
    missing = [r["trade_date"] for r in ordered if r["trade_date"] not in factor_map]
    if missing:
        raise ValueError(f"复权因子缺少 {len(missing)} 个交易日（{', '.join(missing[:3])}），请更换标的或缩短区间")
    anchor = positive(factor_map.get(ordered[evaluated[0]]["trade_date"]))
    prices = []
    for r in ordered:
        ratio = positive(factor_map.get(r["trade_date"])) / anchor
        prices.append((positive(r.get("open")) * ratio, positive(r.get("close")) * ratio))

    initial = p["initialCapital"]
    cash, units, entry_cost = initial, 0.0, 0.0
    peak, previous_equity = initial, initial
    commission, tax, slip = (p[key] / 10000 for key in ("commissionBps", "sellTaxBps", "slippageBps"))
    curve, trades, daily_returns, closed = [], [], [], []
    total_fees, total_slippage, entries, invested_days, positive_days = 0.0, 0.0, 0, 0, 0
    benchmark_open = prices[evaluated[0]][0]
    for i in evaluated:
        signal = True
        if p["strategyId"] == "ma":
            signal = prices[i - 1][1] > statistics.mean(v[1] for v in prices[i - period:i])
        elif p["strategyId"] == "dual_ma":
            signal = statistics.mean(v[1] for v in prices[i - p["fastPeriod"]:i]) > statistics.mean(v[1] for v in prices[i - period:i])
        day = date.fromisoformat(ordered[i]["trade_date"]).isoformat()
        opening, closing = prices[i]
        held_before = units > 0
        if signal and units == 0:
            budget = cash * p["positionPct"] / 100
            notional = max(0.0, min(budget / (1 + commission), budget - p["minCommission"]))
            if notional > 0:
                fill = opening * (1 + slip)
                fee = max(notional * commission, p["minCommission"])
                # shortcut: 复权小数份额仅用于研究，实盘撮合需改用原始价格与公司行动账本。
                units = notional / fill
                entry_cost = notional + fee
                cash -= entry_cost
                total_fees += fee
                total_slippage += units * (fill - opening)
                entries += 1
                trades.append({"date": day, "side": "买入", "price": round(fill, 4), "units": round(units, 4),
                               "amount": round(notional, 2), "fees": round(fee, 2), "pnl": None, "cash": round(cash, 2)})
        elif not signal and units > 0:
            fill = opening * (1 - slip)
            notional = units * fill
            fee = max(notional * commission, p["minCommission"]) + notional * tax
            pnl = notional - fee - entry_cost
            cash += notional - fee
            total_fees += fee
            total_slippage += units * (opening - fill)
            closed.append(pnl)
            trades.append({"date": day, "side": "卖出", "price": round(fill, 4), "units": round(units, 4),
                           "amount": round(notional, 2), "fees": round(fee, 2), "pnl": round(pnl, 2), "cash": round(cash, 2)})
            units, entry_cost = 0.0, 0.0
        equity = cash + units * closing
        if equity <= 0:
            raise ValueError("资金不足以覆盖交易成本，请调整资金与费率")
        change = equity / previous_equity - 1
        daily_returns.append(change)
        if held_before or units > 0:
            invested_days += 1
            positive_days += change > 0
        peak = max(peak, equity)
        curve.append({"date": day, "strategy": round(equity / initial, 6), "benchmark": round(closing / benchmark_open, 6),
                      "equity": round(equity, 2), "cash": round(cash, 2), "marketValue": round(units * closing, 2),
                      "positionPct": round(units * closing / equity * 100, 2), "drawdown": round((equity / peak - 1) * 100, 4)})
        previous_equity = equity

    total_return = (previous_equity / initial - 1) * 100
    try:
        annual = ((previous_equity / initial) ** (252 / len(curve)) - 1) * 100
    except OverflowError:
        annual = None
    volatility = statistics.stdev(daily_returns)
    sharpe = statistics.mean(daily_returns) / volatility * math.sqrt(252) if volatility > 1e-12 else None
    def rounded(value):
        return round(value, 2) if value is not None and math.isfinite(value) else None
    return {"strategy": STRATEGIES[p["strategyId"]], "parameters": p,
            "startDate": curve[0]["date"], "endDate": curve[-1]["date"], "sampleCount": len(curve),
            "warmupCount": evaluated[0], "totalReturn": rounded(total_return), "annualReturn": rounded(annual),
            "benchmarkReturn": rounded((curve[-1]["benchmark"] - 1) * 100),
            "maxDrawdown": rounded(min(point["drawdown"] for point in curve)), "sharpe": rounded(sharpe),
            "tradeWinRate": rounded(sum(v > 0 for v in closed) / len(closed) * 100) if closed else None,
            "investedDayWinRate": rounded(positive_days / invested_days * 100) if invested_days else None,
            "entries": entries, "closedTrades": len(closed), "totalFees": rounded(total_fees),
            "slippageCost": rounded(total_slippage), "finalEquity": rounded(previous_equity),
            "openPosition": {"units": round(units, 4), "marketValue": curve[-1]["marketValue"],
                             "unrealizedPnl": round(curve[-1]["marketValue"] - entry_cost, 2) if units else 0},
            "equityCurve": curve, "trades": trades,
            "method": "昨日收盘信号、次日开盘成交；复权价格及小数份额；期末持仓按收盘估值，不强制平仓。",
            "limitations": "单标的研究回测，不模拟整手、涨跌停成交限制与市场冲击；基准为同一标的持有且不计成本。"}
