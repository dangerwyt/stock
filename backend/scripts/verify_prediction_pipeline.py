"""prediction_pipeline 端到端逻辑验收（不依赖真实 Tushare / 不污染真实 data 目录）。

用注入依赖的方式验证：
1) 累积库播种（fixtures 320 条基线）→ load_predictions
2) build_acceptance_pipeline / calculate_accuracy 派生口径自洽
3) freeze 由合成 snapshot 派生 pending（4 周期 × 4 期限），去重 + maturity 计算
4) evaluate 用注入收盘回填 metrics（actualReturn / benchmarkReturn / brier / hit）
"""
import asyncio
import json
import tempfile
import pathlib
from datetime import datetime, timedelta

import app.prediction_pipeline as pp
import app.accuracy as acc

# 把累积库指到临时文件，避免污染真实 data/predictions.json。
_TMP = pathlib.Path(tempfile.mkdtemp()) / "predictions.json"
pp._PREDICTIONS_PATH = _TMP
pp._cache = {"preds": None, "loaded": False}

PASS = []


def check(name, cond, extra=""):
    PASS.append(cond)
    print(f"[{'OK' if cond else 'FAIL'}] {name} {extra}")


# 1) 播种基线
preds = pp.load_predictions()
check("seed baseline count == 320", len(preds) == 320, f"(got {len(preds)})")
check("baseline all evaluated+complete", all(
    p.get("status") == "evaluated" and p.get("evidenceCompleteness") == "complete" for p in preds[:5]
))

# 2) 派生口径
pipe = acc.build_acceptance_pipeline(preds)
print("PIPELINE:", json.dumps(pipe, ensure_ascii=False))
check("pipeline.tradeDate is max tradeDate", pipe["tradeDate"] == max(p["tradeDate"] for p in preds), f"({pipe['tradeDate']})")
latest = [p for p in preds if p["tradeDate"] == pipe["tradeDate"]]
check("pipeline.frozenCount == latest-batch size", pipe["frozenCount"] == len(latest), f"({pipe['frozenCount']} vs {len(latest)})")

snap = acc.calculate_accuracy(preds)
ov = snap["overall"]
print("OVERALL:", json.dumps(ov, ensure_ascii=False))
check("overall.sampleCount == 320", ov["sampleCount"] == 320, f"({ov['sampleCount']})")
check("overall.hitRate ~ 63.1", ov["hitRate"] is not None and abs(ov["hitRate"] - 63.1) < 0.5, f"({ov['hitRate']})")
check("horizons present 1d/5d/20d/60d", set(snap["horizons"].keys()) == {"1d", "5d", "20d", "60d"})


# 3) freeze 派生
async def fake_add_trading_days(start, n):
    d = datetime.strptime(start, "%Y-%m-%d") + timedelta(days=n)
    return d.strftime("%Y-%m-%d")


pp._add_trading_days = fake_add_trading_days

snapshot = {"cycles": {}}
for cyc in pp.CYCLES:
    snapshot["cycles"][cyc] = {
        "cycleSnapshotId": f"TOP50-20261016-{cyc}-test",
        "ranking": [
            {"tsCode": "600104.SH", "code": "600104", "name": "上汽集团", "close": 47.0,
             "probabilityUp": 0.8, "industry": "汽车", "topAgents": ["陈江挺", "龙一"]},
            {"tsCode": "000001.SZ", "code": "000001", "name": "平安银行", "close": 12.0,
             "probabilityUp": 0.4, "industry": "银行", "topAgents": ["养家"]},
        ],
    }

fr = asyncio.run(pp.freeze_predictions(as_of="2026-10-16", snapshot=snapshot))
print("FREEZE:", json.dumps(fr, ensure_ascii=False))
check("freeze.frozenCount == 4*4*2=32", fr["frozenCount"] == 32, f"({fr['frozenCount']})")
check("freeze.byHorizon all 8", all(v == 8 for v in fr["byHorizon"].values()), f"({fr['byHorizon']})")

all_preds = pp.load_predictions(force=True)
pending = [p for p in all_preds if p.get("status") == "pending"]
check("total pending now 32 (injected)", len(pending) == 32, f"({len(pending)})")
check("record shape: status pending & has evidence", all(
    p["status"] == "pending" and p.get("evidence") and p["evidenceCompleteness"] == "pending" for p in pending[:1]
))
# maturity 计算：1d 应为 tradeDate+1，60d 应为 tradeDate+60
one_d = next(p for p in pending if p["horizon"] == "1d" and p["code"] == "600104.SH")
sixty_down = next(p for p in pending if p["horizon"] == "60d" and p["code"] == "000001.SZ")
check("1d maturity == 2026-10-17", one_d["maturityTradeDate"] == "2026-10-17", f"({one_d['maturityTradeDate']})")
check("60d maturity == 2026-12-15", sixty_down["maturityTradeDate"] == "2026-12-15", f"({sixty_down['maturityTradeDate']})")
check("predictedDirection matches prob", one_d["predictedDirection"] == "up" and sixty_down["predictedDirection"] == "down")

# 去重：再 freeze 同 snapshot 不应新增
fr2 = asyncio.run(pp.freeze_predictions(as_of="2026-10-16", snapshot=snapshot))
check("freeze idempotent (no dup)", fr2["frozenCount"] == 0, f"({fr2['frozenCount']})")


# 4) evaluate 回填
async def fake_close(ts_code, trade_date, close_cache):
    # 股票：相对冻结价涨 6.38%；基准指数：涨 1%
    if ts_code == "000001.SH":
        return 3030.0 if trade_date != "2026-10-16" else 3000.0
    ref = 47.0 if ts_code == "600104.SH" else 12.0
    return round(ref * 1.0638, 2)


pp._CLOSE_OVERRIDE = fake_close

# 把 1d 那批的 maturity 设为 <= today，触发评估
today = "2026-10-17"
for p in pending:
    if p["horizon"] == "1d":
        p["maturityTradeDate"] = today
pp.save_predictions(all_preds)

ev = asyncio.run(pp.evaluate_due_predictions(as_of=today))
print("EVALUATE:", json.dumps(ev, ensure_ascii=False))
check("evaluate.evaluated == 8 (4 cycles x 2)", ev["evaluated"] == 8, f"({ev['evaluated']})")

all_preds = pp.load_predictions(force=True)
ev_records = [p for p in all_preds if p.get("status") == "evaluated" and p["maturityTradeDate"] == today]
r0 = ev_records[0]
check("evaluated record: hit True for up prob", r0["hit"] is True)
check("evaluated record: brier == (0.8-1)^2=0.04", abs((r0["brierScore"] or 0) - 0.04) < 1e-6, f"({r0['brierScore']})")
check("evaluated record: actualReturn ~0.0638", r0["actualReturn"] is not None and abs(r0["actualReturn"] - 0.0638) < 0.01, f"({r0['actualReturn']})")
check("evaluated record: benchmarkReturn ~0.01", r0["benchmarkReturn"] is not None and abs(r0["benchmarkReturn"] - 0.01) < 0.01, f"({r0['benchmarkReturn']})")
check("evaluated record: evidence.evaluation filled", r0["evidence"].get("evaluation") is not None)

# accuracy 现在应把新评估计入（320 + 8）
snap2 = acc.calculate_accuracy(pp.load_predictions(force=True))
check("overall.sampleCount == 328", snap2["overall"]["sampleCount"] == 328, f"({snap2['overall']['sampleCount']})")

# _add_trading_days_approx 周末跳过校验
sat = "2026-10-17"  # 周六
nx = pp._add_trading_days_approx(sat, 1)
check("approx skips weekend (Sat+1 => Mon 10-19)", nx == "2026-10-19", f"({nx})")

print("\n=== %d/%d checks passed ===" % (sum(PASS), len(PASS)))
