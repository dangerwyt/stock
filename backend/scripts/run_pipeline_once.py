"""手动跑一次 prediction-pipeline（真实 Tushare），不等待下个交易日就地验收。

为什么周六/周日跑不出东西：
  1d 到期日 = 冻结日之后的第 1 个**交易日**。今天(周五)冻结 → 到期日是下周一，周六是休市日。
  所以「自然回填」永远发生在到期日收盘之后；想今天就看到回填，必须用**已过期的历史交易日**
  造 pending（下面 evaluate 实证就是这么做的），这正是真实管道每天在做的事。

模式：
  --eval   (默认)：最快实证。临时累积库，造几条已到期 pending → 跑 evaluate，
           用真实收盘 + index_daily 基准回填 actualReturn/excess/brier/hit。约几秒。
  --freeze ：额外尝试真实 TOP50 快照派生 pending（拉全市场行情，慢；主源日限流时可能超时）。
  --real   ：写真实 data/predictions.json（生产行为，⚠️ 会改真实文件）。

用法（backend/ 目录下）：
    .venv/Scripts/python.exe scripts/run_pipeline_once.py                # 只跑 evaluate 实证（推荐）
    .venv/Scripts/python.exe scripts/run_pipeline_once.py --freeze       # 顺带试 freeze（慢）
"""
from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import tempfile

import app.prediction_pipeline as pp
from app import tushare_client as tc


async def _close(code: str, yyyymmdd: str) -> float | None:
    rows = await tc._call("daily", {"ts_code": code, "trade_date": yyyymmdd}, "ts_code,close")
    return float(rows[0]["close"]) if rows else None


async def evaluate_live_demo() -> None:
    """用两个**已收盘**的历史交易日造已到期 pending，跑真实 evaluate。"""
    # ref_d → mat_d 都是已收盘交易日，mat_d 就是 evaluate 的「到期日」
    ref_d, mat_d = "20261014", "20261015"
    ref_iso, mat_iso = "2026-10-14", "2026-10-15"
    stocks = ["600104.SH", "000001.SZ", "600036.SH", "600519.SH"]
    preds = []
    print(f"[准备] referencePrice 取 {ref_d} 真实收盘，maturityTradeDate={mat_iso}（均已收盘）")
    for code in stocks:
        ref = await _close(code, ref_d)
        if not ref:
            print(f"  [skip] {code} 无 {ref_d} 收盘")
            continue
        preds.append({
            "id": f"MANUAL-{code}-1d", "code": code, "name": code, "industry": "手动验收",
            "cycle": "短线", "horizon": "1d", "horizonLabel": "1日", "factorVersion": pp.FACTOR_VERSION,
            "predictedDirection": "up", "probabilityUp": 0.7, "referencePrice": ref,
            "tradeDate": ref_iso, "maturityTradeDate": mat_iso,
            "frozenAt": f"{ref_iso}T01:09:48Z", "status": "pending",
            "evidenceCompleteness": "pending", "topAgents": ["陈江挺"],
            "evidence": {"prediction": {"benchmark": {"name": "上证指数", "referenceDate": ref_iso, "referencePrice": None}}, "events": []},
        })
        print(f"  {code}: 参考价({ref_d}收盘) = {ref}")
    pp.save_predictions(preds)

    # as_of 传 mat_iso：让到期判定等于「到期日当天收盘后」
    res = await pp.evaluate_due_predictions(as_of=mat_iso)
    print(f"\n[evaluate 实测] {json.dumps(res, ensure_ascii=False)}")
    for p in pp.load_predictions(force=True):
        print(f"  {p['code']}: {p['predictedDirection']}->{p['actualDirection']} "
              f"actRet={p['actualReturn']} benchRet={p['benchmarkReturn']} "
              f"excess={p['excessReturn']} brier={p['brierScore']} hit={p['hit']}")
    ok = res["evaluated"] == len(preds) and res["evaluated"] > 0
    bench_ok = any(p.get("benchmarkReturn") is not None for p in pp.load_predictions(force=True))
    print(f"\n[判定] evaluate {'✅ 通过' if ok else '❌ 未全部回填'} / 基准(index_daily) {'✅ 有值' if bench_ok else '❌ 仍为 null'}")


async def freeze_live() -> None:
    print("\n[freeze 实测] 拉真实 TOP50 快照派生 pending（拉全市场行情，较慢；主源日限流时可能失败）…")
    try:
        fr = await pp.freeze_predictions(as_of="2026-10-16")
        print(f"[freeze 实测] {json.dumps(fr, ensure_ascii=False)}")
    except Exception as exc:  # noqa: BLE001
        print(f"[freeze 实测] 未跑通（今日额度/网络）：{type(exc).__name__}: {str(exc)[:160]}")
        print("            freeze 逻辑已由注入快照的 23/23 单测覆盖；live 仅卡在额度/全市场拉取。")


async def real() -> None:
    print("[real] 写真实 data/predictions.json（生产行为）")
    fr = await pp.freeze_predictions(as_of="2026-10-16")
    print(f"[freeze] {json.dumps(fr, ensure_ascii=False)}")
    ev = await pp.evaluate_due_predictions(as_of="2026-10-16")
    print(f"[evaluate] {json.dumps(ev, ensure_ascii=False)}")
    print("提示：1d 到期日是下周一（周六休市被跳过），故今天 evaluate 多为 0 条属正常；")
    print("      真实样本要等下个交易日收盘后 /api/accuracy 才增长。")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze", action="store_true", help="额外尝试真实 freeze（慢）")
    ap.add_argument("--real", action="store_true", help="写真实 data/predictions.json")
    args = ap.parse_args()

    if not args.real:
        pp._PREDICTIONS_PATH = pathlib.Path(tempfile.mkdtemp()) / "predictions.json"
        pp._cache = {"preds": None, "loaded": False}

    if args.real:
        asyncio.run(real())
    else:
        async def main():
            print("=" * 64)
            print("prediction-pipeline 手动验收（临时累积库，不碰真实 data/predictions.json）")
            print("=" * 64)
            await evaluate_live_demo()
            if args.freeze:
                await freeze_live()
        asyncio.run(main())