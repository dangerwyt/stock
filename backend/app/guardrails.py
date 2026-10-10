"""话题守卫：把与股票财经无关的提问挡在会诊之外。

**为什么需要它**：``agent_chat`` 的 system prompt 里已经写了域规则（软约束），但 prompt
约束终究是可以绕的 —— 换个说法、先聊别的再拐回来，都可能让模型开口。这里做的是**硬闸门**，
挂在 ``POST /api/ai/jobs`` 入口：非财经问题根本不进入会诊流程，也就不会消耗 N 个老师的调用。

**策略（成本从低到高）**：
1. 问题里出现高置信度的财经词 → 直接放行，不调模型（真实的投研提问几乎都会命中）；
2. 否则问一次模型（极短 prompt）。

**失败即放行**：守卫自己挂了（模型超时/网关报错）不应该让用户用不了产品，所以任何异常都
按「允许」处理并记日志 —— 这时还有 prompt 那层软约束兜底。
"""
from __future__ import annotations

import logging
import re

from app.llm import LlmError, extract_json

logger = logging.getLogger(__name__)

# 高置信度财经词。命中任意一个就直接放行，省掉一次模型调用。
# 注意别放单字（「股」会撞「屁股」），也别放过于通用的词（「投资」会撞「投资自己」）。
_FINANCE_HINTS = (
    "A股", "港股", "美股", "股票", "股价", "股市", "个股", "龙头", "大盘", "指数",
    "上证", "深证", "创业板", "科创板", "北交所", "沪深", "板块", "题材", "涨停",
    "跌停", "打板", "龙头股", "资金流", "北向", "主力", "筹码", "仓位", "持仓",
    "建仓", "加仓", "减仓", "止盈", "止损", "均线", "K线", "MACD", "量能",
    "成交量", "估值", "市盈率", "市值", "财报", "业绩", "营收", "净利", "毛利",
    "现金流", "分红", "回购", "增发", "并购", "重组", "退市", "基金", "ETF",
    "可转债", "债券", "期货", "期权", "汇率", "黄金", "原油", "加息", "降息",
    "通胀", "CPI", "PPI", "GDP", "央行", "牛市", "熊市", "回调", "反弹",
    "支撑位", "压力位", "券商", "研报", "龙虎榜", "打新", "IPO", "利好", "利空",
    "炒股", "行情", "涨跌", "盈亏", "复盘", "选股", "赔率", "趋势",
)

# 用正则做一次整体匹配，比逐个 `in` 快，也方便以后加词。
_HINT_RE = re.compile("|".join(re.escape(word) for word in _FINANCE_HINTS))

CLASSIFY_SYSTEM_PROMPT = """你要判断用户的问题是否属于「中国 A 股 / 股票 / 财经 / 投资」范畴。

属于：个股、指数、板块、行业、财报、估值、基金、ETF、债券、宏观财经、货币政策、交易策略、
仓位与风险、市场情绪、上市公司经营等。

不属于：闲聊、生活常识、天气、旅行、娱乐、编程、翻译、数学题、健康等与投资无关的话题。

只输出一个 JSON 对象，不要任何解释：
{"in_scope": true 或 false, "reason": "20 字以内的理由"}

拿不准时判为 true（宁可不拦，也不要误伤正常的投研提问）。"""

REFUSAL_MESSAGE = (
    "这不在我的研究范围内。我是股票投研助手，只回答中国 A 股、财经与投资相关的问题 —— "
    "换成投资相关的提问，我会认真回答。"
)


def looks_like_finance(question: str) -> bool:
    """粗筛：命中财经词就放行。宁可多放过，也不要误拦。"""
    return bool(_HINT_RE.search(question or ""))


def classify(question: str) -> tuple[bool, str]:
    """判定问题是否在范围内。返回 ``(in_scope, reason)``，异常时返回 ``(True, "")``。"""
    text = (question or "").strip()
    if not text:
        return True, ""
    if looks_like_finance(text):
        return True, "命中财经关键词"

    messages = [
        {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
        {"role": "user", "content": text},
    ]
    try:
        # 只要一个短 JSON，200 tokens 足够（思考已在 llm.py 里关掉）。
        data = extract_json(messages, max_tokens=200)
    except LlmError as exc:
        logger.warning("话题守卫调用失败，按放行处理：%s", exc)
        return True, ""

    in_scope = data.get("in_scope")
    if not isinstance(in_scope, bool):
        # 模型没按 schema 回答：保守放行，交给 prompt 那层。
        logger.warning("话题守卫返回了非预期结构：%s", data)
        return True, ""
    return in_scope, str(data.get("reason") or "")
