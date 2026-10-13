"""Turn an uploaded agent document into plain text.

Supported: ``.txt`` / ``.md`` / ``.markdown`` / ``.pdf`` / 图片（``.png`` ``.jpg``
``.jpeg`` ``.webp`` ``.bmp`` ``.gif``）。

PDF 优先走 ``pypdf`` 文本层；若文本层几乎为空（扫描件 / 图片版 PDF），自动用
RapidOCR（``rapidocr-onnxruntime``，CPU 友好的 onnxruntime 模型）把每页渲染成图
再做 OCR。图片文件直接 OCR。OCR 仍抽不到字才抛 ``DocumentError``。
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from app.config import settings

PLAIN_SUFFIXES = {".txt", ".md", ".markdown", ".text"}
PDF_SUFFIXES = {".pdf"}
# 图片文件：直接走 OCR（RapidOCR）。
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
SUPPORTED_SUFFIXES = PLAIN_SUFFIXES | PDF_SUFFIXES | IMAGE_SUFFIXES

# Encodings tried in order for plain-text files (GBK for domestic research notes).
TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "utf-16", "latin-1")

# Below this many characters per page we treat a PDF as image-only (走 OCR 回落).
MIN_CHARS_PER_PAGE = 20


class DocumentError(ValueError):
    """Unsupported type, oversized file, unreadable content, or scanned PDF."""


@dataclass
class ExtractedDocument:
    filename: str
    suffix: str
    kind: str  # "pdf" | "text" | "image"
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

    # 文本层不足不在此报死：交给 extract_text 走 OCR 回落（扫描件 / 图片版 PDF）。
    return text, total_pages, notes


# ----------------------------------------------------------------- 图片 / 图片PDF 的 OCR 回落
_OCR_ENGINE = None


def _ocr_engine():
    """RapidOCR 懒单例：首次调用才加载 onnx 模型（约几百 MB 内存，秒级）。"""
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise DocumentError(
                "服务端 OCR 依赖未就绪（rapidocr-onnxruntime/opencv 未安装，"
                "或 Debian 镜像缺 libGL 等系统库），无法识别图片/扫描件"
            ) from exc
        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def _ocr_array(arr) -> str:
    """对一张图（numpy 数组，BGR）做 OCR，返回拼接后的文本行。"""
    result, _ = _ocr_engine()(arr)
    if not result:
        return ""
    return "\n".join(line[1] for line in result if line and line[1])


def _ocr_image_bytes(data: bytes) -> tuple[str, list[str]]:
    """图片文件：PIL 打开 → numpy(BGR) → OCR。"""
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover
        raise DocumentError("服务端缺少 Pillow，无法处理图片") from exc
    import numpy as np

    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        arr = np.asarray(img)[:, :, ::-1]  # RGB→BGR，RapidOCR 期望 BGR
    except Exception as exc:  # noqa: BLE001 - 损坏/不支持的图片
        raise DocumentError(f"图片无法解码（{exc}）") from exc
    return _ocr_array(arr), []


def _ocr_pdf(data: bytes, pages: int) -> tuple[str, list[str]]:
    """图片版 PDF：PyMuPDF 把每页渲染成图 → 逐页 OCR → 拼接。

    只渲染前 ``max_pdf_pages`` 页，避免超大扫描件把上传请求拖死。
    """
    try:
        import fitz  # pymupdf
    except ImportError as exc:  # pragma: no cover
        raise DocumentError("服务端缺少 pymupdf，无法解析图片版 PDF") from exc
    import numpy as np
    from PIL import Image

    notes: list[str] = []
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise DocumentError(f"PDF 无法用 pymupdf 打开（{exc}）") from exc

    chunks: list[str] = []
    rendered = 0
    for index, page in enumerate(doc):
        if index >= settings.max_pdf_pages:
            notes.append(f"扫描件超过 {settings.max_pdf_pages} 页，仅 OCR 前 {settings.max_pdf_pages} 页")
            break
        try:
            pix = page.get_pixmap(dpi=200)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            arr = np.asarray(img)[:, :, ::-1]
            text = _ocr_array(arr).strip()
            if text:
                chunks.append(text)
            rendered += 1
        except Exception as exc:  # noqa: BLE001 - 单页失败不中断
            notes.append(f"第 {index + 1} 页 OCR 失败已跳过：{exc}")
    if not chunks:
        notes.append(f"已渲染 {rendered} 页，OCR 未识别到任何文字")
    return "\n".join(chunks), notes


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
    pages = None
    if suffix in PDF_SUFFIXES:
        text, pages, notes = _extract_pdf(data, name)
        kind = "pdf"
        # 文本层几乎为空 → 可能是扫描件，走 OCR 回落
        if pages and len(text.strip()) < MIN_CHARS_PER_PAGE * pages:
            ocr_text, ocr_notes = _ocr_pdf(data, pages)
            notes += ocr_notes
            if ocr_text.strip():
                text = ocr_text
                notes.append("原 PDF 文本层为空，已通过 OCR 提取图片内容")
    elif suffix in IMAGE_SUFFIXES:
        text, img_notes = _ocr_image_bytes(data)
        kind = "image"
        notes = img_notes
    else:
        text, encoding = _decode_plain(data, name)
        pages = None
        kind = "text"
        notes.append(f"按 {encoding} 解码")

    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise DocumentError(f"{name} 未提取到任何文字（图片/扫描件可能无清晰文字内容）")

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
