"""Turn agent documents into a structured persona profile via the LLM.

The prompt pins an **exact flat schema with a filled example** — MiniMax-M3
otherwise invents nesting (``style.type`` / ``style.core_logic``), which breaks
every downstream consumer. Everything the model returns still goes through
:func:`normalize`, because LLM output is never trusted verbatim.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app import relevance
from app.documents import ExtractedDocument
from app.llm import LlmError, extract_json

MAX_FIELD_CHARS = 120

SYSTEM_PROMPT = """你是股票投研团队的 Agent 画像建模专家。
你会阅读用户上传的研究资料，把其中的投资方法论提炼成一个可执行的角色画像。

必须严格遵守：
1. 只输出一个 JSON 对象，禁止输出任何解释、前言、markdown 代码块标记。
2. 顶层字段固定为：style, subtitle, horizon, decision, select, risk, factorWeights, evidence。
3. 所有描述字段都是**字符串**，不要用嵌套对象。
4. factorWeights 是数组，元素为 {"factor": 字符串, "weight": 数字}，weight 取值 0~1，所有 weight 之和必须为 1。
5. factor 只能从这些里选：趋势, 资金, 情绪, 事件, 估值, 业绩, 政策, 产业。最多 5 个。
6. evidence 是数组，放 2~4 条你依据的原文关键句（字符串）。
7. 资料里没有提到的信息，按你的专业判断补一个合理的保守值，不要留空。

字段含义与长度：
- style：风格标签，8 字以内，如「趋势交易」
- subtitle：一句话定位，14 字以内，如「临界点 · 小亏大赚」
- horizon：持股周期，8 字以内，如「短线 / 波段」
- decision：决策依据，80 字以内
- select：选股条件，80 字以内
- risk：风险纪律，80 字以内

正确输出示例（请严格模仿这个结构）：
{"style":"趋势交易","subtitle":"临界点 · 小亏大赚","horizon":"短线 / 波段","decision":"只在市场完成验证后行动，不预测底部。","select":"趋势形成、临界点清晰、盈亏比至少3:1。","risk":"单笔小亏，跌破失效位立即退出。","factorWeights":[{"factor":"趋势","weight":0.4},{"factor":"资金","weight":0.3},{"factor":"情绪","weight":0.3}],"evidence":["只在市场完成验证后行动"]}"""

ALLOWED_FACTORS = ("趋势", "资金", "情绪", "事件", "估值", "业绩", "政策", "产业")
DEFAULT_FACTORS = (("趋势", 0.4), ("资金", 0.3), ("情绪", 0.3))

TEXT_FIELDS = ("style", "subtitle", "horizon", "decision", "select", "risk")

FALLBACKS = {
    "style": "自定义",
    "subtitle": "待补充画像",
    "horizon": "待定",
    "decision": "资料中未明确说明决策依据，需人工补充。",
    "select": "资料中未明确说明选股条件，需人工补充。",
    "risk": "资料中未明确说明风险纪律，需人工补充。",
}


def _clip(value: Any, fallback: str, limit: int = MAX_FIELD_CHARS) -> str:
    if not isinstance(value, str):
        return fallback
    text = " ".join(value.split()).strip()
    if not text:
        return fallback
    return text[:limit]


def _normalize_weights(raw: Any) -> list[dict[str, Any]]:
    items: list[tuple[str, float]] = []
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            factor = str(entry.get("factor") or "").strip()
            try:
                weight = float(entry.get("weight"))
            except (TypeError, ValueError):
                continue
            if factor in ALLOWED_FACTORS and weight > 0:
                items.append((factor, weight))
    if not items:
        items = list(DEFAULT_FACTORS)

    # de-duplicate, keep first occurrence, cap at 5
    seen: dict[str, float] = {}
    for factor, weight in items:
        if factor not in seen:
            seen[factor] = weight
    trimmed = list(seen.items())[:5]

    total = sum(w for _, w in trimmed) or 1.0
    return [
        {"factor": factor, "weight": round(weight / total, 3)}
        for factor, weight in trimmed
    ]


def _normalize_evidence(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for entry in raw:
        text = _clip(entry, "", 200)
        if text and text not in out:
            out.append(text)
    return out[:4]


def normalize(data: dict[str, Any]) -> dict[str, Any]:
    """Coerce raw model output into a profile with guaranteed field shapes."""
    profile: dict[str, Any] = {}
    for field_name in TEXT_FIELDS:
        profile[field_name] = _clip(data.get(field_name), FALLBACKS[field_name])
    profile["factorWeights"] = _normalize_weights(data.get("factorWeights"))
    profile["evidence"] = _normalize_evidence(data.get("evidence"))
    return profile


def _history_block(history: list[dict[str, Any]] | None) -> str:
    """Render past session turns as a clearly-subordinate hint block."""
    if not history:
        return ""
    lines: list[str] = []
    for turn in history:
        content = str(turn.get("content") or "").strip()
        if not content:
            continue
        speaker = "用户" if turn.get("role") == "user" else "角色本人"
        lines.append(f"{speaker}：{content}")
    if not lines:
        return ""
    return (
        "【历史对话补充】\n"
        "以下是该角色在研究会话中的近期问答记录。**仅在资料未覆盖时作为补充线索**，"
        "不要用它覆盖资料里的明确结论；若两者冲突，以资料为准。\n"
        + "\n".join(lines)
    )


def build_messages(
    agent_name: str,
    documents: list[ExtractedDocument],
    history: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    blocks: list[str] = []
    for index, doc in enumerate(documents, start=1):
        meta = f"{doc.filename}（{doc.kind}"
        if doc.pages:
            meta += f"，{doc.pages}页"
        meta += f"，{doc.chars}字符）"
        blocks.append(f"【资料{index}】{meta}\n{doc.text}")

    parts = [
        f"角色名称：{agent_name}",
        f"请阅读以下 {len(documents)} 份资料，提炼出该角色的策略因子画像。",
        "只输出 JSON，字段与示例完全一致。",
    ]
    supplemental = _history_block(history)
    if supplemental:
        parts.append(supplemental)
    parts.append("\n\n".join(blocks))
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


def prune_documents(documents: list[ExtractedDocument]) -> list[ExtractedDocument]:
    """剔掉噪声段落（封面 / 目录 / 免责声明 / 广告）。

    每份资料一次 LLM 调用，所以并行跑 —— 串行的话 3 份资料要白等 3 倍时间。
    单份失败不会中断整体：``prune_document`` 内部已经把异常兜成「保留全文」。
    """
    if not documents:
        return documents
    if len(documents) == 1:
        return [relevance.prune_document(documents[0])]
    with ThreadPoolExecutor(max_workers=min(4, len(documents))) as pool:
        return list(pool.map(relevance.prune_document, documents))


def extract_profile(
    agent_name: str,
    documents: list[ExtractedDocument],
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """LLM extraction + normalization. Raises ``LlmError`` on unusable output."""
    if not documents:
        raise LlmError("没有可用于提炼的资料")
    # 第二层相关性过滤：段落级的噪声剔除，在拼 prompt 之前做（第一层在入库时）。
    raw = extract_json(build_messages(agent_name, prune_documents(documents), history))
    return normalize(raw)
