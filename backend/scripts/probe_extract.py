"""CLI probe for the document → profile pipeline.

Usage (from `backend/`)::

    python scripts/probe_extract.py <file> [agent name]

Prints parse stats, extraction timing, token usage and the normalized profile.
This is the gate for the whole feature: if this doesn't produce clean JSON,
nothing downstream matters.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.agent_profile import extract_profile  # noqa: E402
from app.config import settings  # noqa: E402
from app.documents import DocumentError, extract_text  # noqa: E402
from app.llm import LlmError  # noqa: E402

TEXT_FIELDS = ("style", "subtitle", "horizon", "decision", "select", "risk")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    parse_only = "--parse-only" in argv
    args = [arg for arg in argv[1:] if not arg.startswith("--")]
    if not args:
        print(__doc__)
        return 2

    path = Path(args[0])
    agent_name = args[1] if len(args) > 1 else "测试角色"

    print(
        json.dumps(
            {
                "model": settings.minimax_model,
                "backend": settings.llm_backend,
                "base_url": settings.minimax_base_url,
                "daily_limit": settings.ai_daily_call_limit,
                "key_configured": bool(settings.minimax_api_key),
            },
            ensure_ascii=False,
        )
    )

    started = time.time()
    try:
        document = extract_text(path.name, path.read_bytes())
    except DocumentError as exc:
        print(f"[解析失败] {exc}")
        return 1
    parse_seconds = time.time() - started
    print(
        f"[解析] kind={document.kind} pages={document.pages} chars={document.chars} "
        f"truncated={document.truncated} notes={document.notes} 耗时={parse_seconds:.2f}s"
    )

    if parse_only:
        print("[提取文本前 200 字]")
        print(document.text[:200].replace("\n", " "))
        print("[结论] PASS 解析正常")
        return 0

    started = time.time()
    try:
        profile = extract_profile(agent_name, [document])
    except LlmError as exc:
        print(f"[提炼失败] {exc}")
        return 1
    print(f"[提炼] 耗时={time.time() - started:.1f}s")

    print("[画像]")
    print(json.dumps(profile, ensure_ascii=False, indent=2))

    missing = [field for field in TEXT_FIELDS if not profile.get(field)]
    weights = profile.get("factorWeights") or []
    total = round(sum(item["weight"] for item in weights), 3)
    print(f"[校验] 空字段={missing or '无'} 因子数={len(weights)} 权重和={total}")
    ok = not missing and weights and abs(total - 1.0) < 0.02
    print("[结论]", "PASS 可进入下一步" if ok else "FAIL 画像不完整")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
