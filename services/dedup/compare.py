"""
比对引擎 — MinHash 筛选 + 多维相似度计算
===========================================
1. 用户上传文本 → 生成 MinHash → LSH 候选筛选
2. 候选集内做多维相似度评分：
   - 题名相似度（N-gram Jaccard）
   - 内容相似度（MinHash Jaccard）
   - 结构相似度（章节骨架 Jaccard）
   - 引用重叠度
   - 术语重叠度
3. 加权综合评分 → 排序 → 返回 top_n
"""
import json
import logging
import pickle
import re
try:
    import pysqlite3 as sqlite3  # CentOS 7 系统 SQLite 3.7.17 不支持 partial index
except ImportError:
    import sqlite3
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

import jieba
import numpy as np
from datasketch import MinHash

log = logging.getLogger("dedup.compare")

NUM_PERM = 128  # 与 dedup_pipeline.py 一致

# ─── 权重配置 ───────────────────────────────────────────────

WEIGHTS = {
    "title": 0.15,
    "content": 0.40,
    "structure": 0.15,
    "reference": 0.15,
    "term": 0.15,
}


@dataclass
class CandidateResult:
    code: str
    name: str
    overall_score: float = 0.0
    title_sim: float = 0.0
    content_sim: float = 0.0
    structure_sim: float = 0.0
    reference_sim: float = 0.0
    term_sim: float = 0.0
    tier: str = ""
    ics: str = ""
    matched_sections: list = field(default_factory=list)
    matched_refs: list = field(default_factory=list)
    matched_terms: list = field(default_factory=list)


@dataclass
class CompareStats:
    total_in_db: int = 0
    candidates_screened: int = 0
    processing_ms: int = 0


# ─── 文本处理工具 ──────────────────────────────────────────

def _text_to_shingles(text: str, k: int = 5) -> set[str]:
    """
    与 dedup_pipeline.py 的 text_to_shingles() 完全一致：
    jieba 分词 → k-word-gram shingles
    """
    words = list(jieba.cut(text))
    words = [w for w in words if w.strip()]
    if len(words) < k:
        return set(words)
    return set(" ".join(words[i : i + k]) for i in range(len(words) - k + 1))


def _make_minhash(shingles: set[str]) -> MinHash:
    """与 dedup_pipeline.py 的 compute_minhash() 完全一致"""
    m = MinHash(num_perm=NUM_PERM)
    for s in shingles:
        m.update(s.encode("utf-8"))
    return m


def _jaccard_from_arrays(a: np.ndarray, b: np.ndarray) -> float:
    """从两个 MinHash hashvalues 数组计算 Jaccard 估计"""
    return float(np.mean(a == b))


def _ngram_sim(a: str, b: str, n: int = 2) -> float:
    """N-gram Jaccard 相似度（用于题名比对）"""
    if not a or not b:
        return 0.0
    sa = set(a[i : i + n] for i in range(max(len(a) - n + 1, 1)))
    sb = set(b[i : i + n] for i in range(max(len(b) - n + 1, 1)))
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


def _extract_user_refs(text: str) -> set[str]:
    """从用户文本中提取引用标准号"""
    pattern = r"(?:GB/T|GB|T/[A-Z]+|JB/T|NY/T|HJ|DB\d+/T?)\s*[\d.\-]+"
    matches = re.findall(pattern, text)
    return {re.sub(r"\s+", " ", m.strip()) for m in matches}


def _extract_user_terms(text: str) -> set[str]:
    """从用户文本提取术语（3.x 格式）"""
    terms = set()
    for line in text.split("\n"):
        m = re.match(r"^\d+\.\d+\s+(.+?)[\s：:]", line)
        if m:
            terms.add(m.group(1).strip())
    return terms


_SECTION_PATTERN = re.compile(
    r"^(\d+(?:\.\d+)*)\s+(.+)", re.MULTILINE
)

_GB_TYPES = {
    "scope": ["范围", "适用范围"],
    "normative_refs": ["规范性引用文件", "规范性引用", "引用文件", "引用标准"],
    "terms": ["术语和定义", "术语", "定义"],
    "body": [],  # 其余正文
}


def _extract_user_structure(text: str) -> list[dict]:
    """从用户文本提取章节骨架"""
    sections = []
    for m in _SECTION_PATTERN.finditer(text):
        num, title = m.group(1), m.group(2).strip()
        stype = "body"
        for t, kws in _GB_TYPES.items():
            if t == "body":
                continue
            if any(kw in title for kw in kws):
                stype = t
                break
        sections.append({"num": num, "title": title, "type": stype})
    return sections


# ─── 数据库加载 ─────────────────────────────────────────────

class DedupDB:
    """去重主库只读连接 + 缓存"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        # 缓存: a001 → (code, name, tier, ics)
        self._meta: dict[str, tuple] = {}
        # 缓存: a001 → np.ndarray (MinHash hashvalues)
        self._fingerprints: dict[str, np.ndarray] = {}
        # 缓存: a001 → set of cited_code
        self._refs: dict[str, set[str]] = {}
        # 缓存: a001 → set of term
        self._terms: dict[str, set[str]] = {}
        # 缓存: a001 → list of section dicts
        self._sections: dict[str, list[dict]] = {}
        self._loaded = False

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            uri = f"file:{self.db_path}?mode=ro"
            self._conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def load_all(self):
        """启动时一次性加载所有计算产物到内存"""
        if self._loaded:
            return
        t0 = time.time()
        log.info("Loading dedup database into memory...")

        # 1) 标准元数据
        for row in self.conn.execute(
            "SELECT a001, code, name, dedup_tier, ics FROM standards "
            "WHERE dedup_tier IN ('G1','G2','G3')"
        ):
            self._meta[row["a001"]] = (
                row["code"], row["name"], row["dedup_tier"], row["ics"] or ""
            )
        log.info(f"  standards: {len(self._meta)} records")

        # 2) MinHash 指纹
        for row in self.conn.execute(
            "SELECT a001, minhash_signature FROM standard_fingerprints"
        ):
            try:
                arr = pickle.loads(row["minhash_signature"])
                if isinstance(arr, np.ndarray):
                    self._fingerprints[row["a001"]] = arr
            except Exception:
                pass
        log.info(f"  fingerprints: {len(self._fingerprints)} records")

        # 3) 引用
        for row in self.conn.execute(
            "SELECT a001, cited_code FROM standard_references"
        ):
            self._refs.setdefault(row["a001"], set()).add(row["cited_code"])
        log.info(f"  references: {len(self._refs)} standards with refs")

        # 4) 术语
        for row in self.conn.execute(
            "SELECT a001, term FROM standard_terms"
        ):
            self._terms.setdefault(row["a001"], set()).add(row["term"])
        log.info(f"  terms: {len(self._terms)} standards with terms")

        # 5) 章节骨架（只要 type + title，不要 content）
        #    如果表为空或不存在，降级跳过章节级比对
        try:
            for row in self.conn.execute(
                "SELECT a001, section_num, title, section_type FROM standard_sections"
            ):
                self._sections.setdefault(row["a001"], []).append({
                    "num": row["section_num"],
                    "title": row["title"],
                    "type": row["section_type"],
                })
        except Exception:
            log.warning("  standard_sections table missing or unreadable, skipping")
        log.info(f"  sections: {len(self._sections)} standards with sections")

        self._loaded = True
        log.info(f"Database loaded in {time.time()-t0:.1f}s")

    def table_counts(self) -> dict:
        counts = {}
        for table in ["standards", "standard_fingerprints", "standard_sections",
                       "standard_terms", "standard_references"]:
            try:
                row = self.conn.execute(f"SELECT count(*) FROM {table}").fetchone()
                counts[table] = row[0]
            except Exception:
                counts[table] = 0
        return counts


# ─── 主比对函数 ─────────────────────────────────────────────

def compare_against_library(
    db: DedupDB,
    text: str,
    title: str = "",
    ics_hint: str = "",
    top_n: int = 20,
) -> tuple[list[CandidateResult], CompareStats]:
    """
    全库比对主入口
    返回: (candidates, stats)
    """
    t0 = time.time()
    db.load_all()

    # 1. 生成用户文本的 MinHash（方法与 dedup_pipeline.py 一致）
    shingles = _text_to_shingles(text)
    if not shingles:
        return [], CompareStats(total_in_db=len(db._fingerprints))

    user_mh = _make_minhash(shingles)
    user_hashvalues = user_mh.hashvalues

    # 2. 提取用户文本的辅助信息
    user_refs = _extract_user_refs(text)
    user_terms = _extract_user_terms(text)
    user_structure = _extract_user_structure(text)
    user_section_types = {s["type"] for s in user_structure}

    # 3. Phase 1: MinHash 候选筛选 — 计算所有 Jaccard
    #    如果有 ICS hint，先按 ICS 过滤
    candidate_pool = db._fingerprints
    if ics_hint:
        ics_prefix = ics_hint.split(".")[0]  # e.g. "13" from "13.100"
        filtered = {
            a001: fp for a001, fp in candidate_pool.items()
            if a001 in db._meta and db._meta[a001][3].startswith(ics_prefix)
        }
        # 如果过滤后太少，回退到全库
        if len(filtered) >= 10:
            candidate_pool = filtered

    # 快速 Jaccard 估计 + 取 top candidates
    jaccard_scores: list[tuple[str, float]] = []
    for a001, fp_arr in candidate_pool.items():
        j = _jaccard_from_arrays(user_hashvalues, fp_arr)
        if j > 0.02:  # 极低相似度直接跳过
            jaccard_scores.append((a001, j))

    jaccard_scores.sort(key=lambda x: x[1], reverse=True)
    candidates_screened = len(jaccard_scores)

    # 取 top 50 做精细评分
    top_candidates = jaccard_scores[: max(top_n * 3, 50)]

    # 4. Phase 2: 多维精细评分
    results: list[CandidateResult] = []
    for a001, content_sim in top_candidates:
        meta = db._meta.get(a001)
        if not meta:
            continue
        code, name, tier, ics = meta

        # 题名相似度
        t_sim = _ngram_sim(title, name) if title else 0.0

        # 结构相似度
        lib_sections = db._sections.get(a001, [])
        if user_structure and lib_sections:
            lib_types = {s["type"] for s in lib_sections}
            inter = len(user_section_types & lib_types)
            union = len(user_section_types | lib_types)
            struct_sim = inter / union if union else 0.0

            # 章节数量接近度（bonus）
            ratio = min(len(user_structure), len(lib_sections)) / max(len(user_structure), len(lib_sections), 1)
            struct_sim = struct_sim * 0.6 + ratio * 0.4
        else:
            struct_sim = 0.0

        # 引用重叠度
        lib_refs = db._refs.get(a001, set())
        if user_refs and lib_refs:
            # 标准号模糊匹配（去空格后比较）
            u_normalized = {re.sub(r"\s+", "", r) for r in user_refs}
            l_normalized = {re.sub(r"\s+", "", r) for r in lib_refs}
            inter = len(u_normalized & l_normalized)
            union = len(u_normalized | l_normalized)
            ref_sim = inter / union if union else 0.0
        else:
            ref_sim = 0.0

        # 术语重叠度
        lib_terms = db._terms.get(a001, set())
        if user_terms and lib_terms:
            inter = len(user_terms & lib_terms)
            union = len(user_terms | lib_terms)
            term_sim = inter / union if union else 0.0
        else:
            term_sim = 0.0

        # 加权综合
        overall = (
            WEIGHTS["title"] * t_sim
            + WEIGHTS["content"] * content_sim
            + WEIGHTS["structure"] * struct_sim
            + WEIGHTS["reference"] * ref_sim
            + WEIGHTS["term"] * term_sim
        )

        # 匹配详情
        matched_secs = []
        if lib_sections and user_structure:
            for us in user_structure[:10]:
                best_match = max(
                    lib_sections,
                    key=lambda ls: _ngram_sim(us["title"], ls["title"]),
                    default=None,
                )
                if best_match:
                    sim = _ngram_sim(us["title"], best_match["title"])
                    if sim > 0.3:
                        matched_secs.append({
                            "user_section": us["title"],
                            "lib_section": best_match["title"],
                            "similarity": round(sim, 2),
                        })

        matched_ref_list = []
        if user_refs and lib_refs:
            u_norm = {re.sub(r"\s+", "", r): r for r in user_refs}
            l_norm = {re.sub(r"\s+", "", r): r for r in lib_refs}
            for norm_code in set(u_norm) & set(l_norm):
                matched_ref_list.append(l_norm[norm_code])

        matched_term_list = list(user_terms & lib_terms) if user_terms and lib_terms else []

        results.append(CandidateResult(
            code=code,
            name=name,
            overall_score=round(overall, 4),
            title_sim=round(t_sim, 4),
            content_sim=round(content_sim, 4),
            structure_sim=round(struct_sim, 4),
            reference_sim=round(ref_sim, 4),
            term_sim=round(term_sim, 4),
            tier=tier,
            ics=ics,
            matched_sections=matched_secs[:5],
            matched_refs=matched_ref_list[:10],
            matched_terms=matched_term_list[:10],
        ))

    # 排序取 top_n
    results.sort(key=lambda r: r.overall_score, reverse=True)
    results = results[:top_n]

    elapsed_ms = int((time.time() - t0) * 1000)
    stats = CompareStats(
        total_in_db=len(db._fingerprints),
        candidates_screened=candidates_screened,
        processing_ms=elapsed_ms,
    )

    return results, stats
