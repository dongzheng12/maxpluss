"""
报告生成 — 7 模块组装（+ 悬置段检测 + 行业格局分析）
======================
基于比对结果组装标准质量评估报告，对标知网口径。

架构说明：
  - bx_standards.db（73K）：正文比对主库，承担 MinHash 比对 + 引用/术语/章节索引
  - classification_result_final.json（487K）：权威元数据源，承担引用有效性扩查 + 行业格局统计
    （classification_result.json 为中间产物，保留作兜底，dedup 服务默认不再使用）
  - 两库职责不混用，_META_CACHE 服务启动时一次性加载
"""
import json
import logging
import re
import sqlite3
import unicodedata
from dataclasses import asdict
from typing import Optional

from .compare import CandidateResult, CompareStats, DedupDB

log = logging.getLogger("dedup.report")

# ─── 487K 元数据缓存（服务启动时加载，请求时只读）──────────────
_META_CACHE: dict = {}       # original_code → {status, name, ics, ics_name, ccs_name, ...}
_META_NORM_IDX: dict = {}    # normalized_code → original_code（归一化索引，解决全角/连字符/空格差异）

def _normalize_std_code(code: str) -> str:
    """
    标准号归一化：消除全角/半角、连字符变体（—–‐−）、多余空格、大小写差异。
    保留年份尾缀（年份是版本号的一部分，不能去掉）。
    """
    code = unicodedata.normalize("NFKC", code)  # 全角→半角
    code = code.upper()
    for ch in "\u2014\u2013\u2010\u2212":      # — – ‐ −
        code = code.replace(ch, "-")
    code = re.sub(r"\s+", "", code)
    return code


def load_meta_cache(json_path: str) -> None:
    """
    服务启动时调用一次，把 487K classification_result_final.json 载入内存。
    同时构建归一化索引，确保 _meta_lookup() 能稳定命中。
    两步缺一不可：raw dict + norm index，查询时统一走 _meta_lookup()。
    """
    global _META_CACHE, _META_NORM_IDX
    _log = logging.getLogger("dedup.report")
    try:
        with open(json_path, encoding="utf-8") as f:
            _META_CACHE = json.load(f)
        for code in _META_CACHE:
            norm = _normalize_std_code(code)
            if norm not in _META_NORM_IDX:   # 保留第一个（通常是较新版本）
                _META_NORM_IDX[norm] = code
        _log.info(f"Meta cache loaded: {len(_META_CACHE)} records, {len(_META_NORM_IDX)} norm keys from {json_path}")
    except FileNotFoundError:
        _log.warning(f"Meta cache file not found: {json_path}. Reference second-stage lookup will be unavailable.")
    except Exception as e:
        _log.error(f"Failed to load meta cache: {e}")


def _meta_lookup(code: str) -> Optional[dict]:
    """
    487K 元数据查询统一入口，走归一化索引。
    不要直接用 _META_CACHE.get(code)，以免因格式差异漏查。
    """
    if not _META_CACHE:
        return None
    norm = _normalize_std_code(code)
    original = _META_NORM_IDX.get(norm)
    return _META_CACHE.get(original) if original else None


def _classify_risk(overall_max: float, ref_issues: int, struct_issues: int) -> str:
    """综合风险等级"""
    score = 0
    if overall_max >= 0.6:
        score += 3
    elif overall_max >= 0.4:
        score += 2
    elif overall_max >= 0.2:
        score += 1
    if ref_issues >= 3:
        score += 2
    elif ref_issues >= 1:
        score += 1
    if struct_issues >= 2:
        score += 1
    if score >= 5:
        return "high"
    elif score >= 3:
        return "medium"
    return "low"


RISK_LABELS = {"high": "高风险", "medium": "中风险", "low": "低风险"}


def _check_reference_validity(db: DedupDB, cited_codes: set[str]) -> list[dict]:
    """
    两阶段引用有效性检查：
      第1阶段：73K 主库精确匹配（有废止替代逻辑）
      第2阶段：487K 元数据二次查（走归一化索引）
      兜底：年份 < 2015 警告
    """
    issues = []
    for code in sorted(cited_codes):
        normalized = re.sub(r"\s+", "", code)

        # ── 第1阶段：73K 主库（精确匹配，有替代标准查询）──
        row = db.conn.execute(
            "SELECT code, name, status FROM standards WHERE replace(code,' ','') = ? LIMIT 1",
            (normalized,),
        ).fetchone()
        if row:
            status = row["status"] or "未知"
            if status in ("废止", "已废止", "作废"):
                replacement = db.conn.execute(
                    "SELECT code, name FROM standards WHERE code LIKE ? AND status='现行' ORDER BY code DESC LIMIT 1",
                    (normalized.rsplit("-", 1)[0] + "%",),
                ).fetchone()
                issues.append({
                    "cited_code": code,
                    "status": "已废止",
                    "issue": f"{code} 已废止",
                    "replacement": (
                        f"{replacement['code']} {replacement['name']}"
                        if replacement else "请查询最新现行版本"
                    ),
                    "source": "main_db",
                })
            # 现行/未知 — 不报问题
            continue   # 73K 已处理，不走第2阶段

        # ── 第2阶段：487K 元数据（归一化索引查询）──
        meta = _meta_lookup(code)
        if meta:
            meta_status = meta.get("status", "")
            if meta_status in ("作废", "废止"):
                # 优先用 replaces 字段提供真实替代标准号
                replacement_hint = "请查询最新现行版本"
                meta_replaces = meta.get("replaces", "")
                if meta_replaces:
                    replacement_hint = f"建议参照 {meta_replaces}"
                issues.append({
                    "cited_code": code,
                    "status": "已废止",
                    "issue": f"{code} 已废止",
                    "replacement": replacement_hint,
                    "source": "metadata",
                })
            elif meta_status == "现行":
                # 即将废止检查：obsolete_date 已设置则加提醒
                obsolete_date = meta.get("obsolete_date", "")
                if obsolete_date:
                    issues.append({
                        "cited_code": code,
                        "status": "即将废止",
                        "issue": f"{code} 已设废止日期（{obsolete_date}），请关注更新情况",
                        "replacement": "建议核实是否已发布替代标准",
                        "source": "metadata",
                    })
            # 其他状态 → 不报问题
            continue

        # ── 兜底：年份 < 2015 警告（两库都未收录时）──
        year_match = re.search(r"-(\d{4})$", code.strip())
        if year_match and int(year_match.group(1)) < 2015:
            yr = year_match.group(1)
            issues.append({
                "cited_code": code,
                "status": "版本较旧",
                "issue": f"{code} 版本较旧（{yr}年），可能已更新",
                "replacement": "建议核实最新现行版本",
                "source": "heuristic",
            })
        # 未收录且年份无问题（外标、企标）→ 静默，不报问题
    return issues


def _assess_structure(user_sections: list[dict]) -> dict:
    """
    评估用户文档结构完整性（GB/T 1.1-2020 口径）

    基于 GB/T 1.1-2020 检查六项：
      1. 必备章节覆盖（§8.5 范围 / §8.6 规范性引用 / §8.7 术语定义）
      2. 顶层章节跳号（§7.2 章编号应严格连续递增）
      3. 章节深度超 4 级（§9.3 条的层次不宜多于 4 级）
      4. 列项层级检测（§7.5.2 列项细分不宜超过两个层次）
      5. 附录规范性标注检测（§9.6.2 附录应标明规范性或资料性）
    """
    issues: list[dict] = []

    # ── 1. 必备章节（§8.5 / §8.6 / §8.7）──
    required = {
        "scope":          {"label": "范围",       "found": False, "clause": "§8.5"},
        "normative_refs": {"label": "规范性引用文件", "found": False, "clause": "§8.6"},
        "terms":          {"label": "术语和定义",   "found": False, "clause": "§8.7"},
    }
    for sec in user_sections:
        title_lower = sec.get("title", "").lower()
        if "范围" in title_lower or "适用范围" in title_lower:
            required["scope"]["found"] = True
        if "引用" in title_lower:
            required["normative_refs"]["found"] = True
        if "术语" in title_lower or "定义" in title_lower:
            required["terms"]["found"] = True

    missing = []
    for k, v in required.items():
        if not v["found"]:
            missing.append(v["label"])
            issues.append({
                "issue": f"缺少必备要素「{v['label']}」",
                "clause": f"GB/T 1.1-2020 {v['clause']}",
                "severity": "error",
                "suggestion": f"请补充「{v['label']}」章节，该章为标准必备要素",
            })

    # ── 2. 顶层章节跳号（§7.2）──
    # 只统计纯数字顶层号（1/2/3…），忽略 > 50 的（防 OCR 误识别页码/表号）
    top_nums: list[int] = []
    for sec in user_sections:
        num = sec.get("num", "").strip()
        if re.match(r"^\d+$", num):
            n = int(num)
            if n <= 50:
                top_nums.append(n)

    top_nums_sorted = sorted(set(top_nums))
    gap_issues: list[dict] = []
    for i in range(len(top_nums_sorted) - 1):
        a, b = top_nums_sorted[i], top_nums_sorted[i + 1]
        if b - a > 1:
            issue = {
                "from_num": a,
                "to_num":   b,
                "issue":  f"章节编号跳号：第 {a} 章 → 第 {b} 章，中间缺少 {b - a - 1} 个章节",
                "clause": "GB/T 1.1-2020 §7.2",
                "severity": "warning",
                "suggestion": "章编号应严格连续递增，请核实是否有章节遗漏",
            }
            gap_issues.append(issue)
            issues.append(issue)

    # ── 3. 深度超 4 级（§9.3）──
    depth_issues: list[dict] = []
    for sec in user_sections:
        num = sec.get("num", "").strip()
        if not num:
            continue
        if re.match(r"^[A-Z]$", num):
            continue
        depth = len(num.split("."))
        if depth > 4:
            issue = {
                "section": num,
                "title":   sec.get("title", ""),
                "depth":   depth,
                "issue": f"章节 {num}《{sec.get('title', '')}》深度 {depth} 级，超过 4 级上限",
                "clause": "GB/T 1.1-2020 §9.3",
                "severity": "warning",
                "suggestion": "条的层次不宜多于 4 级，建议拆分或合并子条",
            }
            depth_issues.append(issue)
            issues.append(issue)
    depth_issues = depth_issues[:5]

    # ── 4. 列项层级检测（§7.5.2）──
    # 检测正文中列项嵌套是否超过两层（a) 1) 或 — — — 三层嵌套）
    list_nesting_issues: list[dict] = []
    for sec in user_sections:
        content = sec.get("content", "")
        if not content:
            continue
        # 简单检测：连续缩进的列项标记层数
        lines = content.split("\n")
        max_depth = 0
        for line in lines:
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            # 列项标记：a) b) 1) 2) — ● · 等
            if re.match(r"^[a-z]\)|^\d\)|^[—●·•‒]\s", stripped):
                depth = 1 + (indent // 4)  # 每 4 空格算一层
                max_depth = max(max_depth, depth)
        if max_depth > 2:
            issue = {
                "section": sec.get("num", ""),
                "issue": f"章节 {sec.get('num', '')} 列项嵌套 {max_depth} 层，超过 2 层上限",
                "clause": "GB/T 1.1-2020 §7.5.2",
                "severity": "warning",
                "suggestion": "列项细分不宜超过两个层次，建议简化层级",
            }
            list_nesting_issues.append(issue)
            issues.append(issue)
    list_nesting_issues = list_nesting_issues[:5]

    # ── 5. 附录规范性标注检测（§9.6.2）──
    appendix_issues: list[dict] = []
    for sec in user_sections:
        title = sec.get("title", "")
        num = sec.get("num", "").strip()
        if not (num and re.match(r"^[A-Z]$", num)):
            continue
        # 附录标题应包含"规范性"或"资料性"
        if "规范性" not in title and "资料性" not in title:
            issue = {
                "section": num,
                "title": title,
                "issue": f"附录 {num}「{title}」未标明规范性或资料性",
                "clause": "GB/T 1.1-2020 §9.6.2",
                "severity": "warning",
                "suggestion": "附录编号之下应标明「（规范性）」或「（资料性）」",
            }
            appendix_issues.append(issue)
            issues.append(issue)

    complete = len(issues) == 0

    return {
        "total_sections":  len(user_sections),
        "required_found":  sum(1 for v in required.values() if v["found"]),
        "required_total":  len(required),
        "missing":         missing,
        "gap_issues":      gap_issues,
        "depth_issues":    depth_issues,
        "list_nesting_issues": list_nesting_issues,
        "appendix_issues": appendix_issues,
        "issues":          issues,           # 统一格式的全部问题
        "complete":        complete,
    }


# ─── 内部引用模式：见第X章 / 按X.X.X / 见附录A ─────────────
_INTERNAL_REF_PATTERNS = [
    re.compile(r"见第\s*(\d+(?:\.\d+)*)\s*[章节条款]"),
    re.compile(r"参见第?\s*(\d+(?:\.\d+)*)\s*[章节条款]"),
    re.compile(r"按\s*(\d+(?:\.\d+)*)\s*(?:的规定|章节条款|条|节|章)"),
    re.compile(r"按照\s*(\d+(?:\.\d+)*)\s*(?:的规定|章节条款|条|节|章)"),
    re.compile(r"见附录\s*([A-Z])"),
    re.compile(r"参见附录\s*([A-Z])"),
    re.compile(r"附录\s*([A-Z])\s*[（(]规范性|资料性"),
]


def _check_dangling_sections(text: str, user_sections: list[dict]) -> dict:
    """
    检测正文中内部章节引用指向不存在的章节（悬置引用）。
    只记录引用描述 + 目标章节号 + 所在章节（定位信息），不截取原文片段，
    以保持报告产品感，避免做成文本阅读器。
    """
    # 构建已知章节号集合
    known_nums: set[str] = {s["num"] for s in user_sections}
    known_appendix: set[str] = set()
    for s in user_sections:
        title = s.get("title", "")
        if title.startswith("附录") and len(title) >= 3 and title[2].isupper():
            known_appendix.add(title[2])

    dangling = []
    all_ref_targets: set[str] = set()

    for pattern in _INTERNAL_REF_PATTERNS:
        for m in pattern.finditer(text):
            ref_target = m.group(1)
            if not ref_target:
                continue
            all_ref_targets.add(ref_target)

            is_dangling = False
            if ref_target.isupper() and len(ref_target) == 1:
                # 附录字母
                if ref_target not in known_appendix:
                    is_dangling = True
            else:
                if ref_target not in known_nums:
                    # 允许引用父章节（如引用"4.3"，实际只有"4.3.1"/"4.3.2"）
                    has_child = any(num.startswith(ref_target + ".") for num in known_nums)
                    if not has_child:
                        is_dangling = True

            if is_dangling:
                # 找所在章节：引用位置之前最近的章节标题（只作定位，不含原文内容）
                containing_section = ""
                pos = m.start()
                for sec in reversed(user_sections):
                    probe = sec["num"] + " " + sec.get("title", "")
                    sec_pos = text.find(probe)
                    if sec_pos != -1 and sec_pos < pos:
                        containing_section = f"{sec['num']} {sec.get('title', '')}"
                        break
                dangling.append({
                    "ref": m.group(0),
                    "target": ref_target,
                    "in_section": containing_section,
                    "issue": f"内部引用「{m.group(0)}」指向不存在的章节",
                    "clause": "GB/T 1.1-2020 §7.4",
                    "severity": "warning",
                    "suggestion": "章标题与条之间不应有悬置段，请核实引用目标是否正确",
                })

    # 按目标章节号去重（同一目标多处引用只报一次）
    seen: set[str] = set()
    unique_dangling = []
    for d in dangling:
        if d["target"] not in seen:
            seen.add(d["target"])
            unique_dangling.append(d)

    return {
        "checked": len(all_ref_targets),
        "dangling_count": len(unique_dangling),
        "dangling": unique_dangling[:20],
        "complete": len(unique_dangling) == 0,
    }


def _build_industry_landscape(
    top_candidates: list[CandidateResult],
    user_ics_hint: str = "",
) -> dict:
    """
    基于相似标准 ICS 分类，在 487K 元数据中统计领域现行/废止/即将实施标准数量。
    结果为启发式参考统计，不代表精确领域归类，前端需标注"参考"字样。
    """
    if not _META_CACHE:
        return {"available": False, "reason": "meta_cache_not_loaded"}

    # 确定 ICS 大类前缀
    primary_ics = ""
    if user_ics_hint:
        primary_ics = user_ics_hint.split(".")[0]
    else:
        ics_list = [c.ics for c in top_candidates[:5] if c.ics]
        if ics_list:
            from collections import Counter
            prefixes = [ics.split(".")[0] for ics in ics_list]
            primary_ics = Counter(prefixes).most_common(1)[0][0]

    if not primary_ics:
        return {"available": False, "reason": "no_ics_hint"}

    active_count = 0
    obsolete_count = 0
    upcoming_count = 0
    ics_name = ""

    for code, meta in _META_CACHE.items():
        ics = meta.get("ics", "") or ""
        if not ics.startswith(primary_ics):
            continue
        status = meta.get("status", "")
        if not ics_name and meta.get("ics_name"):
            ics_name = meta["ics_name"]
        if status == "现行":
            active_count += 1
        elif status in ("作废", "废止"):
            obsolete_count += 1
        elif status == "即将实施":
            upcoming_count += 1

    return {
        "available": True,
        "ics_prefix": primary_ics,
        "ics_name": ics_name,
        "active_count": active_count,
        "obsolete_count": obsolete_count,
        "upcoming_count": upcoming_count,
        # 文案明确标注"参考统计"，不写绝对判断
        "insight": (
            f"基于相似标准 ICS 分类的领域参考统计：{primary_ics}"
            + (f" {ics_name}" if ics_name else "")
            + f" 下现行 {active_count} 条，已废止 {obsolete_count} 条，即将实施 {upcoming_count} 条。"
            "（仅供参考，不代表对立项可行性的判断）"
        ),
    }


def build_report(
    db: DedupDB,
    text: str,
    title: str,
    candidates: list[CandidateResult],
    stats: CompareStats,
    user_refs: set[str],
    user_terms: set[str],
    user_sections: list[dict],
    ics_hint: str = "",
) -> dict:
    """
    组装 7 模块报告 + 悬置段检测 + 行业格局分析
    返回可 JSON 序列化的 dict
    """

    # ── 模块 1: 基础信息 ──
    basic_info = {
        "title": title or "未命名标准",
        "text_length": len(text),
        "section_count": len(user_sections),
        "reference_count": len(user_refs),
        "term_count": len(user_terms),
    }

    # ── 模块 2: 风险等级 ──
    max_overall = max((c.overall_score for c in candidates), default=0.0)
    ref_issues = _check_reference_validity(db, user_refs)
    struct_result = _assess_structure(user_sections)
    # 结构问题 = 必备章节缺失 + 跳号 + 深度超限（每类各算1分，上限3）
    struct_issues_count = (
        len(struct_result["missing"])
        + (1 if struct_result["gap_issues"] else 0)
        + (1 if struct_result["depth_issues"] else 0)
    )

    # 悬置段检测（需要 text + user_sections，结果纳入风险评分）
    dangling_result = _check_dangling_sections(text, user_sections)
    dangling_penalty = 1 if dangling_result["dangling_count"] >= 3 else 0

    risk_level = _classify_risk(
        max_overall,
        len(ref_issues),
        struct_issues_count + dangling_penalty,  # 结构问题 + 悬置段加入结构风险
    )

    # ── 模块 3: 评估结果总述 ──
    summary = {
        "overall_max": round(max_overall * 100, 1),   # 统一百分比数值（如 45.2 表示 45.2%）
        "risk_level": risk_level,
        "risk_label": RISK_LABELS[risk_level],
        "dimensions": {
            "title":     round(max((c.title_sim     for c in candidates), default=0.0) * 100, 1),
            "content":   round(max((c.content_sim   for c in candidates), default=0.0) * 100, 1),
            "structure": round(max((c.structure_sim for c in candidates), default=0.0) * 100, 1),
            "reference": round(max((c.reference_sim for c in candidates), default=0.0) * 100, 1),
            "term":      round(max((c.term_sim      for c in candidates), default=0.0) * 100, 1),
        },
        "candidates_total": stats.candidates_screened,
        "db_total": stats.total_in_db,
    }

    # ── 模块 4: 高相似度标准（附加 status / pub_date / impl_date / issuing_dept）──
    top_similar = []
    for c in candidates[:10]:
        # 从 487K 元数据查丰富字段
        meta_entry = _meta_lookup(c.code)
        if meta_entry:
            std_status    = meta_entry.get("status", "")
            std_pub_date  = meta_entry.get("pub_date", "")
            std_impl_date = meta_entry.get("impl_date", "")
            std_dept      = meta_entry.get("issuing_dept", "")
        else:
            std_status = std_pub_date = std_impl_date = std_dept = ""
        top_similar.append({
            "code": c.code,
            "name": c.name,
            "status": std_status,           # 现行 / 作废 / 废止 / 即将实施 / ""
            "pub_date": std_pub_date,       # 发布日期，如 "2023-05-12"
            "impl_date": std_impl_date,     # 实施日期
            "issuing_dept": std_dept,       # 发布机构
            "overall_score": round(c.overall_score * 100, 1),
            "title_sim": round(c.title_sim * 100, 1),
            "content_sim": round(c.content_sim * 100, 1),
            "structure_sim": round(c.structure_sim * 100, 1),
            "reference_sim": round(c.reference_sim * 100, 1),
            "term_sim": round(c.term_sim * 100, 1),
            "matched_sections": c.matched_sections,
            "matched_refs": c.matched_refs,
            "matched_terms": c.matched_terms,
        })

    # ── 模块 5: 引用文件规范性 ──
    references = {
        "total": len(user_refs),
        "valid": len(user_refs) - len(ref_issues),
        "issues": ref_issues,
    }

    # ── 模块 6: 术语和定义 ──
    # 汇总所有候选标准中匹配到的术语
    all_matched_terms: dict[str, list[str]] = {}
    for c in candidates[:10]:
        for t in c.matched_terms:
            all_matched_terms.setdefault(t, []).append(c.code)

    terms = {
        "user_total": len(user_terms),
        "matched": len(all_matched_terms),
        "details": [
            {"term": t, "matched_in": codes[:3]}
            for t, codes in sorted(all_matched_terms.items())
        ],
    }

    # ── 模块 7: 正文重复率 ──
    # 基于 MinHash Jaccard，估算整体内容重复率
    content_sims = [c.content_sim for c in candidates if c.content_sim > 0.05]
    if content_sims:
        avg_dup = sum(content_sims[:5]) / len(content_sims[:5])
    else:
        avg_dup = 0.0

    duplication = {
        "estimated_rate": round(avg_dup * 100, 1),
        "high_sim_count": len([c for c in candidates if c.content_sim > 0.3]),
        "medium_sim_count": len([c for c in candidates if 0.15 < c.content_sim <= 0.3]),
        "low_sim_count": len([c for c in candidates if 0.05 < c.content_sim <= 0.15]),
    }

    # ── 结论生成 ──
    conclusions = []
    if risk_level == "high":
        conclusions.append("当前文档与多份现行标准存在较高相似度，建议重新评估立项必要性。")
    elif risk_level == "medium":
        conclusions.append("文档与部分现行标准存在中等程度相似，建议对相似内容进行差异化修订。")
    else:
        conclusions.append("文档整体原创性良好，与现有标准重叠度较低。")

    if ref_issues:
        conclusions.append(f"检测到 {len(ref_issues)} 条引用标准可能存在版本或有效性问题，建议逐条核实。")

    if struct_result["missing"]:
        conclusions.append(f"文档缺少以下标准必备结构：{'、'.join(struct_result['missing'])}，建议补充。")
    if struct_result["gap_issues"]:
        gap_desc = "；".join(g["issue"] for g in struct_result["gap_issues"][:2])
        conclusions.append(f"章节编号存在跳号（{gap_desc}），建议按 GB/T 1.1-2020 重新梳理章节顺序。")
    if struct_result["depth_issues"]:
        conclusions.append(
            f"检测到 {len(struct_result['depth_issues'])} 处章节深度超过 4 级，"
            "GB/T 1.1-2020 §9.3 建议层级不超 4 级，建议合并或重组。"
        )

    if all_matched_terms:
        conclusions.append(f"检测到 {len(all_matched_terms)} 个术语与现有标准定义一致，建议标注来源。")

    if dangling_result["dangling_count"] > 0:
        conclusions.append(
            f"检测到 {dangling_result['dangling_count']} 处内部章节引用指向不存在的章节，"
            "建议逐一核实后修正，以避免送审被退回。"
        )

    # ── 行业格局分析（元数据联动，启发式参考统计）──
    industry_landscape = _build_industry_landscape(candidates[:5], ics_hint)

    # ── 免费风险摘要（未解锁时也能看到的部分）──
    free_risk = []
    if max_overall >= 0.4:
        high_count = len([c for c in candidates if c.overall_score >= 0.4])
        free_risk.append(f"命中 {high_count} 条高相似度标准，最高综合相似度 {round(max_overall*100,1)}%。")
    if ref_issues:
        free_risk.append(f"检测到 {len(ref_issues)} 条引用标准可能存在版本问题，建议核实。")
    if struct_result["missing"]:
        free_risk.append(f"文档结构缺少 {len(struct_result['missing'])} 项标准必备部分。")
    if struct_result["gap_issues"]:
        free_risk.append(f"章节编号存在 {len(struct_result['gap_issues'])} 处跳号，建议核实。")
    if struct_result["depth_issues"]:
        free_risk.append(f"检测到 {len(struct_result['depth_issues'])} 处章节层级超过 4 级。")
    if not free_risk:
        free_risk.append("未发现显著风险，文档结构和内容整体符合规范。（本分析为系统自动生成，仅供参考）")

    return {
        "basic_info": basic_info,
        "risk_level": risk_level,
        "risk_label": RISK_LABELS[risk_level],
        "summary": summary,
        "top_similar": top_similar,
        "references": references,
        "terms": terms,
        "duplication": duplication,
        "structure": struct_result,
        "dangling_sections": dangling_result,        # 新增：悬置段检测
        "industry_landscape": industry_landscape,   # 新增：行业格局分析
        "conclusions": conclusions,
        "free_risk": free_risk,
        "stats": {
            "total_compared": stats.total_in_db,
            "candidates_screened": stats.candidates_screened,
            "processing_ms": stats.processing_ms,
        },
    }
