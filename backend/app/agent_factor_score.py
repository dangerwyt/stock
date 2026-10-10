"""把 AI 学习产出的画像权重，翻译成 TOP50 引擎能直接使用的量化因子权重。

**设计分歧记录**：原项目（reference-react）的铁律是「AI 不参与排名」——
`distillTeacherKnowledge` 只产出候选知识、必须人工 PUBLISH、且文案明写「未修改生产
量化权重」。本项目明确改为「**AI 学习要能改变分数**」，所以这里承担三件事：

1. 把 :mod:`agent_profile` 提炼出的 8 类抽象因子权重，映射到 :mod:`top50_engine` 的
   量化因子键（``m``/``l``/``t``/``v``/``pe``/``pb``/``cap``/``range``/``strength``）；
2. 没有行情数据源的因子（事件 / 业绩 / 政策 / 产业）**剔除后按原比例重归一** —— 若
   直接把它们当 0 分参与加权，等于凭空拉低每一只股票的分数，重归一是唯一不引入
   系统性偏差的做法；
3. 以 :func:`custom_teacher_specs` 的形式交给引擎并入周期加权，从而真实改变 ``score``
   与排名。

映射表刻意让 4 个可用因子**互不重叠**（组内等权），这样分数变化可以逐组归因：
``趋势 → m + range``、``资金 → l + t``、``情绪 → v + strength``、``估值 → pe + pb``。
引擎的 ``cap``（总市值）没有对应的抽象因子，故不参与 —— 这是有意的，不是遗漏。
"""
from __future__ import annotations

import logging
from typing import Any

from app import agent_docs, agent_profile, agents

logger = logging.getLogger(__name__)

# AI 抽象因子 → 引擎量化因子键（必须与 top50_engine.score_universe 的 factors 字典一致）。
# 组内等权：某个 AI 因子拿到 0.4 的权重、映射到 2 个引擎因子，则每个引擎因子得 0.2。
AI_TO_QUANT: dict[str, tuple[str, ...]] = {
    "趋势": ("m", "range"),
    "资金": ("l", "t"),
    "情绪": ("v", "strength"),
    "估值": ("pe", "pb"),
}

# 这 4 类 AI 因子目前**没有行情数据源**（需要基本面/公告/政策数据），
# 故按用户决策「剔除后重归一」处理。
NO_MARKET_DATA_FACTORS: tuple[str, ...] = ("事件", "业绩", "政策", "产业")

# 反向映射：引擎量化因子 → AI 抽象因子组。
# 用途是把"按持有周期重配之后的权重"翻译回中文分组，好让界面直接显示
# 「本周期偏向 趋势 95% / 估值 5%」，不必让前端再维护一份因子键→中文的映射表。
# ``cap`` 不在表里 —— 它本来就没有对应的抽象因子（见文件头说明）。
QUANT_TO_AI: dict[str, str] = {
    key: factor for factor, keys in AI_TO_QUANT.items() for key in keys
}

# 引擎因子键 → 界面中文标签。
# 比 QUANT_TO_AI 多一个 ``cap``（总市值）：AI 画像里没有"市值"这一类抽象因子，
# 但**周期先验**会用到它 —— 原版中长线班底的第一大因子就是 cap（累计 24.9）、
# 波段也用到（11.6）。它必须有自己的中文名，否则界面上会直接漏掉中长线最大的因子。
QUANT_LABELS: dict[str, str] = {**QUANT_TO_AI, "cap": "市值"}


def group_shares(quant_weights: Any) -> dict[str, float]:
    """量化因子权重 → 归一后的**中文因子占比**（按占比降序，只保留 >0 的项）。

    用来解释「为什么四个周期的 Agent 权重都是 100%，榜单却不一样」——
    差异全在因子配比上，这一层不翻译出来，界面上看着就像 bug。
    """
    totals: dict[str, float] = {}
    for key, value in (quant_weights or {}).items():
        group = QUANT_LABELS.get(key)
        number = _num(value)
        if group is None or number is None or number <= 0:
            continue
        totals[group] = totals.get(group, 0.0) + number
    total = sum(totals.values())
    if total <= 0:
        return {}
    return {
        group: round(value / total, 4)
        for group, value in sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    }


def _num(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        number = float(value)
        return number if number == number else None  # 过滤 NaN
    except (TypeError, ValueError):
        return None


def resolve_quant_weights(factor_weights: Any) -> dict[str, float]:
    """AI 抽象因子权重 → 引擎量化因子权重，权重和 ≈ 1。

    只用有行情数据源的因子；其余按原比例重归一。一个可用因子都没有时落到
    :data:`agent_profile.DEFAULT_FACTORS`（趋势 .4 / 资金 .3 / 情绪 .3）。
    """
    usable: list[tuple[str, float]] = []
    dropped: list[str] = []
    for entry in factor_weights or []:
        if not isinstance(entry, dict):
            continue
        factor = str(entry.get("factor") or "").strip()
        weight = _num(entry.get("weight"))
        if weight is None or weight <= 0:
            continue
        if factor in AI_TO_QUANT:
            usable.append((factor, weight))
        elif factor in NO_MARKET_DATA_FACTORS:
            dropped.append(factor)
    if not usable:
        usable = [(factor, float(weight)) for factor, weight in agent_profile.DEFAULT_FACTORS]
        dropped = []
    if dropped:
        logger.info("AI 画像权重剔除无行情数据的因子并重归一：%s", "、".join(dropped))

    total = sum(weight for _, weight in usable) or 1.0
    out: dict[str, float] = {}
    for factor, weight in usable:
        keys = AI_TO_QUANT[factor]
        share = (weight / total) / len(keys)
        for key in keys:
            out[key] = out.get(key, 0.0) + share
    return {key: round(value, 6) for key, value in out.items()}


def custom_teacher_specs() -> list[dict[str, Any]]:
    """所有**已完成画像提炼**的自建老师，连同其引擎因子权重。

    没有提炼过画像的角色（``profile`` 为空）不参与 —— 没学习就没有可改分的依据。
    返回项包含引擎算分所需的 ``quantWeights``，以及证据链要用的画像文案。
    """
    specs: list[dict[str, Any]] = []
    for agent in agents.list_custom():
        agent_id = str(agent.get("id") or "").strip()
        name = str(agent.get("name") or "").strip()
        if not agent_id or not name:
            continue
        profile = agent_docs.profile(agent_id)
        if not isinstance(profile, dict) or not profile:
            continue
        quant_weights = resolve_quant_weights(profile.get("factorWeights"))
        if not quant_weights:
            continue
        specs.append(
            {
                "id": agent_id,
                "name": name,
                "quantWeights": quant_weights,
                "factorWeights": profile.get("factorWeights") or [],
                "style": profile.get("style") or agent.get("style") or "AI 学习画像",
                "selection": profile.get("select") or agent.get("select") or "",
                "risk": profile.get("risk") or agent.get("risk") or "",
                "horizon": profile.get("horizon") or agent.get("horizon") or "",
                "materialCount": int(agent.get("materialCount") or 0),
            }
        )
    return specs


def custom_teacher_names(specs: list[dict[str, Any]] | None = None) -> list[str]:
    return [spec["name"] for spec in (specs if specs is not None else custom_teacher_specs())]


def profile_meta(specs: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    """把自建老师折成 ``TEACHER_PROFILES`` 同形状，供证据链复用同一套读取逻辑。"""
    return {
        spec["name"]: {
            "style": spec.get("style") or "",
            "selection": spec.get("selection") or "",
            "risk": spec.get("risk") or "",
        }
        for spec in specs
    }
