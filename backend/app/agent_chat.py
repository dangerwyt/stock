"""Multi-teacher AI consultation: each persona answers from its own playbook,
then a moderator merges the answers into one conclusion.

方向与 ``agent_profile`` 相反：那边是「资料 → 画像」，这边是「画像 → 观点」。
两边共用同一套原则 —— prompt 里把边界写死，模型输出仍不逐字信任。

纯函数模块：只负责渲染消息，不碰网络、不查库（画像由调用方查好传进来）。
"""
from __future__ import annotations

from typing import Any

# 200 字左右的中文观点 ≈ 300~400 token，留一倍余量。
TEACHER_MAX_TOKENS = 700
# 汇总 250 字 ≈ 400 token。
SUMMARY_MAX_TOKENS = 800
# 通用研究是「一次成型」的单条回答，没有老师发言可依据，篇幅给它放宽到 400 字级。
GENERAL_MAX_TOKENS = 1000

TEACHER_TEMPERATURE = 0.7
SUMMARY_TEMPERATURE = 0.3
# 通用研究没有画像做风格锚点，温度放低一点，避免它靠"脑补"补足细节。
GENERAL_TEMPERATURE = 0.4

# 领域边界。当前是一层「软约束」（写在 system prompt 里）——
# 真正拦得住越界提问的是入口分类（T1），这里只是第一道防线。
_DOMAIN_RULE = (
    "只讨论中国 A 股、股票、财经与投资相关的话题。"
    "若用户的问题与这些完全无关，只回一句「这不在我的研究范围内」，不要展开、不要转换话题。"
)

# 汇总环节**不套** _DOMAIN_RULE：送进来的已经是老师们的投资判断，主持人只负责归纳。
# 之前沿用域规则时踩过一次 —— 模型把「若问题无关就回『这不在我的研究范围内』」当成了
# 拒绝汇总的借口，整段汇总变成一句拒绝语。
_SUMMARY_RULE = (
    "这是一次股票投研会诊，你收到的已经是老师们的投资判断：你只做归纳，"
    "不要重新判定话题是否在研究范围内、不要拒绝汇总、也不要引入与股市无关的内容。"
)

# 带了【研究标的】快照时必须加的约束。实测：只给股票名的情况下，模型会凭训练记忆
# 编出「均线空头排列、连续亏损」，而当天它实际涨了 11.9% —— 编造不仅无用，还会
# 反过来把老师的画像纪律带偏，所以这条是硬要求。
_SNAPSHOT_RULE = (
    "若本次带了【研究标的】快照，那是系统提供的**真实数据**，必须以它为准："
    "不要编造该标的的历史走势、财务数据、公告或市场传闻；"
    "快照里没有的信息就直接说「快照未提供」，不要凭印象猜；"
    "若你的印象与快照冲突（例如快照显示当日大涨，而你认为它趋势走弱），以快照为准并说明理由。"
)


def persona_brief(persona: dict[str, Any]) -> str:
    """把一位老师的画像渲染成 prompt 里的短块。缺失字段直接跳过。"""
    lines = [f"角色：{persona.get('name') or '未命名'}"]
    for label, key in (
        ("风格", "style"),
        ("定位", "subtitle"),
        ("持股周期", "horizon"),
        ("决策依据", "decision"),
        ("选股条件", "select"),
        ("风险纪律", "risk"),
    ):
        value = str(persona.get(key) or "").strip()
        if value:
            lines.append(f"{label}：{value}")

    weights = persona.get("factorWeights") or []
    parts: list[str] = []
    if isinstance(weights, list):
        for entry in weights[:5]:
            if not isinstance(entry, dict):
                continue
            factor = str(entry.get("factor") or "").strip()
            try:
                weight = float(entry.get("weight"))
            except (TypeError, ValueError):
                continue
            if factor:
                parts.append(f"{factor} {round(weight * 100)}%")
    if parts:
        lines.append("因子权重：" + "、".join(parts))
    return "\n".join(lines)


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive(value: Any) -> float | None:
    """数据源用 0 表示「无有效值」（例如 peTtm=0），所以只认正数。"""
    number = _num(value)
    return number if number is not None and number > 0 else None


def _gap_from(base: float | None, target: float | None) -> str:
    """距某价位的百分比，例如「+7.11%」。"""
    if not base or target is None:
        return ""
    return f"{(target - base) / base * 100:+.2f}%"


def _stock_block(stock: Any) -> str:
    """把前端选中的标的渲染成**结构化真实快照**。

    为什么不能只给名字 —— 实测过：只传「安居宝 300155」时，模型会凭训练记忆编出
    「均线空头排列、连续多年净利润下滑」这类结论，而当天它实际涨了 11.9%、9/12 位老师看好，
    方向完全相反。所以这里把快照里能用的字段都摊开给模型，并在 prompt 里禁止它编造。

    **刻意不传 ``amount``（成交额）**：TOP50 快照里它的单位与
    ``MarketCenterPage.vue`` 那份数据口径不一致（原型还有 ``amountUnit`` 区分元/千元），
    传错数字比不传更糟。判断量价强弱用无歧义的换手率 / 量比 / 振幅就够了。
    """
    if not isinstance(stock, dict):
        return ""
    name = str(stock.get("name") or "").strip()
    code = str(stock.get("code") or "").strip()
    if not name and not code:
        return ""

    head = f"{name} {code}".strip()
    ts_code = str(stock.get("tsCode") or "").strip()
    if ts_code and ts_code != code:
        head += f"（{ts_code}）"
    rank = _positive(stock.get("rank"))
    if rank:
        head += f"（持仓池 TOP50 第 {int(rank)} 位）"

    lines = [
        f"【研究标的】{head}",
        "系统已提供该标的的当日真实快照，你的判断必须基于它，不要凭记忆编造。",
    ]

    industry = str(stock.get("industry") or "").strip()
    if industry and industry != "行业待映射":
        lines.append(f"所属行业：{industry}")

    # —— 当日行情 ——
    close = _num(stock.get("close"))
    if close is None:
        close = _num(stock.get("price"))
    quote: list[str] = []
    if close is not None:
        quote.append(f"最新价 {close:.2f}")
    pct = _num(stock.get("pct"))
    if pct is not None:
        quote.append(f"当日{'涨幅' if pct >= 0 else '跌幅'} {abs(pct):.2f}%")
    for label, key in (("今开", "open"), ("最高", "high"), ("最低", "low"), ("前收", "preClose")):
        value = _num(stock.get(key))
        if value is not None:
            quote.append(f"{label} {value:.2f}")
    for label, key in (("振幅", "amplitude"), ("换手率", "turnoverRate")):
        value = _num(stock.get(key))
        if value is not None:
            quote.append(f"{label} {value:.2f}%")
    volume_ratio = _num(stock.get("volumeRatio"))
    if volume_ratio is not None:
        quote.append(f"量比 {volume_ratio:.2f}")
    if quote:
        lines.append("当日行情：" + "，".join(quote))

    # —— 估值 ——
    pe = _positive(stock.get("peTtm"))
    pb = _positive(stock.get("pb"))
    if pe or pb:
        valuation = [f"PE(TTM) {pe:.1f}" if pe else "PE(TTM) 无有效值"]
        if pb:
            valuation.append(f"PB {pb:.2f}")
        lines.append("估值：" + "，".join(valuation))

    # —— 策略快照 ——
    strategy: list[str] = []
    score = _num(stock.get("score"))
    if score is not None:
        strategy.append(f"综合评分 {score:.0f}/100")
    votes = _num(stock.get("agentVotes"))
    if votes is not None:
        # 分母是**参与打分的画像数**，不是写死的 12。内置 12 位 mock 人设已从产品
        # 去掉，写死 12 会让模型把「1/12 位老师支持」当成弱共识（实际是 1/1 强共识）。
        # 拿不到分母时只报绝对票数 —— 绝不编一个分母出来。
        scores = stock.get("agentScores")
        total = len(scores) if isinstance(scores, dict) and scores else 0
        strategy.append(
            f"共识 {votes:.0f}/{total} 个画像支持" if total else f"共识 {votes:.0f} 个画像支持"
        )
    for label, key in (("状态", "status"), ("风险等级", "risk"), ("趋势", "trend")):
        value = str(stock.get(key) or "").strip()
        if value:
            strategy.append(f"{label} {value}")
    if strategy:
        lines.append("策略快照：" + "｜".join(strategy))

    # —— 关键价位 ——
    trigger = _positive(stock.get("triggerPrice"))
    invalid = _positive(stock.get("invalidPrice"))
    if trigger or invalid:
        price_bits: list[str] = []
        if trigger:
            gap = _gap_from(close, trigger)
            price_bits.append(f"突破触发 {trigger:.2f}" + (f"（距今 {gap}）" if gap else ""))
        if invalid:
            gap = _gap_from(close, invalid)
            price_bits.append(f"失效线 {invalid:.2f}" + (f"（距今 {gap}）" if gap else ""))
        lines.append("关键价位：" + "｜".join(price_bits))

    reason = str(stock.get("reason") or "").strip()
    if reason:
        lines.append(f"入选理由：{reason}")

    # —— 因子拆解与老师投票（selectionEvidence 里最值钱的部分）——
    evidence = stock.get("selectionEvidence")
    if isinstance(evidence, dict):
        breakdown = evidence.get("factorBreakdown") or []
        pieces: list[str] = []
        for entry in breakdown[:4]:
            if not isinstance(entry, dict):
                continue
            label = str(entry.get("agent") or "").strip()
            if not label:
                continue
            style = str(entry.get("style") or "").strip()
            if style:
                label += f"({style})"
            weight = _num(entry.get("weight"))
            if weight is not None:
                label += f" 权重{weight:.0f}"
            entry_score = _num(entry.get("score"))
            if entry_score is not None:
                label += f" 得分{entry_score:.1f}"
            pieces.append(label)
        if pieces:
            lines.append("因子拆解：" + "｜".join(pieces))

        support = evidence.get("supportingAgents") or []
        names: list[str] = []
        for entry in support[:5]:
            if not isinstance(entry, dict):
                continue
            agent = str(entry.get("agent") or "").strip()
            if not agent:
                continue
            entry_score = _num(entry.get("score"))
            names.append(f"{agent} {entry_score:.1f}" if entry_score is not None else agent)
        if names:
            more = f" 等共 {len(support)} 位" if len(support) > len(names) else ""
            lines.append("支持该标的的老师：" + "、".join(names) + more)

        oppose = evidence.get("opposingAgents") or []
        objections: list[str] = []
        for entry in oppose[:3]:
            if not isinstance(entry, dict):
                continue
            agent = str(entry.get("agent") or "").strip()
            if not agent:
                continue
            entry_score = _num(entry.get("score"))
            concern = str(entry.get("concern") or "").strip()
            piece = f"{agent} {entry_score:.1f}" if entry_score is not None else agent
            if concern:
                piece += f"（{concern[:46]}）"
            objections.append(piece)
        if objections:
            lines.append("持反对意见的老师：" + "；".join(objections))

        meta: list[str] = []
        cutoff = str(evidence.get("dataCutoff") or "").strip()
        if cutoff:
            meta.append(f"数据截止 {cutoff[:10]}")
        source = str(evidence.get("marketDataSource") or "").strip()
        if source:
            meta.append(f"数据源 {source}")
        if meta:
            lines.append("｜".join(meta))

    return "\n" + "\n".join(lines)


def _news_block(news: Any) -> str:
    """把实时新闻（NewsAPI）渲染成只读上下文块。

    无新闻（未配置 key 或拉取失败）时返回空串，prompt 里不出现新闻段 ——
    按「必须实时」策略，绝不注入假新闻。
    """
    if not isinstance(news, list):
        return ""
    items = [n for n in news if isinstance(n, dict) and str(n.get("title") or "").strip()]
    if not items:
        return ""
    lines = ["【相关财经新闻（实时 · NewsAPI）】"]
    for n in items[:6]:
        title = str(n.get("title") or "").strip()
        source = str(n.get("source") or "").strip()
        line = f"- {title}"
        if source:
            line += f"（{source}）"
        lines.append(line)
    return "\n" + "\n".join(lines)


def _numbered(items: list[str]) -> str:
    """把要求列表渲染成 ``1. … 2. …``。

    手写序号在"按场景插入 / 删除一条"时几乎必然出错（漏改一处就是两个「2.」），
    这里统一生成。
    """
    return "\n".join(f"{i}. {text}" for i, text in enumerate(items, start=1))


def build_teacher_messages(
    persona: dict[str, Any],
    question: str,
    stock: Any = None,
    news: Any = None,
    solo: bool = False,
) -> list[dict[str, str]]:
    """一位老师的会诊发言 prompt。

    ``solo=True``：这位老师是**本次唯一**的回答者（通用研究会话里用户临时选中的角色）。
    此时不能再说"正在参加多老师联合会诊" —— 实测那会让模型自己脑补出
    「其他老师也这么看」，而根本不存在其他老师。
    """
    name = persona.get("name") or "一位投研老师"
    if solo:
        scene = "正在单独回答用户的研究问题（本次只有你一位，没有其他老师，也没有人可商量）"
        limit = "400 字以内"
    else:
        scene = "正在参加多老师联合会诊，需要**独立**给出你自己的判断"
        limit = "250 字以内"

    items = [
        _DOMAIN_RULE,
        "**用第一人称说话**（「我」「我看」「我认为」），像在跟人当面聊，"
        "禁止出现「该老师认为」「××的策略是」这类第三人称旁白。",
    ]
    if solo:
        items.append(
            "**本次只有你一位**，禁止出现「其他老师」「多数老师」「共识 / 分歧」"
            "这类暗示存在其他参与者的说法。"
        )
    items += [
        f"只输出你的观点本身，{limit}；不要复述问题、不要客套开场。",
        "必须体现画像里的风格与纪律 —— "
        + ("把你自己那套方法用足，不要给谁都适用的通用答案。"
           if solo else "不同老师对同一问题要给出不同侧重，不要给通用答案。"),
        "尽量给可执行的条件（数字、信号、门槛、触发线），不要空泛表态。",
        "不要写免责声明、不要提「以上内容仅供参考」这类套话。",
        "不要使用 markdown 标记（# 标题、* 或 - 列表符号、``` 代码块），"
        "直接输出纯文本，用中文标点和「1. 2. 3.」分点。",
        _SNAPSHOT_RULE,
    ]

    system = (
        f"你是「{name}」，一名中国 A 股投研老师，{scene}。\n\n"
        "你的方法论画像：\n"
        f"{persona_brief(persona)}\n\n"
        "回答要求：\n"
        f"{_numbered(items)}"
    )
    user = f"问题：{question.strip()}{_stock_block(stock)}{_news_block(news)}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_summary_messages(
    question: str,
    answers: list[dict[str, Any]],
    stock: Any = None,
    news: Any = None,
) -> list[dict[str, str]]:
    """主持人汇总 prompt。``answers`` 是 ``[{name, answer, error}]``。

    参与者常常只有一位（会话默认单人），这时**不能**套用「多位老师」的话术 ——
    实测单人会话下，模型会顺着 system prompt 编出「多数老师」「其他老师也偏谨慎」
    这类并不存在的观点。所以按实际人数切换措辞。
    """
    blocks: list[str] = []
    valid = 0
    for item in answers:
        name = item.get("name") or "未知老师"
        answer = str(item.get("answer") or "").strip()
        if answer:
            valid += 1
            blocks.append(f"【{name}】\n{answer}")
        else:
            blocks.append(f"【{name}】\n（本次未给出有效回答）")

    if valid <= 1:
        system = (
            "你是投研 AI 助手。你会收到**一位**老师对某个问题的判断，"
            "需要把它整理成一段结论。\n\n"
            "要求：\n"
            "1. 只输出结论本身，300 字以内；不要逐句复述原文。\n"
            "2. **本次只有这一位老师**，禁止出现「其他老师」「多数老师」「共识 / 分歧」这类说法。\n"
            f"3. {_SUMMARY_RULE}\n"
            "4. 结尾用一句话说明这是 AI 整理、不构成投资建议。\n"
            "5. 不要使用 markdown 标记（# 标题、* 或 - 列表符号），"
            "直接输出纯文本，用中文标点和「1. 2. 3.」分点。\n"
            f"6. {_SNAPSHOT_RULE}"
        )
    else:
        system = (
            f"你是多老师 AI 会诊的主持人。你会收到 {valid} 位投研老师对同一问题的独立判断，"
            "需要把它们汇总成一段结论。\n\n"
            "要求：\n"
            "1. 先给共识，再**明确指出分歧**（不要把分歧抹平、不要假共识）。\n"
            "2. 只输出结论本身，300 字以内；不要逐位复述，不要客套开场。\n"
            f"3. {_SUMMARY_RULE}\n"
            "4. 结尾用一句话说明这是 AI 汇总、不构成投资建议。\n"
            "5. 不要使用 markdown 标记（# 标题、* 或 - 列表符号），"
            "直接输出纯文本，用中文标点和「1. 2. 3.」分点。\n"
            f"6. {_SNAPSHOT_RULE}"
        )
    user = (
        f"问题：{question.strip()}{_stock_block(stock)}{_news_block(news)}\n\n"
        "老师的判断：\n\n" + "\n\n".join(blocks)
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# 通用研究会话专用的额外约束。这个会话**不绑定任何角色**，所以必须挡住模型
# 「顺手扮演一位老师」的倾向 —— 实测在多老师 prompt 语境下，模型很容易自己
# 编出「某位趋势派老师认为…」，那等于凭空造了一个不存在的角色，还会被用户
# 误以为是榜单里真实存在的画像。
_GENERAL_RULE = (
    "本次是「通用研究」会话，**不属于任何一位老师**：你以投研 AI 助手本人的身份"
    "直接给出分析，不要扮演任何角色、不要自称某位老师、"
    "不要出现「某位老师认为」「多数老师」「老师的共识」这类把观点归给具体人设的说法。"
    "如果【研究标的】快照里列出了画像名称与票数，那只是系统给出的**榜单证据**："
    "优先用聚合说法引用（例如「榜单显示 1 个画像支持」「画像权重集中在趋势与产业」），"
    "**默认不要点出具体画像的名字** —— 只有在用户明确问「是哪个角色 / 哪位老师」时才回名字。"
)


def build_general_messages(
    question: str,
    stock: Any = None,
    news: Any = None,
) -> list[dict[str, str]]:
    """「通用研究」会话的回答 prompt。

    与 ``build_teacher_messages`` 的关键差别：**没有 persona**，因此也不同走
    "独立发言 + 主持人汇总" 两段式 —— 一次调用直接产出最终回答。这样回答里
    天然不会有"老师"这个概念，也就不会污染用户对榜单的认知。
    """
    system = (
        "你是一名中国 A 股投研 AI 助手，正在回答用户的研究问题。\n\n"
        "回答要求：\n"
        f"1. {_GENERAL_RULE}\n"
        f"2. {_DOMAIN_RULE}\n"
        "3. 直接给结论和分析，400 字以内；不要复述问题、不要客套开场。\n"
        "4. 尽量给可执行的条件（数字、信号、门槛、触发线），不要空泛表态。\n"
        "5. 结尾用一句话说明这是 AI 整理、不构成投资建议。\n"
        "6. 不要使用 markdown 标记（# 标题、* 或 - 列表符号、``` 代码块），"
        "直接输出纯文本，用中文标点和「1. 2. 3.」分点。\n"
        f"7. {_SNAPSHOT_RULE}"
    )
    user = f"问题：{question.strip()}{_stock_block(stock)}{_news_block(news)}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
