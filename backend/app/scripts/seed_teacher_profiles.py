"""一次性种子脚本：把 12 位自建老师置为「已提炼画像」状态，并清掉已删除的 A/B/C 孤儿会话。

为什么需要它：A/B/C 老师是上一轮从 ``custom_agents.json`` 删掉的角色，但历史会话还留在
``ai_threads.json``（左侧列表因此出现幽灵项）；同时 12 位老师的 ``agent_docs/<id>/meta.json``
还没有 ``profile``，右侧 ``AgentDocsPanel`` 只会显示「尚未提炼画像。」。

本脚本**可重跑、幂等**：
- 对每个老师，按 ``top50_engine._AGENT_FORMULAS`` 反推 AI 抽象因子权重
  （趋势 = m+range、资金 = l+t、情绪 = v+strength、估值 = pe+pb，cap 与无行情因子剔除后重归一），
  复用 ``custom_agents.json`` 里已有的画像文本，调 ``agent_docs.finish_extraction`` 写
  ``meta.json``（extraction.status=completed + profile 落盘）。
- 调 ``threads.purge_for_agent`` 删掉 A/B/C 三条孤儿会话（通用会话里它们答过的痕迹按设计立墓碑）。

数据文件全部在 ``.gitignore`` 里、不受版本库保护，Mac 重新部署不会带本地数据，
因此必须用一个可重跑的种子脚本，而不是手改磁盘文件。

用法（在 ``backend/`` 下）：
    python -m app.scripts.seed_teacher_profiles
"""
from __future__ import annotations

from app import agent_docs, agents, threads
from app.agent_factor_score import QUANT_TO_AI
from app.agent_profile import DEFAULT_FACTORS
from app.top50_engine import _AGENT_FORMULAS


def reverse_factor_weights(formula: dict[str, float]) -> list[dict]:
    """引擎量化因子权重 → 归一后的 AI 抽象因子权重（只保留可映射的 4 类）。

    ``cap``（总市值）与事件/业绩/政策/产业没有对应抽象因子，直接剔除，
    其余按原比例重归一（与 ``agent_factor_score.resolve_quant_weights`` 的逆操作）。
    """
    sums: dict[str, float] = {}
    for key, weight in (formula or {}).items():
        ai = QUANT_TO_AI.get(key)
        if ai:
            sums[ai] = sums.get(ai, 0.0) + float(weight)
    total = sum(sums.values())
    if total <= 0:
        return [{"factor": f, "weight": round(w, 3)} for f, w in DEFAULT_FACTORS]
    ordered = sorted(sums.items(), key=lambda kv: kv[1], reverse=True)
    return [{"factor": factor, "weight": round(value / total, 3)} for factor, value in ordered]


def seed_one(agent: dict) -> None:
    agent_id = str(agent.get("id") or "").strip()
    name = str(agent.get("name") or "").strip()
    if not agent_id or not name:
        return
    formula = _AGENT_FORMULAS.get(name)
    factor_weights = reverse_factor_weights(formula) if formula else [
        {"factor": f, "weight": round(w, 3)} for f, w in DEFAULT_FACTORS
    ]
    profile_data = {
        "style": agent.get("style") or "自定义",
        "subtitle": agent.get("subtitle") or "",
        "horizon": agent.get("horizon") or "待定",
        "decision": agent.get("decision") or "",
        "select": agent.get("select") or "",
        "risk": agent.get("risk") or "",
        "factorWeights": factor_weights,
        "evidence": [s for s in [agent.get("decision"), agent.get("select")] if s],
    }
    agent_docs.finish_extraction(agent_id, profile_data, error=None, history_count=0)
    print(f"  ✓ {name}（{agent_id}）画像已置为 completed，因子权重："
          + "、".join(f"{w['factor']} {round(w['weight'] * 100)}%" for w in factor_weights))


def main() -> None:
    print("== 种子：12 位老师置为已提炼画像状态 ==")
    custom = agents.list_custom()
    if not custom:
        print("  ! 未读到任何自建老师（custom_agents.json 为空？）")
        return
    for agent in custom:
        seed_one(agent)

    print("\n== 清理：删除已下线的 A/B/C 孤儿会话 ==")
    for orphan in ("A老师", "B老师", "C老师"):
        removed = threads.purge_for_agent(orphan)
        print(f"  {'✓' if removed else '·'} {orphan}：删掉 {removed} 条会话"
              + ("" if removed else "（已无匹配，或已是墓碑）"))

    print("\n完成。重启后端（或下次请求即生效）后，左侧列表只剩 12 位老师，"
          "右侧 AgentDocsPanel 显示「画像提炼完成」+ 画像结论。")


if __name__ == "__main__":
    main()
