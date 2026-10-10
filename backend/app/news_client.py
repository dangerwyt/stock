"""NewsAPI 实时财经新闻客户端。

接入原 reference-react 的新闻来源链路（worker 里 NewsAPI 与晴红 50+ 二选一）。

策略（用户决策）：**必须实时，不注入假新闻**。
* 未配置 ``NEWSAPI_KEY`` → 返回 ``None``，调用方据此**跳过**新闻块（不造假数据，也不报错中断整场会诊）。
* 配置但调用失败 → 返回空列表并记日志（同样不中断会诊）。
* 调用成功 → 返回最近 7 天、与 query 相关的真实新闻条目。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_NEWS_API_URL = "https://newsapi.org/v2/everything"


async def fetch_news(
    query: str | None = None,
    *,
    max_items: int = 8,
    timeout: float = 15.0,
) -> list[dict] | None:
    """拉取与 query（通常是股票名/代码或问题）相关的财经新闻。

    返回 ``None`` 表示未配置 key（调用方跳过新闻块）；否则返回条目列表（可能为空）。
    """
    if not settings.newsapi_key:
        logger.info("NEWSAPI_KEY 未配置，跳过新闻源（不注入假新闻）。")
        return None

    q = (query or "").strip() or "A股 财经"
    params = {
        "q": q,
        "language": "zh",
        "sortBy": "publishedAt",
        "pageSize": str(max_items),
        "from": (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d"),
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                _NEWS_API_URL,
                params=params,
                headers={"X-Api-Key": settings.newsapi_key},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.warning("NewsAPI 调用失败，跳过新闻块：%s", exc)
        return []
    if data.get("status") != "ok":
        logger.warning("NewsAPI 返回异常：%s", data.get("message"))
        return []

    articles = data.get("articles") or []
    return [
        {
            "title": a.get("title") or "",
            "source": (a.get("source") or {}).get("name") or "",
            "url": a.get("url") or "",
            "publishedAt": a.get("publishedAt") or "",
            "snippet": (a.get("description") or "")[:160],
        }
        for a in articles[:max_items]
        if a.get("title")
    ]
