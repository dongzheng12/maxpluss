"""
Dedup 能力服务 — FastAPI 入口
================================
端口 8067，仅监听 127.0.0.1
提供 /internal/compare, /internal/report, /internal/health, /internal/extract-text, /internal/recognize
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import importlib.util
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()  # 从 /app/.env 加载环境变量

try:
    import ahocorasick
    _HAS_AHOCORASICK = True
except ImportError:
    ahocorasick = None  # type: ignore[assignment]
    _HAS_AHOCORASICK = False

from fastapi import FastAPI, File, Request, UploadFile, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import verify_internal_request
from .compare import DedupDB, compare_against_library, _extract_user_refs, _extract_user_terms, _extract_user_structure, asdict
from .report import build_report, load_meta_cache, _meta_lookup
from . import report as _report_mod
from . import jobs as job_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-5s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("dedup.service")

DB_PATH = os.environ.get(
    "BXZ_DB_PATH",
    os.path.join(os.path.dirname(__file__), "../../data/bx_standards.db"),
)
META_PATH = os.environ.get(
    "BXZ_META_PATH",
    # classification_result_final.json = 权威元数据源（经 enrich_all_metadata_v2 全链路处理）
    # classification_result.json = 中间产物，保留作兜底，不作默认
    os.path.join(os.path.dirname(__file__), "../../data/classification_result_final.json"),
)

# 全局 DB 实例
db: DedupDB = None  # type: ignore

TEXT_INSUFFICIENT = "TEXT_INSUFFICIENT"
OCR_FAILED = "OCR_FAILED"
DEPENDENCY_MISSING = "DEPENDENCY_MISSING"
SYSTEM_FAILURE = "SYSTEM_FAILURE"

_MIN_STRIPPED_LENGTH = 80
_MIN_COMPACT_LENGTH = 50
_MIN_VALID_CHAR_COUNT = 40
_MIN_VALID_CHAR_RATIO = 0.35
_MIN_NON_EMPTY_PAGES = 1
_MIN_PAGE_COMPACT_LENGTH = 10
_VALID_TEXT_CHAR_RE = re.compile(r"[\u4e00-\u9fffA-Za-z0-9]")


def _normalize_text(text: str) -> str:
    return "\n".join(line.strip() for line in (text or "").splitlines() if line.strip())


def _compact_text(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


# ─── OCR 文本归一化（用于品牌匹配） ───
_FULLWIDTH_MAP = str.maketrans(
    '！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠'
    'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ'
    '［＼］＾＿｀ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝～',
    '!"#$%&\'()*+,-./'
    '0123456789'
    ':;<=>?@'
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    '[\\]^_`'
    'abcdefghijklmnopqrstuvwxyz'
    '{|}~'
)


def normalize_ocr_text(text: str) -> str:
    """Normalize OCR text for brand matching: remove spaces, punctuation, fullwidth→halfwidth, lowercase."""
    if not text:
        return ""
    # Fullwidth to halfwidth
    text = text.translate(_FULLWIDTH_MAP)
    # Remove whitespace, newlines
    text = re.sub(r'[\s\n\r\t]+', '', text)
    # Remove common punctuation and special chars (keep Chinese + alphanumeric)
    text = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]', '', text)
    # Lowercase
    text = text.lower()
    return text


def _analyze_text_quality(text: str, page_texts: Optional[List[str]] = None) -> Dict[str, Any]:
    raw_text = text or ""
    stripped_text = raw_text.strip()
    normalized_text = _normalize_text(raw_text)
    compact_text = _compact_text(normalized_text)
    valid_char_count = len(_VALID_TEXT_CHAR_RE.findall(compact_text))
    valid_char_ratio = valid_char_count / max(len(compact_text), 1) if compact_text else 0.0

    page_samples = page_texts if page_texts is not None else [raw_text]
    non_empty_pages = sum(
        1
        for page_text in page_samples
        if len(_compact_text(page_text or "")) >= _MIN_PAGE_COMPACT_LENGTH
    )

    is_effective = (
        len(stripped_text) >= _MIN_STRIPPED_LENGTH
        and len(compact_text) >= _MIN_COMPACT_LENGTH
        and valid_char_count >= _MIN_VALID_CHAR_COUNT
        and valid_char_ratio >= _MIN_VALID_CHAR_RATIO
        and non_empty_pages >= _MIN_NON_EMPTY_PAGES
    )

    return {
        "raw_text_length": len(raw_text),
        "stripped_text_length": len(stripped_text),
        "normalized_text_length": len(normalized_text),
        "compact_text_length": len(compact_text),
        "valid_char_count": valid_char_count,
        "valid_char_ratio": round(valid_char_ratio, 4),
        "non_empty_pages": non_empty_pages,
        "is_effective": is_effective,
        "text": normalized_text,
    }


def _build_extract_response(
    *,
    success: bool,
    text: str,
    method: str,
    pages: int,
    error: Optional[str] = None,
    error_code: Optional[str] = None,
    ocr_error_code: Optional[str] = None,
    quality: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    metrics = quality or _analyze_text_quality(text)
    return {
        "success": success,
        "text": text,
        "text_length": len(text or ""),
        "raw_text_length": metrics["raw_text_length"],
        "normalized_text_length": metrics["normalized_text_length"],
        "compact_text_length": metrics["compact_text_length"],
        "non_empty_pages": metrics["non_empty_pages"],
        "valid_char_count": metrics["valid_char_count"],
        "valid_char_ratio": metrics["valid_char_ratio"],
        "method": method,
        "extract_method": method,
        "pages": pages,
        "error": error,
        "error_code": error_code,
        "ocr_error_code": ocr_error_code,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时加载数据库到内存"""
    global db
    db = DedupDB(DB_PATH)
    db.load_all()
    load_meta_cache(META_PATH)   # 加载 487K 元数据（~30-40MB，建归一化索引）

    # ── 启动硬校验：元数据必须加载成功 ──
    _meta_count = len(_report_mod._META_CACHE)
    _META_LOAD_OK = _meta_count >= 400_000  # 预期 487K，低于 400K 视为异常
    if _META_LOAD_OK:
        log.info(f"[startup] ✅ metadata_loaded=true metadata_count={_meta_count} (487K 主召回就绪)")
    else:
        log.error(
            f"[startup] ❌ metadata_loaded={'true' if _meta_count > 0 else 'false'} "
            f"metadata_count={_meta_count} — 低于预期 400K！487K 主召回路径可能失效，"
            f"将 fallback 到 pyapi 搜索"
        )

    # ── 启动硬校验：Aho-Corasick 状态 ──
    log.info(f"[startup] brand-ac status: {_AC_STATS}")

    # 注册异步 job 处理器并启动后台 worker 线程（每个 uvicorn worker 进程一份）
    job_store.register_processor("extract_text", _job_run_extract_text)
    job_store.ensure_worker_started()
    log.info(
        f"[startup] ✅ Dedup service ready | DB={DB_PATH} | META={META_PATH} | "
        f"meta_count={_meta_count} | aho_enabled={_AC_STATS.get('aho_enabled')} | "
        f"brands_total={len(_BRAND_CATEGORY_MAP)}"
    )
    yield
    log.info("Dedup service shutting down")


app = FastAPI(
    title="BXZ Dedup Capability Service",
    version="1.0.0",
    lifespan=lifespan,
)


# ─── 请求/响应模型 ──────────────────────────────────────────

class CompareRequest(BaseModel):
    text: str = Field(..., min_length=50, max_length=500_000)
    title: str = Field(default="", max_length=500)
    ics_hint: str = Field(default="", max_length=20)
    top_n: int = Field(default=20, ge=1, le=50)


class ReportRequest(BaseModel):
    text: str = Field(..., min_length=50, max_length=500_000)
    title: str = Field(default="", max_length=500)
    ics_hint: str = Field(default="", max_length=20)
    top_n: int = Field(default=20, ge=1, le=50)


# ─── 健康检查（不需要鉴权）──────────────────────────────────

@app.get("/internal/health")
async def health():
    counts = db.table_counts()
    _meta_count = len(_report_mod._META_CACHE)
    return {
        "status": "ok",
        "db_path": DB_PATH,
        "db_tables": len(counts),
        "counts": counts,
        "fingerprints_loaded": len(db._fingerprints),
        # ── 品牌匹配状态 ──
        "aho_corasick": _AC_STATS,
        "brands_total": len(_BRAND_CATEGORY_MAP),
        # ── 487K 元数据状态 ──
        "metadata_loaded": _meta_count > 0,
        "metadata_count": _meta_count,
        "metadata_487k_ready": _meta_count >= 400_000,
    }


# ─── 全库比对 ──────────────────────────────────────────────

@app.post("/internal/compare", dependencies=[Depends(verify_internal_request)])
async def compare(req: CompareRequest):
    candidates, stats = compare_against_library(
        db=db,
        text=req.text,
        title=req.title,
        ics_hint=req.ics_hint,
        top_n=req.top_n,
    )

    return {
        "candidates": [
            {
                "code": c.code,
                "name": c.name,
                "overall_score": round(c.overall_score, 4),
                "title_sim": round(c.title_sim, 4),
                "content_sim": round(c.content_sim, 4),
                "structure_sim": round(c.structure_sim, 4),
                "reference_sim": round(c.reference_sim, 4),
                "term_sim": round(c.term_sim, 4),
                "tier": c.tier,
            }
            for c in candidates
        ],
        "stats": {
            "total_compared": stats.total_in_db,
            "candidates_screened": stats.candidates_screened,
            "processing_ms": stats.processing_ms,
        },
    }


# ─── 生成报告（compare + report 合并，一次请求完成）──────────

@app.post("/internal/report", dependencies=[Depends(verify_internal_request)])
async def report(req: ReportRequest):
    # 先做比对
    candidates, stats = compare_against_library(
        db=db,
        text=req.text,
        title=req.title,
        ics_hint=req.ics_hint,
        top_n=req.top_n,
    )

    # 提取用户文本辅助信息
    user_refs = _extract_user_refs(req.text)
    user_terms = _extract_user_terms(req.text)
    user_sections = _extract_user_structure(req.text)

    # 组装报告
    report_data = build_report(
        db=db,
        text=req.text,
        title=req.title,
        candidates=candidates,
        stats=stats,
        user_refs=user_refs,
        user_terms=user_terms,
        user_sections=user_sections,
        ics_hint=req.ics_hint,       # 透传 ICS hint 用于行业格局分析
    )

    return report_data


# ─── 相似标准查询（扫一扫场景预留）─────────────────────────

@app.get("/internal/similar", dependencies=[Depends(verify_internal_request)])
async def similar(code: str):
    """按标准号查相似标准"""
    # 找到该标准的 a001
    row = db.conn.execute(
        "SELECT a001, code, name FROM standards WHERE code = ? LIMIT 1",
        (code,),
    ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "standard not found"})

    a001 = row["a001"]
    fp = db._fingerprints.get(a001)
    if fp is None:
        return {"code": code, "name": row["name"], "similar": []}

    # 用该标准的 MinHash 找相似
    import numpy as np
    from .compare import _jaccard_from_arrays

    scores = []
    for other_a001, other_fp in db._fingerprints.items():
        if other_a001 == a001:
            continue
        j = _jaccard_from_arrays(fp, other_fp)
        if j > 0.05:
            meta = db._meta.get(other_a001)
            if meta:
                scores.append((meta[0], meta[1], j))

    scores.sort(key=lambda x: x[2], reverse=True)
    return {
        "code": code,
        "name": row["name"],
        "similar": [
            {"code": s[0], "name": s[1], "similarity": round(s[2], 4)}
            for s in scores[:20]
        ],
    }


# ─── PDF 文本提取（PyMuPDF + ocrmac fallback）─────────────

def _run_extract_pdf_sync(tmp_path: str, max_pages: Optional[int]) -> Dict[str, Any]:
    """
    PDF 文本提取核心逻辑（同步版，无 FastAPI 依赖）。
    被 /internal/extract-text 同步端点和 /internal/jobs/extract-text 异步 job 共用。
    返回 _build_extract_response 标准 dict（含 success/text/error_code 等字段）。
    调用方负责传入 tmp_path（已落盘的 PDF 文件路径）和清理。
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return _build_extract_response(
            success=False,
            text="",
            method="none",
            pages=0,
            error="PyMuPDF (fitz) 未安装，请执行 pip install PyMuPDF",
            error_code=DEPENDENCY_MISSING,
        )

    try:
        # ── 第一步：PyMuPDF 提取 ──
        doc = fitz.open(tmp_path)
        total_pages = len(doc)
        page_limit = max_pages if max_pages and max_pages > 0 else total_pages
        pages_text = []
        for i, page in enumerate(doc):
            if i >= page_limit:
                break
            pages_text.append(page.get_text("text"))
        doc.close()
        if max_pages and total_pages > max_pages:
            log.info(f"[extract-text] 页数限制: 总 {total_pages} 页，只处理前 {max_pages} 页")

        full_text = "\n".join(pages_text)
        watermark_re = re.compile(r"学兔兔|bzfxw|www\.|标准下载|标准网", re.IGNORECASE)
        filtered = "\n".join(
            line for line in full_text.split("\n")
            if not watermark_re.search(line)
        )
        pymupdf_quality = _analyze_text_quality(filtered, pages_text)
        method = "pymupdf"

        log.info(
            "[extract-text] PyMuPDF metrics raw_text_length=%s normalized_text_length=%s non_empty_pages=%s valid_char_ratio=%.2f extract_method=%s",
            pymupdf_quality["raw_text_length"],
            pymupdf_quality["normalized_text_length"],
            pymupdf_quality["non_empty_pages"],
            pymupdf_quality["valid_char_ratio"],
            method,
        )

        if pymupdf_quality["is_effective"]:
            if pymupdf_quality["normalized_text_length"] < 120:
                log.error(
                    "[extract-text][alert] success=true but normalized_text_length=%s extract_method=%s pages=%s",
                    pymupdf_quality["normalized_text_length"],
                    method,
                    total_pages,
                )
            return _build_extract_response(
                success=True,
                text=pymupdf_quality["text"],
                method=method,
                pages=total_pages,
                quality=pymupdf_quality,
            )

        log.info(
            "[extract-text] PyMuPDF 文字层不足，进入 OCR raw_text_length=%s normalized_text_length=%s non_empty_pages=%s valid_char_ratio=%.2f",
            pymupdf_quality["raw_text_length"],
            pymupdf_quality["normalized_text_length"],
            pymupdf_quality["non_empty_pages"],
            pymupdf_quality["valid_char_ratio"],
        )

        # ── 第二步：PyMuPDF 不足 → OCR fallback（共用 _ocr_single_image）──
        ocr_method = "none"
        ocr_error_code = None
        ocr_error_message = None
        try:
            ocr_pages = []
            doc2 = fitz.open(tmp_path)
            ocr_limit = max_pages if max_pages and max_pages > 0 else 200
            for i, page in enumerate(doc2):
                if i >= ocr_limit:
                    break
                pix = page.get_pixmap(dpi=200)
                img_path = tmp_path + f"_p{i}.png"
                pix.save(img_path)
                try:
                    ocr_result = _ocr_single_image(img_path)
                    if ocr_result["success"] and ocr_result["text"]:
                        ocr_pages.append(ocr_result["text"])
                        if ocr_method == "none":
                            ocr_method = ocr_result.get("engine") or "ocr"
                    elif ocr_result.get("error_code"):
                        ocr_error_code = ocr_error_code or ocr_result["error_code"]
                        ocr_error_message = ocr_error_message or ocr_result.get("error_message")
                        if ocr_result["error_code"] == DEPENDENCY_MISSING:
                            break
                finally:
                    if os.path.exists(img_path):
                        os.unlink(img_path)
            doc2.close()

            ocr_text = "\n".join(ocr_pages)
            ocr_quality = _analyze_text_quality(ocr_text, ocr_pages)
            log.info(
                "[extract-text] OCR metrics raw_text_length=%s normalized_text_length=%s non_empty_pages=%s valid_char_ratio=%.2f extract_method=%s ocr_error_code=%s",
                ocr_quality["raw_text_length"],
                ocr_quality["normalized_text_length"],
                ocr_quality["non_empty_pages"],
                ocr_quality["valid_char_ratio"],
                ocr_method,
                ocr_error_code,
            )

            if ocr_quality["is_effective"]:
                if ocr_quality["normalized_text_length"] < 120:
                    log.error(
                        "[extract-text][alert] success=true but normalized_text_length=%s extract_method=%s pages=%s",
                        ocr_quality["normalized_text_length"],
                        ocr_method,
                        total_pages,
                    )
                return _build_extract_response(
                    success=True,
                    text=ocr_quality["text"],
                    method=ocr_method,
                    pages=total_pages,
                    ocr_error_code=ocr_error_code,
                    quality=ocr_quality,
                )

            final_error_code = ocr_error_code or OCR_FAILED
            final_error = ocr_error_message or "OCR 未能提取到可用正文，请上传文字版 PDF 或检查 OCR 服务"
            failure_quality = {
                **ocr_quality,
                "raw_text_length": pymupdf_quality["raw_text_length"],
            }
            log.warning(
                "[extract-text][content-failure] error_code=%s raw_text_length=%s normalized_text_length=%s non_empty_pages=%s extract_method=%s",
                final_error_code,
                failure_quality["raw_text_length"],
                failure_quality["normalized_text_length"],
                failure_quality["non_empty_pages"],
                ocr_method,
            )
            return _build_extract_response(
                success=False,
                text=ocr_quality["text"],
                method=ocr_method if ocr_method != "none" else method,
                pages=total_pages,
                error=final_error,
                error_code=final_error_code,
                ocr_error_code=ocr_error_code,
                quality=failure_quality,
            )
        except Exception as e:
            log.error(
                "[extract-text][system-failure] OCR fallback 失败: %s raw_text_length=%s normalized_text_length=%s non_empty_pages=%s extract_method=%s",
                e,
                pymupdf_quality["raw_text_length"],
                pymupdf_quality["normalized_text_length"],
                pymupdf_quality["non_empty_pages"],
                method,
            )
            return _build_extract_response(
                success=False,
                text="",
                method=method,
                pages=total_pages,
                error=f"OCR 处理失败: {e}",
                error_code=OCR_FAILED,
                ocr_error_code=OCR_FAILED,
            )
    except Exception as e:
        log.error(f"[extract-text][system-failure] 提取失败: {e}", exc_info=True)
        return _build_extract_response(
            success=False,
            text="",
            method="none",
            pages=0,
            error=str(e),
            error_code=SYSTEM_FAILURE,
        )


# ─── 同步 / 异步 extract-text 端点 ────────────────────────

@app.post("/internal/extract-text", dependencies=[Depends(verify_internal_request)])
async def extract_text(file: UploadFile = File(...), max_pages: Optional[int] = None):
    """
    同步 PDF 文本提取（旧端点，保留作 fallback / 扫一扫 / 测试）。
    现在内部调 _run_extract_pdf_sync。
    """
    content = await file.read()
    if not content:
        return _build_extract_response(
            success=False,
            text="",
            method="none",
            pages=0,
            error="上传文件为空",
            error_code=TEXT_INSUFFICIENT,
        )
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        return _run_extract_pdf_sync(tmp_path, max_pages)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def _job_run_extract_text(job: dict) -> dict:
    """
    /internal/jobs/extract-text 的后台执行体（被 jobs.py worker 线程调）。
    job 是 jobs 表的一行 dict，包含 file_path（之前 submit 写到 /tmp）+ meta（含 max_pages）。
    返回值会被 jobs.py 写回 jobs.result 字段。
    """
    file_path = job.get("file_path") or ""
    meta_raw = job.get("meta") or "{}"
    try:
        meta = json.loads(meta_raw) if isinstance(meta_raw, str) else (meta_raw or {})
    except Exception:
        meta = {}
    max_pages = meta.get("max_pages")
    try:
        max_pages = int(max_pages) if max_pages else None
    except Exception:
        max_pages = None
    if not file_path or not os.path.exists(file_path):
        return _build_extract_response(
            success=False, text="", method="none", pages=0,
            error="job 文件已丢失（容器重启或 TTL 过期）",
            error_code=SYSTEM_FAILURE,
        )
    return _run_extract_pdf_sync(file_path, max_pages)


@app.post("/internal/jobs/extract-text", dependencies=[Depends(verify_internal_request)])
async def submit_extract_text_job(file: UploadFile = File(...), max_pages: Optional[int] = None):
    """
    异步提交 extract-text 任务。
    立即返回 {job_id}，后台 worker 线程跑 OCR；用 GET /internal/jobs/{job_id} 拉结果。
    """
    content = await file.read()
    if not content:
        return JSONResponse(status_code=400, content={"error": "上传文件为空"})
    job_id = job_store.submit(
        kind="extract_text",
        file_bytes=content,
        meta={"max_pages": max_pages, "filename": file.filename or ""},
    )
    return {"job_id": job_id, "status": "pending"}


@app.get("/internal/jobs/{job_id}", dependencies=[Depends(verify_internal_request)])
async def get_job_status(job_id: str):
    """
    查 job 状态。
    返回 {status: pending|running|done|failed, result?, error?, error_code?}
    'not_found' 表示 job 不存在（已过期 / 容器重启 / 错 worker pid 等）
    """
    job = job_store.get(job_id)
    if not job:
        return {"status": "not_found"}
    out = {
        "job_id": job_id,
        "status": job["status"],
    }
    if job["status"] == "done" and job.get("result"):
        try:
            out["result"] = json.loads(job["result"])
        except Exception:
            out["result"] = None
    if job["status"] == "failed":
        out["error"] = job.get("error") or ""
        out["error_code"] = job.get("error_code") or "SYSTEM_FAILURE"
    return out


# ─── 统一识别端点（扫描优先，OCR 兜底）─────────────────────
#
# 识别链路：
#   1. 条形码/二维码扫描 → 提取标准号 → 查 487K 库匹配
#   2. 若扫描无结果 → OCR 提取图片文字 → 正则提取标准号
#   3. 若提取到标准号 → 返回标准信息 + 相似标准
#   4. 若提取到文字但无标准号 → 返回文字内容（可用于后续全库比对）
#
# 支持输入：图片（jpg/png/bmp/webp）或 PDF

@app.post("/internal/recognize", dependencies=[Depends(verify_internal_request)])
async def recognize(file: UploadFile = File(...)):
    """
    统一图片/文档识别能力端点。
    扫一扫、拍照识别、全库比对等场景统一调用。

    返回:
      {
        success: bool,
        stage: "barcode" | "ocr" | "none",
        barcode: { type, value, standard_code } | null,
        standard: { code, name, status } | null,
        text: str,
        text_length: int,
        method: str,
        error: str | null,
      }
    """
    import re
    import io as _io

    content = await file.read()
    if not content:
        return _recognize_error("上传文件为空")

    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    is_pdf = ext == "pdf" or file.content_type == "application/pdf"
    is_image = ext in ("jpg", "jpeg", "png", "bmp", "webp", "tiff") or (
        file.content_type or ""
    ).startswith("image/")

    if not is_pdf and not is_image:
        return _recognize_error(f"不支持的文件类型: {ext or file.content_type}")

    # 写入临时文件
    suffix = f".{ext}" if ext else (".pdf" if is_pdf else ".png")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = {
            "success": False,
            "stage": "none",
            "barcode": None,
            "standard": None,
            "text": "",
            "text_length": 0,
            "method": "none",
            "error": None,
        }

        # ═══ 阶段 1：条形码/二维码扫描（优先） ═══
        barcode_data = _try_barcode_scan(tmp_path, is_pdf)
        if barcode_data:
            result["stage"] = "barcode"
            result["barcode"] = barcode_data
            result["method"] = "barcode"

            # 尝试从条码值中提取标准号
            std_code = _extract_standard_code_from_barcode(barcode_data["value"])
            if std_code:
                barcode_data["standard_code"] = std_code
                std_info = _lookup_standard(std_code)
                if std_info:
                    result["standard"] = std_info
                    result["success"] = True
                    log.info(f"[recognize] 条码识别成功: {std_code} → {std_info['name']}")
                    return result

            # 条码有值但没匹配到标准号，标记为部分成功
            result["success"] = True
            log.info(f"[recognize] 条码识别到值 '{barcode_data['value']}' 但未匹配标准号")
            # 继续 OCR 尝试提取更多信息

        # ═══ 阶段 2：OCR 文字提取（兜底） ═══
        ocr_text, ocr_method = _try_ocr(tmp_path, is_pdf, is_image)

        if ocr_text:
            result["text"] = ocr_text
            result["text_length"] = len(ocr_text)
            result["method"] = ocr_method if result["stage"] != "barcode" else f"barcode+{ocr_method}"

            # 从 OCR 文字中提取标准号
            if not result.get("standard"):
                std_codes = _extract_standard_codes_from_text(ocr_text)
                if std_codes:
                    # 取第一个能在库中匹配到的
                    for code in std_codes:
                        std_info = _lookup_standard(code)
                        if std_info:
                            result["standard"] = std_info
                            result["stage"] = result["stage"] if result["stage"] == "barcode" else "ocr"
                            log.info(f"[recognize] OCR 提取标准号: {code} → {std_info['name']}")
                            break

            result["success"] = True
            if result["stage"] == "none":
                result["stage"] = "ocr"
        elif result["stage"] != "barcode":
            result["error"] = "无法从图片中识别到文字或条码信息"

        return result

    except Exception as e:
        log.error(f"[recognize] 识别失败: {e}", exc_info=True)
        return _recognize_error(str(e))
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


SHITU_URL = os.environ.get("SHITU_SERVICE_URL", "http://127.0.0.1:8069")


# ─── 扫一扫 行业大类白名单 / 风险方向 ──────────────────────────────
#
# 用途：scan-recognize 把品类标签映射到大类 token，对 pyapi 全文检索结果做
# 「正向词必含 + 负向词必排除」过滤，避免「酱油 → 农药残留标准」这类跨行业误推。
#
# 维护规则：
# - must_include: standard.name 至少含其中 1 个词，才算匹配该行业
# - must_exclude: standard.name 含其中任何词，立即剔除（无论 must_include 是否命中）
# - INDUSTRY_RISK_DIRECTIONS: general 模式下展示给用户的「这类商品通常需要关注的方向」
#
# 添加新品类时：
# 1. 在 _expand_scan_search_keywords 加 label
# 2. 在这里 CATEGORY_INDUSTRY_MAP 加同款 label → industry meta 映射
# 3. 在 INDUSTRY_RISK_DIRECTIONS 加 industry_token → 风险方向文字列表

# 跨行业通用「绝不在食品/日化里出现」黑名单（每个食品/日化大类都继承）
_EXCLUDE_AGRO = ["农药", "兽药", "饲料", "化肥", "农作物", "种子", "灌溉",
                 "栽培", "土壤", "农产品质量安全", "化学品安全", "GHS"]
_EXCLUDE_INDUSTRIAL = ["矿山", "冶金", "钢铁", "焊接", "锅炉", "石油", "天然气",
                       "电力工程", "建筑施工"]

CATEGORY_INDUSTRY_MAP: Dict[str, Dict[str, Any]] = {
    # ── 食品调味品 ──
    "酱油调味品": {"industry": "food_seasoning",
                "must_include": ["调味", "酱油", "食醋", "蚝油", "调味料", "酱料", "豆瓣酱", "辣椒酱"],
                "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "食品调味品": {"industry": "food_seasoning",
                "must_include": ["调味", "酱油", "食醋", "蚝油", "调味料", "酱料"],
                "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "酱油": {"industry": "food_seasoning",
            "must_include": ["调味", "酱油", "豆豉", "食醋"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "食醋": {"industry": "food_seasoning",
            "must_include": ["调味", "食醋", "醋"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "蚝油": {"industry": "food_seasoning",
            "must_include": ["调味", "蚝油"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "辣椒酱": {"industry": "food_seasoning",
            "must_include": ["调味", "辣椒酱", "酱料", "酱"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "芝麻油": {"industry": "food_oil",
            "must_include": ["调味", "芝麻油", "香油", "食用油"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "调味品": {"industry": "food_seasoning",
            "must_include": ["调味", "酱油", "食醋", "蚝油"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "食盐": {"industry": "food_seasoning",
            "must_include": ["食盐", "盐", "调味"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["工业盐", "氯化钠工业"]},
    "白砂糖": {"industry": "food_seasoning",
            "must_include": ["白砂糖", "食糖", "糖", "调味"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "味精鸡精": {"industry": "food_seasoning",
            "must_include": ["味精", "鸡精", "调味"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "食用油": {"industry": "food_oil",
            "must_include": ["食用油", "植物油", "调和油", "油脂"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["润滑油", "燃料油", "工业油"]},
    # ── 乳制品 ──
    "牛奶": {"industry": "food_dairy",
            "must_include": ["乳", "奶", "乳制品", "乳粉"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["饲料", "原料乳"]},
    "酸奶": {"industry": "food_dairy",
            "must_include": ["乳", "酸奶", "发酵乳", "乳酸菌"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "奶酪": {"industry": "food_dairy",
            "must_include": ["乳", "干酪", "奶酪", "再制干酪"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 粮食 / 主食 ──
    "大米": {"industry": "food_grain",
            "must_include": ["大米", "稻米", "粮食", "稻谷"],
            "must_exclude": _EXCLUDE_AGRO + ["种子", "栽培", "种植"]},
    "面粉": {"industry": "food_grain",
            "must_include": ["面粉", "小麦粉", "粮食", "粮油"],
            "must_exclude": _EXCLUDE_AGRO + ["种子", "栽培"]},
    # ── 烘焙 / 零食 ──
    "面包": {"industry": "food_bakery",
            "must_include": ["面包", "糕点", "烘焙", "焙烤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "饼干": {"industry": "food_bakery",
            "must_include": ["饼干", "糕点", "焙烤", "烘焙"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "薯片": {"industry": "food_snack",
            "must_include": ["膨化食品", "薯片", "休闲食品", "食品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "巧克力": {"industry": "food_snack",
            "must_include": ["巧克力", "糖果", "可可"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "坚果": {"industry": "food_snack",
            "must_include": ["坚果", "干果", "炒货", "休闲食品"],
            "must_exclude": _EXCLUDE_AGRO + ["种植", "栽培", "采收"]},
    "蜜饯果干": {"industry": "food_snack",
            "must_include": ["蜜饯", "果干", "果脯", "休闲食品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 速冻 / 罐头 / 肉制品 ──
    "冷冻食品": {"industry": "food_frozen",
            "must_include": ["速冻", "冷冻食品", "速食", "速冻面米"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "罐头": {"industry": "food_canned",
            "must_include": ["罐头", "罐头食品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "火腿肠": {"industry": "food_meat",
            "must_include": ["火腿", "肉制品", "肠", "腌腊"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["饲料"]},
    "豆制品": {"industry": "food_grain",
            "must_include": ["豆制品", "豆腐", "大豆制品", "豆"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "鸡蛋": {"industry": "food_egg",
            "must_include": ["蛋", "鸡蛋", "蛋制品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["饲料", "兽药"]},
    "方便面": {"industry": "food_grain",
            "must_include": ["方便面", "方便食品", "速食面"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 饮料 ──
    "饮料冲调": {"industry": "beverage",
            "must_include": ["饮料", "饮品", "饮用水", "果汁", "茶", "咖啡", "冲调"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "矿泉水": {"industry": "beverage",
            "must_include": ["矿泉水", "饮用水", "包装饮用水"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["污水", "工业用水"]},
    "饮用水": {"industry": "beverage",
            "must_include": ["饮用水", "包装饮用水", "纯净水"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["污水"]},
    "碳酸饮料": {"industry": "beverage",
            "must_include": ["碳酸饮料", "汽水", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "果汁": {"industry": "beverage",
            "must_include": ["果汁", "果蔬汁", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "茶饮料": {"industry": "beverage",
            "must_include": ["茶饮料", "茶", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["茶叶种植", "茶叶栽培"]},
    "茶叶": {"industry": "beverage",
            "must_include": ["茶叶", "茶", "茶饮料"],
            "must_exclude": _EXCLUDE_AGRO + ["茶叶栽培", "茶园"]},
    "咖啡": {"industry": "beverage",
            "must_include": ["咖啡", "咖啡饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "植物蛋白饮料": {"industry": "beverage",
            "must_include": ["植物蛋白", "豆奶", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "椰汁": {"industry": "beverage",
            "must_include": ["椰汁", "椰子", "植物蛋白", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "燕麦奶": {"industry": "beverage",
            "must_include": ["燕麦", "植物蛋白", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "功能饮料": {"industry": "beverage",
            "must_include": ["功能饮料", "运动饮料", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "奶茶": {"industry": "beverage",
            "must_include": ["奶茶", "茶饮料", "饮料"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 酒类 ──
    "啤酒": {"industry": "alcohol",
            "must_include": ["啤酒", "酒"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "葡萄酒": {"industry": "alcohol",
            "must_include": ["葡萄酒", "酒"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["葡萄种植", "葡萄园"]},
    "白酒": {"industry": "alcohol",
            "must_include": ["白酒", "酒"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["工业酒精"]},
    "黄酒": {"industry": "alcohol",
            "must_include": ["黄酒", "料酒", "酒"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 日化 / 洗护 ──
    "洗护清洁": {"industry": "daily_chem",
            "must_include": ["洗涤", "洗发", "沐浴", "护发", "洗护", "皂", "牙膏", "化妆品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["工业洗涤剂"]},
    "洗发水": {"industry": "daily_chem",
            "must_include": ["洗发", "护发", "化妆品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "护发素": {"industry": "daily_chem",
            "must_include": ["护发", "洗发", "化妆品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "沐浴露": {"industry": "daily_chem",
            "must_include": ["沐浴", "洗涤", "化妆品", "洗护"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "牙膏": {"industry": "daily_chem",
            "must_include": ["牙膏", "口腔", "化妆品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "漱口水": {"industry": "daily_chem",
            "must_include": ["漱口", "口腔", "化妆品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "洗衣液": {"industry": "daily_chem",
            "must_include": ["洗涤剂", "洗衣", "洗涤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["工业洗涤剂"]},
    "洗衣凝珠": {"industry": "daily_chem",
            "must_include": ["洗涤剂", "洗衣", "洗涤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["工业洗涤剂"]},
    "洗洁精": {"industry": "daily_chem",
            "must_include": ["餐具洗涤剂", "洗洁精", "洗涤剂"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "洁厕剂": {"industry": "daily_chem",
            "must_include": ["洁厕", "清洁剂", "洗涤剂"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "纸巾": {"industry": "paper",
            "must_include": ["纸", "纸巾", "卫生纸", "面巾纸"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["造纸工业", "纸浆"]},
    "卫生纸": {"industry": "paper",
            "must_include": ["卫生纸", "纸"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["造纸工业"]},
    "湿巾": {"industry": "paper",
            "must_include": ["湿巾", "纸巾", "卫生用品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "卫生巾": {"industry": "paper",
            "must_include": ["卫生巾", "卫生用品", "经期"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 母婴 ──
    "母婴用品": {"industry": "mother_baby",
            "must_include": ["婴幼儿", "婴儿", "儿童", "奶粉", "配方", "纸尿裤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "奶粉": {"industry": "mother_baby",
            "must_include": ["奶粉", "乳粉", "婴幼儿", "婴儿", "配方"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["饲料"]},
    "婴幼儿配方奶粉": {"industry": "mother_baby",
            "must_include": ["婴幼儿", "婴儿", "配方", "乳粉", "奶粉"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["饲料"]},
    "纸尿裤": {"industry": "mother_baby",
            "must_include": ["纸尿裤", "拉拉裤", "婴儿"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "婴儿辅食": {"industry": "mother_baby",
            "must_include": ["婴幼儿", "辅食", "婴儿"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 个护 / 化妆品 ──
    "面霜": {"industry": "cosmetics",
            "must_include": ["化妆品", "护肤", "面霜", "乳液"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "面膜": {"industry": "cosmetics",
            "must_include": ["化妆品", "面膜", "护肤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "防晒霜": {"industry": "cosmetics",
            "must_include": ["化妆品", "防晒", "护肤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "身体乳": {"industry": "cosmetics",
            "must_include": ["化妆品", "护肤", "乳液", "身体乳"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "护手霜": {"industry": "cosmetics",
            "must_include": ["化妆品", "护肤", "护手"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "免洗洗手液": {"industry": "cosmetics",
            "must_include": ["洗手液", "化妆品", "消毒"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "隐形眼镜护理液": {"industry": "medical_device",
            "must_include": ["隐形眼镜", "角膜接触镜", "护理液"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "护肤品/化妆品": {"industry": "cosmetics",
            "must_include": ["化妆品", "护肤"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 生鲜 ──
    "水果": {"industry": "fresh",
            "must_include": ["鲜", "水果", "果品"],
            "must_exclude": _EXCLUDE_AGRO + ["种植", "栽培", "采收", "果园"]},
    "蔬菜": {"industry": "fresh",
            "must_include": ["蔬菜", "鲜菜"],
            "must_exclude": _EXCLUDE_AGRO + ["种植", "栽培", "菜地"]},
    "肉类": {"industry": "fresh",
            "must_include": ["鲜肉", "畜禽", "肉", "肉品"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL + ["饲料", "屠宰场"]},
    "猪肉": {"industry": "fresh",
            "must_include": ["猪肉", "鲜肉", "畜禽肉"],
            "must_exclude": _EXCLUDE_AGRO + ["饲料", "养殖"]},
    "牛肉": {"industry": "fresh",
            "must_include": ["牛肉", "鲜肉", "畜禽肉"],
            "must_exclude": _EXCLUDE_AGRO + ["饲料", "养殖"]},
    "鸡肉": {"industry": "fresh",
            "must_include": ["鸡肉", "禽肉", "鲜肉"],
            "must_exclude": _EXCLUDE_AGRO + ["饲料", "养殖"]},
    "水产海鲜": {"industry": "fresh",
            "must_include": ["水产", "海鲜", "鱼", "虾", "贝"],
            "must_exclude": _EXCLUDE_AGRO + ["饲料", "养殖", "渔业捕捞"]},
    "虾": {"industry": "fresh",
            "must_include": ["虾", "水产"],
            "must_exclude": _EXCLUDE_AGRO + ["饲料", "养殖"]},
    "冻品": {"industry": "food_frozen",
            "must_include": ["速冻", "冷冻食品", "冻"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    # ── 五金 / 家电 / 建材（保留宽松规则） ──
    "杯壶容器": {"industry": "kitchenware",
            "must_include": ["保温杯", "杯", "容器", "炊具", "食品接触"],
            "must_exclude": _EXCLUDE_AGRO},
    "保温杯": {"industry": "kitchenware",
            "must_include": ["保温", "杯", "食品接触"],
            "must_exclude": _EXCLUDE_AGRO},
    "炊具": {"industry": "kitchenware",
            "must_include": ["炊具", "厨具", "食品接触"],
            "must_exclude": _EXCLUDE_AGRO},
    "炊具厨具": {"industry": "kitchenware",
            "must_include": ["炊具", "厨具", "食品接触"],
            "must_exclude": _EXCLUDE_AGRO},
    "LED灯": {"industry": "appliance",
            "must_include": ["LED", "照明", "灯"],
            "must_exclude": _EXCLUDE_AGRO},
    "LED照明": {"industry": "appliance",
            "must_include": ["LED", "照明", "灯"],
            "must_exclude": _EXCLUDE_AGRO},
    "电线": {"industry": "appliance",
            "must_include": ["电线", "电缆"],
            "must_exclude": _EXCLUDE_AGRO},
    "电线电缆": {"industry": "appliance",
            "must_include": ["电线", "电缆"],
            "must_exclude": _EXCLUDE_AGRO},
    "水龙头": {"industry": "hardware",
            "must_include": ["水龙头", "水嘴", "卫浴", "陶瓷片密封"],
            "must_exclude": _EXCLUDE_AGRO},
    "卫浴洁具": {"industry": "hardware",
            "must_include": ["卫浴", "洁具", "陶瓷"],
            "must_exclude": _EXCLUDE_AGRO},
    "瓷砖": {"industry": "hardware",
            "must_include": ["瓷砖", "陶瓷砖", "建筑陶瓷"],
            "must_exclude": _EXCLUDE_AGRO},
    "涂料": {"industry": "hardware",
            "must_include": ["涂料", "建筑涂料", "油漆"],
            "must_exclude": _EXCLUDE_AGRO},
    "建筑涂料": {"industry": "hardware",
            "must_include": ["涂料", "建筑涂料"],
            "must_exclude": _EXCLUDE_AGRO},
    "口罩": {"industry": "medical_device",
            "must_include": ["口罩", "防护"],
            "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "玻璃水": {"industry": "auto",
            "must_include": ["玻璃水", "汽车", "玻璃清洗"],
            "must_exclude": _EXCLUDE_AGRO},
}


# 行业 → 风险方向（general 模式下展示给用户）
INDUSTRY_RISK_DIRECTIONS: Dict[str, List[str]] = {
    "food_seasoning": [
        "食品安全国家标准 GB 2760 食品添加剂使用标准",
        "食品安全国家标准 GB 7718 预包装食品标签通则",
        "食品安全国家标准 GB 28050 预包装食品营养标签通则",
        "对应品类的产品执行标准（具体见包装上的执行标准号）",
    ],
    "food_oil": [
        "食品安全国家标准 GB 2716 植物油",
        "食品安全国家标准 GB 7718 预包装食品标签通则",
        "对应油种的产品执行标准（食用植物油 / 调和油 / 橄榄油 等）",
    ],
    "food_dairy": [
        "食品安全国家标准 GB 25190 灭菌乳 / GB 19645 巴氏杀菌乳",
        "食品安全国家标准 GB 19302 发酵乳",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "food_grain": [
        "食品安全国家标准 GB 2715 粮食",
        "对应主食的产品标准（大米 GB/T 1354 / 小麦粉 GB/T 1355）",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "food_bakery": [
        "食品安全国家标准 GB 7099 糕点、面包",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
        "食品安全国家标准 GB 2760 食品添加剂使用",
    ],
    "food_snack": [
        "食品安全国家标准 GB 17401 膨化食品 / GB 9678 巧克力 / GB 19300 坚果",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "food_frozen": [
        "食品安全国家标准 GB 19295 速冻面米与调制食品",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "food_canned": [
        "食品安全国家标准 GB 7098 罐头食品",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "food_meat": [
        "食品安全国家标准 GB 2726 熟肉制品",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "food_egg": [
        "食品安全国家标准 GB 2749 蛋与蛋制品",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "beverage": [
        "食品安全国家标准 GB 7101 饮料",
        "食品安全国家标准 GB 19298 包装饮用水",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
        "对应品类的产品执行标准（具体见包装）",
    ],
    "alcohol": [
        "对应酒种的产品标准（GB/T 4927 啤酒 / GB/T 15037 葡萄酒 / GB/T 10781 白酒 等）",
        "食品安全国家标准 GB 2758 发酵酒及其配制酒 / GB 2757 蒸馏酒及其配制酒",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "daily_chem": [
        "化妆品 GB 5296.3 消费品使用说明",
        "化妆品安全技术规范（国家药监局发布）",
        "对应品类的产品标准（洗发水 GB/T 29679 / 牙膏 GB 8372 等）",
    ],
    "paper": [
        "GB/T 20810 卫生纸 / GB/T 20808 纸巾纸",
        "对应产品的卫生标准与材料安全规范",
    ],
    "mother_baby": [
        "食品安全国家标准 GB 10765 / GB 10766 / GB 10767 婴幼儿配方食品",
        "GB/T 38790 卫生巾、纸尿裤等卫生用品的执行标准",
        "食品安全国家标准 GB 7718 / GB 28050 标签和营养标签",
    ],
    "cosmetics": [
        "化妆品安全技术规范（国家药监局发布）",
        "GB 5296.3 消费品使用说明 化妆品",
        "对应品类的产品标准",
    ],
    "medical_device": [
        "医疗器械产品注册标准（NMPA 监管）",
        "对应品类的国家行业标准（GB / YY 系列）",
    ],
    "fresh": [
        "食品安全国家标准 GB 2762 食品中污染物限量",
        "食品安全国家标准 GB 2763 食品中农药最大残留限量",
        "对应品类的产品执行标准（具体见包装）",
    ],
    "kitchenware": [
        "食品安全国家标准 GB 4806 系列 食品接触材料及制品",
        "对应材质的产品标准（不锈钢 GB/T 17117 / 玻璃 GB/T 17374 等）",
    ],
    "appliance": [
        "GB 4706 家用和类似用途电器的安全",
        "GB 4943 信息技术设备安全",
        "对应品类的能效与电磁兼容标准",
    ],
    "hardware": [
        "对应品类的国家行业标准（GB / JC / JG 系列）",
    ],
    "auto": [
        "对应品类的汽车行业标准（GB / QC 系列）",
    ],
}


def _resolve_industry_meta(label: Optional[str]) -> Optional[Dict[str, Any]]:
    """根据品类 label 取行业 meta；找不到返回 None。"""
    if not label:
        return None
    return CATEGORY_INDUSTRY_MAP.get(label)


# 通用负向词：即使没有行业 meta，这些标准名也应该被排除（扫一扫场景不可能匹配到这些）
_GLOBAL_EXCLUDE_NAMES = [
    "比例尺", "地图", "测绘", "矿山", "冶金", "钢铁", "焊接", "锅炉", "石油",
    "天然气", "电力工程", "建筑施工", "水利", "铁路", "公路工程", "船舶",
    "航空", "航天", "核能", "军用", "弹药", "烟草", "烟花爆竹",
]


def _filter_standards_by_industry(
    standards: List[Dict[str, Any]],
    industry_meta: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    用行业大类白名单过滤 pyapi 返回的标准列表。
    - 没有 industry_meta → 仅做通用负向过滤（排除明显不相关）
    - 有 industry_meta → must_include + must_exclude 双向过滤
    """
    if not industry_meta:
        # 无行业 meta 时仍做通用负向过滤
        return [s for s in standards
                if not any(neg in (s.get("name") or "") for neg in _GLOBAL_EXCLUDE_NAMES)]
    must_in = industry_meta.get("must_include") or []
    must_out = industry_meta.get("must_exclude") or []
    if not must_in:
        return standards
    out: List[Dict[str, Any]] = []
    for s in standards:
        name = (s.get("name") or "").strip()
        if not name:
            continue
        if any(neg in name for neg in must_out):
            continue
        if not any(pos in name for pos in must_in):
            continue
        out.append(s)
    return out


def _industry_token_for_label(label: Optional[str]) -> Optional[str]:
    meta = _resolve_industry_meta(label)
    if not meta:
        return None
    return meta.get("industry")


def _risk_directions_for_industry(token: Optional[str]) -> List[str]:
    if not token:
        return [
            "请以商品包装上印刷的产品执行标准为准",
            "拍照识别仅作分类参考，不构成购买建议",
        ]
    return INDUSTRY_RISK_DIRECTIONS.get(token, [
        "请以商品包装上印刷的产品执行标准为准",
        "对应行业暂无通用方向归纳，建议结合包装信息核对",
    ])


# ─── 品牌词 → 商品类目映射（优先级高于类目词纠偏）──────────
# 作用：OCR 里出现品牌名时，直接锁定商品类目，不再依赖 CLIP 或模糊关键词。
# 维护：按品牌名 → display_label 映射，display_label 必须在 CATEGORY_INDUSTRY_MAP 里有对应条目。
_BRAND_CATEGORY_MAP: Dict[str, str] = {
    # ── 口腔护理 ──
    "高露洁": "牙膏", "佳洁士": "牙膏", "云南白药": "牙膏", "黑人": "牙膏", "舒客": "牙膏",
    "冷酸灵": "牙膏", "中华": "牙膏", "舒适达": "牙膏", "皓乐齿": "牙膏",
    "李施德林": "漱口水", "比那氏": "漱口水",
    # ── 洗护 ──
    "海飞丝": "洗发水", "潘婷": "洗发水", "飘柔": "洗发水", "清扬": "洗发水", "沙宣": "洗发水",
    "力士": "沐浴露", "多芬": "沐浴露", "舒肤佳": "沐浴露", "六神": "沐浴露",
    "滴露": "洗衣液", "威露士": "洗衣液", "蓝月亮": "洗衣液", "立白": "洗衣液", "奥妙": "洗衣液",
    "超能": "洗衣液", "汰渍": "洗衣液",
    "白猫": "洗洁精", "雕牌": "洗洁精", "妈妈壹选": "洗洁精",
    # ── 调味品 ──
    "海天": "酱油调味品", "李锦记": "酱油调味品", "厨邦": "酱油调味品", "千禾": "食醋",
    "恒顺": "食醋", "太太乐": "味精鸡精", "家乐": "调味品",
    "鲁花": "食用油", "金龙鱼": "食用油", "福临门": "食用油", "多力": "食用油",
    # ── 乳制品 ──
    "伊利": "牛奶", "蒙牛": "牛奶", "光明": "牛奶", "三元": "牛奶", "君乐宝": "酸奶",
    "安慕希": "酸奶", "纯甄": "酸奶", "特仑苏": "牛奶", "金典": "牛奶",
    "飞鹤": "婴幼儿配方奶粉", "美赞臣": "婴幼儿配方奶粉", "惠氏": "婴幼儿配方奶粉",
    "爱他美": "婴幼儿配方奶粉", "美素佳儿": "婴幼儿配方奶粉", "合生元": "婴幼儿配方奶粉",
    "a2": "婴幼儿配方奶粉",
    # ── 饮料 ──
    "农夫山泉": "矿泉水", "百岁山": "矿泉水", "怡宝": "矿泉水", "娃哈哈": "矿泉水",
    "可口可乐": "碳酸饮料", "百事可乐": "碳酸饮料", "雪碧": "碳酸饮料", "芬达": "碳酸饮料",
    "美汁源": "果汁", "汇源": "果汁", "味全": "果汁",
    "康师傅": "茶饮料", "统一": "茶饮料", "东方树叶": "茶饮料", "王老吉": "茶饮料", "加多宝": "茶饮料",
    "雀巢": "咖啡", "星巴克": "咖啡", "瑞幸": "咖啡",
    "红牛": "功能饮料", "东鹏": "功能饮料", "脉动": "功能饮料", "外星人": "功能饮料",
    "椰树": "椰汁", "特种兵": "椰汁",
    # ── 酒类 ──
    "茅台": "白酒", "五粮液": "白酒", "泸州老窖": "白酒", "汾酒": "白酒", "剑南春": "白酒",
    "青岛啤酒": "啤酒", "雪花啤酒": "啤酒", "百威": "啤酒", "哈尔滨啤酒": "啤酒", "燕京": "啤酒",
    "张裕": "葡萄酒", "长城": "葡萄酒",
    # ── 零食 / 烘焙 ──
    "乐事": "薯片", "品客": "薯片", "好丽友": "饼干", "奥利奥": "饼干", "旺旺": "饼干",
    "德芙": "巧克力", "费列罗": "巧克力", "士力架": "巧克力",
    "三只松鼠": "坚果", "百草味": "坚果", "良品铺子": "坚果",
    "桃李": "面包", "达利园": "面包",
    # ── 方便食品 / 粮油 ──
    "康师傅方便面": "方便面", "今麦郎": "方便面", "统一方便面": "方便面",
    "金沙河": "面粉", "五得利": "面粉", "北大荒": "大米", "十月稻田": "大米",
    # ── 个护 / 美妆 ──
    "百雀羚": "面霜", "相宜本草": "面霜", "自然堂": "面霜", "丸美": "面霜",
    "妮维雅": "面霜", "欧莱雅": "面霜", "玉兰油": "面霜",
    "美肤宝": "防晒霜", "安耐晒": "防晒霜", "曼秀雷敦": "防晒霜",
    # ── 纸品 / 母婴 ──
    "维达": "纸巾", "清风": "纸巾", "心相印": "纸巾", "洁柔": "纸巾",
    "苏菲": "卫生巾", "护舒宝": "卫生巾", "七度空间": "卫生巾", "自由点": "卫生巾",
    "帮宝适": "纸尿裤", "花王": "纸尿裤", "大王": "纸尿裤", "好奇": "纸尿裤",
    # ── 医药 ──
    "新乐敦": "滴眼液", "乐敦": "滴眼液", "珍视明": "滴眼液", "闪亮": "滴眼液",
    "ROHTO": "滴眼液", "rohto": "滴眼液",
    "999": "OTC药品", "三九": "OTC药品", "同仁堂": "OTC药品", "云南白药": "OTC药品",
    # ── 宠物 ──
    "皇家": "宠物食品", "冠能": "宠物食品", "伯纳天纯": "宠物食品", "麦富迪": "宠物食品",
    # ── 其他 ──
    "南孚": "电池", "金霸王": "电池", "松下": "电池",
    "妙洁": "保鲜膜", "旭包鲜": "保鲜膜",
}

# 加载扩展品牌库（从 104 万条中国商品条码数据提取的 4435 个品牌→品类映射）
# 手工维护的 _BRAND_CATEGORY_MAP 优先级高于扩展库（放在前面，匹配时先命中）
_BRAND_EXT_PATH = Path(__file__).parent / "brand_category_extended.json"
if _BRAND_EXT_PATH.exists():
    import json as _json
    with open(_BRAND_EXT_PATH, "r", encoding="utf-8") as _f:
        _ext_brands: Dict[str, str] = _json.load(_f)
    # 扩展库不覆盖手工库已有的品牌
    for _b, _c in _ext_brands.items():
        _BRAND_CATEGORY_MAP.setdefault(_b, _c)
    log.info(f"[brand] 加载扩展品牌库 {len(_ext_brands)} 条，合并后总计 {len(_BRAND_CATEGORY_MAP)} 个品牌")

# 补充缺失的品类到 CATEGORY_INDUSTRY_MAP
_EXTRA_CATEGORIES: Dict[str, Dict[str, Any]] = {
    "牙刷": {"industry": "daily_chem", "must_include": ["牙刷", "口腔"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "味精鸡精": {"industry": "food_seasoning", "must_include": ["味精", "鸡精", "调味"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "饮料冲调": {"industry": "beverage", "must_include": ["饮料", "饮品", "冲调", "麦片", "燕麦"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "巧克力": {"industry": "food_snack", "must_include": ["巧克力", "糖果", "可可"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "方便面": {"industry": "food_grain", "must_include": ["方便面", "方便食品", "速食"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "滴眼液": {"industry": "medical_device", "must_include": ["滴眼", "眼", "眼药", "眼科"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "OTC药品": {"industry": "medical_device", "must_include": ["药", "OTC", "非处方", "口服", "胶囊", "片剂"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "创可贴": {"industry": "medical_device", "must_include": ["创可贴", "创面", "敷料", "医疗器械"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "药膏": {"industry": "medical_device", "must_include": ["药", "膏", "软膏", "外用"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "鼻喷雾": {"industry": "medical_device", "must_include": ["鼻", "喷雾", "生理盐水"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "隐形眼镜护理液": {"industry": "medical_device", "must_include": ["隐形眼镜", "护理液", "角膜"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "宠物食品": {"industry": "pet_food", "must_include": ["宠物", "犬", "猫", "饲料", "宠物食品"], "must_exclude": _EXCLUDE_INDUSTRIAL},
    "电池": {"industry": "appliance", "must_include": ["电池", "蓄电池", "碱性电池"], "must_exclude": _EXCLUDE_AGRO},
    "保鲜膜": {"industry": "kitchenware", "must_include": ["保鲜膜", "保鲜袋", "食品接触"], "must_exclude": _EXCLUDE_AGRO},
    "消毒液": {"industry": "daily_chem", "must_include": ["消毒", "杀菌", "卫生"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "洗衣粉": {"industry": "daily_chem", "must_include": ["洗衣粉", "洗涤", "洗衣"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "香皂": {"industry": "daily_chem", "must_include": ["香皂", "肥皂", "皂"], "must_exclude": _EXCLUDE_AGRO + _EXCLUDE_INDUSTRIAL},
    "挂面": {"industry": "food_grain", "must_include": ["挂面", "面条", "粮食"], "must_exclude": _EXCLUDE_AGRO},
}
CATEGORY_INDUSTRY_MAP.update(_EXTRA_CATEGORIES)

# 补充 INDUSTRY_RISK_DIRECTIONS 缺的行业
INDUSTRY_RISK_DIRECTIONS.setdefault("pet_food", [
    "宠物饲料行业标准（GB/T 31216 / GB/T 31217 等）",
    "宠物食品卫生标准",
])

# ─── 构建 Aho-Corasick 自动机（品牌匹配加速） ───
_AC_CATEGORY_BRANDS = None       # 有品类映射的品牌（raw text）
_AC_SIGNAL_BRANDS = None         # 无品类映射的品牌（raw text）
_AC_CATEGORY_BRANDS_NORM = None  # 有品类映射的品牌（normalized text）
_AC_SIGNAL_BRANDS_NORM = None    # 无品类映射的品牌（normalized text）

if _HAS_AHOCORASICK:
    def _build_ac_automaton(entries: list[tuple[str, str, Optional[str]]]) -> "ahocorasick.Automaton":
        """Build an Aho-Corasick automaton from (pattern, brand_name, category) tuples."""
        ac = ahocorasick.Automaton()
        for pattern, brand_name, category in entries:
            if pattern and len(pattern) >= 2:
                ac.add_word(pattern, (brand_name, category))
        ac.make_automaton()
        return ac

    _cat_entries_raw: list[tuple[str, str, Optional[str]]] = []
    _sig_entries_raw: list[tuple[str, str, Optional[str]]] = []
    _cat_entries_norm: list[tuple[str, str, Optional[str]]] = []
    _sig_entries_norm: list[tuple[str, str, Optional[str]]] = []

    _CN_CHAR_RE = re.compile(r'[\u4e00-\u9fff]')
    try:
        for _brand_name, _brand_cat in _BRAND_CATEGORY_MAP.items():
            _has_cn = bool(_CN_CHAR_RE.search(_brand_name))
            if _has_cn and len(_brand_name) < 2:
                continue
            if not _has_cn and len(_brand_name) < 3:
                continue
            _has_cat = _brand_cat in CATEGORY_INDUSTRY_MAP
            _norm_brand = normalize_ocr_text(_brand_name)
            if _has_cat:
                _cat_entries_raw.append((_brand_name, _brand_name, _brand_cat))
                if _norm_brand and len(_norm_brand) >= 2:
                    _cat_entries_norm.append((_norm_brand, _brand_name, _brand_cat))
            else:
                _sig_entries_raw.append((_brand_name, _brand_name, _brand_cat))
                if _norm_brand and len(_norm_brand) >= 2:
                    _sig_entries_norm.append((_norm_brand, _brand_name, _brand_cat))

        if _cat_entries_raw:
            _AC_CATEGORY_BRANDS = _build_ac_automaton(_cat_entries_raw)
        if _sig_entries_raw:
            _AC_SIGNAL_BRANDS = _build_ac_automaton(_sig_entries_raw)
        if _cat_entries_norm:
            _AC_CATEGORY_BRANDS_NORM = _build_ac_automaton(_cat_entries_norm)
        if _sig_entries_norm:
            _AC_SIGNAL_BRANDS_NORM = _build_ac_automaton(_sig_entries_norm)

        _AC_STATS = {
            "aho_enabled": True,
            "automaton_loaded": True,
            "category_brand_count": len(_cat_entries_raw),
            "signal_brand_count": len(_sig_entries_raw),
            "category_norm_count": len(_cat_entries_norm),
            "signal_norm_count": len(_sig_entries_norm),
        }
        log.info(
            f"[brand-ac] ✅ AHO_ENABLED=true automaton_loaded=true "
            f"category_brands={_AC_STATS['category_brand_count']} "
            f"signal_brands={_AC_STATS['signal_brand_count']}"
        )
        del _cat_entries_raw, _sig_entries_raw, _cat_entries_norm, _sig_entries_norm
    except Exception as _ac_err:
        _AC_STATS = {"aho_enabled": False, "automaton_loaded": False, "error": str(_ac_err)}
        log.error(f"[brand-ac] ❌ AHO_ENABLED=false automaton build FAILED: {_ac_err}", exc_info=True)
else:
    _AC_STATS = {"aho_enabled": False, "automaton_loaded": False, "reason": "pyahocorasick not installed"}
    log.warning("[brand-ac] ⚠️ AHO_ENABLED=false — pyahocorasick NOT installed, using LINEAR SCAN fallback")


def _brand_match_all(text: str) -> list[dict]:
    """
    Aho-Corasick multi-pattern match. Returns all brand matches from OCR text.
    Each match: {"brand": str, "category": str|None, "has_category": bool,
                 "start": int, "end": int, "normalized_match": bool}
    Sorted by brand name length descending (longer matches first).
    """
    if not text:
        return []

    results: dict[str, dict] = {}  # keyed by brand name for dedup

    if _HAS_AHOCORASICK:
        # Pass 1: raw text (whitespace normalized only)
        cleaned = re.sub(r"[\s\n]+", " ", text).strip()
        if cleaned:
            for ac, has_cat in [(_AC_CATEGORY_BRANDS, True), (_AC_SIGNAL_BRANDS, False)]:
                if ac is None:
                    continue
                for end_idx, (brand_name, category) in ac.iter(cleaned):
                    start_idx = end_idx - len(brand_name) + 1
                    if brand_name not in results:
                        results[brand_name] = {
                            "brand": brand_name,
                            "category": category,
                            "has_category": has_cat,
                            "start": start_idx,
                            "end": end_idx + 1,
                            "normalized_match": False,
                        }

        # Pass 2: normalized text
        norm_text = normalize_ocr_text(text)
        if norm_text:
            for ac, has_cat in [(_AC_CATEGORY_BRANDS_NORM, True), (_AC_SIGNAL_BRANDS_NORM, False)]:
                if ac is None:
                    continue
                for end_idx, (brand_name, category) in ac.iter(norm_text):
                    if brand_name not in results:
                        results[brand_name] = {
                            "brand": brand_name,
                            "category": category,
                            "has_category": has_cat,
                            "start": end_idx - len(normalize_ocr_text(brand_name)) + 1,
                            "end": end_idx + 1,
                            "normalized_match": True,
                        }
    else:
        # Fallback: linear scan (no ahocorasick installed)
        cleaned = re.sub(r"[\s\n]+", " ", text).strip()
        if cleaned:
            for brand_name in sorted(_BRAND_CATEGORY_MAP.keys(), key=len, reverse=True):
                if len(brand_name) < 2:
                    continue
                if brand_name in cleaned:
                    category = _BRAND_CATEGORY_MAP[brand_name]
                    has_cat = category in CATEGORY_INDUSTRY_MAP
                    pos = cleaned.index(brand_name)
                    results[brand_name] = {
                        "brand": brand_name,
                        "category": category,
                        "has_category": has_cat,
                        "start": pos,
                        "end": pos + len(brand_name),
                        "normalized_match": False,
                    }

    # 过滤常见通用词误匹配（这些词虽然在品牌库中存在，但太泛，容易误中）
    _GENERIC_WORDS = {"牛奶", "酸奶", "面包", "饼干", "月亮", "可口", "黄金", "国产", "中国",
                      "红色", "蓝色", "金色", "黑色", "白色", "通用", "日用", "经典", "标准"}
    filtered = {k: v for k, v in results.items() if k not in _GENERIC_WORDS}

    # Sort by brand name length descending (longer matches = more specific)
    return sorted(filtered.values(), key=lambda m: len(m["brand"]), reverse=True)


def _brand_category_override(ocr_text: str) -> tuple[Optional[str], Optional[str]]:
    """
    Backwards-compatible wrapper. Returns first category-brand match as (brand_name, category).
    未命中返回 (None, None)。
    """
    matches = _brand_match_all(ocr_text)
    for m in matches:
        if m["has_category"]:
            return m["brand"], m["category"]
    return None, None


# ─── 487K 元数据召回 + 重排 + 富化 ──────────────────────────────

# 标准章节模式提取正则
_FOCUS_TOPIC_RE = re.compile(r"([\u4e00-\u9fff]{2,6}(?:指标|要求|限量|含量|方法|规格|检验|测定|试验|限度|规定))")

# 行业 → 推荐章节
_SUGGESTED_SECTIONS_MAP: Dict[str, List[str]] = {
    "food": ["范围", "技术要求", "检验方法", "标签"],
    "food_seasoning": ["范围", "技术要求", "检验方法", "标签"],
    "food_snack": ["范围", "技术要求", "检验方法", "标签"],
    "food_baked": ["范围", "技术要求", "检验方法", "标签"],
    "food_instant": ["范围", "技术要求", "检验方法", "标签"],
    "food_frozen": ["范围", "技术要求", "检验方法", "标签"],
    "food_canned": ["范围", "技术要求", "检验方法", "标签"],
    "dairy": ["范围", "技术要求", "检验方法", "标签"],
    "infant_formula": ["范围", "技术要求", "检验方法", "标签"],
    "beverage": ["范围", "技术要求", "检验方法", "标签"],
    "alcohol": ["范围", "技术要求", "检验方法", "标签"],
    "daily_chem": ["范围", "技术要求", "试验方法"],
    "oral_care": ["范围", "技术要求", "试验方法"],
    "cosmetics": ["范围", "技术要求", "试验方法", "标签"],
    "pet_food": ["范围", "技术要求", "检验方法", "标签"],
}


def _search_metadata(
    keywords: List[str],
    industry_meta: Optional[Dict[str, Any]],
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """
    在 487K _META_CACHE 中按关键词搜索标准名称，返回带 match_score 的候选列表。
    快速路径：遍历 _META_CACHE（dict），对 name 做关键词匹配 + 行业过滤。
    复杂度: O(N) 线性扫描 487K 条，带 COLLECT_CAP 提前退出。
    单次约 30-80ms。后续优化位：可建按品类首字/ICS 的倒排索引降到 O(K)。
    """
    _t0 = time.perf_counter()
    meta_cache = _report_mod._META_CACHE
    if not meta_cache or not keywords:
        return []

    must_in = (industry_meta.get("must_include") or []) if industry_meta else []
    must_out = (industry_meta.get("must_exclude") or []) if industry_meta else []

    # 预处理关键词（去重、转小写）
    kw_set = []
    seen_kw = set()
    for kw in keywords:
        k = kw.strip()
        if k and k not in seen_kw:
            seen_kw.add(k)
            kw_set.append(k)
    if not kw_set:
        return []

    candidates: List[Dict[str, Any]] = []
    # 收集上限：匹配够多就提前退出（避免全量遍历时间过长）
    _COLLECT_CAP = limit * 10

    for code, meta in meta_cache.items():
        name = meta.get("name") or ""
        if not name:
            continue

        # ── 行业负向过滤 ──
        if must_out and any(neg in name for neg in must_out):
            continue
        # 通用负向过滤
        if any(neg in name for neg in _GLOBAL_EXCLUDE_NAMES):
            continue

        # ── 关键词匹配打分 ──
        score = 0.0
        matched_kw = None
        for kw in kw_set:
            if kw == name:
                score = max(score, 5.0)
                matched_kw = matched_kw or kw
            elif kw in name:
                score = max(score, 3.0)
                matched_kw = matched_kw or kw

        if score == 0:
            # 尝试 ICS/CCS 名称匹配（弱信号）
            ics_name = meta.get("ics_name") or ""
            ccs_name = meta.get("ccs_name") or ""
            for kw in kw_set:
                if kw in ics_name or kw in ccs_name:
                    score = 1.0
                    matched_kw = matched_kw or kw
                    break

        if score == 0:
            continue

        # ── 行业正向加分 ──
        if must_in and any(pos in name for pos in must_in):
            score += 1.0

        # ── 状态加分 ──
        status = meta.get("status") or ""
        if status == "现行":
            score += 1.0
        elif status in ("作废", "废止"):
            score -= 0.5

        # ── GB 国标加分 ──
        if code.startswith("GB"):
            score += 0.5

        candidates.append({
            "code": code,
            "name": name,
            "status": status,
            "ics": meta.get("ics") or "",
            "ics_name": meta.get("ics_name") or "",
            "ccs": meta.get("ccs") or "",
            "ccs_name": meta.get("ccs_name") or "",
            "pub_date": meta.get("pub_date") or "",
            "match_score": round(score, 1),
            "_matched_kw": matched_kw,
            "_source": "metadata_487k",
        })

        if len(candidates) >= _COLLECT_CAP:
            break

    # 按分数降序排列，截断
    candidates.sort(key=lambda x: x["match_score"], reverse=True)
    _ms = (time.perf_counter() - _t0) * 1000
    log.info(f"[metadata-search] metadata_search_ms={_ms:.1f} candidates={len(candidates)} keywords={kw_set[:3]}")
    return candidates[:limit]


def _rerank_with_fulltext(
    candidates: List[Dict[str, Any]],
    category_label: Optional[str],
    industry_token: Optional[str],
) -> List[Dict[str, Any]]:
    """
    用 73K SQLite 的 scope + name 对候选做二次重排。
    不输出长文本片段（合规要求），只提取短标签和评分。
    """
    _t0 = time.perf_counter()
    if not candidates:
        return candidates

    for item in candidates:
        code = item["code"]
        boost = 0.0

        # 查 SQLite 73K（不再读 cleaned_text）
        try:
            row = db.conn.execute(
                "SELECT scope, name, pub_date FROM standards WHERE replace(code,' ','') = ? LIMIT 1",
                (re.sub(r"\s+", "", code),),
            ).fetchone()
        except Exception:
            row = None

        scope_text = ""
        name_text = ""
        if row:
            scope_text = (row["scope"] or "") if "scope" in row.keys() else ""
            name_text = (row["name"] or "") if "name" in row.keys() else ""
            # pub_date 补充（SQLite 可能有更准确的日期）
            _pub = row["pub_date"] if "pub_date" in row.keys() else None
            if _pub and not item.get("pub_date"):
                item["pub_date"] = _pub

            # scope 包含品类名 → +2
            if category_label and category_label in scope_text:
                boost += 2.0

            # name 包含品类名 → +1（替代原 cleaned_text 前 500 字匹配）
            if category_label and category_label in name_text:
                boost += 1.0

        # 现行状态已在 _search_metadata 加过分，这里不重复
        # GB 国标已在 _search_metadata 加过分，这里不重复

        item["match_score"] = round(item["match_score"] + boost, 1)

        # 提取 focus_topics 和 suggested_sections
        focus_info = _extract_focus_info(scope_text, industry_token)
        item["focus_topics"] = focus_info["focus_topics"]
        item["suggested_sections"] = focus_info["suggested_sections"]

    # 重新排序
    candidates.sort(key=lambda x: x["match_score"], reverse=True)
    _ms = (time.perf_counter() - _t0) * 1000
    log.info(f"[rerank] rerank_ms={_ms:.1f} candidates={len(candidates)}")
    return candidates


def _extract_focus_info(
    scope_text: str,
    industry_token: Optional[str],
) -> Dict[str, Any]:
    """
    从 scope 中提取短标签（focus_topics）和推荐章节（suggested_sections）。
    不输出长文本片段。
    """
    # focus_topics: 从 scope 中正则抽取
    topics: List[str] = []
    combined = (scope_text or "")[:300]
    if combined.strip():
        found = _FOCUS_TOPIC_RE.findall(combined)
        seen_t = set()
        for t in found:
            if t not in seen_t:
                seen_t.add(t)
                topics.append(t)
            if len(topics) >= 3:
                break

    # suggested_sections
    sections = _SUGGESTED_SECTIONS_MAP.get(industry_token or "", ["范围", "技术要求"])

    return {
        "focus_topics": topics,
        "suggested_sections": sections,
    }


def _generate_match_reason(
    item: Dict[str, Any],
    matched_by_code: bool = False,
    industry_label: Optional[str] = None,
) -> str:
    """根据匹配方式生成简短中文原因。"""
    source = item.get("_source", "")
    matched_kw = item.get("_matched_kw", "")

    if matched_by_code:
        return "包装标注了该标准号"

    if matched_kw:
        name = item.get("name") or ""
        ics_name = item.get("ics_name") or ""
        ccs_name = item.get("ccs_name") or ""
        # 判断是 name 命中还是 ICS/CCS 命中
        if matched_kw in name:
            return f"标准名称包含「{matched_kw}」"
        elif matched_kw in ics_name:
            return f"标准分类（{ics_name}）与商品品类一致"
        elif matched_kw in ccs_name:
            return f"标准分类（{ccs_name}）与商品品类一致"

    if industry_label:
        return f"属于{industry_label}行业标准"

    return "关键词关联匹配"


def _normalize_relevance_score(raw_score: float) -> float:
    """将原始打分映射到 0-10 区间。"""
    # 当前 raw 范围大约 0.5 ~ 8.5，线性映射到 0-10
    clamped = max(0.0, min(raw_score, 10.0))
    return round(clamped, 1)


def _enrich_standard_item(
    item: Dict[str, Any],
    matched_by_code: bool = False,
    industry_label: Optional[str] = None,
    industry_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    把候选标准统一富化为新返回结构。
    旧字段（code/name/status）保留，新增 relevance_score / match_reason 等。
    """
    # 如果是旧格式（只有 code/name/status），先补充元数据
    if "_source" not in item:
        meta = _meta_lookup(item.get("code", ""))
        if meta:
            item.setdefault("ics", meta.get("ics") or "")
            item.setdefault("ics_name", meta.get("ics_name") or "")
            item.setdefault("ccs", meta.get("ccs") or "")
            item.setdefault("ccs_name", meta.get("ccs_name") or "")
            item.setdefault("pub_date", meta.get("pub_date") or "")
            item.setdefault("match_score", 6.0 if matched_by_code else 3.0)
            item.setdefault("_matched_kw", "")
            item.setdefault("_source", "code_match" if matched_by_code else "pyapi")
        else:
            item.setdefault("ics", "")
            item.setdefault("pub_date", "")
            item.setdefault("match_score", 5.0 if matched_by_code else 2.0)
            item.setdefault("_matched_kw", "")
            item.setdefault("_source", "code_match" if matched_by_code else "pyapi")

    # focus_topics / suggested_sections（如果还没有）
    if "focus_topics" not in item:
        item["focus_topics"] = []
        item["suggested_sections"] = _SUGGESTED_SECTIONS_MAP.get(industry_token or "", ["范围", "技术要求"])

    # 构造最终结构
    raw_score = item.get("match_score", 0.0)
    return {
        "code": item.get("code", ""),
        "name": item.get("name", ""),
        "status": item.get("status", "") or "未知",
        "relevance_score": _normalize_relevance_score(raw_score),
        "match_reason": _generate_match_reason(item, matched_by_code, industry_label),
        "category_match": industry_label or "",
        "focus_topics": item.get("focus_topics", []),
        "suggested_sections": item.get("suggested_sections", []),
        "pub_date": item.get("pub_date") or None,
        "ics": item.get("ics") or None,
    }


@app.post("/internal/scan-recognize", dependencies=[Depends(verify_internal_request)])
async def scan_recognize(file: UploadFile = File(...)):
    """
    扫一扫拍照识别：PP-ShiTu（品类识别）+ PaddleOCR（文字提取）并行执行。
    合并结果后搜索 pyapi 返回标准列表。

    返回:
      {
        "success": bool,
        "standards": [{ "code", "name", "status" }],
        "recognized": str | null,   # PP-ShiTu 识别的品类词
        "confidence": float | null,
        "ocr_text": str,
        "error": str | null,
      }
    """
    import re
    import asyncio
    import httpx

    content = await file.read()
    if not content:
        return {"success": False, "standards": [], "recognized": None, "confidence": None, "ocr_text": "", "error": "上传文件为空"}

    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    is_image = ext in ("jpg", "jpeg", "png", "bmp", "webp") or (file.content_type or "").startswith("image/")

    if not is_image:
        return {"success": False, "standards": [], "recognized": None, "confidence": None, "ocr_text": "", "error": "仅支持图片格式（jpg/png）"}

    suffix = f".{ext}" if ext else ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # ═══ 并行：PP-ShiTu + OCR ═══
        async def call_shitu():
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    files = {"file": (filename or "image.jpg", content, "image/jpeg")}
                    resp = await client.post(f"{SHITU_URL}/recognize", files=files)
                    if resp.status_code == 200:
                        return resp.json()
            except Exception as e:
                log.warning(f"[scan-recognize] PP-ShiTu call failed: {e}")
            return {"success": False, "labels": []}

        async def call_ocr():
            try:
                is_pdf = False
                ocr_text, ocr_method = _try_ocr(tmp_path, is_pdf, True)
                return ocr_text or "", ocr_method or "none"
            except Exception as e:
                log.warning(f"[scan-recognize] OCR failed: {e}")
                return "", "none"

        shitu_result, (ocr_text, ocr_method) = await asyncio.gather(call_shitu(), call_ocr())

        # ═══ 合并结果 ═══
        recognized = None
        confidence = None
        search_keywords = []
        recognized_source = "unknown"

        labels = shitu_result.get("labels", [])
        if labels:
            top = labels[0]
            confidence = top.get("score")

        ocr_keywords = _extract_scan_keywords_from_ocr(ocr_text)

        # ─── 商品名生成：6 级优先级 ───
        # P1: 标准号直命中（后面策略 1 处理，这里不影响 recognized）
        # P2: OCR 商品词
        # P3: 品牌词 + OCR 商品词组合
        # P4: OCR 类目词纠偏（品牌词单独命中 → 用品牌对应类目）
        # P5: 视觉识别结果（CLIP）
        # P6: 视觉弱结果降级为「xxx（待核实）」

        recognized = None
        recognized_source = "unknown"

        # P2 + P3: OCR 商品词 + 品牌词组合
        ocr_product, ocr_hit = _ocr_category_override(ocr_text, None)
        all_brand_matches = _brand_match_all(ocr_text)
        category_brands = [m for m in all_brand_matches if m["has_category"]]
        signal_brands = [m for m in all_brand_matches if not m["has_category"]]

        # For backwards compat
        brand_name = category_brands[0]["brand"] if category_brands else None
        brand_label = category_brands[0]["category"] if category_brands else None

        if ocr_hit and ocr_product:
            if brand_name and brand_label == ocr_product:
                recognized = f"{brand_name}{ocr_product}"
            else:
                recognized = ocr_product
            recognized_source = "ocr_text"
            log.info(f"[scan-recognize] P2/P3 OCR product: recognized={recognized}")
        elif brand_name and brand_label:
            # P4: 品牌词单独命中
            recognized = brand_label
            recognized_source = "ocr_text"
            log.info(f"[scan-recognize] P4 brand only: '{brand_name}' → {brand_label}")

        # P4.5: signal brands + CLIP — 品牌存在但无品类映射，用 CLIP top-1 补品类
        if not recognized and signal_brands and labels:
            clip_label, clip_source = _choose_scan_recognized_label(labels, ocr_text)
            if clip_label:
                recognized = clip_label
                recognized_source = "brand_signal_plus_clip"
                log.info(
                    f"[scan-recognize] P4.5 signal brand detected "
                    f"({signal_brands[0]['brand']}), using CLIP top-1 for category: {clip_label}"
                )

        # P5 + P6: 没有 OCR 商品词 → 回退视觉识别
        if not recognized:
            clip_label, clip_source = _choose_scan_recognized_label(labels, ocr_text)
            if clip_label:
                recognized = clip_label
                recognized_source = clip_source
                log.info(f"[scan-recognize] P5/P6 CLIP fallback: recognized={recognized}")

        # 搜索优先级：OCR 证据 > 展示名扩展 > 高置信度视觉候选
        search_keywords.extend(ocr_keywords)
        if recognized:
            search_keywords.extend(_expand_scan_search_keywords(recognized))

        top_confidence = float(confidence or 0)
        if labels and (not ocr_keywords or top_confidence >= 0.6):
            for item in labels[:3]:
                raw_name = (item or {}).get("class_name")
                normalized_name = _normalize_scan_display_label(raw_name)
                if normalized_name:
                    search_keywords.extend(_expand_scan_search_keywords(normalized_name))

        # 去重保序，避免相同关键词反复搜索
        uniq_keywords = []
        seen_keywords = set()
        for kw in search_keywords:
            normalized_kw = (kw or "").strip()
            if not normalized_kw or normalized_kw in seen_keywords:
                continue
            seen_keywords.add(normalized_kw)
            uniq_keywords.append(normalized_kw)
        search_keywords = uniq_keywords[:8]

        # 从 OCR 提取标准号
        std_codes = []
        if ocr_text:
            std_codes = _extract_standard_codes_from_text(ocr_text)

        # ═══ 行业过滤上下文 ═══
        # recognized 是「展示名」（_choose_scan_recognized_label 选出来的，可能带"（待核实）"）
        # 用 _normalize 后的纯品类名去查 industry_meta
        industry_label = _normalize_scan_display_label(recognized) if recognized else None
        if industry_label:
            # 去掉「（待核实）」之类后缀，再查 map
            industry_label = re.sub(r"（[^）]*）", "", industry_label).strip()
        industry_meta = _resolve_industry_meta(industry_label)
        industry_token = industry_meta.get("industry") if industry_meta else None

        # ═══ 搜索策略 ═══
        # 策略1：OCR 提取到标准号 → 精确匹配 + 行业一致性校验
        # 策略2：品类词 → pyapi 全文检索 + 行业过滤 + 全关键词扫并集
        # （策略3 旧 OCR 前 30 字 fallback 已删除：无语义校验，是垃圾结果主要来源）
        standards: List[Dict[str, Any]] = []
        matched_by_code = False

        # ── 策略 1：OCR 标准号精确匹配 + 行业一致性校验 ──
        if std_codes:
            for code in std_codes[:5]:
                std_info = _lookup_standard(code)
                if not std_info:
                    continue
                # 加行业一致性校验：如果有 industry_meta，标准 name 必须通过过滤
                if industry_meta:
                    survived = _filter_standards_by_industry([std_info], industry_meta)
                    if not survived:
                        log.info(
                            f"[scan-recognize] strategy1 dropped {code} ({std_info.get('name','')}) "
                            f"by industry filter, label={industry_label}"
                        )
                        continue
                std_info["_matched_by_code"] = True
                standards.append(std_info)
                matched_by_code = True

        # ── 策略 2：两层召回（Layer 1: 487K 元数据 → Layer 2: 73K 全文重排）──
        if not standards and search_keywords:
            # Layer 1: 487K 元数据召回
            meta_candidates = _search_metadata(search_keywords, industry_meta, limit=20)
            log.info(
                f"[scan-recognize] strategy2 layer1 metadata recall: "
                f"{len(meta_candidates)} candidates from {len(search_keywords)} keywords"
            )

            if meta_candidates:
                # Layer 2: 73K SQLite 全文重排
                meta_candidates = _rerank_with_fulltext(
                    meta_candidates, industry_label, industry_token
                )
                standards.extend(meta_candidates)
                log.info(
                    f"[scan-recognize] strategy2 layer2 reranked: "
                    f"top score={meta_candidates[0]['match_score'] if meta_candidates else 0}"
                )

            # Fallback: 如果 487K 没结果，仍走 pyapi（兼容旧路径）
            if not standards:
                for kw in search_keywords:
                    try:
                        async with httpx.AsyncClient(timeout=10) as client:
                            resp = await client.get(
                                "http://127.0.0.1:8082/api/v1/standards",
                                params={"q": kw, "page_size": 5},
                            )
                            if resp.status_code != 200:
                                continue
                            data = resp.json()
                            raw_items = [
                                {
                                    "code": item.get("code", ""),
                                    "name": item.get("name") or item.get("title", ""),
                                    "status": item.get("status", ""),
                                }
                                for item in data.get("items", [])
                            ]
                            # 行业过滤
                            filtered = _filter_standards_by_industry(raw_items, industry_meta)
                            if not filtered:
                                log.info(
                                    f"[scan-recognize] strategy2 pyapi fallback kw={kw} all dropped "
                                    f"({len(raw_items)} raw → 0 after filter)"
                                )
                                continue
                            standards.extend(filtered)
                    except Exception as e:
                        log.warning(f"[scan-recognize] pyapi search failed for '{kw}': {e}")

        # 去重 + 富化
        seen = set()
        unique_standards: List[Dict[str, Any]] = []
        for s in standards:
            code = s.get("code", "")
            if code and code not in seen:
                seen.add(code)
                enriched = _enrich_standard_item(
                    s,
                    matched_by_code=bool(s.get("_matched_by_code")),
                    industry_label=industry_label,
                    industry_token=industry_token,
                )
                unique_standards.append(enriched)
        standards = unique_standards[:8]

        # ═══ 三态 recognition_mode 计算 ═══
        # exact    ：策略 1 命中标准号 OR (策略 2 有结果 AND 来源是 OCR 文字)
        # category ：策略 2 有结果 AND 来源是 category_keyword（不再要求 CLIP ≥ 0.6）
        # general  ：没找到具体标准，但有 industry_token → 弱结论报告（仍返通用方向）
        # 三态都算"识别成功"，只是结论强度不同。general 也保留 standards（如果有的话）
        if matched_by_code and standards:
            recognition_mode = "exact"
            match_source = "ocr_code"
        elif standards and recognized_source in ("ocr_text",):
            recognition_mode = "exact"
            match_source = recognized_source
        elif standards and recognized_source == "category_keyword":
            recognition_mode = "category"
            match_source = recognized_source
        elif standards and recognized_source == "brand_signal_plus_clip":
            recognition_mode = "category"
            match_source = "brand_signal_plus_clip"
        else:
            recognition_mode = "general"
            match_source = recognized_source if recognized_source else "unknown"
            # general 模式保留 standards（如果策略 2 有漏过的少量结果）

        risk_directions = _risk_directions_for_industry(industry_token)
        # 三态都算成功（只要有 recognized 或 industry_token）
        success = bool(recognized) or bool(industry_token) or len(standards) > 0
        error = None if success else "未能识别到标准信息，请拍摄商品包装上的标准号，或手动输入"

        log.info(
            f"[scan-recognize] recognized={recognized}, label={industry_label}, "
            f"industry={industry_token}, mode={recognition_mode}, "
            f"confidence={confidence}, search_keywords={search_keywords}, "
            f"std_codes={std_codes}, standards_returned={len(standards)}"
        )

        return {
            "success": success,
            "standards": standards,
            "recognized": recognized,
            "confidence": confidence,
            "ocr_text": ocr_text[:200] if ocr_text else "",
            "match_source": match_source,
            "category_source": match_source,
            "recognition_mode": recognition_mode,
            "brand_signal_detected": bool(signal_brands),
            "industry_token": industry_token,
            "risk_directions": risk_directions,
            "confidence_level": {"exact": "high", "category": "mid", "general": "low"}.get(recognition_mode, "low"),
            "confidence_tip": {
                "exact": "已找到对应标准，可继续查看具体标准内容与风险提示",
                "category": "已识别到商品类别，当前结果为类别参考，建议结合包装信息进一步核对",
                "general": "当前仅完成初步识别，建议补充清晰包装文字或直接做全库比对",
            }.get(recognition_mode, ""),
            "purchase_advice": {
                "exact": {
                    "level": "strong", "label": "优先参考",
                    "conclusion": "已识别到商品对应标准，可作为当前选购参考。",
                    "basis": "包装文字匹配" if match_source in ("ocr_code", "ocr_text") else "商品类别识别 + 标准关联",
                },
                "category": {
                    "level": "moderate", "label": "建议核对",
                    "conclusion": "当前识别结果较明确，建议优先结合包装执行标准核对。",
                    "basis": "商品类别识别",
                },
                "general": {
                    "level": "weak", "label": "仅作参考",
                    "conclusion": "当前识别证据较弱，建议拍摄更清晰的包装文字重新识别。",
                    "basis": "当前标准关联结果",
                },
            }.get(recognition_mode, {"level": "weak", "label": "仅作参考", "conclusion": "仅作初步参考。", "basis": ""}),
            "error": error,
        }

    except Exception as e:
        # 对齐 MEMORY 铁律：catch 块不外泄 e.message，记录内部日志 + 中文兜底返给前端
        log.error(f"[scan-recognize] error: {e}", exc_info=True)
        return {"success": False, "standards": [], "recognized": None, "confidence": None, "ocr_text": "", "error": "识别服务异常，请稍后重试"}
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _recognize_error(msg: str) -> dict:
    return {
        "success": False,
        "stage": "none",
        "barcode": None,
        "standard": None,
        "text": "",
        "text_length": 0,
        "method": "none",
        "error": msg,
    }


def _expand_scan_search_keywords(label: str) -> list[str]:
    label = (label or "").strip()
    if not label:
        return []

    mapping = {
        # ── 食品 ──
        "酱油调味品": ["酱油", "生抽", "老抽", "调味品"],
        "食品调味品": ["调味品", "调味料", "酱油"],
        "酱油": ["酱油", "生抽", "老抽", "调味品"],
        "食醋": ["食醋", "醋", "调味品"],
        "蚝油": ["蚝油", "调味品"],
        "辣椒酱": ["辣椒酱", "调味品", "酱料"],
        "芝麻油": ["芝麻油", "香油", "调味品"],
        "调味品": ["调味品", "调味料", "酱油", "食醋"],
        "食盐": ["食盐", "盐", "调味品"],
        "白砂糖": ["白砂糖", "食糖", "调味品"],
        "味精鸡精": ["味精", "鸡精", "调味品"],
        "食用油": ["食用油", "植物油", "调和油"],
        "牛奶": ["牛奶", "鲜奶", "乳制品"],
        "酸奶": ["酸奶", "乳酸菌", "乳制品"],
        "奶酪": ["奶酪", "芝士", "乳制品"],
        "大米": ["大米", "稻米", "粮食"],
        "面粉": ["面粉", "小麦粉", "粮食"],
        "冷冻食品": ["冷冻食品", "速冻食品", "速冻水饺"],
        "罐头": ["罐头", "罐头食品"],
        "火腿肠": ["火腿肠", "香肠", "肉制品"],
        "面包": ["面包", "糕点", "烘焙食品"],
        "饼干": ["饼干", "糕点"],
        "坚果": ["坚果", "干果", "休闲食品"],
        "蜜饯果干": ["蜜饯", "果干", "休闲食品"],
        "豆制品": ["豆制品", "豆腐", "大豆制品"],
        "鸡蛋": ["鸡蛋", "蛋", "蛋制品"],
        # ── 饮料 ──
        "饮料冲调": ["饮料", "饮品", "冲调食品"],
        "矿泉水": ["矿泉水", "饮用水", "包装饮用水"],
        "饮用水": ["饮用水", "纯净水", "包装饮用水"],
        "碳酸饮料": ["碳酸饮料", "汽水", "饮料"],
        "果汁": ["果汁", "果蔬汁", "饮料"],
        "茶饮料": ["茶饮料", "茶", "饮料"],
        "功能饮料": ["功能饮料", "运动饮料", "饮料"],
        "奶茶": ["奶茶", "茶饮料", "饮料"],
        "茶叶": ["茶叶", "茶"],
        "咖啡": ["咖啡", "咖啡饮料"],
        "植物蛋白饮料": ["植物蛋白饮料", "豆奶", "饮料"],
        "椰汁": ["椰汁", "椰子水", "植物蛋白饮料"],
        "燕麦奶": ["燕麦奶", "植物蛋白饮料", "饮料"],
        # ── 日化 ──
        "洗护清洁": ["洗护用品", "清洁用品", "日化用品"],
        "洗发水": ["洗发水", "洗护用品"],
        "护发素": ["护发素", "洗护用品"],
        "沐浴露": ["沐浴露", "洗浴用品"],
        "牙膏": ["牙膏", "口腔护理"],
        "漱口水": ["漱口水", "口腔护理"],
        "洗衣液": ["洗衣液", "洗涤用品"],
        "洗衣凝珠": ["洗衣凝珠", "洗涤用品"],
        "洗洁精": ["洗洁精", "餐具洗涤剂"],
        "洁厕剂": ["洁厕剂", "清洁用品"],
        "纸巾": ["纸巾", "纸制品"],
        "卫生纸": ["卫生纸", "纸制品"],
        "湿巾": ["湿巾", "纸制品"],
        "卫生巾": ["卫生巾", "卫生用品"],
        # ── 母婴 ──
        "母婴用品": ["婴幼儿配方奶粉", "奶粉", "纸尿裤"],
        "奶粉": ["奶粉", "婴幼儿配方奶粉"],
        "婴幼儿配方奶粉": ["婴幼儿配方奶粉", "奶粉", "乳粉"],
        "纸尿裤": ["纸尿裤", "拉拉裤"],
        "婴儿辅食": ["婴儿辅食", "辅食", "婴幼儿食品"],
        # ── 个护 ──
        "面霜": ["面霜", "护肤品", "化妆品"],
        "面膜": ["面膜", "护肤品"],
        "防晒霜": ["防晒霜", "防晒", "护肤品"],
        "身体乳": ["身体乳", "护肤品"],
        "护手霜": ["护手霜", "护肤品"],
        "免洗洗手液": ["免洗洗手液", "洗手液"],
        "隐形眼镜护理液": ["隐形眼镜护理液", "护理液"],
        # ── 生鲜 ──
        "水果": ["水果", "鲜果"],
        "蔬菜": ["蔬菜", "鲜菜"],
        "肉类": ["肉类", "鲜肉", "畜禽肉"],
        "猪肉": ["猪肉", "鲜肉", "肉类"],
        "牛肉": ["牛肉", "鲜肉", "肉类"],
        "鸡肉": ["鸡肉", "禽肉", "肉类"],
        "水产海鲜": ["水产", "海鲜", "水产品"],
        "虾": ["虾", "水产品"],
        "冻品": ["冻品", "速冻食品", "冷冻食品"],
        # ── 酒类 ──
        "啤酒": ["啤酒", "酒类"],
        "葡萄酒": ["葡萄酒", "红酒", "酒类"],
        "白酒": ["白酒", "酒类"],
        "黄酒": ["黄酒", "料酒", "酒类"],
        # ── 家电/电子/建材（保留） ──
        "杯壶容器": ["保温杯", "杯壶", "容器"],
        "保温杯": ["保温杯"],
        "炊具": ["炊具", "厨具"],
        "LED灯": ["LED灯", "LED照明"],
        "电线": ["电线", "电线电缆"],
        "水龙头": ["水龙头", "水嘴", "卫浴五金"],
        "卫浴洁具": ["卫浴洁具", "洁具", "卫浴五金"],
        "瓷砖": ["瓷砖", "陶瓷砖"],
        "涂料": ["涂料", "建筑涂料"],
        "口罩": ["口罩", "防护口罩"],
        "玻璃水": ["玻璃水", "汽车玻璃清洗液"],
    }
    return mapping.get(label, [label])


def _get_scan_ocr_rules() -> list[tuple[str, str, list[str]]]:
    """⚠️ DEPRECATED: 不再用于商品名生成和关键词提取。统一用 _OCR_CATEGORY_OVERRIDES。保留仅供审计。"""
    return [
        # ── 食品（超市核心） ──
        # "配方"单独出现太宽（牙膏/护肤品都可能含此字），必须要求"配方奶粉/配方乳粉/婴幼儿配方"
        (r"婴幼儿配方|配方奶粉|配方乳粉|婴儿奶粉|乳粉|奶粉", "婴幼儿配方奶粉", ["婴幼儿配方奶粉", "奶粉"]),
        (r"生抽|老抽|酱油|蚝油|味极鲜|蒸鱼豉油|调味料|调味品", "酱油调味品", ["酱油", "生抽", "调味品"]),
        (r"食用油|植物油|花生油|大豆油|菜籽油|橄榄油|调和油|葵花", "食用油", ["食用油", "植物油"]),
        (r"牛奶|鲜奶|纯牛奶|全脂奶|脱脂奶", "牛奶", ["牛奶", "乳制品"]),
        (r"酸奶|乳酸菌|益生菌", "酸奶", ["酸奶", "乳制品"]),
        (r"奶酪|芝士|干酪", "奶酪", ["奶酪", "乳制品"]),
        (r"食醋|陈醋|米醋|香醋", "食醋", ["食醋", "醋", "调味品"]),
        (r"辣椒酱|豆瓣酱|番茄酱|甜面酱", "辣椒酱", ["辣椒酱", "酱料", "调味品"]),
        (r"芝麻油|香油|麻油", "芝麻油", ["芝麻油", "调味品"]),
        (r"味精|鸡精|鸡粉", "味精鸡精", ["味精", "鸡精", "调味品"]),
        (r"大米|稻米|粳米|籼米|糯米", "大米", ["大米", "粮食"]),
        (r"面粉|小麦粉|高筋|低筋", "面粉", ["面粉", "小麦粉"]),
        (r"方便面|泡面|速食面", "方便面", ["方便面", "方便食品"]),
        (r"速冻|水饺|汤圆|馄饨", "冷冻食品", ["冷冻食品", "速冻食品"]),
        (r"罐头|午餐肉", "罐头", ["罐头", "罐头食品"]),
        (r"火腿肠|香肠|腊肠", "火腿肠", ["火腿肠", "肉制品"]),
        (r"面包|蛋糕|糕点|烘焙", "面包", ["面包", "糕点", "烘焙食品"]),
        (r"饼干|曲奇|威化", "饼干", ["饼干", "糕点"]),
        (r"薯片|膨化|虾条", "薯片", ["薯片", "膨化食品"]),
        (r"巧克力", "巧克力", ["巧克力", "糖果"]),
        (r"坚果|核桃|腰果|开心果|杏仁|每日坚果", "坚果", ["坚果", "休闲食品"]),
        (r"蜜饯|果干|葡萄干|蔓越莓", "蜜饯果干", ["蜜饯", "果干", "休闲食品"]),
        (r"蜂蜜", "蜂蜜", ["蜂蜜"]),
        (r"豆腐|豆浆|豆制品|腐竹", "豆制品", ["豆制品", "大豆制品"]),
        (r"鸡蛋|蛋", "鸡蛋", ["鸡蛋", "蛋制品"]),
        # ── 饮料 ──
        (r"饮用水|矿泉水|苏打水|纯净水", "矿泉水", ["矿泉水", "饮用水", "包装饮用水"]),
        (r"果汁|果蔬汁|NFC|鲜榨", "果汁", ["果汁", "饮料"]),
        (r"可乐|雪碧|汽水|碳酸", "碳酸饮料", ["碳酸饮料", "饮料"]),
        (r"茶饮|冰红茶|绿茶|乌龙茶|茉莉", "茶饮料", ["茶饮料", "饮料"]),
        (r"红牛|功能饮料|运动饮料|电解质", "功能饮料", ["功能饮料", "运动饮料"]),
        (r"奶茶|珍珠奶茶", "奶茶", ["奶茶", "茶饮料"]),
        (r"咖啡|拿铁|美式", "咖啡", ["咖啡", "咖啡饮料"]),
        (r"椰汁|椰子水|椰奶", "椰汁", ["椰汁", "植物蛋白饮料"]),
        (r"燕麦奶|豆奶|植物奶", "植物蛋白饮料", ["植物蛋白饮料", "饮料"]),
        # ── 日化 ──
        (r"洗发水|洗发露|去屑", "洗发水", ["洗发水", "洗护用品"]),
        (r"护发素", "护发素", ["护发素", "洗护用品"]),
        (r"沐浴露|沐浴乳", "沐浴露", ["沐浴露", "洗浴用品"]),
        (r"洗衣液|洗涤剂", "洗衣液", ["洗衣液", "洗涤用品"]),
        (r"洗衣凝珠|洗衣球", "洗衣凝珠", ["洗衣凝珠", "洗涤用品"]),
        (r"洗洁精|餐具净", "洗洁精", ["洗洁精", "餐具洗涤剂"]),
        (r"洁厕|马桶清洁", "洁厕剂", ["洁厕剂", "清洁用品"]),
        (r"纸巾|抽纸|手帕纸", "纸巾", ["纸巾", "纸制品"]),
        (r"卫生纸|厕纸|卷纸", "卫生纸", ["卫生纸", "纸制品"]),
        (r"湿巾|湿纸巾", "湿巾", ["湿巾", "纸制品"]),
        (r"卫生巾|护垫", "卫生巾", ["卫生巾", "卫生用品"]),
        (r"牙膏", "牙膏", ["牙膏", "口腔护理"]),
        (r"漱口水", "漱口水", ["漱口水", "口腔护理"]),
        # ── 个护 ──
        (r"面膜", "面膜", ["面膜", "护肤品"]),
        (r"防晒|SPF", "防晒霜", ["防晒霜", "护肤品"]),
        (r"面霜|乳液|润肤", "面霜", ["面霜", "护肤品"]),
        (r"洗手液|免洗", "免洗洗手液", ["免洗洗手液", "洗手液"]),
        # ── 酒类 ──
        (r"啤酒|精酿|拉格", "啤酒", ["啤酒", "酒类"]),
        (r"白酒|茅台|五粮液|泸州|酱香|浓香", "白酒", ["白酒", "酒类"]),
        (r"葡萄酒|红酒|干红|干白", "葡萄酒", ["葡萄酒", "红酒", "酒类"]),
        (r"黄酒|料酒|花雕", "黄酒", ["黄酒", "料酒", "酒类"]),
        # ── 建材/家电（保留核心） ──
        (r"水龙头|龙头|水嘴", "水龙头", ["水龙头", "卫浴五金"]),
        (r"电线|电缆|BV|BVR|YJV|护套线", "电线", ["电线", "电线电缆"]),
        (r"瓷砖|地砖|墙砖|陶瓷砖", "瓷砖", ["瓷砖", "陶瓷砖"]),
        (r"纸尿裤|尿不湿|拉拉裤", "纸尿裤", ["纸尿裤"]),
        (r"口罩|医用防护", "口罩", ["口罩"]),
        (r"保温杯|保温壶", "保温杯", ["保温杯"]),
        (r"电热水壶|烧水壶", "电热水壶", ["电热水壶"]),
        (r"电饭煲|电饭锅", "电饭煲", ["电饭煲"]),
        (r"轮胎", "轮胎", ["轮胎"]),
        (r"玻璃水|雨刷液|雨刮液", "玻璃水", ["玻璃水", "汽车玻璃清洗液"]),
    ]


def _extract_scan_keywords_from_ocr(text: str) -> list[str]:
    """从 OCR 文本提取搜索关键词。统一用 _OCR_CATEGORY_OVERRIDES（不再用旧 _get_scan_ocr_rules）。"""
    import re

    cleaned = re.sub(r"[\s\n]+", " ", text or "").strip()
    if not cleaned:
        return []

    keywords: list[str] = []
    for pattern, label in _OCR_CATEGORY_OVERRIDES:
        if re.search(pattern, cleaned, re.IGNORECASE):
            # label 就是搜索词（如「牙膏」「滴眼液」「酱油」）
            keywords.append(label)
            # 同时用 _expand_scan_search_keywords 展开同义词
            keywords.extend(_expand_scan_search_keywords(label))

    if not keywords and len(cleaned) >= 2:
        keywords.append(cleaned[:24])

    # 去重保序
    seen = set()
    unique = []
    for kw in keywords:
        if kw not in seen:
            seen.add(kw)
            unique.append(kw)
    return unique


def _normalize_scan_display_label(recognized: Optional[str]) -> Optional[str]:
    raw_label = (recognized or "").strip()
    if not raw_label:
        return None

    generic_map = {
        "涂料": "建筑涂料",
        "电线": "电线电缆",
        "护肤品": "护肤品/化妆品",
        "药品": "药品/医疗器械",
        "服装": "服装纺织",
        "LED灯": "LED照明",
        "炊具": "炊具厨具",
        "身体乳": "护肤品",
    }
    return generic_map.get(raw_label, raw_label)


def _downgrade_weak_scan_label(recognized: Optional[str]) -> Optional[str]:
    label = _normalize_scan_display_label(recognized)
    if not label:
        return None

    generic_map = {
        "保温杯": "杯壶容器（待核实）",
        "电热水壶": "杯壶容器（待核实）",
        "电饭煲": "厨房小家电（待核实）",
        "水龙头": "卫浴五金（待核实）",
        "花洒": "卫浴五金（待核实）",
        "角阀": "卫浴五金（待核实）",
        "插座面板": "电工材料（待核实）",
        "开关面板": "电工材料（待核实）",
        "电线电缆": "电工材料（待核实）",
        "婴幼儿配方奶粉": "母婴用品（待核实）",
        "奶粉": "母婴用品（待核实）",
        "纸尿裤": "母婴用品（待核实）",
        "洗发水": "洗护清洁（待核实）",
        "牙膏": "洗护清洁（待核实）",
        "酱油调味品": "食品调味品（待核实）",
        "饮料冲调": "饮料冲调（待核实）",
    }
    return generic_map.get(label, f"{label}（待核实）")


def _pick_scan_ocr_display_label(ocr_text: str) -> Optional[str]:
    """⚠️ DEPRECATED: 不再被调用。商品名生成统一由 _ocr_category_override + _brand_category_override 处理。"""
    import re

    cleaned = re.sub(r"[\s\n]+", " ", ocr_text or "").strip()
    if not cleaned:
        return None

    for pattern, display_label, _values in _get_scan_ocr_rules():
        if re.search(pattern, cleaned, re.IGNORECASE):
            return display_label
    return None


# ─── OCR 类目纠偏 ──────────────────────────────────────────
# OCR 里出现了明确的产品品名词时，强制覆盖 CLIP 视觉标签。
# 解决「牙膏被识别成婴幼儿配方奶粉」「洗衣液被识别成饮料」等串类问题。
# 规则：OCR 品名词 → 强制类目。优先级高于 CLIP label 和 _pick_scan_ocr_display_label。
# 只有**非常明确**的品名词才加这里，模糊词（如「配方」「清洁」）不加。
_OCR_CATEGORY_OVERRIDES: list[tuple[str, str]] = [
    # (regex, display_label) — regex 必须是不会误命中其他品类的精确词
    # 口腔护理
    (r"牙膏|牙齿美白|刷牙", "牙膏"),
    (r"漱口水|口腔清洁液", "漱口水"),
    # 洗护
    (r"洗发水|洗发露|去屑洗发", "洗发水"),
    (r"护发素|焗油膏", "护发素"),
    (r"沐浴露|沐浴乳|沐浴液", "沐浴露"),
    (r"洗面奶|洁面乳|洗面乳|洁面膏", "面霜"),
    (r"洗衣液|洗衣精", "洗衣液"),
    (r"洗衣凝珠|洗衣球", "洗衣凝珠"),
    (r"洗洁精|餐具净|餐具洗涤", "洗洁精"),
    # 食品调味
    (r"酱油|生抽|老抽|味极鲜", "酱油"),
    (r"蚝油", "蚝油"),
    (r"食醋|陈醋|米醋|白醋|香醋", "食醋"),
    (r"食用油|花生油|大豆油|菜籽油|橄榄油|葵花籽油|调和油", "食用油"),
    (r"食盐|加碘盐|海盐|精盐", "食盐"),
    # 乳制品
    (r"纯牛奶|鲜牛奶|全脂牛奶|脱脂牛奶", "牛奶"),
    (r"酸奶|风味酸乳|发酵乳", "酸奶"),
    # 饮料
    (r"矿泉水|纯净水|饮用水", "矿泉水"),
    (r"可乐|雪碧|芬达", "碳酸饮料"),
    # 个护
    (r"面膜|蚕丝面膜|补水面膜", "面膜"),
    (r"防晒霜|防晒乳|SPF\s*\d+", "防晒霜"),
    (r"洗手液|免洗洗手", "免洗洗手液"),
    # 纸品
    (r"抽纸|纸巾|手帕纸", "纸巾"),
    (r"卫生纸|卷纸|厕纸", "卫生纸"),
    (r"纸尿裤|拉拉裤|尿不湿", "纸尿裤"),
    (r"卫生巾|护垫|夜用卫生巾", "卫生巾"),
    # ── 扩展：超市场景补充 ──
    # 口腔补充
    (r"牙刷|电动牙刷|儿童牙刷", "牙刷"),
    # 食品补充
    (r"白糖|冰糖|绵白糖|白砂糖", "白砂糖"),
    (r"挂面|面条|龙须面|刀削面", "挂面"),
    (r"方便面|泡面|速食面|杯面", "方便面"),
    (r"罐头|午餐肉|豆豉鲮鱼", "罐头"),
    (r"膨化食品|虾条|锅巴", "薯片"),
    (r"麦片|燕麦|冲调|芝麻糊|藕粉", "饮料冲调"),
    (r"糖果|软糖|硬糖|棒棒糖|奶糖", "巧克力"),
    (r"味精|鸡精|鸡粉", "味精鸡精"),
    (r"料酒|烹饪酒", "黄酒"),
    (r"番茄酱|沙拉酱|蛋黄酱|芥末酱", "调味品"),
    (r"辣条|辣片", "薯片"),
    # 日化补充
    (r"消毒液|消毒剂|84消毒", "消毒液"),
    (r"洗衣粉", "洗衣粉"),
    (r"厨房清洁|油污净|去油", "洗洁精"),
    (r"洁厕灵|马桶清洁|管道疏通", "洁厕剂"),
    (r"玻璃清洁|玻璃水", "玻璃水"),
    (r"香皂|透明皂|硫磺皂", "香皂"),
    # 个护补充
    (r"身体乳|润肤乳|凡士林", "面霜"),
    (r"护手霜", "面霜"),
    (r"洗面奶|洁面乳|洁面膏|洁面泡沫", "面霜"),
    # 母婴纸品补充
    (r"湿厕纸", "湿巾"),
    (r"护垫|迷你卫生巾", "卫生巾"),
    # 医药 / OTC / 护理
    (r"滴眼液|眼药水|眼药|滴眼剂", "滴眼液"),
    (r"OTC|非处方药|口服液|糖浆|止咳", "OTC药品"),
    (r"创可贴|止血贴|敷料贴", "创可贴"),
    (r"药膏|软膏|乳膏|皮肤用药", "药膏"),
    (r"鼻喷雾|鼻腔喷雾|生理盐水喷雾", "鼻喷雾"),
    (r"隐形眼镜护理液|护理液|美瞳护理", "隐形眼镜护理液"),
    # 宠物
    (r"猫粮|狗粮|宠物食品|宠物零食", "宠物食品"),
    # 其他
    (r"电池|碱性电池|锂电池|充电电池", "电池"),
    (r"保鲜膜|保鲜袋|食品袋", "保鲜膜"),
    (r"一次性手套|一次性杯|一次性碗|一次性筷", "保鲜膜"),
]


def _ocr_category_override(ocr_text: str, current_label: Optional[str]) -> tuple[Optional[str], bool]:
    """
    如果 OCR 文本里存在明确品名词，返回 (override_label, True)；否则 (None, False)。
    调用方用 override_label 替代 CLIP label，避免串类。
    """
    if not ocr_text:
        return None, False
    import re
    cleaned = re.sub(r"[\s\n]+", " ", ocr_text).strip()
    if not cleaned:
        return None, False
    for pattern, label in _OCR_CATEGORY_OVERRIDES:
        if re.search(pattern, cleaned, re.IGNORECASE):
            if current_label and current_label == label:
                return None, False  # 不冲突，不需要覆盖
            return label, True
    return None, False


def _choose_scan_recognized_label(labels: list[dict], ocr_text: str) -> tuple[Optional[str], str]:
    # 不再走 _pick_scan_ocr_display_label（旧独立规则集），统一由主流程的
    # _ocr_category_override + _brand_category_override 处理 OCR 商品名生成。
    # 这里只负责 CLIP 视觉 fallback。

    if not labels:
        return None, "unknown"

    top = labels[0] or {}
    raw_label = top.get("class_name")
    top_confidence = float(top.get("score") or 0)
    normalized_label = _normalize_scan_display_label(raw_label)

    if top_confidence < 0.35:
        return _downgrade_weak_scan_label(normalized_label), "category_keyword"

    return normalized_label, "category_keyword"


def _try_barcode_scan(file_path: str, is_pdf: bool) -> Optional[dict]:
    """尝试从图片/PDF 首页扫描条形码和二维码"""
    try:
        from PIL import Image
        import io as _io

        if is_pdf:
            try:
                import fitz
                doc = fitz.open(file_path)
                if len(doc) == 0:
                    doc.close()
                    return None
                pix = doc[0].get_pixmap(dpi=300)
                img = Image.open(_io.BytesIO(pix.tobytes("png")))
                doc.close()
            except Exception as e:
                log.warning(f"[barcode] PDF 转图片失败: {e}")
                return None
        else:
            img = Image.open(file_path)

        # 优先 pyzbar（支持条形码+二维码）
        try:
            from pyzbar.pyzbar import decode as zbar_decode
            barcodes = zbar_decode(img)
            if barcodes:
                bc = barcodes[0]
                return {
                    "type": bc.type,  # EAN13, CODE128, QRCODE, etc.
                    "value": bc.data.decode("utf-8", errors="replace"),
                    "standard_code": None,
                }
        except ImportError:
            log.debug("[barcode] pyzbar 未安装")

        # fallback: opencv + 内置 barcode detector
        try:
            import cv2
            import numpy as np
            img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)

            # QR Code
            qr_detector = cv2.QRCodeDetector()
            data, _, _ = qr_detector.detectAndDecode(img_cv)
            if data:
                return {"type": "QRCODE", "value": data, "standard_code": None}

            # Barcode (opencv-contrib barcode module)
            try:
                barcode_detector = cv2.barcode.BarcodeDetector()
                ok, decoded_info, decoded_type, _ = barcode_detector.detectAndDecode(img_cv)
                if ok and decoded_info:
                    for info, btype in zip(decoded_info, decoded_type):
                        if info:
                            return {"type": btype or "BARCODE", "value": info, "standard_code": None}
            except AttributeError:
                pass  # opencv 版本无 barcode 模块
        except ImportError:
            log.debug("[barcode] opencv 未安装")

        return None
    except Exception as e:
        log.warning(f"[barcode] 条码识别异常: {e}")
        return None


def _try_ocr(file_path: str, is_pdf: bool, is_image: bool) -> tuple[str, str]:
    """OCR 文字提取，返回 (text, method)"""
    import re

    if is_pdf:
        # PDF: 复用 extract-text 逻辑
        try:
            import fitz
            doc = fitz.open(file_path)
            pages_text = [page.get_text("text") for page in doc]
            doc.close()
            full_text = "\n".join(pages_text)

            watermark_re = re.compile(r"学兔兔|bzfxw|www\.|标准下载|标准网", re.IGNORECASE)
            filtered = "\n".join(
                line for line in full_text.split("\n")
                if not watermark_re.search(line)
            )

            cjk_count = len(re.findall(r"[\u4e00-\u9fff]", filtered))
            cjk_ratio = cjk_count / max(len(filtered), 1)

            if len(filtered) >= 100 and cjk_ratio >= 0.03:
                return filtered, "pymupdf"

            # PyMuPDF 不足，OCR fallback
            ocr_text = _ocr_image_file(file_path, is_pdf=True)
            if ocr_text and len(ocr_text) > len(filtered):
                return ocr_text, "ocr"
            return filtered, "pymupdf"
        except Exception as e:
            log.error(f"[ocr] PDF 处理失败: {e}")
            return "", "none"
    else:
        # 图片: 直接 OCR — _ocr_single_image 在 4-05 重构后返回 dict（结构化错误码），
        # 需在此解包；用 isinstance 兼容判断，保留对未来重新返回 str 的容错。
        ocr_result = _ocr_image_file(file_path, is_pdf=False)
        if isinstance(ocr_result, dict):
            text = ocr_result.get("text") or ""
            return text, "ocr" if text else "none"
        return ocr_result or "", "ocr" if ocr_result else "none"


def _ocr_image_file(file_path: str, is_pdf: bool = False) -> str:
    """对单张图片或 PDF 首页做 OCR"""
    import io as _io

    if is_pdf:
        try:
            import fitz
            doc = fitz.open(file_path)
            # OCR 前 5 页（拍照场景通常只有 1 页）
            ocr_pages = []
            for i, page in enumerate(doc):
                if i >= 5:
                    break
                pix = page.get_pixmap(dpi=200)
                img_path = file_path + f"_ocr_p{i}.png"
                pix.save(img_path)
                try:
                    ocr_result = _ocr_single_image(img_path)
                    # _ocr_single_image 返回 dict（4-05 重构），解包出 text
                    text = ocr_result.get("text", "") if isinstance(ocr_result, dict) else (ocr_result or "")
                    if text:
                        ocr_pages.append(text)
                finally:
                    if os.path.exists(img_path):
                        os.unlink(img_path)
            doc.close()
            return "\n".join(ocr_pages)
        except Exception as e:
            log.error(f"[ocr] PDF OCR 失败: {e}")
            return ""
    else:
        return _ocr_single_image(file_path)


## ─── PaddleOCR 懒加载单例 ──────────────────────────────────
_paddle_ocr_instance = None

def _get_paddle_ocr():
    """获取 PaddleOCR 单例（懒加载，首次调用时初始化）"""
    global _paddle_ocr_instance
    if _paddle_ocr_instance is None:
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import PaddleOCR
        # PP-OCRv4 默认用 mobile 级模型，体积小、内存占用低（~10MB 模型 / ~100MB 推理）
        # PP-OCRv5 默认用 server 级模型（~150MB 模型 / ~400MB 推理），1.6G 内存服务器吃不消
        _paddle_ocr_instance = PaddleOCR(
            use_textline_orientation=True,  # v3.4+ 替代 use_angle_cls
            lang='ch',
            device='cpu',                   # v3.4+ 替代 use_gpu=False
            ocr_version='PP-OCRv4',         # 指定 v4 mobile 级模型
        )
        log.info("[ocr] PaddleOCR 初始化完成 (CPU, ch, PP-OCRv4 mobile)")
    return _paddle_ocr_instance


def _paddle_ocr_single(img_path: str) -> str:
    """PaddleOCR 单图识别，返回文本"""
    try:
        ocr = _get_paddle_ocr()
        result = ocr.ocr(img_path, cls=True)
        if not result or not result[0]:
            return ""
        lines = []
        for line in result[0]:
            if line and len(line) >= 2 and line[1] and line[1][0]:
                lines.append(line[1][0])
        return "\n".join(lines)
    except Exception as e:
        log.warning(f"[ocr] PaddleOCR 失败: {e}")
        return ""


def _ocr_single_image(img_path: str) -> Dict[str, Any]:
    """对单张图片执行 OCR。优先级: Docker PaddleOCR → ocrmac(macOS)。"""
    result: Dict[str, Any] = {
        "success": False,
        "text": "",
        "engine": "none",
        "error_code": None,
        "error_message": None,
    }

    httpx_mod = None
    try:
        if importlib.util.find_spec("httpx") is None:
            raise ModuleNotFoundError("httpx is not installed")

        import httpx as httpx_mod

        with open(img_path, "rb") as f:
            img_bytes = f.read()
        resp = httpx_mod.post(
            f"{SHITU_URL}/ocr",
            files={"file": (os.path.basename(img_path), img_bytes, "image/png")},
            timeout=60,
        )
        if resp.status_code == 200:
            data = resp.json()
            text = (data.get("text") or "").strip()
            if text:
                log.info(f"[ocr] Docker PaddleOCR 成功, {len(text)} chars")
                result.update({"success": True, "text": text, "engine": "paddleocr"})
                return result

        result.update({
            "error_code": OCR_FAILED,
            "error_message": f"Docker PaddleOCR 返回异常状态: {resp.status_code}",
        })
    except Exception as e:
        timeout_exc = getattr(httpx_mod, "TimeoutException", None) if httpx_mod else None
        if timeout_exc and isinstance(e, timeout_exc):
            result.update({
                "error_code": OCR_FAILED,
                "error_message": "Docker PaddleOCR 超时(60s)",
            })
            log.warning("[ocr] Docker PaddleOCR 超时(60s)，降级到下一引擎")
        elif isinstance(e, ModuleNotFoundError):
            result.update({
                "error_code": DEPENDENCY_MISSING,
                "error_message": f"OCR 依赖缺失: {e}",
            })
            log.error(f"[ocr] 依赖缺失: {e}")
        else:
            result.update({
                "error_code": OCR_FAILED,
                "error_message": f"Docker PaddleOCR 调用失败: {e}",
            })
            log.warning(f"[ocr] Docker PaddleOCR 调用失败: {e}，降级到下一引擎")

    try:
        from ocrmac import ocrmac as ocr_engine

        annotations = ocr_engine.OCR(img_path, recognition_level="accurate").recognize()
        text = "\n".join(a[0] for a in annotations).strip()
        if text:
            result.update({
                "success": True,
                "text": text,
                "engine": "ocrmac",
                "error_code": None,
                "error_message": None,
            })
            return result
    except ImportError:
        if not result["error_code"]:
            result.update({
                "error_code": DEPENDENCY_MISSING,
                "error_message": "ocrmac 不可用",
            })
    except Exception as e:
        if not result["error_code"]:
            result.update({
                "error_code": OCR_FAILED,
                "error_message": f"ocrmac 失败: {e}",
            })
        log.warning(f"[ocr] ocrmac 失败: {e}")

    if not result["error_code"]:
        result.update({
            "error_code": OCR_FAILED,
            "error_message": "所有 OCR 引擎均未返回有效文本",
        })

    return result


def _extract_standard_code_from_barcode(value: str) -> Optional[str]:
    """从条码值中提取标准号（如 EAN-13 映射或直接包含标准号的二维码）"""
    import re

    if not value:
        return None

    # 二维码可能直接包含标准号或 URL
    # 如 "GB/T 1.1-2020" 或 "https://xxx/standard/GB%2FT+1.1-2020"
    patterns = [
        r"(GB/T\s*[\d.]+(?:-\d{4})?)",
        r"(GB\s+\d+(?:\.\d+)*(?:-\d{4})?)",
        r"(T/[A-Z]+\s*[\d.]+(?:-\d{4})?)",
        r"(JB/T\s*[\d.]+(?:-\d{4})?)",
        r"(NY/T\s*[\d.]+(?:-\d{4})?)",
        r"(HJ\s*[\d.]+(?:-\d{4})?)",
        r"(DB\d+/T?\s*[\d.]+(?:-\d{4})?)",
        r"(YD/T\s*[\d.]+(?:-\d{4})?)",
        r"(SJ/T\s*[\d.]+(?:-\d{4})?)",
        r"(QC/T\s*[\d.]+(?:-\d{4})?)",
    ]
    for pat in patterns:
        m = re.search(pat, value, re.IGNORECASE)
        if m:
            return re.sub(r"\s+", " ", m.group(1).strip())

    return None


def _extract_standard_codes_from_text(text: str) -> list[str]:
    """从 OCR 文字中提取所有可能的标准号"""
    import re

    pattern = r"(?:GB/T|GB|T/[A-Z]+|JB/T|NY/T|HJ|DB\d+/T?|YD/T|SJ/T|QC/T)\s*[\d.][\d.\-]*(?:-\d{4})?"
    matches = re.findall(pattern, text[:3000])  # 只扫前 3000 字（封面/首页区域）
    # 去重保序
    seen = set()
    result = []
    for m in matches:
        normalized = re.sub(r"\s+", " ", m.strip())
        if normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result[:10]


def _lookup_standard(code: str) -> Optional[dict]:
    """在去重库中按标准号查找标准信息"""
    import re

    normalized = re.sub(r"\s+", "", code)

    # 精确匹配
    row = db.conn.execute(
        "SELECT code, name, status FROM standards WHERE replace(code,' ','') = ? LIMIT 1",
        (normalized,),
    ).fetchone()

    if not row:
        # 模糊匹配：去掉年份部分
        code_no_year = re.sub(r"-\d{4}$", "", normalized)
        row = db.conn.execute(
            "SELECT code, name, status FROM standards WHERE replace(code,' ','') LIKE ? ORDER BY code DESC LIMIT 1",
            (code_no_year + "%",),
        ).fetchone()

    if row:
        return {
            "code": row["code"],
            "name": row["name"],
            "status": row["status"] or "未知",
        }
    return None


# ─── 错误处理 ──────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error(f"Unhandled error: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
    )
