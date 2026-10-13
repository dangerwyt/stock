"""上传资料的相关性过滤：入库判定 + 提炼前段落筛选。

两层，各一次 LLM 调用（都是极短的 JSON 输出）：

1. :func:`judge_document` —— 整篇判定是否属于股票财经范畴。不相关的资料**仍然落盘**
   （用户需要知道「为什么没收」），但在 ``meta.json`` 里标 ``status: "rejected"``，
   且不计入 :func:`agent_docs.read_documents`，因此不会参与画像提炼。
2. :func:`prune_document` —— 提炼前把封面 / 目录 / 免责声明 / 广告 / 致谢等噪声段落剔掉。
   一次调用返回「要丢弃的段号」，而不是每段问一次模型（那会把 token 烧光）。

**失败即放行**：判定失败（模型超时 / 网关报错 / 返回怪结构）时按「相关」处理并记 warning ——
过滤是锦上添花，不能因为它挂了就让用户传不了资料，也不能让已有的好资料被误剔。
"""
from __future__ import annotations

import logging
import re
from dataclasses import replace

from app.documents import ExtractedDocument
from app.llm import LlmError, extract_json

logger = logging.getLogger(__name__)

# 交给模型判定的正文上限：取头 + 尾。研报动辄两万字，全塞进去既慢又贵，
# 而「这是什么资料」在开头就写得清楚，免责声明/广告则在结尾。
HEAD_CHARS = 3000
TAIL_CHARS = 1000

# 段落太少 / 太短就不值得跑一次筛选调用。
MIN_SECTIONS_FOR_PRUNE = 4
MIN_CHARS_FOR_PRUNE = 400

# 一次最多送多少段给模型判定（超过就取头尾，中间的段保持原样）。
MAX_SECTIONS_TO_JUDGE = 60

# 每段送给模型时截断的长度（只看开头就够判断是不是免责声明）。
SECTION_PREVIEW_CHARS = 400

# 筛选后至少要保留原文这个比例，否则认为模型删过头了，放弃筛选、回退原文。
MIN_KEEP_RATIO = 0.3


JUDGE_SYSTEM_PROMPT = """你是股票投研资料审核员。判断用户上传的文件是否属于
「中国 A 股 / 股票 / 财经 / 投资」研究范畴。

属于：上市公司研究、行业与产业链分析、财报解读、估值方法、交易策略与交易纪律、
宏观财经与货币政策、市场复盘、基金 / ETF / 债券、大宗商品与汇率、投资方法论等。

不属于：与投资无关的内容，例如生活常识、菜谱、旅游攻略、小说散文、编程教程、
产品说明书、法律合同、个人简历、与财经无关的学术论文、纯广告推销页等。

只输出一个 JSON 对象，不要任何解释：
{"relevant": true 或 false, "reason": "20 字以内的理由"}

拿不准时判为 true（宁可不拦，也不要误伤正常的研究资料）。"""


PRUNE_SYSTEM_PROMPT = """下面会把一份投研资料切分后的若干段落交给你（段号从 1 开始）。
请挑出**与股票投研无关、对提炼投资方法论没有帮助**的段落。

典型的噪声段落：封面页与版权页、目录、免责声明、风险提示套话、广告与推销、
联系方式、招聘信息、致谢、参考文献列表、无关的公司八卦。

**不要剔除**：行情数据、财务数据与表格、投资逻辑、行业分析、选股条件、交易纪律、
风险控制规则 —— 即使它们很短或很碎。

只输出一个 JSON 对象，不要任何解释：
{"drop": [要剔除的段号, ...]}

没有需要剔除的段落时返回 {"drop": []}。"""


def _sample(text: str) -> str:
    """头 + 尾取样，控制单次判定的小说输入量。"""
    body = (text or "").strip()
    if len(body) <= HEAD_CHARS + TAIL_CHARS:
        return body
    return f"{body[:HEAD_CHARS]}\n\n…（中间省略）…\n\n{body[-TAIL_CHARS:]}"


def judge_document(filename: str, text: str) -> tuple[bool, str]:
    """整篇判定是否与股票财经相关。返回 ``(relevant, reason)``。

    任何异常都返回 ``(True, "")``：判定失败不该挡住上传，此时由「资料是否有用」
    这个问题交给提炼环节去承受（提炼本来就会对噪声做段落级筛选）。
    """
    sample = _sample(text)
    if not sample:
        return True, ""

    messages = [
        {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
        {"role": "user", "content": f"文件名：{filename}\n\n正文：\n{sample}"},
    ]
    try:
        data = extract_json(messages, max_tokens=200)
    except LlmError as exc:
        logger.warning("资料相关性判定失败，按相关处理：%s", exc)
        return True, ""

    relevant = data.get("relevant")
    if not isinstance(relevant, bool):
        logger.warning("资料相关性判定返回了非预期结构：%s", data)
        return True, ""
    return relevant, str(data.get("reason") or "")


def split_sections(text: str) -> list[str]:
    """按空行切段。研报的封面 / 目录 / 免责声明通常各自成段。"""
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text or "")]
    return [block for block in blocks if block]


def _parse_drop(raw: object) -> set[int]:
    if not isinstance(raw, list):
        return set()
    out: set[int] = set()
    for entry in raw:
        try:
            value = int(str(entry).strip())
        except (TypeError, ValueError):
            continue
        if value > 0:
            out.add(value)
    return out


def prune_document(document: ExtractedDocument) -> ExtractedDocument:
    """剔掉噪声段落后返回新的文档对象；不值得筛或筛失败时原样返回。"""
    sections = split_sections(document.text)
    if len(sections) < MIN_SECTIONS_FOR_PRUNE or len(document.text) < MIN_CHARS_FOR_PRUNE:
        return document

    indexed = list(enumerate(sections, start=1))
    if len(indexed) > MAX_SECTIONS_TO_JUDGE:
        half = MAX_SECTIONS_TO_JUDGE // 2
        # 段号保持原值，只挑头尾送检（中间的段落一律保留）。
        indexed = indexed[:half] + indexed[-half:]

    listing = "\n\n".join(
        f"[{index}]\n{section[:SECTION_PREVIEW_CHARS]}" for index, section in indexed
    )
    messages = [
        {"role": "system", "content": PRUNE_SYSTEM_PROMPT},
        {"role": "user", "content": f"文件名：{document.filename}\n\n{listing}"},
    ]
    try:
        data = extract_json(messages, max_tokens=300)
    except LlmError as exc:
        logger.warning("段落筛选调用失败，保留全文：%s", exc)
        return document

    drop = _parse_drop(data.get("drop"))
    if not drop:
        return document

    kept = [section for index, section in enumerate(sections, start=1) if index not in drop]
    if not kept:
        logger.warning("%s 的段落筛选把全文都删了，回退原文", document.filename)
        return document

    body = "\n\n".join(kept)
    if len(body) < len(document.text) * MIN_KEEP_RATIO:
        logger.warning(
            "%s 段落筛选后仅剩 %d/%d 字符，超过删除阈值，回退原文",
            document.filename,
            len(body),
            len(document.text),
        )
        return document

    removed = len(sections) - len(kept)
    logger.info("%s 段落筛选：剔除 %d/%d 段", document.filename, removed, len(sections))
    return replace(
        document,
        text=body,
        chars=len(body),
        notes=[*document.notes, f"已剔除 {removed} 个无关段落"],
    )
