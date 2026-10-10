"""Loads the original 智策研究 (reference-react) API responses.

These JSON files were captured 1:1 from the running reference app so the Vue
port renders byte-identical business data without re-implementing the whole
Cloudflare Worker / factor engine.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).parent / "fixtures"


@lru_cache(maxsize=None)
def load(name: str) -> Any:
    """Return a parsed fixture by file stem (e.g. "top50")."""
    path = FIXTURE_DIR / f"{name}.json"
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def _top50() -> dict:
    return load("top50")


def stock_directory() -> list[dict]:
    """Flat search directory built from TOP50 names + market quotes."""
    seen: dict[str, dict] = {}
    snapshot = _top50()
    for cycle in (snapshot.get("cycles") or {}).values():
        for item in cycle.get("ranking") or []:
            code = str(item.get("code") or "")
            if code and code not in seen:
                seen[code] = {
                    "code": code,
                    "tsCode": item.get("tsCode") or f"{code}.SZ",
                    "name": item.get("name") or code,
                    "industry": item.get("industry") or "—",
                    "market": "TOP50",
                    "listDate": item.get("listDate"),
                }
    quotes = load("market").get("quotes") or []
    for item in quotes:
        code = str(item.get("code") or "")
        if code and code not in seen:
            seen[code] = {
                "code": code,
                "tsCode": item.get("tsCode") or f"{code}.SZ",
                "name": item.get("name") or code,
                "industry": item.get("industry") or item.get("sector") or "—",
                "market": "行情",
                "listDate": item.get("listDate"),
            }
    return list(seen.values())


def search_stocks(query: str) -> list[dict]:
    query = (query or "").strip().lower()
    items = stock_directory()
    if not query:
        return items[:20]
    return [
        item
        for item in items
        if query in item["code"].lower() or query in str(item["name"]).lower()
    ][:20]
