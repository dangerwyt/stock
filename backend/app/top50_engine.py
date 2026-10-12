"""TOP50 量化引擎（移植自 reference-react ``worker/index.js``）。

设计原则：
* **真实行情、不生成假排名**：数据来自 Tushare（``fetch_top50_universe``）；不可用
  时由调用方回落 fixtures 并标 ``sourceMode='fixtures'``，绝不冒充实时。
* **内置 12 套画像的系数按原版冻结**：公式与系数逐字移植，是「原版基线」。它们来自原版
  原型，属于 mock 人设，**已从产品界面彻底移除**（见 ``agents.visible_agents``），
  此处仅作为「一个自建画像都还没有」时的兜底基线保留。
* **AI 学习接管排名（与原版的有意分歧）**：原版铁律是「AI 不参与排名」，本项目改为
  「AI 学习要能改变分数」—— 自建老师（已完成画像提炼的角色）按其 ``factorWeights``
  翻译出的量化因子权重参与打分，并按 :data:`settings.custom_teacher_weight_share`
  并入周期加权。当前该份额为 **1.0**，即自建老师**完全接管**：内置权重被压成 0 后剔除，
  ``score`` / 排名 / ``agentVotes`` / 证据链全部只由自建老师决定。
  把份额设为 0 即回到原版行为。

  由于「参与打分的画像」可能只有 1-2 位，票数阈值与 ``reason`` 分母都随实际参与数缩放，
  不再沿用原版写死的 ``/12``（见 ``build_top50`` 里的 ``vote_low`` / ``vote_mid``）；
  并且参与画像不足 :data:`MIN_CONSENSUS_PARTICIPANTS` 位时**不评共识**（``risk`` 最多「中」），
  免得"一位画像看好"被渲染成「低风险 / 可试仓」。

* **周期差异在自建老师身上必须显式补回来**：原版四个周期不同，靠的是每周期启用不同的
  老师班底（见 ``CYCLES``）；自建老师接管后同一位老师在四个周期权重都是 100%，周期差异
  的来源就没了，会排出**四份一模一样的榜单**。所以每个周期会从"该周期原版启用那几位老师
  的公式"里**推导**出一份因子先验（``_cycle_factor_prior``），再按
  :data:`settings.cycle_tilt_strength` 与自建老师的画像**混合**（``_apply_cycle_tilt``）——
  "持有周期不同 → 看重的因子不同"这条原版逻辑得以延续，且系数来源可追溯到原版。

  先验刻意在**引擎因子键**层面推导（不先归到 AI 的四个抽象因子组）：原版中长线班底的
  第一大因子是 ``cap``（总市值，累计 24.9）、波段也用到（11.6），而超短/短线**完全不用**
  —— "中长期持有更看重大市值"正是原版把中长线和超短拉开距离的最大信号，归组会把它丢掉。


流水线：全市场日线 → 硬门槛筛（screen） → 7 因子 min-max 归一 + 内置基线打分 + 自建老师
画像打分（score_universe） → 按周期权重加权成综合分、取前 50（build_top50） → 挂证据链。
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app import agent_factor_score, agents, tushare_client
from app.config import settings

logger = logging.getLogger(__name__)

SHANGHAI = ZoneInfo("Asia/Shanghai")

# 形成「共识」所需的最少参与画像数（可用 ``MIN_CONSENSUS_PARTICIPANTS`` 环境变量覆盖）。
# 低于它时票数不构成共识，``risk`` 最多给到「中」—— 详见 ``build_top50`` 里的说明。
MIN_CONSENSUS_PARTICIPANTS = max(1, int(settings.min_consensus_participants))

# 4 个持有周期 + 各自的老师权重（reference-react CYCLES）。
CYCLES: dict[str, dict[str, Any]] = {
    "超短": {
        "suffix": "ULTRA",
        "holdingPeriod": "1—3个交易日",
        "focus": "情绪强度、核心辨识度、资金反馈与次日预期",
        "weights": {"养家": 28, "寻龙一手": 25, "龙一": 24, "短线委员会": 23},
    },
    "短线": {
        "suffix": "SHORT",
        "holdingPeriod": "3—10个交易日",
        "focus": "趋势临界点、主线强度、事件催化与盈亏比",
        "weights": {"陈江挺": 22, "养家": 21, "寻龙一手": 19, "龙一": 19, "短线委员会": 19},
    },
    "波段": {
        "suffix": "SWING",
        "holdingPeriod": "2—8周",
        "focus": "产业景气、订单验证、趋势结构与估值消化",
        "weights": {"陈江挺": 20, "产业调研凌": 22, "产业调研福总": 20, "菠萝": 18, "曾剑枫": 20},
    },
    "中长线": {
        "suffix": "LONG",
        "holdingPeriod": "3—18个月",
        "focus": "安全边际、现金流、产业兑现与组合风险",
        "weights": {"谭琦": 22, "曹名长": 22, "产业调研凌": 20, "曹靖楠": 18, "曾剑枫": 18},
    },
}

# 12 位老师的画像（证据链用 style/selection/risk）。
TEACHER_PROFILES: dict[str, dict[str, str]] = {
    "陈江挺": {"style": "趋势交易", "selection": "上升趋势、行业强度、临界位置清晰、盈亏比至少3:1。", "risk": "买入前确定止损和仓位，只加盈利且被市场确认的仓。"},
    "养家": {"style": "超短情绪", "selection": "主流题材、赚钱效应、核心龙头、首次分歧转一致与弱转强。", "risk": "退潮期不格局，不及预期即撤，仓位随周期和确定性变化。"},
    "谭琦": {"style": "价值研究", "selection": "安全边际、基本面改善、市场预期偏低且价格阶段合适。", "risk": "财务造假、盈利证伪和估值严重透支一票否决。"},
    "曹名长": {"style": "深度价值", "selection": "自由现金流、低估值、稳定分红、低杠杆和内生增长。", "risk": "不加杠杆、适度分散，警惕永久性损失和价值陷阱。"},
    "产业调研凌": {"style": "产业研究", "selection": "国产替代、供给短板、客户验证、订单兑现和份额提升。", "risk": "未完成客户验证只进观察池，警惕产业叙事和估值透支。"},
    "曹靖楠": {"style": "宏观策略", "selection": "国家战略、供应链安全、政策兑现与企业真实受益。", "risk": "宏观判断必须落到公司财务，多源核验且保留不交易选项。"},
    "产业调研福总": {"style": "产业波段", "selection": "扩产节奏、设备订单、关键瓶颈、交付和回款验证。", "risk": "产业知识不能成为高位被套的借口，扩产不等于盈利。"},
    "菠萝": {"style": "概率择时", "selection": "基本面未坏、系统性错杀、催化临近、赔率突出。", "risk": "允许长期空仓，不无限补仓，环境越差容错越低。"},
    "曾剑枫": {"style": "产业成长", "selection": "真实需求、竞争壁垒、业绩兑现与估值增速匹配。", "risk": "不追无业绩题材，不满仓不高杠杆，警惕技术路线变化。"},
    "寻龙一手": {"style": "盘面推演", "selection": "事件驱动、资金聚焦、核心反馈、竞价和关键时点验证。", "risk": "不猜资金意图，不把单股脉冲当板块修复，场景失效即降仓。"},
    "龙一": {"style": "题材交易", "selection": "主营利润、重复采购、订单兑现、量价转强和核心辨识度。", "risk": "中线逻辑不代表短线可追，高位放量下跌尊重价格信号。"},
    "短线委员会": {"style": "多因子短线", "selection": "趋势、资金、事件、情绪和赔率同时达标，多Agent投票确认。", "risk": "硬风险一票否决，结论必须包含失效条件、仓位上限和回撤线。"},
}

# 每位老师的因子权重公式（因子键 → 系数，系数和为 1.0）。因子键：
#   m=动量pct_chg, l=流动性amount, t=换手turnover_rate, v=量比volume_ratio,
#   pe=估值pe_ttm(反转), pb=估值pb(反转), cap=市值total_mv, range=日内区间位置, strength=阴阳强度
_AGENT_FORMULAS: dict[str, dict[str, float]] = {
    "陈江挺": {"m": 0.38, "v": 0.22, "range": 0.25, "strength": 0.15},
    "养家": {"m": 0.34, "t": 0.28, "l": 0.25, "range": 0.13},
    "谭琦": {"pe": 0.38, "pb": 0.32, "cap": 0.18, "range": 0.12},
    "曹名长": {"pe": 0.42, "pb": 0.38, "cap": 0.20},
    "产业调研凌": {"cap": 0.28, "l": 0.28, "m": 0.22, "v": 0.22},
    "曹靖楠": {"cap": 0.34, "l": 0.30, "pe": 0.20, "m": 0.16},
    "产业调研福总": {"v": 0.31, "l": 0.28, "m": 0.24, "t": 0.17},
    "菠萝": {"pe": 0.30, "pb": 0.24, "range": 0.24, "m": 0.22},
    "曾剑枫": {"cap": 0.27, "m": 0.27, "pe": 0.24, "l": 0.22},
    "寻龙一手": {"t": 0.32, "m": 0.29, "l": 0.23, "range": 0.16},
    "龙一": {"m": 0.31, "t": 0.25, "v": 0.23, "range": 0.21},
    "短线委员会": {"m": 0.25, "l": 0.23, "t": 0.20, "v": 0.17, "range": 0.15},
}

# evidence 按 predictionId 累积保留：AI 学习会生成新 snapshotId，但历史预测记录必须
# 仍可回验（「旧预测保持不动」）。上限防止长时间运行后内存无界增长，约等于留最近 20 批。
_MAX_EVIDENCE_ENTRIES = 4000

# 快照按「数据窗口」冻结（窗口定义见 ``tushare_client._data_window``）。
#
# 为什么不是 TTL：同一窗口（同一交易日的同一份行情）+ 同一份画像指纹 → 榜单结果**必然
# 相同**，按时间反复重算是纯浪费 —— 每次重算都是一轮全市场 ``daily`` + ``daily_basic``。
# 画像变了有 ``specSig`` 指纹兜底，行情变了会切窗口，两者都不需要靠 TTL 发现。
_CACHE: dict[str, Any] = {"snapshot": None, "evidence": {}, "window": None, "specSig": ""}

# 落盘：uvicorn 重启后同窗口内直接恢复，不再全量重算 —— 省额度最直接的一条。
# 失败只记 warning，绝不影响本轮结果（缓存本来就是可选项）。
_DEFAULT_SNAPSHOT_FILE = Path(__file__).resolve().parent / "data" / "top50_snapshot.json"
_SNAPSHOT_LOCK = threading.Lock()
_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024
_restore_attempted = False


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _num(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        f = float(value)
        return f if f == f and f not in (float("inf"), float("-inf")) else None  # 过滤 NaN/Inf
    except (TypeError, ValueError):
        return None


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    if value != value:  # NaN
        value = low
    return max(low, min(high, value))


def _compact(value: str) -> str:
    return str(value or "").replace("-", "")[:8]


def _iso_date(value: str | None) -> str:
    text = _compact(value or "")
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}" if len(text) == 8 else ""


def _parse_date(value: str | None) -> date | None:
    text = _compact(value or "")
    if len(text) != 8:
        return None
    try:
        return date(int(text[:4]), int(text[4:6]), int(text[6:8]))
    except ValueError:
        return None


def _listing_age_days(list_date: str | None, reference: str) -> int | None:
    listed = _parse_date(list_date)
    ref = _parse_date(reference)
    if not listed or not ref:
        return None
    return (ref - listed).days


def _daily_limit_threshold(ts_code: str) -> float:
    code = str(ts_code or "").split(".")[0]
    if re.match(r"^(30|68)", code):
        return 19.5
    if re.match(r"^(4|8)", code):
        return 29.5
    return 9.5


# --------------------------------------------------------------------------- #
# 硬门槛筛（reference-react screenTradableUniverse）
# --------------------------------------------------------------------------- #
def screen_tradable_universe(rows: list[dict], reference: str) -> tuple[list[dict], dict[str, int], int]:
    excluded = {
        "invalidQuote": 0,
        "riskName": 0,
        "newlyListed": 0,
        "priceLimit": 0,
        "liquidity": 0,
        "abnormalTurnover": 0,
    }
    eligible: list[dict] = []
    for item in rows:
        name = str(item.get("name") or "")
        close = _num(item.get("close"))
        amount = _num(item.get("amount"))
        pct = abs(_num(item.get("pct_chg")) or 0.0)
        turnover = _num(item.get("turnover_rate"))
        volume_ratio = _num(item.get("volume_ratio"))
        age = _listing_age_days(item.get("list_date"), reference)

        if not close or close <= 0 or not amount or amount <= 0:
            excluded["invalidQuote"] += 1
            continue
        if re.search(r"ST|退|暂停上市", name, re.I):
            excluded["riskName"] += 1
            continue
        if age is None or age < 90:
            excluded["newlyListed"] += 1
            continue
        if pct >= _daily_limit_threshold(item.get("ts_code")):
            excluded["priceLimit"] += 1
            continue
        if amount < 100000:
            excluded["liquidity"] += 1
            continue
        if (turnover is not None and (turnover < 0.2 or turnover > 25)) or (
            volume_ratio is not None and (volume_ratio < 0.2 or volume_ratio > 10)
        ):
            excluded["abnormalTurnover"] += 1
            continue
        eligible.append(item)
    return eligible, excluded, len(rows)


# --------------------------------------------------------------------------- #
# 因子归一 + 12 套老师画像打分（reference-react normalizeRows + scoreUniverse）
# --------------------------------------------------------------------------- #
def _normalize(rows: list[dict], field: str, invert: bool = False) -> dict[str, float]:
    values = [v for v in (_num(r.get(field)) for r in rows) if v is not None]
    if not values:
        return {}
    lo, hi = min(values), max(values)
    out: dict[str, float] = {}
    for r in rows:
        v = _num(r.get(field))
        ratio = (v - lo) / (hi - lo) if (v is not None and hi > lo) else 0.5
        out[r["ts_code"]] = (1 - ratio if invert else ratio) * 100
    return out


def score_universe(rows: list[dict], custom_specs: list[dict] | None = None) -> list[dict]:
    momentum = _normalize(rows, "pct_chg")
    liquidity = _normalize(rows, "amount")
    turnover = _normalize(rows, "turnover_rate")
    volume = _normalize(rows, "volume_ratio")
    value_pe = _normalize(rows, "pe_ttm", invert=True)
    value_pb = _normalize(rows, "pb", invert=True)
    size = _normalize(rows, "total_mv")

    scored: list[dict] = []
    for row in rows:
        code = row["ts_code"]
        close = _num(row.get("close")) or 0.0
        open_ = _num(row.get("open")) or 0.0
        high = _num(row.get("high")) or 0.0
        low = _num(row.get("low")) or 0.0
        range_position = _clamp(((close - low) / (high - low)) * 100) if high > low else 50.0
        day_strength = 70.0 if close >= open_ else 35.0
        factors = {
            "m": momentum.get(code, 0.0),
            "l": liquidity.get(code, 0.0),
            "t": turnover.get(code, 0.0),
            "v": volume.get(code, 50.0),
            "pe": value_pe.get(code, 50.0),
            "pb": value_pb.get(code, 50.0),
            "cap": size.get(code, 50.0),
            "range": range_position,
            "strength": day_strength,
        }
        # 注意变量名不叫 ``agents`` —— 那个名字在本模块顶部是 ``app.agents``（仓储层），
        # 同名局部变量会遮蔽它，将来在这个函数里调 ``agents.list_custom()`` 会莫名炸。
        agent_scores = {
            name: _clamp(sum(factors[k] * w for k, w in formula.items()))
            for name, formula in _AGENT_FORMULAS.items()
        }
        # AI 学习画像：公式形状与内置画像一模一样（Σ(因子分×权重)，权重和=1），
        # 唯一区别是系数来自画像提炼（factorWeights）而不是写死的常量。
        # ⚠️ 这里算出来的是**未与周期先验混合**的基准值（``build_top50`` 也会按周期重算，
        # 那个才是真正参与加权的分）—— 保留它是为了让 ``row["agents"]`` 始终是一份
        # 周期无关的口径，便于对照与排查。
        for spec in custom_specs or ():
            weights = spec.get("quantWeights") or {}
            if weights:
                agent_scores[spec["name"]] = _clamp(
                    sum(factors.get(key, 0.0) * weight for key, weight in weights.items())
                )
        scored.append({**row, "close": close, "agents": agent_scores, "_factors": factors})
    return scored


# --------------------------------------------------------------------------- #
# 证据链（reference-react buildRankingSelectionEvidence）
# --------------------------------------------------------------------------- #
def _round(value: Any, digits: int = 2) -> float:
    return round(_num(value) or 0.0, digits)


def build_selection_evidence(
    item: dict,
    cycle: str,
    config: dict,
    reference_date: str,
    profiles: dict[str, dict[str, str]] | None = None,
) -> dict:
    """选股证据链。

    ``profiles`` 允许把 AI 学习画像的 style/selection/risk 合并进来 —— 自建老师不在
    内置 ``TEACHER_PROFILES`` 里，不合并就会在证据链里显示成空文案。
    """
    lookup = profiles if profiles is not None else TEACHER_PROFILES
    agent_scores = item.get("agentScores") or {}
    factor_breakdown = []
    for agent, weight in config["weights"].items():
        score = _round(agent_scores.get(agent), 1)
        profile = lookup.get(agent, {})
        factor_breakdown.append(
            {
                "agent": agent,
                "weight": weight,
                "score": score,
                "contribution": _round(score * weight / 100, 2),
                "style": profile.get("style"),
                "thesis": profile.get("selection"),
            }
        )
    factor_breakdown.sort(key=lambda x: x["contribution"], reverse=True)

    supporting = [
        {
            "agent": agent,
            "score": _round(score, 1),
            "style": lookup.get(agent, {}).get("style"),
            "rationale": lookup.get(agent, {}).get("selection"),
        }
        for agent, score in agent_scores.items()
        if _num(score) is not None and _num(score) >= 60
    ]
    supporting.sort(key=lambda x: x["score"], reverse=True)

    opposing = [
        {
            "agent": agent,
            "score": _round(score, 1),
            "style": lookup.get(agent, {}).get("style"),
            "concern": lookup.get(agent, {}).get("risk"),
        }
        for agent, score in agent_scores.items()
        if _num(score) is not None and _num(score) < 45
    ]
    opposing.sort(key=lambda x: x["score"])
    opposing = opposing[:4]

    high, low = _num(item.get("high")), _num(item.get("low"))
    return {
        "snapshotId": None,
        "cycleSnapshotId": None,
        "cycle": cycle,
        "rank": item.get("rank"),
        "score": item.get("score"),
        "reason": item.get("reason"),
        "dataCutoff": _iso_date(reference_date),
        "factorBreakdown": factor_breakdown,
        "supportingAgents": supporting,
        "opposingAgents": opposing,
        "trigger": {
            "type": "price_breakout",
            "rule": f"突破当日高点 {high:.2f}" if high else "待更新",
            "context": f"{cycle}周期入场触发（当日结构位）",
            "price": high,
        },
        "invalidation": {
            "type": "price_breakdown",
            "rule": f"跌破当日低点 {low:.2f}" if low else "待更新",
            "context": f"{cycle}周期失效位（当日结构位）",
            "price": low,
        },
    }


# --------------------------------------------------------------------------- #
# 排名生成（reference-react buildTop50Snapshot）
# --------------------------------------------------------------------------- #
def _cycle_weights(config: dict, custom_names: list[str]) -> dict[str, float]:
    """某周期的参与权重：内置 lead agents + AI 学习画像，合计仍为 100。

    内置画像的相对比例**原样保留**（「前半段按原版」），只在总和里让出
    ``settings.custom_teacher_weight_share`` 给 AI 学习画像，团队内按人数均分 ——
    这是「后半段改分」：原版铁律是 AI 不参与排名。

    * ``share = 1.0`` → 内置权重被压成 0，直接**剔除**（不再出现在权重表、票数、
      均分、领先因子与 ``agentScores`` 里），自建老师完全接管。
    * ``share = 0`` 或**没有任何自建画像** → 返回与内置 ``CYCLES`` 完全一致的权重。
      后者是兜底：一个可用的自建画像都没有时若还让内置归 0，加权会全是 0、榜单直接崩。
    """
    base = {agent: float(weight) for agent, weight in config["weights"].items()}
    share = max(0.0, min(1.0, float(settings.custom_teacher_weight_share)))
    if not custom_names or share <= 0:
        return base
    scaled = {
        agent: weight * (1 - share)
        for agent, weight in base.items()
        # share = 1.0 时内置权重恒为 0，留着只会污染下游口径（票数分母 / 权重表 / 证据链）
        if weight * (1 - share) > 0
    }
    per_agent = share * 100 / len(custom_names)
    for name in custom_names:
        scaled[name] = per_agent
    return scaled


def _cycle_factor_prior(cycle: str) -> dict[str, float]:
    """某周期的**因子先验**：从该周期原版启用的内置老师公式推导出的因子配比（和为 1）。

    为什么需要它：原版四个周期能给出不同榜单，靠的是**每个周期启用不同的老师**
    （超短用养家/寻龙一手/龙一，中长线用谭琦/曹名长…），而这些老师的因子侧重本来就
    不同 —— 周期差异是"老师班底差异"的产物。自建老师接管后，同一位自建老师在四个
    周期里的权重完全相同（``_cycle_weights`` 返回的都是 100%），周期差异的来源就
    整个消失了，四个周期会排出**四份一模一样的榜单**。

    修法刻意**不手写一套系数**，而是把"原版这个周期的因子配比"从
    ``CYCLES[cycle]["weights"]`` × ``_AGENT_FORMULAS`` 里提取出来，再与自建老师的
    画像混合 —— "持有周期不同 → 看重的因子不同"这条原版逻辑继续成立，系数可追溯。

    ⚠️ 口径是**引擎因子键**（m/l/t/v/pe/pb/cap/range/strength），不是 AI 的四个抽象
    因子组：原版中长线班底的第一大因子恰好是 ``cap``（总市值，累计 24.9），波段也用到
    （11.6），而超短/短线**完全不用** —— "中长期持有更看重大市值"是原版区分中长线与
    超短的最大信号。若先归到 AI 组，``cap`` 没有对应组会被整个丢掉，最有力的那个
    区分维度就消失了。这里按原样保留 9 个键，只在返回时归一化。
    """
    accumulated: dict[str, float] = {}
    for name, weight in CYCLES[cycle]["weights"].items():
        formula = _AGENT_FORMULAS.get(name) or {}
        for key, value in formula.items():
            accumulated[key] = accumulated.get(key, 0.0) + value * weight
    total = sum(accumulated.values())
    if total <= 0:
        return {}
    return {key: value / total for key, value in accumulated.items()}


def _apply_cycle_tilt(quant_weights: dict, prior: dict) -> dict[str, float]:
    """把老师画像与周期先验按 :data:`settings.cycle_tilt_strength` 混合，得到一个周期
    实际使用的因子权重（和为 1）。

    两种"话语权"合成最终权重：

    * **画像**（归一化后占 ``1-λ``）：这位老师自己看重什么 —— 来自 AI 学习；
    * **周期先验**（占 ``λ``）：这个持有周期天然看重什么 —— 从原版班底推导。

    为什么用**混合**而不是"把画像乘上先验"：乘性只会在"画像本来就用的那几个因子"上做
    缩放，画像没提的因子永远进不去。于是一份 89% 押趋势的画像，在超短（趋势倾向 1.84）
    和短线（1.99）下都会被归一成"100% 趋势"，两个周期排出**完全一样**的榜单；而且
    中长线最重要的 ``cap`` 也永远进不来。混合让"持有周期"能补上画像忽略的维度，
    四个周期才真正有差异 —— 与"原版靠换老师班底拉开差异"是同一种效果。

    参数两端都退化得干净：``λ=0`` → 纯画像（周期不影响）；``λ=1`` → 纯周期基线
    （画像不影响）。所以 :data:`settings.cycle_tilt_strength` 是一个可解释的旋钮。
    """
    base = {
        key: float(value)
        for key, value in (quant_weights or {}).items()
        if value not in (None, "") and float(value) > 0
    }
    if not base and not prior:
        return {}
    if not base:
        return dict(prior)
    base_total = sum(base.values()) or 1.0
    normalized_base = {key: value / base_total for key, value in base.items()}
    if not prior:
        return normalized_base
    strength = max(0.0, min(1.0, float(settings.cycle_tilt_strength)))
    out = {
        key: (1 - strength) * normalized_base.get(key, 0.0) + strength * prior.get(key, 0.0)
        for key in set(normalized_base) | set(prior)
    }
    total = sum(out.values())
    if total <= 0:
        return normalized_base
    return {key: value / total for key, value in out.items()}


def _weight_entries(
    cycle_weights: dict[str, float],
    per_cycle_ai: dict[str, dict[str, float]],
    custom_names: list[str],
) -> list[dict]:
    """权重表条目。自建老师额外带上**本周期的因子占比**（趋势/资金/情绪/估值/市值）。

    share = 1.0 时每位自建老师的 agent 权重恒为 100%，四个周期看着一模一样，
    但榜单确实不同 —— 差异全在因子配比上（画像与周期先验混合的结果）。不把这一层
    翻译出来，界面上会像 bug，所以这里把"按持有周期重配后"的中文因子占比一并下发。
    """
    entries: list[dict] = []
    for agent, weight in cycle_weights.items():
        entry: dict[str, Any] = {
            "agent": agent,
            "weight": round(weight, 2),
            "origin": "ai" if agent in custom_names else "builtin",
        }
        tilted = per_cycle_ai.get(agent)
        if tilted:
            entry["factorGroups"] = agent_factor_score.group_shares(tilted)
        entries.append(entry)
    return entries


def build_top50(
    scored_rows: list[dict],
    reference_date: str,
    generated_at: str,
    custom_specs: list[dict] | None = None,
) -> tuple[dict, dict[str, dict]]:
    snapshot_id = f"TOP50-{_compact(reference_date)}-{uuid.uuid4().hex[:8]}"
    cycles: dict[str, dict] = {}
    evidence_store: dict[str, dict] = {}

    specs = custom_specs or []
    custom_names = [spec["name"] for spec in specs]
    # 证据链要读 style/selection/risk：内置画像 + AI 学习画像合成一张表，
    # 否则自建老师在证据链里会是空文案。
    profiles = {**TEACHER_PROFILES, **agent_factor_score.profile_meta(specs)}

    # 周期因子先验（每周期一份，含 cap）+ 与自建老师画像混合后的"按周期权重"。
    # 这是四份榜单能真正不同的**唯一**来源：agent 权重在 share=1.0 时恒为 100%，
    # 差异只能落在因子配比上（见 _cycle_factor_prior / _apply_cycle_tilt）。
    priors = {cycle: _cycle_factor_prior(cycle) for cycle in CYCLES}
    ai_cycle_weights: dict[str, dict[str, dict[str, float]]] = {
        cycle: {
            spec["name"]: _apply_cycle_tilt(spec.get("quantWeights") or {}, priors[cycle])
            for spec in specs
        }
        for cycle in CYCLES
    }

    share = max(0.0, min(1.0, float(settings.custom_teacher_weight_share)))
    # share = 1.0（自建完全接管）时内置权重已被 _cycle_weights 剔除，故不再计入画像数。
    builtin_active = len(_AGENT_FORMULAS) if (not custom_names or share < 1) else 0
    agent_count = builtin_active + len(custom_names)
    # 界面分母：**用户自己创建的老师总数** —— 含尚未学出画像、因而不参与打分的角色。
    # 矩阵会为它们保留一列并标「待评分」，所以分母必须大于参与数。
    teacher_count = len(agents.list_custom())
    if custom_names and share >= 1:
        ai_role = "自建老师完全接管排名：内置 mock 画像不参与加权，score 与排序只由自建老师的因子权重决定"
    elif custom_names:
        ai_role = "AI 学习画像按提炼出的因子权重参与加权，会改变 score 与排名"
    else:
        ai_role = "没有任何自建老师学出画像，排名暂由内置基线兜底"

    for cycle, config in CYCLES.items():
        cycle_weights = _cycle_weights(config, custom_names)
        participants = list(cycle_weights)
        participant_count = len(participants)
        per_cycle_ai = ai_cycle_weights[cycle]
        # 票数阈值随参与画像数缩放：原版按 12 套写死 7 / 6（≈58% / 50%）。去掉 mock
        # 老师后参与数可能只剩 1-2 位，写死阈值会把每一票都判成「高风险」。保留原版比例，
        # 于是 participant_count = 12 时结果与原来完全一致（ceil(7)=7 / ceil(6)=6）。
        vote_low = max(1, math.ceil(participant_count * 7 / 12))
        vote_mid = max(1, math.ceil(participant_count * 6 / 12))
        # 共识样本下限：参与画像少于这个数时，"票数"不构成共识 → risk 最多给到「中」。
        # 1 位参与时 ceil(1*7/12)=1，任何一只 score>=70 的票都会被判成「低风险/可试仓」，
        # 而榜单展示的又恰好是分数最高的 50 只 → 整张榜清一色「低 / 可试仓」，
        # 风险标签彻底失去信息量。那是"一位画像看好"在冒充"多画像共识"，
        # 是原版 12 套系数下不会出现的口径坍塌，必须显式挡住。
        consensus_ready = participant_count >= MIN_CONSENSUS_PARTICIPANTS
        ranking: list[dict] = []
        for row in scored_rows:
            # 只统计**本周期参与打分的画像**：share = 1.0 时就是纯自建老师，内置 12 位
            # 既不参与加权，也不再出现在票数 / 均分 / 领先因子 / agentScores 里 ——
            # 否则界面上会冒出「菠萝、陈江挺」这些已经不存在于产品中的老师名。
            #
            # 自建老师要按**本周期重配后**的因子权重现算一遍：内置老师的公式与周期
            # 无关（周期差异体现在"这个周期启用哪几位"），所以直接用 score_universe
            # 算好的值；自建老师只有一位时启用哪几位也变不了，差异必须落在因子配比上。
            row_factors = row.get("_factors") or {}
            agent_scores: dict[str, float] = {}
            for name in participants:
                tilted = per_cycle_ai.get(name)
                if tilted:
                    agent_scores[name] = _clamp(
                        sum(
                            row_factors.get(key, 0.0) * weight
                            for key, weight in tilted.items()
                        )
                    )
                else:
                    agent_scores[name] = row["agents"].get(name, 0.0)
            weighted = sum(
                agent_scores[name] * weight / 100 for name, weight in cycle_weights.items()
            )
            top_agents = [
                name for name, _ in sorted(agent_scores.items(), key=lambda kv: kv[1], reverse=True)[:3]
            ]
            probability_up = _clamp(0.5 + (weighted - 50) / 125, 0.34, 0.84)
            agent_votes = sum(1 for s in agent_scores.values() if s >= 60)
            score = round(weighted)
            risk = (
                "低"
                if (consensus_ready and score >= 70 and agent_votes >= vote_low)
                else "中"
                if (score >= 60 and agent_votes >= vote_mid)
                else "高"
            )
            status = "可试仓" if risk == "低" else "等待确认" if risk == "中" else "仅观察"
            pre_close = _num(row.get("pre_close"))
            high, low = _num(row.get("high")), _num(row.get("low"))
            amplitude = (
                round((high - low) / pre_close * 100, 2)
                if high is not None and low is not None and pre_close and pre_close > 0
                else None
            )
            pct = _num(row.get("pct_chg")) or 0.0
            pe = _num(row.get("pe_ttm"))
            item = {
                "code": str(row.get("ts_code") or "").split(".")[0],
                "tsCode": row.get("ts_code"),
                "name": row.get("name") or row.get("ts_code"),
                "close": row.get("close"),
                "pct": pct,
                "industry": row.get("industry") or "未分类",
                "score": score,
                "confidence": round(probability_up * 100),
                "probabilityUp": round(probability_up, 4),
                "agentVotes": agent_votes,
                "agentAverage": round(sum(agent_scores.values()) / participant_count) if participant_count else 0,
                "topAgents": top_agents,
                "agentScores": {k: round(v, 1) for k, v in agent_scores.items()},
                "open": _num(row.get("open")),
                "high": high,
                "low": low,
                "preClose": pre_close,
                "amount": _num(row.get("amount")),
                "turnoverRate": _num(row.get("turnover_rate")),
                "volumeRatio": _num(row.get("volume_ratio")),
                "peTtm": pe,
                "pb": _num(row.get("pb")),
                "amplitude": amplitude,
                "listDate": _iso_date(row.get("list_date")),
                "status": status,
                "risk": risk,
                "reason": (
                    f"{'、'.join(top_agents)}因子得分领先；支持{agent_votes}/{participant_count}"
                    if consensus_ready
                    # 参与画像不够时把原因写在脸上，否则用户会以为"票数明明过半却不给低风险"是 bug。
                    else f"{'、'.join(top_agents)}因子得分领先；支持{agent_votes}/{participant_count}"
                    f"（参与画像不足{MIN_CONSENSUS_PARTICIPANTS}位，不评共识）"
                ),
                "trend": "当日量价偏强" if pct >= 0 else "当日价格回撤",
                "valuation": f"PE(TTM) {pe:.1f}" if pe and pe > 0 else "PE暂无有效值",
                "triggerPrice": high,
                "invalidPrice": low,
                "marketDataDate": _iso_date(reference_date),
                "predictionId": None,
            }
            item["selectionEvidence"] = build_selection_evidence(
                item, cycle, {**config, "weights": cycle_weights}, reference_date, profiles
            )
            ranking.append(item)

        ranking.sort(key=lambda x: x["score"], reverse=True)
        ranking = ranking[:50]
        cycle_snapshot_id = (
            f"TOP50-{_compact(reference_date)}-{config['suffix']}-{generated_at[11:16].replace(':', '')}"
        )
        for index, item in enumerate(ranking):
            item["rank"] = index + 1
            item["selectionEvidence"]["snapshotId"] = snapshot_id
            item["selectionEvidence"]["cycleSnapshotId"] = cycle_snapshot_id
            item["selectionEvidence"]["rank"] = item["rank"]
            prediction_id = f"{cycle_snapshot_id}:{item['tsCode']}:1d"
            item["predictionId"] = prediction_id
            item["predictionIds"] = {"1d": prediction_id}
            evidence_store[prediction_id] = {
                "selectionEvidence": item["selectionEvidence"],
                "prediction": {
                    "name": item["name"],
                    "code": item["code"],
                    "cycle": cycle,
                    "horizonLabel": "1日",
                    "maturityTradeDate": None,
                },
                "dataCutoff": _iso_date(reference_date),
                "events": [],
            }

        cycles[cycle] = {
            "snapshotId": snapshot_id,
            "cycleSnapshotId": cycle_snapshot_id,
            "holdingPeriod": config["holdingPeriod"],
            "focus": config["focus"],
            "leadAgents": list(cycle_weights.keys()),
            "weights": _weight_entries(cycle_weights, per_cycle_ai, custom_names),
            "ranking": ranking,
        }

    today = datetime.now(SHANGHAI).strftime("%Y-%m-%d")
    ai_share = round(share, 3) if custom_names else 0.0
    meta = {
        "snapshotId": snapshot_id,
        "tradeDate": today,
        "marketDataDate": _iso_date(reference_date),
        "generatedAt": generated_at,
        "cachedAt": generated_at,
        "selectedCount": 50,
        # agentCount = **参与打分**的画像数（内置 + 自建）；teacherCount = 用户创建的
        # 老师总数（含还没学出画像的），也就是界面上的分母 —— 两者刻意分开，
        # 因为矩阵会为「待评分」的角色留列。
        "agentCount": agent_count,
        "completedAgents": agent_count,
        "teacherCount": teacher_count,
        "builtinAgentCount": builtin_active,
        "aiAgentCount": len(custom_names),
        "aiAgentNames": custom_names,
        "aiWeightShare": ai_share,
        "status": "ready",
        "sourceMode": "live",
        "marketProvider": "Tushare",
        "cachePolicy": "in-process-data-window",
        "selectionEngine": (
            f"{agent_count}套因子画像周期加权"
            f"（内置{builtin_active} + AI学习{len(custom_names)}）"
        ),
        "aiRole": ai_role,
    }
    return {"meta": meta, "cycles": cycles}, evidence_store


# --------------------------------------------------------------------------- #
# 对外入口（带缓存）
# --------------------------------------------------------------------------- #
def _spec_signature(specs: list[dict]) -> str:
    """AI 学习画像的指纹：任一自建老师的因子权重变了，指纹就变。

    有了它，「AI 学习后自动生成新 snapshotId 重新冻结」不依赖任何显式钩子 ——
    哪怕提炼是由定时任务在半夜跑的，下一次请求也会自己发现并重建。

    ⚠️ 指纹里还带上**四个周期的因子先验向量 + 混合强度 λ**：榜单结果现在同时取决于
    "画像权重"和"周期先验"两部分，而周期先验是从 ``CYCLES`` × ``_AGENT_FORMULAS``
    推导出来的。只盯画像权重的话，改了周期系数（比如调 CYCLES 的班底）或调了 λ
    会命中旧缓存、榜单静默不更新 —— 那是查起来最费劲的一类 bug。
    """
    parts = [
        "{}:{}".format(
            spec["name"],
            ",".join(f"{key}={value}" for key, value in sorted((spec.get("quantWeights") or {}).items())),
        )
        for spec in specs
    ]
    tilt_part = "|".join(
        "{}:{}".format(
            cycle,
            ",".join(f"{key}={round(value, 4)}" for key, value in sorted(_cycle_factor_prior(cycle).items())),
        )
        for cycle in CYCLES
    )
    return "|".join(sorted(parts)) + f"@{tilt_part}@{float(settings.cycle_tilt_strength):.3f}"


def _snapshot_file() -> Path:
    """落盘路径：优先 ``settings.top50_snapshot_path``。

    ⚠️ 空串必须兜回默认值 —— ``Path("")`` 会解析成当前工作目录，
    数据会静默落到 CWD（agent_docs / job_runs 都踩过这个坑）。
    """
    raw = (settings.top50_snapshot_path or "").strip()
    return Path(raw) if raw else _DEFAULT_SNAPSHOT_FILE


def _persist_snapshot() -> None:
    """把当前快照 + 证据落盘（临时文件 + ``replace`` 原子写）。

    目的：**uvicorn 重启后同一数据窗口内不需要重算** —— 省额度最直接的一条。
    落盘失败只记 warning，绝不影响本轮结果（缓存本来就是可选项）。
    """
    try:
        payload = {
            "savedAt": datetime.now(SHANGHAI).isoformat(),
            "window": _CACHE.get("window"),
            "specSig": _CACHE.get("specSig"),
            "snapshot": _CACHE.get("snapshot"),
            "evidence": _CACHE.get("evidence") or {},
        }
        text = json.dumps(payload, ensure_ascii=False)
        size = len(text.encode("utf-8"))
        if size > _SNAPSHOT_MAX_BYTES:
            logger.warning("TOP50 快照过大（%.1f MB），跳过落盘", size / 1048576)
            return
        path = _snapshot_file()
        with _SNAPSHOT_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(path)
        logger.info(
            "TOP50 快照已落盘：%s（窗口 %s，%.1f MB）",
            path.name,
            _CACHE.get("window"),
            size / 1048576,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("TOP50 快照落盘失败（不影响本轮结果）：%s", exc)


def _restore_from_disk(window: str) -> None:
    """启动后首次取快照时尝试从落盘文件恢复（每个进程只试一次）。

    ⚠️ 只有「文件里的窗口 == 当前窗口」才认：窗口变了说明行情口径已经切换
    （早晨缓存的昨日数据到收盘后就该过期），此时必须重算，不能拿旧快照冒充实时。
    """
    global _restore_attempted

    # 内存里已有同窗口快照（比如刚跑完 top50 job）就不用读盘了。
    if _CACHE["snapshot"] is not None and _CACHE.get("window") == window:
        return
    if _restore_attempted:
        return
    _restore_attempted = True

    try:
        path = _snapshot_file()
        if not path.exists():
            return
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("TOP50 落盘快照不可读，忽略：%s", exc)
        return

    saved_window = payload.get("window")
    if saved_window != window:
        logger.info(
            "TOP50 落盘快照的窗口 %s 与当前 %s 不符，丢弃并重算", saved_window, window
        )
        return

    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict) or not snapshot.get("cycles"):
        return

    _CACHE["snapshot"] = snapshot
    _CACHE["evidence"] = payload.get("evidence") or {}
    _CACHE["window"] = saved_window
    _CACHE["specSig"] = payload.get("specSig") or ""
    logger.info(
        "TOP50 已从落盘快照恢复（窗口 %s，保存于 %s），本窗口内无需重算",
        saved_window,
        payload.get("savedAt"),
    )


def invalidate_cache() -> None:
    """显式标记快照过期（画像提炼 / 打分完成后调用）。

    指纹机制其实已经能自动发现变化，这个入口用于「同一份画像想强制重算」的场景。
    把窗口清空即可 —— 下次取快照时会重新计算。
    """
    _CACHE["window"] = None


async def get_top50_snapshot(force: bool = False) -> dict:
    """构建/取缓存的 TOP50 快照。数据不可用时抛 TushareError（由调用方回落）。

    缓存判据是「同一数据窗口 + 同一份画像指纹」，**不是** TTL —— 理由见 ``_CACHE``
    的注释。``force=True`` 给调度 job 用：保证每天至少按最新数据重算一次。
    """
    specs = agent_factor_score.custom_teacher_specs()
    signature = _spec_signature(specs)
    window = tushare_client._data_window()

    if not force:
        _restore_from_disk(window)
        if (
            _CACHE["snapshot"] is not None
            and _CACHE.get("window") == window
            and _CACHE.get("specSig") == signature
        ):
            return _CACHE["snapshot"]

    rows, reference_date = await tushare_client.fetch_top50_universe()
    eligible, excluded, total = screen_tradable_universe(rows, reference_date)
    if len(eligible) < 50:
        raise tushare_client.TushareError(f"初筛后候选不足 50 只（{len(eligible)}）")

    scored = score_universe(eligible, specs)
    generated_at = datetime.now(SHANGHAI).isoformat()
    snapshot, evidence_store = build_top50(scored, reference_date, generated_at, specs)
    snapshot["meta"]["marketUniverse"] = total
    snapshot["meta"]["candidateCount"] = len(eligible)
    snapshot["meta"]["riskGate"] = {
        "minimumListingAgeDays": 90,
        "excludesPriceLimit": True,
        "minimumDailyAmountThousandYuan": 100000,
        "excluded": excluded,
    }

    snapshot["meta"]["dataWindow"] = window

    _CACHE["snapshot"] = snapshot
    # 累积而非替换：新批次有自己的 snapshotId/predictionId，不会覆盖旧键。
    merged_evidence = dict(_CACHE.get("evidence") or {})
    merged_evidence.update(evidence_store)
    if len(merged_evidence) > _MAX_EVIDENCE_ENTRIES:
        for stale_key in list(merged_evidence)[: len(merged_evidence) - _MAX_EVIDENCE_ENTRIES]:
            merged_evidence.pop(stale_key, None)
    _CACHE["evidence"] = merged_evidence
    _CACHE["specSig"] = signature
    _CACHE["window"] = window
    _persist_snapshot()
    logger.info(
        "TOP50 已生成：交易日 %s，全市场 %d → 初筛 %d → 每周期前 %d；"
        "画像 %d 套（内置 %d + AI 学习 %d%s）",
        reference_date,
        total,
        len(eligible),
        len(snapshot["cycles"]["超短"]["ranking"]),
        snapshot["meta"]["agentCount"],
        snapshot["meta"]["builtinAgentCount"],
        snapshot["meta"]["aiAgentCount"],
        f"：{'、'.join(snapshot['meta']['aiAgentNames'])}" if snapshot["meta"]["aiAgentCount"] else "",
    )
    return snapshot


def get_evidence(prediction_id: str) -> dict | None:
    """按 predictionId 取冻结选股证据（须先调用过 get_top50_snapshot）。"""
    return (_CACHE.get("evidence") or {}).get(prediction_id)
