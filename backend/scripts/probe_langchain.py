"""验证 LLM 通道：langchain（默认）vs minimax_v2 原生端点。

对同一句 prompt 各打一次，用生产里的入口函数跑，检查：
  1. 能不能通（HTTP/异常）；
  2. 剥完 <think> 之后能不能被 parse_json_object 解析；
  3. 延迟对比。

用法：
    cd backend
    python -m scripts.probe_langchain
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.llm import (  # noqa: E402
    LlmError,
    _chat_langchain,
    _chat_minimax_v2,
    chat,
    parse_json_object,
)

SYSTEM = "你只输出 JSON，不要任何解释或 markdown 标记。"
USER = '只回复一个 JSON 对象：{"ok":true,"backend":"?"}'
MESSAGES = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}]


def run(label: str, fn) -> tuple[bool, str, float]:
    start = time.perf_counter()
    try:
        text = fn()
    except LlmError as exc:
        return False, f"LlmError: {exc}", time.perf_counter() - start
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}", time.perf_counter() - start

    cost = time.perf_counter() - start
    try:
        parsed = parse_json_object(text)
        note = f"可解析 {parsed}"
    except LlmError as exc:
        note = f"!! 解析失败 {exc}"
    print(f"[{label}] OK {cost:.2f}s | {note}")
    print(f"     raw = {text[:160]!r}")
    return True, text, cost


def main() -> None:
    print(f"backend  = {settings.llm_backend} | model = {settings.minimax_model}")
    print(f"base_url = {settings.minimax_base_url}")
    print(f"api_key  = {'已配置' if settings.minimax_api_key else '缺失'}\n")

    ok_lc, raw_lc, t_lc = run("langchain / OpenAI兼容端点", lambda: _chat_langchain(MESSAGES, 300, 0.2))
    ok_v2, raw_v2, t_v2 = run("httpx / MiniMax原生端点", lambda: _chat_minimax_v2(MESSAGES, 300, 0.2))
    ok_default, _, t_default = run(
        f"chat() 当前默认通道 ({settings.llm_backend})", lambda: chat(MESSAGES, max_tokens=300)
    )

    print("\n--- 结论 ---")
    print(f"langchain: {'通' if ok_lc else '失败'} {t_lc:.2f}s | minimax_v2: {'通' if ok_v2 else '失败'} {t_v2:.2f}s")
    print(
        "content 含 <think>："
        f"langchain={('<think' in (raw_lc or '').lower())} "
        f"原生={('<think' in (raw_v2 or '').lower())}"
        "   （两边都传了 thinking=disabled，期望都是 False）"
    )
    if ok_lc and ok_v2:
        delta = t_lc - t_v2
        print(f"兼容端点比原生端点慢 {delta:+.2f}s（独立进程里的 langchain 冷启动，与思考无关）")
    print(f"chat() 默认通道可用: {ok_default}")


if __name__ == "__main__":
    main()
