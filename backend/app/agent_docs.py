"""Per-agent document storage on the local filesystem.

Layout::

    <agent_docs_dir>/<agent_id>/
        meta.json          # document list + extraction state + profile + scores
        files/<doc_id><suffix>   # original upload, kept for re-parsing
        texts/<doc_id>.txt       # extracted text, so extraction never re-parses

All writes go through a temp file + ``replace`` for atomicity, and a module lock
guards the read-modify-write of ``meta.json``. Single uvicorn worker, so that is
sufficient; swapping in a DB later only means re-implementing this module.
"""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import agents, relevance
from app.config import settings
from app.documents import DocumentError, ExtractedDocument, extract_text

_LOCK = threading.Lock()

EXTRACTION_IDLE = {
    "status": "idle",
    "error": None,
    "startedAt": None,
    "finishedAt": None,
    "documentCount": 0,
    "historyCount": 0,
}

# 入库相关性判定不通过时写入 ``record["status"]`` 的值。
REJECTED_STATUS = "rejected"


_DEFAULT_ROOT = Path(__file__).resolve().parent / "data" / "agent_docs"


def _root() -> Path:
    # `.env.example` 里 ``AGENT_DOCS_DIR`` 留空（表示"用默认"），但空串会让 ``Path('')``
    # 解析成当前目录 —— 上传的资料会静默落到 CWD，重建即丢。这里显式兜住默认值。
    raw = (settings.agent_docs_dir or "").strip()
    return Path(raw) if raw else _DEFAULT_ROOT


def agent_dir(agent_id: str) -> Path:
    safe_id = "".join(ch for ch in (agent_id or "") if ch.isalnum() or ch in "-_")
    if not safe_id:
        raise DocumentError("非法的角色 ID")
    return _root() / safe_id


def _meta_path(agent_id: str) -> Path:
    return agent_dir(agent_id) / "meta.json"


def _default_meta() -> dict[str, Any]:
    return {
        "documents": [],
        "extraction": dict(EXTRACTION_IDLE),
        "profile": None,
        "scores": None,
        "autoExtract": None,
    }


def _read_meta(agent_id: str) -> dict[str, Any]:
    path = _meta_path(agent_id)
    if not path.exists():
        return _default_meta()
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return _default_meta()
    if not isinstance(data, dict):
        return _default_meta()
    meta = _default_meta()
    meta.update(data)
    return meta


def _write_meta(agent_id: str, meta: dict[str, Any]) -> None:
    directory = agent_dir(agent_id)
    directory.mkdir(parents=True, exist_ok=True)
    tmp = _meta_path(agent_id).with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    tmp.replace(_meta_path(agent_id))


def _safe_filename(filename: str) -> str:
    """Strip any directory component, including Windows-style separators."""
    raw = (filename or "document").replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch for ch in raw if ch not in '<>:"|?*').strip()
    return cleaned or "document"


# ---------------------------------------------------------------- documents


def list_documents(agent_id: str) -> list[dict]:
    """Every uploaded file, **including** ones rejected by the relevance gate."""
    return _read_meta(agent_id).get("documents") or []


def effective_documents(agent_id: str) -> list[dict]:
    """Only the documents that actually feed extraction (rejected ones are out)."""
    return [
        item
        for item in list_documents(agent_id)
        if str(item.get("status") or "").lower() != REJECTED_STATUS
    ]


def _effective_count(documents: list[dict]) -> int:
    return sum(
        1 for item in documents if str(item.get("status") or "").lower() != REJECTED_STATUS
    )


def get_document(agent_id: str, doc_id: str) -> dict | None:
    for item in list_documents(agent_id):
        if item.get("id") == doc_id:
            return item
    return None


def add_document(agent_id: str, filename: str, data: bytes) -> dict:
    """Parse and persist one upload. Raises ``DocumentError`` on bad input.

    ``settings.doc_relevance_enabled`` 打开时会先让模型判定整篇是否属于股票财经范畴。
    不相关的**照样落盘**（用户需要知道「为什么没收」），只是标 ``rejected`` 且不参与提炼。
    """
    name = _safe_filename(filename)
    document = extract_text(name, data)  # raises DocumentError

    relevant, reason = True, ""
    if settings.doc_relevance_enabled:
        relevant, reason = relevance.judge_document(name, document.text)

    doc_id = uuid.uuid4().hex[:12]
    directory = agent_dir(agent_id)
    files_dir = directory / "files"
    texts_dir = directory / "texts"
    for target in (files_dir, texts_dir):
        target.mkdir(parents=True, exist_ok=True)

    (files_dir / f"{doc_id}{document.suffix}").write_bytes(data)
    (texts_dir / f"{doc_id}.txt").write_text(document.text, encoding="utf-8")

    record = {
        "id": doc_id,
        "filename": document.filename,
        "suffix": document.suffix,
        "kind": document.kind,
        "chars": document.chars,
        "pages": document.pages,
        "truncated": document.truncated,
        "sizeBytes": len(data),
        "notes": document.notes,
        "status": "parsed" if relevant else REJECTED_STATUS,
        "relevanceReason": None if relevant else (reason or "与股票财经无关"),
        "error": None,
        "uploadedAt": datetime.now(timezone.utc).isoformat(),
    }

    with _LOCK:
        meta = _read_meta(agent_id)
        documents = [*(meta.get("documents") or []), record]
        meta["documents"] = documents
        # Any prior profile is now stale.
        meta["extraction"] = {
            **EXTRACTION_IDLE,
            "documentCount": _effective_count(documents),
        }
        meta["profile"] = None
        meta["scores"] = None
        _write_meta(agent_id, meta)
    return record


def remove_document(agent_id: str, doc_id: str) -> bool:
    with _LOCK:
        meta = _read_meta(agent_id)
        documents = meta.get("documents") or []
        remaining = [item for item in documents if item.get("id") != doc_id]
        if len(remaining) == len(documents):
            return False
        meta["documents"] = remaining
        meta["extraction"] = {**EXTRACTION_IDLE, "documentCount": _effective_count(remaining)}
        meta["profile"] = None
        meta["scores"] = None
        _write_meta(agent_id, meta)

    directory = agent_dir(agent_id)
    for candidate in (directory / "files").glob(f"{doc_id}.*"):
        candidate.unlink(missing_ok=True)
    (directory / "texts" / f"{doc_id}.txt").unlink(missing_ok=True)
    return True


def read_documents(agent_id: str) -> list[ExtractedDocument]:
    """Rebuild ExtractedDocument objects from the cached text files.

    被相关性闸门标为 ``rejected`` 的资料在这里被跳过 —— 它们留在盘上供用户查看，
    但不参与画像提炼。
    """
    out: list[ExtractedDocument] = []
    directory = agent_dir(agent_id)
    for record in list_documents(agent_id):
        if str(record.get("status") or "").lower() == REJECTED_STATUS:
            continue
        text_path = directory / "texts" / f"{record['id']}.txt"
        if not text_path.exists():
            continue
        out.append(
            ExtractedDocument(
                filename=record.get("filename") or record["id"],
                suffix=record.get("suffix") or "",
                kind=record.get("kind") or "text",
                text=text_path.read_text(encoding="utf-8"),
                chars=record.get("chars") or 0,
                pages=record.get("pages"),
                truncated=bool(record.get("truncated")),
                notes=list(record.get("notes") or []),
            )
        )
    return out


def purge(agent_id: str) -> None:
    """Delete every file belonging to an agent (used when the persona is removed)."""
    shutil.rmtree(agent_dir(agent_id), ignore_errors=True)


# ---------------------------------------------------------------- extraction


def extraction_state(agent_id: str) -> dict:
    return _read_meta(agent_id).get("extraction") or dict(EXTRACTION_IDLE)


def profile(agent_id: str) -> dict | None:
    return _read_meta(agent_id).get("profile")


def scores(agent_id: str) -> dict | None:
    return _read_meta(agent_id).get("scores")


def begin_extraction(agent_id: str) -> bool:
    """Mark extraction as running. Returns False if one is already in flight."""
    with _LOCK:
        meta = _read_meta(agent_id)
        current = meta.get("extraction") or {}
        if current.get("status") == "running":
            return False
        meta["extraction"] = {
            "status": "running",
            "error": None,
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "finishedAt": None,
            "documentCount": _effective_count(meta.get("documents") or []),
            "historyCount": 0,
        }
        _write_meta(agent_id, meta)
        return True


def finish_extraction(
    agent_id: str,
    profile_data: dict | None,
    error: str | None,
    history_count: int = 0,
) -> None:
    with _LOCK:
        meta = _read_meta(agent_id)
        meta["extraction"] = {
            "status": "failed" if error else "completed",
            "error": error,
            "startedAt": (meta.get("extraction") or {}).get("startedAt"),
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "documentCount": _effective_count(meta.get("documents") or []),
            "historyCount": int(history_count or 0),
        }
        if profile_data:
            meta["profile"] = profile_data
        _write_meta(agent_id, meta)


def save_scores(agent_id: str, payload: dict) -> None:
    with _LOCK:
        meta = _read_meta(agent_id)
        meta["scores"] = payload
        _write_meta(agent_id, meta)


# ------------------------------------------------------------- auto extract


def auto_extract_state(agent_id: str) -> dict:
    """最近一次定时提炼的记录（指纹 / 结果 / 时间）。没有则返回空 dict。"""
    return _read_meta(agent_id).get("autoExtract") or {}


def save_auto_extract(
    agent_id: str,
    fingerprint: str,
    status: str,
    error: str | None = None,
) -> None:
    """记下这一轮定时提炼的指纹 —— 下一轮据此判断资料/会话有没有变。"""
    with _LOCK:
        meta = _read_meta(agent_id)
        meta["autoExtract"] = {
            "fingerprint": fingerprint,
            "status": status,
            "error": error,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        _write_meta(agent_id, meta)


def custom_score_index() -> dict[str, dict[str, int]]:
    """``{agent name: {stock code: score}}`` for every scored custom persona.

    .. deprecated::
        自建老师的分数现在由 :mod:`top50_engine` 按画像 ``factorWeights`` 确定性算出，
        不再从「LLM 打的分」里取。保留此函数只为追溯旧实现，**不要重新接回排名链路**。
    """
    index: dict[str, dict[str, int]] = {}
    for item in agents.list_custom():
        saved = scores(item["id"]) or {}
        mapping = {
            str(entry.get("code")): entry.get("score")
            for entry in (saved.get("items") or [])
            if entry.get("code")
        }
        if mapping:
            index[item.get("name") or item["id"]] = mapping
    return index


def merge_agent_scores(payload: dict) -> dict:
    """Inject custom personas' scores into a TOP50 payload.

    .. deprecated::
        **已停用**（原调用点在 ``routers/snapshots.py``，已移除）。它会把 LLM 主观打的分
        覆盖到引擎按 ``factorWeights`` 算出的确定性分数上，正好抹掉「AI 学习改分」。
        自建老师现在由 ``top50_engine.score_universe`` 直接算进 ``agentScores``。
        保留实现仅供追溯，**不要再接回 ``/api/top50``**。

    ``fixtures.load`` is ``lru_cache``-backed, so ``payload`` is a **shared**
    object — mutating it would poison the cache for every later request. This
    rebuilds the outer dict, the per-cycle dicts and the ranking lists, reusing
    untouched entries by reference. That keeps the copy cheap (the fixture is
    ~840KB) while leaving the cached original pristine.
    """
    index = custom_score_index()
    if not index:
        return payload

    cycles_out: dict[str, Any] = {}
    for key, cycle in (payload.get("cycles") or {}).items():
        rebuilt: list[dict] = []
        for entry in cycle.get("ranking") or []:
            code = str(entry.get("code") or "")
            additions = {
                name: mapping[code] for name, mapping in index.items() if code in mapping
            }
            if additions:
                entry = {
                    **entry,
                    "agentScores": {**(entry.get("agentScores") or {}), **additions},
                }
            rebuilt.append(entry)
        cycles_out[key] = {**cycle, "ranking": rebuilt}

    return {**payload, "cycles": cycles_out, "mergedAgentNames": sorted(index)}
