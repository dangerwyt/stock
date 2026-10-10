"""LLM client for structured extraction (MiniMax-M3).

Two channels,同一个接口 ``chat()``，由 ``settings.llm_backend`` 切换:

* ``langchain``（默认）—— ``langchain.chat_models.init_chat_model`` 构造
  ``ChatOpenAI``（懒单例，见 ``_langchain_model``），打 MiniMax 的
  **OpenAI 兼容端点** ``{base_url}/chat/completions``。换厂商只改 ``model_provider``。
* ``minimax_v2`` —— 手写 httpx 打 MiniMax **原生** ``/text/chatcompletion_v2``，
  推理另存 ``reasoning_content``，``content`` 天生干净。

**思考（reasoning）已在请求层关掉**：两条通道都传 ``thinking={"type": "disabled"}``，
实测 content 直接就是答案（reasoning_tokens=0；同 prompt 从 10.5s 降到 ~1.3s）。
``strip_think`` 只作兜底 —— 万一网关哪天不认这个参数、把推理混回 content，
它会剥掉 ``<think>…</think>``（推理里常带花括号，会把 JSON 切片带偏）。

另外 ``parse_json_object`` 会剥 ```json 围栏，以及当日调用预算（demo 阶段的护栏）。
切通道只需环境变量 ``LLM_BACKEND=minimax_v2``。
"""
from __future__ import annotations

import json
import re
import threading
from datetime import date
from functools import lru_cache
from typing import Any

import httpx

from app.config import settings

_FENCE_RE = re.compile(r"```(?:json)?", re.IGNORECASE)
# <think>…</think> 兜底正则。正常路径下思考已被 thinking=disabled 关掉，用不到；
# 留着是防止网关不认参数时把推理内联进 content。
_THINK_RE = re.compile(r"<\s*think\b[^>]*>.*?<\s*/\s*think\s*>", re.IGNORECASE | re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<\s*think\b[^>]*>", re.IGNORECASE)

# 关思考的请求参数。MiniMax-M3 默认会思考，思考既慢又费 token，
# 而这里两个用途（提炼画像 / 矩阵评分）都是单轮结构化输出，不需要推理。
_NO_THINK = {"thinking": {"type": "disabled"}}


class LlmError(RuntimeError):
    """Unreachable provider, quota exhausted, or unusable response."""


class _DailyQuota:
    """In-process daily counter. Resets on date change or process restart."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._day = date.today()
        self._count = 0

    def consume(self) -> int:
        with self._lock:
            today = date.today()
            if today != self._day:
                self._day, self._count = today, 0
            if self._count >= settings.ai_daily_call_limit:
                raise LlmError(
                    f"今日 AI 调用已达上限（{settings.ai_daily_call_limit} 次），请明天再试"
                )
            self._count += 1
            return self._count

    @property
    def used(self) -> int:
        with self._lock:
            return self._count


quota = _DailyQuota()


def strip_json_fence(text: str) -> str:
    """Remove markdown code fences and any prose around the JSON body."""
    cleaned = _FENCE_RE.sub("", text or "").strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        return cleaned[start : end + 1]
    return cleaned


def strip_think(text: str) -> str:
    """兜底：去掉 ``<think>…</think>`` 推理块；没闭合的（被 max_tokens 截断）整段丢弃。

    正常情况用不上（请求里已 ``thinking=disabled``），只在网关不认该参数时兜住。
    """
    cleaned = _THINK_RE.sub("", text or "")
    unclosed = _THINK_OPEN_RE.search(cleaned)
    if unclosed:
        # 思考没写完就没有答案可用，截断处之后的内容一并丢弃。
        cleaned = cleaned[: unclosed.start()]
    return cleaned.strip()


def parse_json_object(text: str) -> dict[str, Any]:
    body = strip_json_fence(text)
    if not body:
        raise LlmError("模型返回内容为空")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        preview = body[:200].replace("\n", " ")
        raise LlmError(f"模型返回的不是合法 JSON：{exc.msg}（片段：{preview}）") from exc
    if not isinstance(data, dict):
        raise LlmError("模型返回的 JSON 顶层不是对象")
    return data


def _chat_minimax_v2(
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
) -> str:
    """MiniMax 原生端点：推理另存 ``reasoning_content``，``content`` 即答案。"""
    url = f"{settings.minimax_base_url.rstrip('/')}/text/chatcompletion_v2"
    payload = {
        "model": settings.minimax_model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        **_NO_THINK,
    }
    try:
        with httpx.Client(timeout=settings.llm_timeout_seconds) as client:
            resp = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {settings.minimax_api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise LlmError(f"模型调用超时（{settings.llm_timeout_seconds}s）") from exc
    except httpx.HTTPError as exc:
        raise LlmError(f"模型调用失败：{exc}") from exc

    if resp.status_code != 200:
        raise LlmError(f"模型返回 HTTP {resp.status_code}：{resp.text[:200]}")

    try:
        body = resp.json()
    except ValueError as exc:
        raise LlmError("模型返回的不是 JSON 响应") from exc

    base_resp = body.get("base_resp") or {}
    if base_resp.get("status_code") not in (None, 0):
        raise LlmError(f"模型错误：{base_resp.get('status_msg') or base_resp}")

    choices = body.get("choices") or []
    if not choices:
        raise LlmError("模型未返回任何候选结果")
    choice = choices[0]
    content = (choice.get("message") or {}).get("content") or ""
    if not content.strip():
        reason = choice.get("finish_reason")
        raise LlmError(
            f"模型返回空内容（finish_reason={reason}）；推理类模型需要更大的 max_tokens"
        )
    return strip_think(content)


@lru_cache(maxsize=1)
def _langchain_model():
    """懒单例：模型实例只构造一次。

    ``init_chat_model`` 是 LangChain 的统一构造入口，换厂商只改 ``model_provider``
    （``openai`` / ``deepseek`` / ``anthropic`` …），其余参数走 ``**kwargs`` 透传给
    底层类 —— MiniMax 需要的 ``extra_body={"thinking": ...}`` 也是这么带下去的。

    它**本身不带缓存**，所以外面套 ``lru_cache``；``temperature`` / ``max_tokens``
    这类「每次调用都可能不同」的参数不放在这里，由调用方 ``bind`` 覆盖。
    """
    from langchain.chat_models import init_chat_model

    return init_chat_model(
        settings.minimax_model,
        model_provider="openai",
        api_key=settings.minimax_api_key,
        base_url=settings.minimax_base_url,
        timeout=settings.llm_timeout_seconds,
        extra_body=_NO_THINK,
    )


def _chat_langchain(
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
) -> str:
    """LangChain → MiniMax 的 OpenAI 兼容端点（``{base_url}/chat/completions``）。"""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    role_map = {"system": SystemMessage, "user": HumanMessage, "assistant": AIMessage}
    lc_messages = [
        role_map.get(str(item.get("role") or "user"), HumanMessage)(str(item.get("content") or ""))
        for item in messages
    ]

    # 单例只管「谁家模型 / 哪个端点 / 关思考」，token 上限和温度每次调用现绑。
    model = _langchain_model().bind(max_tokens=max_tokens, temperature=temperature)
    try:
        reply = model.invoke(lc_messages)
    except Exception as exc:  # noqa: BLE001 - 统一收敛成 LlmError 交给调用方
        raise LlmError(f"模型调用失败（{type(exc).__name__}）：{exc}") from exc

    content = reply.content if isinstance(reply.content, str) else str(reply.content)
    return strip_think(content)


def chat(
    messages: list[dict[str, str]],
    *,
    max_tokens: int | None = None,
    temperature: float = 0.2,
) -> str:
    """One completion round-trip. Returns the answer text."""
    if not settings.minimax_api_key:
        raise LlmError("未配置 MINIMAX_API_KEY，请在项目根 .env 中填写")

    quota.consume()
    limit = max_tokens or settings.llm_max_tokens
    backend = (settings.llm_backend or "langchain").strip().lower()
    if backend == "minimax_v2":
        content = _chat_minimax_v2(messages, limit, temperature)
    else:
        content = _chat_langchain(messages, limit, temperature)

    if not content.strip():
        raise LlmError("模型返回空内容；推理类模型可能需要更大的 max_tokens")
    return content


def extract_json(
    messages: list[dict[str, str]],
    *,
    retries: int = 1,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """``chat`` + JSON parse, retrying once by default on unusable output."""
    last_error: Exception | None = None
    for _ in range(retries + 1):
        try:
            return parse_json_object(chat(messages, max_tokens=max_tokens))
        except LlmError as exc:
            last_error = exc
    raise LlmError(str(last_error) if last_error else "模型提炼失败")
