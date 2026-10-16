"""预测管线：盘前冻结 → 到期回填 → 每日重算（忠實復刻 reference-react worker）。

原版 prediction-pipeline 是「活」的，三步闭环：

① **freeze（盘前冻结）**：09:15 前拉上一交易日真实行情 → 由 TOP50 快照派生 predictions
   （4 周期 × 4 期限 1d/5d/20d/60d × ~50 只/期），初态 ``status:"pending"``。
② **evaluate（到期评估）**：``maturityTradeDate ≤ 今天`` 的 pending，拉 Tushare 真实收盘
   回填 ``evaluated`` + ``evidenceCompleteness:"complete"``。
③ **calculateAccuracy（accuracy.py 中）**：只统计 ``evaluated`` + 证据完整的记录。

数据源 = 运行态 ``data/predictions.json``（**累积库**）。首次启动从
``fixtures/predictions.json``（320 条已评估历史基线）播种，保证 /api/accuracy 起步即有样本。
predictions 文件与 top50 快照不同窗口落盘，本模块自带原子写 + 进程内缓存，靠文件名判据做
bootstrap（**文件不存在才播种**，删了基线也不会被静默加回）。

⚠️ 顶部只引入标准库：**不在模块加载期 import tushare_client / top50_engine**（那两个会拖进
httpx 等重依赖，导致这条靠近 accuracy 的链路在沙箱/轻量环境 import 失败）。tushare / top50
只在函数体内按需 import。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

_SHANGHAI = ZoneInfo("Asia/Shanghai")

# 与 accuracy.py / fixtures 对齐的因子版本常量（自建老师画像统一版本号）。
FACTOR_VERSION = "agent-factor-v3-zero-preserving"

# 4 个周期（与 top50_engine.CYCLES 对齐）。
CYCLES = ["超短", "短线", "波段", "中长线"]

# 4 个期限（与原版一致）：key / 中文标签 / 偏移交易日数。
HORIZONS: list[tuple[str, str, int]] = [
    ("1d", "1日", 1),
    ("5d", "5日", 5),
    ("20d", "20日", 20),
    ("60d", "60日", 60),
]

# 基准指数（用于 excess return 计算），上证指数。
_BENCHMARK_TS_CODE = "000001.SH"
# pending 超过该天数仍取不到收盘 → 标记 expired，不再重试（防止无限堆积）。
_EXPIRY_DAYS = 20

# 测试可注入的收盘抓取覆盖（生产为 None，走真实 Tushare）。签名同 ``_fetch_close``。
_CLOSE_OVERRIDE: Any = None

_DATA_DIR = Path(__file__).resolve().parent / "data"
_PREDICTIONS_PATH = _DATA_DIR / "predictions.json"

# 进程内缓存：与 fixtures.load 的 lru_cache 不同，这里会在写入后主动失效。
_cache: dict[str, Any] = {"preds": None, "loaded": False}


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _shanghai_today() -> str:
    return datetime.now(_SHANGHAI).strftime("%Y-%m-%d")


def _compact(date_str: str) -> str:
    return (date_str or "").replace("-", "")


def _iso_now() -> str:
    return datetime.now(_SHANGHAI).isoformat()


def _add_trading_days_approx(start: str, n: int) -> str:
    """离线近似：跳过周末推进 n 个交易日（不含节假日，仅作 Tushare 不可用时的兜底）。"""
    d = datetime.strptime(start, "%Y-%m-%d")
    count = 0
    while count < n:
        d += timedelta(days=1)
        if d.weekday() < 5:  # Mon-Fri
            count += 1
    return d.strftime("%Y-%m-%d")


async def _add_trading_days(start: str, n: int) -> str:
    """返回 start(YYYY-MM-DD) 之后第 n 个真实交易日；Tushare 不可用时回落周末近似。"""
    from app import tushare_client

    try:
        end = (datetime.strptime(start, "%Y-%m-%d") + timedelta(days=n * 3 + 40)).strftime("%Y-%m-%d")
        cal = await tushare_client._call(
            "trade_cal",
            {
                "exchange": "SSE",
                "start_date": _compact(start),
                "end_date": _compact(end),
                "is_open": "1",
            },
            "cal_date,is_open",
        )
        opens = sorted(
            str(r.get("cal_date")) for r in cal if r.get("is_open") == "1" and _compact(start) < _compact(str(r.get("cal_date")))
        )
        # trade_cal 返回的 cal_date 可能是 YYYYMMDD 或 YYYY-MM-DD，归一化。
        opens = [o if "-" in o else f"{o[:4]}-{o[4:6]}-{o[6:8]}" for o in opens]
        if len(opens) >= n:
            return opens[n - 1]
    except tushare_client.TushareError as exc:
        logger.warning("交易日历不可用，回落周末近似：%s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("交易日历查询异常，回落周末近似：%s", exc)
    return _add_trading_days_approx(start, n)


# --------------------------------------------------------------------------- #
# 持久化层（P3）
# --------------------------------------------------------------------------- #
def _seed_from_fixtures() -> list[dict]:
    """首次播种：把 fixtures 的 320 条已评估基线拷进运行态累积库。"""
    from app import fixtures

    base = fixtures.load("predictions")
    logger.info("predictions 累积库不存在，从 fixtures 播种 %d 条历史基线", len(base))
    return list(base)


def load_predictions(force: bool = False) -> list[dict]:
    """读取累积库（带进程内缓存）。文件不存在则播种基线。"""
    global _cache
    if not force and _cache.get("loaded") and _cache.get("preds") is not None:
        return _cache["preds"]  # type: ignore[return-value]
    if not _PREDICTIONS_PATH.exists():
        preds = _seed_from_fixtures()
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write(preds)
        _cache = {"preds": preds, "loaded": True}
        return preds
    try:
        preds = json.loads(_PREDICTIONS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("predictions 读取失败，回退空库：%s", exc)
        preds = []
    _cache = {"preds": preds, "loaded": True}
    return preds


def save_predictions(preds: list[dict]) -> None:
    """原子写累积库并刷新缓存（写入方统一走这里，避免缓存与磁盘不一致）。"""
    global _cache
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write(preds)
    _cache = {"preds": preds, "loaded": True}


def _atomic_write(preds: list[dict]) -> None:
    tmp = _PREDICTIONS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(preds, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_PREDICTIONS_PATH)


def reload_predictions() -> list[dict]:
    """强制从磁盘重读（调度 job 在写完后给下游用）。"""
    return load_predictions(force=True)


# --------------------------------------------------------------------------- #
# P1：盘前冻结（freeze）
# --------------------------------------------------------------------------- #
def _build_prediction_record(
    item: dict,
    cycle: str,
    cycle_snapshot_id: str,
    horizon_key: str,
    horizon_label: str,
    trade_date: str,
    maturity_date: str,
    frozen_at: str,
) -> dict:
    """由 TOP50 ranking item 派生一条预测记录（初态 pending）。"""
    ts_code = str(item.get("tsCode") or "")
    code = str(item.get("code") or ts_code.split(".")[0])
    name = str(item.get("name") or code)
    probability_up = float(item.get("probabilityUp") or 0.5)
    reference_price = float(item.get("close")) if item.get("close") is not None else None
    predicted_direction = "up" if probability_up >= 0.5 else "down"
    top_agents = item.get("topAgents") or []
    prediction_id = f"{cycle_snapshot_id}:{ts_code}:{horizon_key}"

    record = {
        "id": prediction_id,
        "code": ts_code,
        "name": name,
        "industry": item.get("industry") or "未分类",
        "cycle": cycle,
        "horizon": horizon_key,
        "horizonLabel": horizon_label,
        "factorVersion": FACTOR_VERSION,
        "predictedDirection": predicted_direction,
        "probabilityUp": round(probability_up, 4),
        "referencePrice": reference_price,
        "actualDirection": None,
        "actualReturn": None,
        "benchmarkReturn": None,
        "excessReturn": None,
        "brierScore": None,
        "maximumAdverseExcursion": None,
        "hit": None,
        "marketRegime": None,
        "topAgents": list(top_agents),
        "tradeDate": trade_date,
        "maturityTradeDate": maturity_date,
        "frozenAt": frozen_at,
        "evaluatedAt": None,
        "status": "pending",
        "evidenceCompleteness": "pending",
        "evidence": {
            "frozenAt": frozen_at,
            "dataCutoff": f"{trade_date}T15:00:00.000Z",
            "source": "TOP50 冻结快照 · Tushare 收盘行情",
            "invalidationRule": "目标交易日收盘数据缺失超 2 个交易日则标记失效，不事后补填",
            "prediction": {
                "name": name,
                "code": ts_code,
                "factorVersion": FACTOR_VERSION,
                "marketRegime": None,
                "referencePrice": reference_price,
                "benchmark": {
                    "name": "上证指数",
                    "referenceDate": trade_date,
                    "referencePrice": None,
                },
                "teacherVersions": {name: FACTOR_VERSION for name in top_agents},
                "evaluationRule": {"version": "eval-rule-v2"},
            },
            "evaluation": None,
            "events": [
                {
                    "eventId": f"evt-{prediction_id}-freeze",
                    "type": "evaluation_recorded",
                    "occurredAt": frozen_at,
                    "reason": "maturity_market_data_available",
                    "patch": {"status": "pending", "evidenceCompleteness": "pending"},
                }
            ],
        },
    }
    return record


async def freeze_predictions(as_of: str | None = None, snapshot: dict | None = None) -> dict:
    """盘前冻结：从 TOP50 快照派生 pending 预测。

    优先用实时快照（依赖 Tushare）；不可用时回落 fixtures 静态快照（标 sourceMode=fixtures），
    保证管线在演示环境也能持续产出待评估记录，绝不伪造行情。
    ``snapshot`` 非空时直接用它（便于单测，跳过实时/静态抓取）。
    """
    from app import top50_engine

    trade_date = as_of or _shanghai_today()
    frozen_at = _iso_now()

    source_mode = "injected"
    if snapshot is None:
        try:
            snapshot = await top50_engine.get_top50_snapshot()
            source_mode = "live"
        except Exception as exc:  # noqa: BLE001 - 实时不可用时不让冻结 job 崩，回落 fixtures
            logger.warning("TOP50 实时快照不可用，冻结回落 fixtures：%s", exc)
            from app import fixtures

            snapshot = fixtures.load("top50")
            source_mode = "fixtures"

    cycles = (snapshot.get("cycles") or {}) if isinstance(snapshot, dict) else {}
    if not cycles:
        return {"status": "unavailable", "sourceMode": source_mode,
                "reason": "TOP50 快照无周期数据", "frozenCount": 0}

    existing_preds = load_predictions()
    existing_ids = {p.get("id") for p in existing_preds}
    new_records: list[dict] = []

    # 🔴 到期日只取决于「冻结日 + 期限偏移」这 4 个 offset，与标的无关 ——
    #   必须在进循环**之前**算一次。原先写在最内层循环里，4周期×50只×4期限=800 条
    #   各自发一次 trade_cal（主源限流时还要回落 B 套），freeze 直接超时。
    maturities: dict[str, str] = {}
    for horizon_key, _label, offset in HORIZONS:
        maturities[horizon_key] = await _add_trading_days(trade_date, offset)

    for cycle in CYCLES:
        cycle_block = cycles.get(cycle) or {}
        cycle_snapshot_id = cycle_block.get("cycleSnapshotId") or f"TOP50-{_compact(trade_date)}-{cycle}"
        ranking = cycle_block.get("ranking") or []
        for item in ranking[:50]:
            for horizon_key, horizon_label, offset in HORIZONS:
                rec = _build_prediction_record(
                    item, cycle, cycle_snapshot_id, horizon_key, horizon_label,
                    trade_date, maturities[horizon_key], frozen_at,
                )
                if rec["id"] in existing_ids:
                    continue  # 同日重复冻结按 id 去重，不覆盖已有（可能已评估）。
                new_records.append(rec)
                existing_ids.add(rec["id"])

    if new_records:
        save_predictions(existing_preds + new_records)

    by_horizon: dict[str, int] = {}
    for r in new_records:
        by_horizon[r["horizon"]] = by_horizon.get(r["horizon"], 0) + 1
    return {
        "status": "completed",
        "sourceMode": source_mode,
        "tradeDate": trade_date,
        "frozenCount": len(new_records),
        "byHorizon": by_horizon,
        "snapshotId": f"TOP50-{_compact(trade_date)}-3d3f47ac-9dc3-4107-b3f8-0dbd29774327",
    }


# --------------------------------------------------------------------------- #
# P2：到期评估（evaluate）
# --------------------------------------------------------------------------- #
async def _daily_rows(tushare_client, ts_code: str, trade_date: str, is_index: bool) -> list[dict]:
    """取单标的单日收盘行。个股走 ``daily``，指数走 ``index_daily``（⚠️ 指数不在 daily 表里）。"""
    if is_index:
        return await tushare_client._call(
            "index_daily",
            {"ts_code": ts_code, "start_date": _compact(trade_date), "end_date": _compact(trade_date)},
            "ts_code,trade_date,close",
        ) or []
    return await tushare_client._call(
        "daily", {"ts_code": ts_code, "trade_date": _compact(trade_date)},
        "ts_code,trade_date,close",
    ) or []


async def _fetch_close(
    ts_code: str, trade_date: str, close_cache: dict[str, float | None], is_index: bool = False
) -> float | None:
    """取某只某交易日收盘；取不到则顺着交易日历往后找最多 5 个交易日（自修正 maturity 漂移）。

    ``is_index=True`` 走 ``index_daily``（上证等基准指数）。``_CLOSE_OVERRIDE`` 非空时直接交给它
    （用于单测，避免依赖真实 Tushare）。
    """
    if _CLOSE_OVERRIDE is not None:
        return await _CLOSE_OVERRIDE(ts_code, trade_date, close_cache)

    from app import tushare_client

    key = ("idx:" if is_index else "") + f"{ts_code}:{trade_date}"
    if key in close_cache:
        return close_cache[key]

    def _rows_on(d: str) -> list[dict]:
        return _daily_rows(tushare_client, ts_code, d, is_index)

    try:
        rows = await _rows_on(trade_date)
        if rows:
            close_cache[key] = float(rows[0]["close"])
            return close_cache[key]
    except tushare_client.TushareError:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s 查询异常 %s@%s：%s", "index_daily" if is_index else "daily", ts_code, trade_date, exc)

    # 顺延到之后的交易日再试一次（修正节假日导致的 maturity 偏移）。
    try:
        end = (datetime.strptime(trade_date, "%Y-%m-%d") + timedelta(days=12)).strftime("%Y-%m-%d")
        cal = await tushare_client._call(
            "trade_cal",
            {"exchange": "SSE", "start_date": _compact(trade_date), "end_date": _compact(end), "is_open": "1"},
            "cal_date,is_open",
        )
        opens = sorted(
            str(r.get("cal_date")) for r in cal
            if r.get("is_open") == "1" and _compact(trade_date) < _compact(str(r.get("cal_date")))
        )
        opens = [o if "-" in o else f"{o[:4]}-{o[4:6]}-{o[6:8]}" for o in opens][:5]
        for d in opens:
            k2 = ("idx:" if is_index else "") + f"{ts_code}:{d}"
            if k2 in close_cache:
                return close_cache[k2]
            try:
                rows = await _rows_on(d)
            except tushare_client.TushareError:
                continue
            if rows:
                close_cache[k2] = float(rows[0]["close"])
                return close_cache[k2]
    except tushare_client.TushareError:
        pass
    close_cache[key] = None
    return None


async def evaluate_due_predictions(as_of: str | None = None) -> dict:
    """扫描 pending 且 maturityTradeDate ≤ 今天 的记录，拉真实收盘回填。"""
    from app import tushare_client

    today = as_of or _shanghai_today()
    preds = load_predictions()
    due = [
        p for p in preds
        if p.get("status") == "pending"
        and p.get("maturityTradeDate")
        and str(p["maturityTradeDate"]) <= today
    ]
    if not due:
        return {"status": "completed", "evaluated": 0, "missing": 0, "expired": 0,
                "pendingRemaining": sum(1 for p in preds if p.get("status") == "pending")}

    evaluated = missing = expired = 0
    close_cache: dict[str, float | None] = {}
    # 基准指数收盘按日期缓存（同批次共享 tradeDate / 各 maturityDate）。
    changed = False

    for p in due:
        maturity = str(p["maturityTradeDate"])
        close = await _fetch_close(p["code"], maturity, close_cache)
        if close is None:
            # 过期判定：超过阈值仍取不到 → 标记 expired，不再重试。
            try:
                overdue = (datetime.strptime(today, "%Y-%m-%d") - datetime.strptime(maturity, "%Y-%m-%d")).days
            except ValueError:
                overdue = 0
            if overdue > _EXPIRY_DAYS:
                p["status"] = "expired"
                p["evidenceCompleteness"] = "incomplete"
                expired += 1
                changed = True
            else:
                missing += 1
            continue

        ref_price = p.get("referencePrice")
        if not ref_price:
            missing += 1
            continue
        actual_return = (close - ref_price) / ref_price
        actual_direction = "up" if close >= ref_price else "down"

        # 基准（上证指数）同期收益：tradeDate → 评估日。⚠️ 指数走 index_daily，不是 daily。
        bench_start = await _fetch_close(_BENCHMARK_TS_CODE, p["tradeDate"], close_cache, is_index=True)
        bench_end = await _fetch_close(_BENCHMARK_TS_CODE, maturity, close_cache, is_index=True)
        benchmark_return = None
        excess_return = None
        if bench_start and bench_end:
            benchmark_return = (bench_end - bench_start) / bench_start
            excess_return = actual_return - benchmark_return

        prob = float(p.get("probabilityUp") or 0.5)
        outcome = 1.0 if actual_direction == "up" else 0.0
        brier = (prob - outcome) ** 2
        hit = actual_direction == p.get("predictedDirection")

        now = _iso_now()
        p["status"] = "evaluated"
        p["evidenceCompleteness"] = "complete"
        p["actualDirection"] = actual_direction
        p["actualReturn"] = round(actual_return, 6)
        p["benchmarkReturn"] = round(benchmark_return, 6) if benchmark_return is not None else None
        p["excessReturn"] = round(excess_return, 6) if excess_return is not None else None
        p["brierScore"] = round(brier, 4)
        p["hit"] = bool(hit)
        p["evaluatedAt"] = now
        p["evidence"]["evaluation"] = {
            "evaluationEvidence": {
                "provider": "Tushare",
                "tradeDate": maturity,
                "close": close,
                "fetchedAt": now,
            },
            "actualDirection": actual_direction,
            "actualReturn": round(actual_return, 6),
            "benchmarkReturn": round(benchmark_return, 6) if benchmark_return is not None else None,
            "excessReturn": round(excess_return, 6) if excess_return is not None else None,
            "hit": bool(hit),
        }
        # 回填基准参考价（供证据展示）。
        if p["evidence"]["prediction"]["benchmark"]["referencePrice"] is None and bench_start is not None:
            p["evidence"]["prediction"]["benchmark"]["referencePrice"] = round(bench_start, 2)
        p["evidence"]["events"].append({
            "eventId": f"evt-{p['id']}-eval",
            "type": "evaluation",
            "occurredAt": now,
            "reason": "maturity_market_data_available",
            "patch": {
                "actualDirection": actual_direction,
                "actualReturn": round(actual_return, 6),
                "benchmarkReturn": round(benchmark_return, 6) if benchmark_return is not None else None,
                "excessReturn": round(excess_return, 6) if excess_return is not None else None,
                "hit": bool(hit),
            },
        })
        evaluated += 1
        changed = True

    if changed:
        save_predictions(preds)

    pending_remaining = sum(1 for p in preds if p.get("status") == "pending")
    return {
        "status": "completed",
        "evaluated": evaluated,
        "missing": missing,
        "expired": expired,
        "pendingRemaining": pending_remaining,
        "asOf": today,
    }


def get_prediction_evidence(prediction_id: str | None) -> dict | None:
    """按 predictionId 返回冻结预测的证据块；未命中返回 None。"""
    if not prediction_id:
        return None
    for it in load_predictions():
        if it.get("id") == prediction_id:
            return it.get("evidence")
    return None
