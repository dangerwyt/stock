"""让某个角色给候选股票写评分与理由（一次 LLM 调用覆盖全部候选）。

⚠️ 口径（重要，改动过）：
**榜单分数的唯一权威来源是 :mod:`top50_engine`** —— 自建老师的分由引擎按画像提炼出的
``factorWeights`` 用确定性的 ``Σ(因子分 × 权重)`` 算出，可复现、可审计。
本模块的 LLM 打分**不参与排名**，只用于给「该角色怎么看这几只票」补一段自然语言理由，
结果仅在本模块自己的返回值与角色详情页展示。

候选股票以前取的是 ``fixtures.load("top50")``（静态 mock），打出来的 code 跟真实榜单
对不上、合并时静默失效；现在强制由调用方传入**实时**快照，拿不到就明确报错，不糊假数据。

Ten separate calls would cost ten round-trips (~8s each) for no quality gain, so
the whole candidate list goes into a single prompt and the model returns one
score per code. Missing or malformed entries are back-filled by
:func:`normalize_scores` so the matrix can never end up with holes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.llm import LlmError, extract_json

DEFAULT_CYCLE = "波段"
DEFAULT_LIMIT = 10

SYSTEM_PROMPT = """你是股票投研团队的评分专家。
给你一个投资角色的画像，以及一组候选股票。你要为每只股票打一个 0-100 的分数，
表示该股票与该角色策略的匹配程度（越高越匹配）。

必须严格遵守：
1. 只输出一个 JSON 对象，禁止任何解释、前言或 markdown 代码块标记。
2. 顶层结构固定：{"scores": [{"code": "股票代码", "score": 整数, "reason": "理由"}]}
3. 必须为每一只候选股票各返回一条，不得遗漏、不得新增。
4. score 必须是 0-100 的整数，reason 不超过 50 字，要具体（点出行业、共识度或形态）。
5. 打分要有区分度，不要所有股票都给同一个分数。

正确输出示例：
{"scores":[{"code":"300155","score":78,"reason":"IT设备行业热度居前，9位老师共识，趋势结构完整"},{"code":"300520","score":52,"reason":"行业分散且老师支持度一般，仅观望"}]}"""


def build_candidates(
    snapshot: dict[str, Any],
    cycle: str = DEFAULT_CYCLE,
    limit: int = DEFAULT_LIMIT,
) -> list[dict[str, Any]]:
    """从**实时** TOP50 快照里取出候选股票，裁成 prompt 真正需要的字段。"""
    ranking = ((snapshot.get("cycles") or {}).get(cycle) or {}).get("ranking") or []
    candidates: list[dict[str, Any]] = []
    for item in ranking[:limit]:
        candidates.append(
            {
                "code": str(item.get("code") or ""),
                "name": item.get("name") or "",
                "industry": item.get("industry") or "—",
                "consensusScore": round(float(item.get("score") or 0)),
                "votes": item.get("agentVotes"),
                "status": item.get("status") or "",
                "pct": item.get("pct"),
            }
        )
    return candidates


def _profile_digest(agent: dict) -> str:
    weights = agent.get("factorWeights") or []
    weight_text = "、".join(
        f"{item.get('factor')}{round(float(item.get('weight') or 0) * 100)}%"
        for item in weights
        if isinstance(item, dict)
    )
    lines = [
        f"角色名称：{agent.get('name')}",
        f"风格：{agent.get('style')}｜定位：{agent.get('subtitle')}｜周期：{agent.get('horizon')}",
        f"决策依据：{agent.get('decision')}",
        f"选股条件：{agent.get('select')}",
        f"风险纪律：{agent.get('risk')}",
    ]
    if weight_text:
        lines.append(f"因子权重：{weight_text}")
    return "\n".join(lines)


def build_messages(agent: dict, candidates: list[dict], agent_count: int = 12) -> list[dict[str, str]]:
    rows = []
    for index, item in enumerate(candidates, start=1):
        pct = item.get("pct")
        pct_text = f"{float(pct):+.2f}%" if isinstance(pct, (int, float)) else "—"
        rows.append(
            f"{index}. {item['name']}({item['code']}) "
            f"行业：{item['industry']}｜系统共识分：{item['consensusScore']}｜"
            f"老师支持：{item.get('votes')}/{agent_count}｜状态：{item.get('status')}｜当日：{pct_text}"
        )
    user = (
        "【角色画像】\n"
        + _profile_digest(agent)
        + "\n\n【候选股票】\n"
        + "\n".join(rows)
        + f"\n\n请为以上 {len(candidates)} 只股票逐一评分，只输出 JSON。"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def _coerce_score(value: Any) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return max(0, min(100, round(number)))


def normalize_scores(raw: Any, candidates: list[dict]) -> list[dict[str, Any]]:
    """Map model output onto the candidate list, filling gaps with a fallback."""
    by_code: dict[str, dict] = {}
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            code = str(entry.get("code") or "").strip()
            score = _coerce_score(entry.get("score"))
            if code and score is not None:
                by_code[code] = {
                    "score": score,
                    "reason": " ".join(str(entry.get("reason") or "").split())[:80],
                }

    items: list[dict[str, Any]] = []
    for candidate in candidates:
        hit = by_code.get(candidate["code"])
        if hit:
            score, reason = hit["score"], hit["reason"] or "模型未给出理由"
            source = "llm"
        else:
            # Fallback: reuse the system consensus score so the row is never blank.
            score = int(candidate.get("consensusScore") or 50)
            reason = "模型未返回该股票评分，暂用系统共识分占位"
            source = "fallback"
        items.append({**candidate, "score": score, "reason": reason, "source": source})
    return items


def score_agent(
    agent: dict,
    cycle: str = DEFAULT_CYCLE,
    limit: int = DEFAULT_LIMIT,
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """跑一次 LLM 评分。模型不可用或被拒时抛 ``LlmError``。

    ``snapshot`` 必须是实时 TOP50 快照（由调用方 await ``top50_engine.get_top50_snapshot()``
    取好后传进来）—— 这个函数保持同步，方便路由用 ``to_thread`` 包住。
    """
    if not isinstance(snapshot, dict) or not snapshot.get("cycles"):
        raise LlmError("缺少实时 TOP50 快照：评分候选必须来自真实行情，不回落假数据。")
    agent_count = int((snapshot.get("meta") or {}).get("agentCount") or 12)
    candidates = build_candidates(snapshot, cycle, limit)
    if not candidates:
        raise LlmError(f"没有找到 {cycle} 周期的候选股票")

    data = extract_json(build_messages(agent, candidates, agent_count))
    items = normalize_scores(data.get("scores"), candidates)
    return {
        "cycle": cycle,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "items": items,
        "llmCount": sum(1 for item in items if item["source"] == "llm"),
        "fallbackCount": sum(1 for item in items if item["source"] == "fallback"),
        "snapshotId": (snapshot.get("meta") or {}).get("snapshotId"),
        # 明确标注：这份分只用于写理由，不参与榜单排名（排名由 factorWeights 决定）。
        "role": "auxiliary_reasoning_only",
    }
