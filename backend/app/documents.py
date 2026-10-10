"""Turn an uploaded agent document into plain text.

Supported: ``.txt`` / ``.md`` / ``.markdown`` / ``.pdf``.

**PDF scope is deliberately narrow.** `pypdf` only reads the text layer, so a
scanned (image-only) PDF yields nothing usable. Rather than silently handing an
empty document to the LLM, ``extract_text`` raises ``DocumentError`` with an
actionable message. OCR is explicitly out of scope for the demo stage.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from app.config import settings

PLAIN_SUFFIXES = {".txt", ".md", ".markdown", ".text"}
PDF_SUFFIXES = {".pdf"}
SUPPORTED_SUFFIXES = PLAIN_SUFFIXES | PDF_SUFFIXES

# Encodings tried in order for plain-text files (GBK for domestic research notes).
TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "utf-16", "latin-1")

# Below this many characters per page we treat a PDF as image-only.
MIN_CHARS_PER_PAGE = 20


class DocumentError(ValueError):
    """Unsupported type, oversized file, unreadable content, or scanned PDF."""


@dataclass
class ExtractedDocument:
    filename: str
    suffix: str
    kind: str  # "pdf" | "text"
    text: str
    chars: int
    pages: int | None = None
    truncated: bool = False
    notes: list[str] = field(default_factory=list)


def _decode_plain(data: bytes, filename: str) -> tuple[str, str]:
    for encoding in TEXT_ENCODINGS:
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise DocumentError(f"{filename} 编码无法识别，请另存为 UTF-8 后重试")


def _extract_pdf(data: bytes, filename: str) -> tuple[str, int, list[str]]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise DocumentError("服务端缺少 pypdf，无法解析 PDF") from exc

    notes: list[str] = []
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:  # noqa: BLE001 - pypdf raises varied types
                raise DocumentError(f"{filename} 已加密，无法解析") from exc

        total_pages = len(reader.pages)
        if total_pages > settings.max_pdf_pages:
            raise DocumentError(
                f"{filename} 共 {total_pages} 页，超过 {settings.max_pdf_pages} 页上限"
            )

        chunks: list[str] = []
        for index, page in enumerate(reader.pages):
            try:
                chunks.append(page.extract_text() or "")
            except Exception as exc:  # noqa: BLE001 - single bad page shouldn't abort
                notes.append(f"第 {index + 1} 页解析失败已跳过：{exc}")
        text = "\n".join(chunks)
    except DocumentError:
        raise
    except Exception as exc:  # noqa: BLE001 - malformed PDF
        raise DocumentError(f"{filename} 不是有效的 PDF 文件（{exc}）") from exc

    stripped = text.strip()
    if len(stripped) < MIN_CHARS_PER_PAGE * max(total_pages, 1):
        raise DocumentError(
            f"{filename} 未能提取到有效文本（共 {total_pages} 页，仅 {len(stripped)} 字符）。"
            "该 PDF 可能是扫描件或图片版，请改用文本版 PDF、Markdown 或 TXT。"
        )
    return text, total_pages, notes


def extract_text(filename: str, data: bytes) -> ExtractedDocument:
    """Parse raw upload bytes into text, enforcing the demo-stage budgets."""
    name = PurePosixPath(filename or "document").name
    suffix = PurePosixPath(name).suffix.lower()

    if suffix not in SUPPORTED_SUFFIXES:
        allowed = "、".join(sorted(SUPPORTED_SUFFIXES))
        raise DocumentError(f"不支持的文件类型 {suffix or '(无扩展名)'}，仅支持 {allowed}")

    size_mb = len(data) / (1024 * 1024)
    if size_mb > settings.max_upload_mb:
        raise DocumentError(
            f"{name} 大小 {size_mb:.1f}MB，超过 {settings.max_upload_mb}MB 上限"
        )
    if not data:
        raise DocumentError(f"{name} 是空文件")

    notes: list[str] = []
    if suffix in PDF_SUFFIXES:
        text, pages, notes = _extract_pdf(data, name)
        kind = "pdf"
    else:
        text, encoding = _decode_plain(data, name)
        pages = None
        kind = "text"
        notes.append(f"按 {encoding} 解码")

    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise DocumentError(f"{name} 未提取到任何文本")

    truncated = len(text) > settings.max_document_chars
    if truncated:
        text = text[: settings.max_document_chars]
        notes.append(f"文本超过 {settings.max_document_chars} 字符，已截断")

    return ExtractedDocument(
        filename=name,
        suffix=suffix,
        kind=kind,
        text=text,
        chars=len(text),
        pages=pages,
        truncated=truncated,
        notes=notes,
    )
