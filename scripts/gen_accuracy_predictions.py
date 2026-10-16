"""生成准确率页所需的「已评估冻结预测」种子数据。

原版 reference-react 的准确率来自一条「冻结预测 → 到期验证 → 聚合」的管道，
端点返回的是预计算快照 ``accuracy:latest``。我们后端暂无真实预测管道，
这里用确定性脚本生成一批**内部自洽**的评估记录，喂给 ``app/accuracy.calculate_accuracy``，
使 /api/accuracy 真正"算"出来（而非读死假 fixture），并且每条都带 evidence 块让证据弹窗可用。

运行：
    python scripts/gen_accuracy_predictions.py
输出：
    backend/app/fixtures/predictions.json
同时把统计摘要（总数 / 最早到期 / 最近冻结 / 最近验证）打印出来，用于同步 acceptance.json。
"""
from __future__ import annotations

import json
import random
from datetime import date, timedelta
from pathlib import Path

random.seed(42)

OUT = Path(__file__).resolve().parent.parent / "backend" / "app" / "fixtures" / "predictions.json"

MIN_SAMPLE = 30
CYCLES = ["超短", "短线", "波段", "中长线"]
HORIZONS = [("1d", "1日", 1), ("5d", "5日", 5), ("20d", "20日", 20), ("60d", "60日", 60)]
TEACHERS = [
    "陈江挺", "养家", "谭琦", "曹名长", "产业调研凌", "曹靖楠",
    "产业调研福总", "菠萝", "曾剑枫", "寻龙一手", "龙一", "短线委员会",
]
FACTOR_VERSION = "agent-factor-v3-zero-preserving"
HISTORICAL_VERSION = "agent-factor-v2-proportional"

# 真实 A 股标的池（code / name / industry，industry 取自原 accuracy fixture 的 34 个行业）
STOCKS = [
    ("600519.SH", "贵州茅台", "白酒"), ("000858.SZ", "五粮液", "白酒"),
    ("600036.SH", "招商银行", "银行"), ("601398.SH", "工商银行", "银行"), ("601288.SH", "农业银行", "银行"),
    ("601318.SH", "中国平安", "保险"), ("601628.SH", "中国人寿", "保险"),
    ("600028.SH", "中国石化", "石油开采"), ("601857.SH", "中国石油", "石油开采"),
    ("600900.SH", "长江电力", "水力发电"),
    ("600585.SH", "海螺水泥", "水泥"),
    ("601668.SH", "中国建筑", "建筑工程"), ("601390.SH", "中国中铁", "建筑工程"),
    ("002594.SZ", "比亚迪", "汽车配件"), ("600104.SH", "上汽集团", "汽车配件"), ("000887.SZ", "中鼎股份", "汽车配件"),
    ("000333.SZ", "美的集团", "家用电器"), ("000651.SZ", "格力电器", "家用电器"),
    ("600887.SH", "伊利股份", "食品"), ("603288.SH", "海天味业", "食品"),
    ("600276.SH", "恒瑞医药", "化学制药"), ("000963.SZ", "华东医药", "化学制药"),
    ("300142.SZ", "沃森生物", "生物制药"), ("600196.SH", "复星医药", "生物制药"),
    ("300760.SZ", "迈瑞医疗", "医疗保健"), ("300347.SZ", "泰格医药", "医疗保健"),
    ("300750.SZ", "宁德时代", "电气设备"), ("601012.SH", "隆基绿能", "电气设备"), ("002202.SZ", "金风科技", "电气设备"),
    ("002475.SZ", "立讯精密", "元器件"), ("000725.SZ", "京东方A", "元器件"), ("600183.SH", "生益科技", "元器件"),
    ("688981.SH", "中芯国际", "半导体"), ("603501.SH", "韦尔股份", "半导体"), ("002129.SZ", "TCL中环", "半导体"),
    ("000977.SZ", "浪潮信息", "IT设备"),
    ("000063.SZ", "中兴通讯", "通信设备"),
    ("600050.SH", "中国联通", "电信运营"), ("601728.SH", "中国电信", "电信运营"),
    ("600588.SH", "用友网络", "软件服务"), ("002230.SZ", "科大讯飞", "软件服务"),
    ("002572.SZ", "索菲亚", "家居用品"), ("603833.SH", "欧派家居", "家居用品"),
    ("600309.SH", "万华化学", "化工原料"), ("002493.SZ", "荣盛石化", "化工原料"),
    ("600143.SH", "金发科技", "塑料"),
    ("600031.SH", "三一重工", "专用机械"), ("000157.SZ", "中联重科", "专用机械"),
    ("002050.SZ", "三花智控", "机械基件"), ("601100.SH", "恒立液压", "机械基件"),
    ("002415.SZ", "海康威视", "电器仪表"), ("300124.SZ", "汇川技术", "电器仪表"),
    ("601058.SH", "赛轮轮胎", "橡胶"),
    ("601949.SH", "中国出版", "出版业"), ("600825.SH", "新华传媒", "出版业"),
    ("600176.SH", "中国巨石", "矿物制品"), ("002080.SZ", "中材科技", "矿物制品"),
    ("300251.SZ", "光线传媒", "影视音像"), ("600977.SH", "中国电影", "影视音像"),
    ("603899.SH", "晨光文具", "文教休闲"), ("002678.SZ", "珠江钢琴", "文教休闲"),
    ("600362.SH", "江西铜业", "铜"), ("000630.SZ", "铜陵有色", "铜"),
    ("600660.SH", "福耀玻璃", "玻璃"),
    ("002918.SZ", "蒙娜丽莎", "陶瓷"),
]

REGIME_WEIGHTS = [("bull", 0.5), ("range", 0.35), ("risk_off", 0.15)]
CYCLE_WEIGHTS = [("超短", 0.28), ("短线", 0.32), ("波段", 0.26), ("中长线", 0.14)]
HORIZON_WEIGHTS = [("1d", 0.34), ("5d", 0.30), ("20d", 0.22), ("60d", 0.14)]

# 🔴 数据截止日 = 最后一个已收盘交易日。**所有预测的到期日必须 ≤ AS_OF**，
# 否则会出现「到期日在未来却已被评估」的时间穿越（曾把 60d 预测的到期日算到 2026-12-17）。
AS_OF = date(2026, 10, 15)
START = date(2026, 6, 1)
HORIZON_BD = {"1d": 1, "5d": 5, "20d": 20, "60d": 60}


def business_days(start: date, end: date) -> list[date]:
    d = start
    out = []
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def add_business_days(d: date, n: int) -> date:
    step = 1 if n >= 0 else -1
    n = abs(n)
    cur = d
    while n > 0:
        cur += timedelta(days=step)
        if cur.weekday() < 5:
            n -= 1
    return cur


def weighted_choice(pairs):
    r = random.random()
    acc = 0.0
    for value, w in pairs:
        acc += w
        if r <= acc:
            return value
    return pairs[-1][0]


_ALL_BD = business_days(START, AS_OF)


def _pick_trade_date(hbd: int) -> date:
    """挑一个冻结日，保证 trade_date + hbd 个交易日 ≤ AS_OF（到期日不落在未来）。"""
    max_td = add_business_days(AS_OF, -hbd)
    pool = [d for d in _ALL_BD if d <= max_td]
    return random.choice(pool)


def make_record(idx: int, forced_date: date | None = None, forced_horizon: str | None = None) -> dict:
    code, name, industry = random.choice(STOCKS)
    cycle = weighted_choice(CYCLE_WEIGHTS)
    hid = forced_horizon or weighted_choice(HORIZON_WEIGHTS)
    hlabel, hbd = {"1d": ("1日", 1), "5d": ("5日", 5), "20d": ("20日", 20), "60d": ("60日", 60)}[hid]
    trade_date = forced_date or _pick_trade_date(hbd)
    predicted = "up" if random.random() < 0.55 else "down"
    # 约 62% 方向命中
    if predicted == "up":
        actual = "up" if random.random() < 0.62 else "down"
    else:
        actual = "down" if random.random() < 0.62 else "up"
    hit = actual == predicted

    if predicted == "up":
        prob = round(0.52 + random.random() * 0.40, 4)
    else:
        prob = round(0.08 + random.random() * 0.40, 4)
    y = 1 if actual == "up" else 0
    brier = round((prob - y) ** 2, 6)

    base = {"1d": 0.03, "5d": 0.07, "20d": 0.15, "60d": 0.30}[hid]
    dir_sign = 1 if actual == "up" else -1
    actual_return = round(dir_sign * base * (0.4 + random.random() * 1.3), 6)
    bench = round((1 if random.random() < 0.5 else -1) * base * 0.5 * (0.3 + random.random()), 6)
    excess = round(actual_return - bench, 6)
    mae = round(actual_return - abs(base) * (0.2 + random.random() * 0.7), 6)

    regime = weighted_choice(REGIME_WEIGHTS)
    factor_version = HISTORICAL_VERSION if random.random() < 0.10 else FACTOR_VERSION

    # 老师支持组：主老师按 idx 轮转保证覆盖，再随机加 1 个（30% 概率加第 3 个）
    agents = {TEACHERS[idx % len(TEACHERS)], random.choice(TEACHERS)}
    if random.random() < 0.30:
        agents.add(random.choice(TEACHERS))
    agents = list(agents)

    maturity = add_business_days(trade_date, hbd)
    frozen_at = f"{trade_date.isoformat()}T01:09:48.235Z"
    evaluated_at = f"{maturity.isoformat()}T09:40:27.186Z"
    rec_id = f"TOP50-{trade_date.isoformat()}-{idx:04d}-{cycle}:{code}:{hid}"

    evidence = {
        "frozenAt": frozen_at,
        "dataCutoff": f"{trade_date.isoformat()}T15:00:00.000Z",
        "source": "TOP50 冻结快照 · Tushare 收盘行情",
        "invalidationRule": "目标交易日收盘数据缺失超 2 个交易日则标记失效，不事后补填",
        "prediction": {
            "name": name,
            "code": code,
            "factorVersion": factor_version,
            "marketRegime": regime,
            "benchmark": {
                "name": "上证指数",
                "referenceDate": trade_date.isoformat(),
                "referencePrice": round(3000 + random.random() * 500, 2),
            },
            "teacherVersions": {a: factor_version for a in agents},
            "evaluationRule": {"version": "eval-rule-v2"},
        },
        "evaluation": {
            "evaluationEvidence": {
                "provider": "Tushare",
                "tradeDate": maturity.isoformat(),
                "close": round(10 + random.random() * 90, 2),
                "fetchedAt": f"{maturity.isoformat()}T15:30:00.000Z",
            },
            "actualDirection": actual,
            "actualReturn": actual_return,
            "hit": hit,
        },
        "events": [
            {
                "eventId": f"evt-{rec_id}-freeze",
                "type": "evaluation_recorded",
                "occurredAt": frozen_at,
                "reason": "maturity_market_data_available",
                "patch": {"status": "evaluated", "evidenceCompleteness": "complete"},
            },
            {
                "eventId": f"evt-{rec_id}-eval",
                "type": "evaluation",
                "occurredAt": evaluated_at,
                "reason": "maturity_market_data_available",
                "patch": {"actualDirection": actual, "actualReturn": actual_return, "hit": hit},
            },
        ],
    }

    return {
        "id": rec_id,
        "code": code,
        "name": name,
        "industry": industry,
        "cycle": cycle,
        "horizon": hid,
        "factorVersion": factor_version,
        "predictedDirection": predicted,
        "probabilityUp": prob,
        "actualDirection": actual,
        "actualReturn": actual_return,
        "benchmarkReturn": bench,
        "excessReturn": excess,
        "brierScore": brier,
        "maximumAdverseExcursion": mae,
        "hit": hit,
        "marketRegime": regime,
        "topAgents": agents,
        "tradeDate": trade_date.isoformat(),
        "maturityTradeDate": maturity.isoformat(),
        "frozenAt": frozen_at,
        "evaluatedAt": evaluated_at,
        "status": "evaluated",
        "evidenceCompleteness": "complete",
        "evidence": evidence,
    }


def main() -> None:
    N = 320
    LATEST_BATCH = 50
    max_td = add_business_days(AS_OF, -1)  # 最近一期 = AS_OF 前一个交易日（2026-10-14）
    records: list[dict] = []
    # 历史散落样本：排除「最近一期」当天，避免与下方批量重叠（否则 frozenCount 会重复计入）
    while len(records) < N - LATEST_BATCH:
        rec = make_record(len(records))
        if rec["tradeDate"] == max_td.isoformat():
            continue
        records.append(rec)
    # 最近一期批量：同一天冻结、1d 期限（maturity == AS_OF，真实可到期），贴近原版一期规模，
    # 让 acceptance 页「N 条预测 · 最早到期」与「最近一期冻结」自洽。
    for j in range(LATEST_BATCH):
        records.append(make_record(100000 + j, forced_date=max_td, forced_horizon="1d"))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(records, ensure_ascii=False, indent=0), encoding="utf-8")

    # 统计摘要
    dates = [date.fromisoformat(r["tradeDate"]) for r in records]
    maturities = [date.fromisoformat(r["maturityTradeDate"]) for r in records]
    evals = [r["evaluatedAt"] for r in records]
    hits = sum(1 for r in records if r["hit"])
    future = [m for m in maturities if m > AS_OF]
    print(f"records           : {len(records)}")
    print(f"AS_OF             : {AS_OF}")
    print(f"freeze range      : {min(dates)} .. {max(dates)}")
    print(f"maturity range    : {min(maturities)} .. {max(maturities)}")
    print(f"last evaluatedAt  : {max(evals)}")
    print(f"first maturity    : {min(maturities)}")
    print(f"distinct tradeDays: {len(set(dates))}")
    print(f"hit rate (raw)    : {hits/len(records)*100:.1f}%")
    print(f"FUTURE maturities : {len(future)}  (必须为 0)")
    print(f"-> wrote {OUT}")

    # 仅供对账：运行时 /api/acceptance 的 pipeline 已由 build_acceptance_pipeline 现算（同批口径），
    # 此处打印「最近一期」快照元信息，对应前端页头展示。
    recent = [r for r in records if r["tradeDate"] == max(dates).isoformat()]
    recent_mat = [date.fromisoformat(r["maturityTradeDate"]) for r in recent if r.get("maturityTradeDate")]
    print("\nACCEPTANCE_PIPELINE_JSON (recent batch only):")
    print(json.dumps({
        "generatedAt": f"{max(dates).isoformat()}T01:09:19.498Z",
        "frozenAt": f"{max(dates).isoformat()}T01:09:48.235Z",
        "tradeDate": max(dates).isoformat(),
        "frozenCount": len(recent),
        "firstMaturityTradeDate": min(recent_mat).isoformat() if recent_mat else None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
