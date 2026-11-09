"""离线验证信号时序、资金守恒、交易成本、复权与输入边界。"""
import sys
from pathlib import Path
from datetime import date, timedelta
from copy import deepcopy
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.backtest import parameters, simulate

opens, closes = [10, 12, 13, 14, 8, 10, 16], [10, 12, 14, 8, 9, 15, 16]
rows = [{"trade_date": (date(2026, 1, 1) + timedelta(days=i)).strftime("%Y%m%d"), "open": o, "close": c}
        for i, (o, c) in enumerate(zip(opens, closes))]
factors = [{"trade_date": r["trade_date"], "adj_factor": 1} for r in rows]
base = dict(startDate="2026-01-03", endDate="2026-01-07", initialCapital=1000, maPeriod=2,
            commissionBps=0, minCommission=0, slippageBps=0, sellTaxBps=0)
p = parameters(base, date(2026, 11, 6))
r = simulate(rows, factors, p)
assert [(t["date"], t["side"]) for t in r["trades"]] == [("2026-01-03", "买入"), ("2026-01-05", "卖出"), ("2026-01-06", "买入")]
assert r["trades"][0]["price"] == 13  # 用开盘价，不能偷看当日收盘。
assert abs(r["finalEquity"] - (1000 / 13 * 8 / 10 * 16)) < .01
assert r["closedTrades"] == 1 and r["tradeWinRate"] == 0
for point in r["equityCurve"]:
    assert abs(point["cash"] + point["marketValue"] - point["equity"]) < .02
assert abs(sum(t["pnl"] or 0 for t in r["trades"]) + r["openPosition"]["unrealizedPnl"] - (r["finalEquity"] - 1000)) < .03

changed = deepcopy(rows); changed[2]["close"] = 1
assert simulate(changed, factors, p)["trades"][0] == r["trades"][0]
split = deepcopy(rows); split_factors = deepcopy(factors)
for i in range(3, len(split)):
    split[i]["open"] /= 2; split[i]["close"] /= 2; split_factors[i]["adj_factor"] = 2
assert simulate(split, split_factors, p)["equityCurve"] == r["equityCurve"]

costly = simulate(rows, factors, parameters(dict(base, commissionBps=3, minCommission=5, sellTaxBps=5, slippageBps=5), date(2026, 11, 6)))
assert costly["totalFees"] >= 15 and costly["slippageCost"] > 0 and costly["finalEquity"] < r["finalEquity"]
hold = simulate(rows, factors, parameters(dict(base, strategyId="buy_hold", positionPct=50), date(2026, 11, 6)))
assert hold["entries"] == 1 and hold["closedTrades"] == 0 and hold["tradeWinRate"] is None
assert abs(hold["finalEquity"] - (500 + 500 / 13 * 16)) < .01
flat = [dict(row, open=10, close=10) for row in rows]
cash = simulate(flat, factors, p)
assert cash["entries"] == 0 and cash["totalReturn"] == 0 and cash["sharpe"] is None
minimum = simulate(flat, factors, parameters(dict(base, strategyId="buy_hold", minCommission=5), date(2026, 11, 6)))
assert minimum["finalEquity"] == 995 and minimum["totalFees"] == 5
dual = simulate(rows, factors, parameters(dict(base, strategyId="dual_ma", fastPeriod=2, slowPeriod=3, startDate="2026-01-04"), date(2026, 11, 6)))
assert dual["sampleCount"] == 4

def fails(fn):
    try: fn()
    except ValueError: return
    raise AssertionError("Invalid input accepted")
for extra in ({"strategyId": "fake"}, {"maPeriod": 2.5}, {"initialCapital": float("nan")},
              {"commissionBps": -1}, {"endDate": "2027-01-01"}, {"startDate": "2024-01-01"},
              {"strategyId": "dual_ma", "fastPeriod": 20, "slowPeriod": 5}):
    fails(lambda: parameters(dict(base, **extra), date(2026, 11, 6)))
fails(lambda: simulate(rows, factors[:-1], p))
fails(lambda: simulate(rows, factors + [factors[-1]], p))
fails(lambda: simulate(rows + [rows[-1]], factors, p))
fails(lambda: simulate(rows[2:], factors, p))
print("PASS: next-open execution, no lookahead, cash identity, cost/slippage, adjustment, strategies and input validation")
