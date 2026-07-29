"""
标准小智 API v2 — 标准检索 / 详情 / 图谱 / 委员会 / 大纲生成等核心接口

@author  通标中研标准化研究院
@version 2.0
@date    2026-03-21

════════════════════════════════════════════════════════
⚠️  【目录命名说明】
  本服务目录名为 python-search-legacy，但"legacy"仅为历史命名遗留，
  并不代表本服务已废弃。

  当前状态：本服务是线上唯一 Python 搜索/检索服务，正常运行中。
  提供：标准全库检索、标准详情、关联标准图谱、委员会查询、
        行业标准、一句话生大纲等核心接口（/api/v1/*）。

  待办：目录名暂不改，改名会牵动 PM2 配置、部署脚本、nginx 反代路径，
        待有完整重构窗口时统一处理。
════════════════════════════════════════════════════════
"""

from pathlib import Path
from typing import Optional
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from engine import StandardKnowledgeBase

# ── 路径 ──
# 项目根：本地 = parent.parent.parent（services/python-search-legacy → biaozhunxiaozhi）
# 服务器可通过 BXZ_PROJECT_ROOT 环境变量覆盖
import os as _os
_default_root = Path(__file__).resolve().parent.parent.parent
BASE = Path(_os.environ.get("BXZ_PROJECT_ROOT", str(_default_root)))
DATA_CRAWLED = BASE / "data" / "crawled_v2"
DATA_RULES = BASE / "data" / "rules"
DATA_CSV = BASE / "data" / "csv"          # 行标/团标/地标 CSV
DATA_TC = BASE / "data" / "tc" / "tc_committees.json"
WEB_DIR = BASE / "web"

# ── 初始化知识库 ──
csv_dir = str(DATA_CSV) if DATA_CSV.is_dir() else ""
kb = StandardKnowledgeBase(str(DATA_CRAWLED), str(DATA_RULES), csv_dir=csv_dir)
print(f"✅ 知识库加载完成: {kb.stats}")

# ── 技术委员会数据 ──
import json as _json
_tc_data = _json.loads(DATA_TC.read_text(encoding="utf-8")) if DATA_TC.exists() else {"committees": []}
TC_LIST = _tc_data.get("committees", [])
print(f"✅ 技术委员会加载完成: {len(TC_LIST)} 条")

# ── App ──
app = FastAPI(title="标准小智 API", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ══════════════════════════════════════════════════════
# ① 行业标准查询
# ══════════════════════════════════════════════════════

@app.get("/api/v1/industry-standards")
def industry_standards(q: str = Query(..., description="行业关键词")):
    result = kb.query_industry(q)
    if not result.get("matched"):
        return {"query": q, "matched": False, "total": 0, "suggestion": result.get("suggestion", "")}
    return {"query": q, **result}


# ══════════════════════════════════════════════════════
# ② 标准大纲生成
# ══════════════════════════════════════════════════════

class OutlineRequest(BaseModel):
    description: str
    standard_type: Optional[str] = None

@app.post("/api/v1/outline")
def generate_outline(req: OutlineRequest):
    return kb.generate_outline(req.description, req.standard_type)


# ══════════════════════════════════════════════════════
# ③ 条款生成
# ══════════════════════════════════════════════════════

class ClauseRequest(BaseModel):
    chapter_title: str
    user_input: str
    clause_number: Optional[str] = "X.X"

@app.post("/api/v1/clause")
def generate_clause(req: ClauseRequest):
    return kb.normalize_clause(req.chapter_title, req.user_input, req.clause_number)


# ══════════════════════════════════════════════════════
# ④ 适用性诊断
# ══════════════════════════════════════════════════════

class DiagnosisRequest(BaseModel):
    description: str

@app.post("/api/v1/diagnosis")
def diagnosis(req: DiagnosisRequest):
    return kb.diagnose(req.description)


# ══════════════════════════════════════════════════════
# ⑤ 术语规范查询
# ══════════════════════════════════════════════════════

@app.get("/api/v1/terminology")
def terminology(q: str = Query(..., description="术语关键词")):
    return kb.query_terminology(q)


# ══════════════════════════════════════════════════════
# ⑥ 标准变更查询
# ══════════════════════════════════════════════════════

@app.get("/api/v1/changes")
def changes(industry: str = Query(None), code: str = Query(None)):
    return kb.query_changes(industry, code)


# ══════════════════════════════════════════════════════
# ⑦ 技术委员会查询
# ══════════════════════════════════════════════════════

@app.get("/api/v1/tc")
def tc_query(
    q: str = Query(None, description="关键词（编号/名称/专业范围/单位）"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    if q:
        kw = q.strip().lower()
        results = [
            c for c in TC_LIST
            if kw in (c.get("code") or "").lower()
            or kw in (c.get("name") or "").lower()
            or kw in (c.get("scope") or "").lower()
            or kw in (c.get("secretariat") or "").lower()
            or kw in (c.get("location") or "").lower()
        ]
    else:
        results = TC_LIST

    total = len(results)
    start = (page - 1) * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": results[start: start + page_size],
    }

@app.get("/api/v1/tc/{code}")
def tc_detail(code: str):
    code_upper = code.upper()
    for c in TC_LIST:
        if (c.get("code") or "").upper() == code_upper:
            return c
    return {"error": f"未找到委员会 {code}"}


# ══════════════════════════════════════════════════════
# 辅助接口
# ══════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════
# ⑧ 标准列表（分页 + 分类）
# ══════════════════════════════════════════════════════

@app.get("/api/v1/standards")
def standards_list(
    category: str = Query("all", description="分类: all/national/industry/local/group/enterprise/international"),
    status: str = Query("", description="状态过滤: 现行/即将实施/废止"),
    q: str = Query("", description="关键词搜索"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = Query("", description="排序: 空=默认 / impl_date_desc / impl_date_asc"),
):
    return kb.list_standards(category, q, page, page_size, status, sort_by)


# ══════════════════════════════════════════════════════
# ⑨ 标准关系查询
# ══════════════════════════════════════════════════════

@app.get("/api/v1/standard/{code:path}/relations")
def standard_relations(code: str):
    return kb.get_relations(code)


# ══════════════════════════════════════════════════════
# ⑩ 单条标准详情
# ══════════════════════════════════════════════════════

@app.get("/api/v1/standard-detail")
def standard_detail(code: str = Query(..., description="标准编号")):
    return kb.get_standard_detail(code)


@app.get("/api/v1/search")
def search(
    q: str = Query(...),
    limit: int = Query(50, le=200),
    sort_by: str = Query("", description="排序: 空=默认 / impl_date_desc / impl_date_asc"),
):
    return {"query": q, "results": kb.search(q, limit, sort_by)}

@app.get("/api/v1/ccs")
def ccs(code: str = Query(None)):
    cats = kb.ccs.get("categories", [])
    if code:
        for c in cats:
            if c["code"] == code.upper():
                return c
        return {"error": f"未找到 {code}"}
    return {"total": len(cats), "categories": [{"code": c["code"], "name": c["name"]} for c in cats]}

@app.get("/api/v1/stats")
def stats():
    return kb.stats

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
