"""实时资讯聚合：晴红50+（优先）→ NewsAPI（备选）→ fixtures 回落。

对齐 reference-react ``worker/index.js`` 的 ``buildNewsSnapshot`` / ``fetchQinghongFinance``
/ ``fetchNewsApi`` / ``inferNewsImpact`` / ``scoreNewsArticle`` 的字段契约——
前端 ``NewsPage.vue`` 按这些字段渲染（``tier`` 分「主要/普通/观察」三栏、
``classificationReason`` 驱动 ``describeNewsClassification``、``newsTierLabel`` 吃 ``tier``）。

策略（用户决策）：**必须实时，不注入假新闻**。任一实时源配置且返回可用数据即用；
全部不可用才回落 ``fixtures/news.json`` 静态快照，并把 ``meta.sourceMode`` 标成
``fixtures``、``delayed=True``，让前端明确显示「非实时 / 待配置API」，不冒充真实源。
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta
from typing import Any

import httpx
from zoneinfo import ZoneInfo

from app.config import settings
from app import fixtures

logger = logging.getLogger(__name__)

SHANGHAI = ZoneInfo("Asia/Shanghai")

# 晴红 source.id → 展示名（来自 reference-react fetchQinghongFinance 的 sourceNames）。
_SOURCE_NAMES = {
    "mktnews-flash": "MKTNews",
    "wallstreetcn-quick": "华尔街见闻",
    "wallstreetcn-news": "华尔街见闻",
    "wallstreetcn-hot": "华尔街见闻",
    "cls-telegraph": "财联社",
    "cls-depth": "财联社",
    "cls-hot": "财联社",
    "xueqiu-hotstock": "雪球",
    "xueqiu-live": "雪球",
    "gelonghui": "格隆汇",
    "stcn": "证券时报",
    "egsea": "证券时报",
    "cninfo-latest": "巨潮资讯",
    "cninfo-sz": "巨潮资讯",
    "cninfo-sh": "巨潮资讯",
    "cninfo-preview": "巨潮资讯",
    "cninfo-buyback": "巨潮资讯",
    "cninfo-reduce": "巨潮资讯",
    "bloomberg-markets": "Bloomberg",
    "bloomberg-politics": "Bloomberg",
    "bloomberg-technology": "Bloomberg",
    "bloomberg-economics": "Bloomberg",
    "bloomberg-wealth": "Bloomberg",
    "jqka-flash": "同花顺",
    "sohu": "搜狐财经",
    "fastbull-express": "法布财经",
    "fastbull-news": "法布财经",
    "jin10": "金十数据",
}

_CACHE_TTL = 300  # 秒；与前端 useSnapshot refreshMs=300000 对齐
_cache: dict[str, Any] = {"data": None, "ts": 0.0}


# --------------------------------------------------------------------------- #
# 时间 / 文本工具
# --------------------------------------------------------------------------- #
def _now_shanghai() -> datetime:
    return datetime.now(SHANGHAI)


def _normalize_ts(value: Any) -> datetime | None:
    """把晴红 / NewsAPI / Tushare major_news 的各种时间格式归一成上海时区 datetime。"""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=SHANGHAI)
    s = str(value).strip()
    if re.fullmatch(r"\d{8}", s):  # YYYYMMDD
        try:
            return datetime(int(s[:4]), int(s[4:6]), int(s[6:8]), tzinfo=SHANGHAI)
        except ValueError:
            return None
    try:  # epoch 秒/毫秒
        n = float(s)
        if n < 10**12:
            n *= 1000
        return datetime.fromtimestamp(n / 1000, tz=SHANGHAI)
    except (ValueError, OverflowError, OSError):
        pass
    try:  # ISO / "YYYY-MM-DD HH:MM:SS"（新闻多用后者，无时区按上海处理）
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=SHANGHAI)
    except ValueError:
        return None


def _fmt_time(dt: datetime | None) -> str:
    """统一按北京时间显示：当天 HH:MM，否则 MM-DD。"""
    if not dt:
        return "--:--"
    now = _now_shanghai()
    dt = dt.astimezone(SHANGHAI)
    if dt.date() == now.date():
        return dt.strftime("%H:%M")
    return dt.strftime("%m-%d")


def _build_text(article: dict) -> str:
    return f"{(article.get('title') or '')} {(article.get('description') or article.get('summary') or article.get('snippet') or '')}".lower()


def _is_entertainment(article: dict) -> bool:
    return bool(
        re.search(
            r"韩庚|明星|综艺|影视|八卦|恋情|酒量|演唱会|网红|娱乐圈|电视剧|电影票房|celebrity|entertainment",
            _build_text(article),
        )
    )


# --------------------------------------------------------------------------- #
# 影响 / 分类 / 打分（移植 reference-react inferNewsImpact + scoreNewsArticle）
# --------------------------------------------------------------------------- #
def _infer_impact(article: dict) -> dict:
    text = _build_text(article)
    title = (article.get("title") or "").lower()
    source_id = str(article.get("sourceId") or "").lower()

    global_m = bool(
        re.search(
            r"federal reserve|wall street|nasdaq|nyse|s&p\s?500|dow jones|nvidia|apple|tesla|"
            r"microsoft|amazon|alphabet|fda|u\.s\. stocks?|us stocks?|treasury yields?|fed\b|"
            r"美联储|华尔街|纳斯达克|纳指|标普|道琼斯|英伟达|苹果|特斯拉|微软|亚马逊|谷歌|"
            r"美国fda|美国食品药品监督管理局|美债|美股|纽交所",
            text,
        )
    ) or source_id.startswith("bloomberg")
    hk = (not global_m) and (
        bool(re.search(r"hong kong|hang seng|港股|恒生|港交所", text))
        or bool(re.search(r"^(hkex|aastocks)", source_id))
    )
    domestic = bool(re.search(r"^(cninfo|sseinfo|szse|sse|cls|jqka|stcn|egsea|xueqiu)", source_id))

    market = "美股/全球" if global_m else ("港股" if hk else "A股/中国")
    reason = (
        "explicit_global_marker"
        if global_m
        else "explicit_hong_kong_marker"
        if hk
        else "domestic_source"
        if domestic
        else "default_a_share"
    )
    negative = re.search(
        r"fall|drop|risk|sanction|tariff|war|crisis|slump|higher yields|下跌|回落|风险|制裁|关税|战争|危机|暴跌|承压|走弱",
        text,
    )
    positive = re.search(
        r"rise|growth|stimulus|cut rates|record|rally|support|上涨|增长|刺激|降息|新高|反弹|支持|利好|走强",
        text,
    )
    ntype = (
        "宏观"
        if re.search(r"fed|rate|inflation|gdp|tariff|oil|央行|利率|通胀|关税|原油|汇率|mlf|逆回购|资金面", title)
        else "公司"
        if re.search(r"earnings|company|profit|公告|公司|业绩|回购|减持|股东|中报|季报|年报", title)
        else "市场"
    )
    tone = "negative" if negative else ("positive" if positive else "neutral")
    impact = "高" if (global_m or re.search(r"tariff|sanction|rate", text)) else "中"
    market_impact = (
        [
            "风险偏好",
            "AI算力/半导体" if re.search(r"nvidia|semiconductor|英伟达|芯片|半导体", text) else "外盘映射",
            "能源成本" if re.search(r"oil|原油|布伦特", text) else "汇率与北向资金",
        ]
        if global_m
        else ["行业情绪", "资金风格"]
    )
    return {
        "market": market,
        "classificationReason": reason,
        "type": ntype,
        "tone": tone,
        "impact": impact,
        "marketImpact": market_impact,
    }


def _source_trust(article: dict) -> int:
    """源可信度：兼容晴红的 source 代码（如 cls-telegraph）与中文源名（如 同花顺）。"""
    src = article.get("source")
    name = src.get("name") if isinstance(src, dict) else (src or "")
    s = f"{article.get('sourceId') or ''} {name}".lower()
    if re.search(
        r"新华|证券时报|财联社|巨潮|上证报|中国证券报|经济日报|新华社|证监会|央视|"
        r"cninfo|sseinfo|szse|hkex|cls|stcn|bloomberg|reuters",
        s,
    ):
        return 25
    if re.search(r"新浪财经|网易财经|东方财富|第一财经|澎湃|证券日报|21世纪|每经|华尔街见闻|wallstreetcn", s):
        return 20
    if re.search(r"同花顺|雪球|金十|法布|格隆汇|搜狐|jqka|jin10|fastbull|xueqiu|sohu|gelonghui", s):
        return 18
    return 12


def _score(article: dict, impact: dict) -> dict:
    st = _source_trust(article)

    text = _build_text(article)
    if re.search(
        r"公告|披露|回购|减持|增持|财报|业绩|分红|停复牌|定增|并购|mlf|逆回购|降息|加息|流动性|"
        r"美联储|港交所|nasdaq|federal reserve|treasury|earnings|buyback|guidance",
        text,
    ):
        fr = 25
    elif re.search(
        r"股票|股市|a股|沪深|创业板|科创板|港股|恒生|美股|纳斯达克|标普|道琼斯|etf|基金|债券|原油|黄金|"
        r"半导体|芯片|ai|算力|行业|公司|market|stocks?|inflation|yield",
        text,
    ):
        fr = 18
    else:
        fr = 10

    published = _normalize_ts(article.get("publishedAt"))
    gen = _normalize_ts(article.get("_generatedAt"))
    if published and gen:
        age_h = max(0.0, (gen - published).total_seconds()) / 3600.0
        tl = 20 if age_h <= 2 else 16 if age_h <= 6 else 10 if age_h <= 24 else 5 if age_h <= 72 else 2
    else:
        tl = 6

    total = st + fr + tl  # 满分 70
    tier = "primary" if total >= 52 else "standard" if total >= 34 else "watch"
    return {"score": total, "tier": tier}


def _normalize(article: dict, idx: int, generated_iso: str) -> dict:
    article = {**article, "_generatedAt": generated_iso}
    impact = _infer_impact(article)
    sc = _score(article, impact)
    published = _normalize_ts(article.get("publishedAt"))
    src = article.get("source")
    source_name = src.get("name") if isinstance(src, dict) else (src or "")
    base = int(published.timestamp() * 1000) if published else int(time.time() * 1000)
    return {
        "id": article.get("id") or f"live-news-{base}-{idx}",
        "type": impact["type"],
        "market": impact["market"],
        "marketScope": {"market": impact["market"], "classificationReason": impact["classificationReason"]},
        "classificationReason": impact["classificationReason"],
        "stock": article.get("stock") or ("A股影响" if impact["market"] == "美股/全球" else "市场"),
        "code": article.get("code") or "",
        "source": source_name or (article.get("provider") or "资讯源"),
        "time": _fmt_time(published),
        "publishedAt": published.isoformat() if published else generated_iso,
        "title": article.get("title") or "",
        "summary": article.get("description") or article.get("summary") or article.get("snippet") or "等待AI生成A股影响分析。",
        "score": sc["score"],
        "tier": sc["tier"],
        "relatedStocks": article.get("relatedStocks") or [],
        "relatedIndustries": article.get("relatedIndustries") or [],
        "tone": impact["tone"],
        "impact": impact["impact"],
        "marketImpact": impact["marketImpact"],
        "relatedTop50Rank": article.get("relatedTop50Rank"),
        "url": article.get("url") or "",
        "provider": article.get("provider") or "资讯源",
        "sourceId": article.get("sourceId"),
        "timestampBasis": article.get("timestampBasis") or "article_published_at",
    }


# --------------------------------------------------------------------------- #
# 实时源拉取
# --------------------------------------------------------------------------- #
async def fetch_qinghong() -> list[dict]:
    """晴红50+ 实时财经（POST {base}/api/finance/entire + X-API-Key）。"""
    if not settings.qinghong_api_key:
        return []
    base = str(settings.qinghong_base_url or "http://124.223.180.129:3220").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{base}/api/finance/entire",
                headers={"accept": "application/json", "X-API-Key": settings.qinghong_api_key},
            )
        if resp.status_code >= 400:
            logger.warning("晴红 HTTP %s: %s", resp.status_code, resp.text[:200])
            return []
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("晴红调用失败：%s", exc)
        return []

    if not isinstance(payload, list):
        if isinstance(payload, dict) and payload.get("code") in ("SUBSCRIPTION_EXPIRED",):
            logger.warning("晴红订阅到期：%s", payload.get("message"))
        else:
            logger.warning("晴红返回非预期结构：%s", str(payload)[:200])
        return []

    articles: list[dict] = []
    for source in payload:
        if not isinstance(source, dict):
            continue
        sid = source.get("id")
        sname = _SOURCE_NAMES.get(sid, sid)
        updated = _normalize_ts(source.get("updatedTime"))
        for it in source.get("items") or []:
            if not isinstance(it, dict):
                continue
            title = it.get("title")
            url = it.get("url") or it.get("mobileUrl")
            if not title or not url:
                continue
            extra = it.get("extra") or {}
            # 时间字段分三种：item.pubDate(ISO) / item.extra.date(epoch ms) / 都没有
            # → 最后一种回落到 source.updatedTime（对齐 reference-react 的
            #   `toIsoTimestamp(articleTimestamp || source.updatedTime)`）。
            # 少了这个回落，无时间条目会被当成「现在」挤到列表最前，页面全显示 --:--。
            pub_raw = it.get("pubDate") or extra.get("date")
            published = _normalize_ts(pub_raw) or updated
            articles.append(
                {
                    "title": title,
                    "description": extra.get("hover") or extra.get("info") or "",
                    "url": url,
                    "publishedAt": published,
                    "source": {"name": sname},
                    "sourceId": sid,
                    "sourceStatus": source.get("status"),
                    "provider": "晴红50+",
                    "timestampBasis": "article_published_at" if pub_raw else "source_updated_at",
                }
            )
    return articles


async def fetch_newsapi() -> list[dict]:
    """NewsAPI 实时财经（复用 news_client.fetch_news）。"""
    from app import news_client

    items = await news_client.fetch_news(None)
    if not items:
        return []
    out: list[dict] = []
    for a in items:
        out.append(
            {
                "title": a.get("title"),
                "description": a.get("snippet") or "",
                "url": a.get("url"),
                "publishedAt": a.get("publishedAt"),
                "source": {"name": a.get("source") or "NewsAPI"},
                "sourceId": (a.get("source") or "newsapi").lower(),
                "provider": "NewsAPI",
                "timestampBasis": "article_published_at",
            }
        )
    return out


async def fetch_tushare_news() -> list[dict]:
    """Tushare ``major_news``（新浪财经）实时新闻，走现有 Tushare 中继（relay A）。

    对齐 reference-react 的 ``fetchBackupNews``：拉最近 2 天、只保留有 http(s) url
    且 pub_time 在窗口内的条目。**只读调用，不改动股票分析链路。**
    """
    from app import tushare_client

    if not settings.tushare_token:
        return []
    now = _now_shanghai()
    try:
        rows = await tushare_client._call(
            "major_news",
            {
                "start_date": (now - timedelta(days=2)).strftime("%Y%m%d 00:00:00"),
                "end_date": now.strftime("%Y%m%d %H:%M:%S"),
            },
            "title,pub_time,src,url",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tushare major_news 调用失败：%s", exc)
        return []

    cutoff = now - timedelta(days=2)
    out: list[dict] = []
    for r in rows:
        url = r.get("url") or ""
        title = r.get("title") or ""
        at = _normalize_ts(r.get("pub_time"))
        if not (re.match(r"^https?://", url) and title and at and at >= cutoff):
            continue
        out.append(
            {
                "title": title,
                "description": title,
                "url": url,
                "publishedAt": at,
                "source": {"name": r.get("src") or "新浪财经"},
                "sourceId": (r.get("src") or "sina").lower().replace(" ", ""),
                "provider": "Tushare major_news · 新浪财经",
                "timestampBasis": "article_published_at",
            }
        )
    return out


# --------------------------------------------------------------------------- #
# 聚合入口
# --------------------------------------------------------------------------- #
async def build_news_snapshot() -> dict:
    cached = _cache.get("data")
    ts = _cache.get("ts") or 0.0
    if cached is not None and (time.time() - ts) < _CACHE_TTL:
        return cached

    generated_at = _now_shanghai()
    generated_iso = generated_at.isoformat()

    raw: list[dict] = []
    providers: list[str] = []

    qh = await fetch_qinghong()
    if qh:
        raw += qh
        providers.append("晴红50+")
    if not raw:  # 晴红为空/未配置 → 试 NewsAPI
        na = await fetch_newsapi()
        if na:
            raw += na
            providers.append("NewsAPI")
    if not raw:  # 前两者都不可用 → Tushare major_news 兜底（走 relay A，实测可用）
        ts = await fetch_tushare_news()
        if ts:
            raw += ts
            providers.append("Tushare major_news · 新浪财经")

    if raw:
        items: list[dict] = []
        for i, a in enumerate(raw):
            if not (a.get("title") and a.get("url")):
                continue
            if _is_entertainment(a):
                continue
            items.append(_normalize(a, i, generated_iso))
        items.sort(key=lambda x: x.get("publishedAt") or "", reverse=True)
        items = items[:80]

        meta = {
            "snapshotId": f"NEWS-{generated_at.strftime('%Y%m%d%H%M%S')}",
            "generatedAt": generated_iso,
            "cachedAt": generated_iso,
            "refreshSeconds": _CACHE_TTL,
            "itemCount": len(items),
            "status": "ready",
            "sourceMode": "live",
            "providers": providers,
            "coverage": ["A股", "港股", "美股", "全球宏观"],
            "collection": {"label": f"实时资讯聚合（{' / '.join(providers)}）"},
            "delayed": False,
        }
        result = {"items": items, "meta": meta}
        _cache.update(data=result, ts=time.time())
        return result

    # 全部实时源不可用 → 回落 fixtures 静态快照（诚实标注非实时）
    logger.warning("实时资讯无可用数据（providers=%s），回落 fixtures 静态快照", providers or "none")
    fx = fixtures.load("news") if hasattr(fixtures, "load") else None
    fx = fx if isinstance(fx, dict) else {}
    fx_meta = dict(fx.get("meta") or {})
    fx_meta.update(
        {
            "sourceMode": "fixtures",
            "delayed": True,
            "collection": {"label": "实时源未返回数据 · 保留静态快照"},
        }
    )
    result = {"items": fx.get("items") or [], "meta": fx_meta}
    _cache.update(data=result, ts=time.time())
    return result
