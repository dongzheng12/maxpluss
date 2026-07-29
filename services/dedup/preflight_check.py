#!/usr/bin/env python3
"""
上线前自检脚本 — 检查所有关键依赖和数据是否就绪。
用法: python preflight_check.py
返回: 0=PASS, 1=FAIL
"""
import json
import os
import sys
from pathlib import Path

BASE = Path(__file__).parent
DATA = BASE / "../../data"
CHECKS = []

def check(name, ok, detail=""):
    status = "✅ PASS" if ok else "❌ FAIL"
    CHECKS.append((name, ok, detail))
    print(f"  {status}  {name}{('  — ' + detail) if detail else ''}")
    return ok

print("=" * 60)
print("标准小智 dedup 服务上线前自检")
print("=" * 60)

# 1. pyahocorasick 依赖
print("\n[1/5] 依赖检查")
try:
    import ahocorasick
    check("pyahocorasick", True, "已安装")
except ImportError:
    check("pyahocorasick", False, "未安装！运行: pip install pyahocorasick>=2.0")

# 2. 品牌库
print("\n[2/5] 品牌库检查")
brand_path = BASE / "brand_category_extended.json"
if brand_path.exists():
    with open(brand_path, "r", encoding="utf-8") as f:
        brands = json.load(f)
    check("品牌库文件", True, f"{len(brands)} 条")
    check("品牌库数量", len(brands) >= 50000, f"预期 ≥50000，实际 {len(brands)}")
else:
    check("品牌库文件", False, f"文件不存在: {brand_path}")

# 3. Aho-Corasick 自动机构建测试
print("\n[3/5] Aho-Corasick 构建测试")
try:
    import ahocorasick as _ac
    ac = _ac.Automaton()
    test_brands = {"伊利": "牛奶", "海天": "酱油", "洁柔": "纸巾"}
    for b, c in test_brands.items():
        ac.add_word(b, (b, c))
    ac.make_automaton()
    results = list(ac.iter("我买了伊利牛奶和海天酱油"))
    check("自动机构建", len(results) >= 2, f"测试匹配 {len(results)} 个品牌")
except Exception as e:
    check("自动机构建", False, str(e))

# 4. 487K 元数据
print("\n[4/5] 487K 元数据检查")
meta_path = DATA / "classification_result_final.json"
if meta_path.exists():
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    check("元数据文件", True, f"{len(meta)} 条")
    check("元数据数量", len(meta) >= 400000, f"预期 ≥400000，实际 {len(meta)}")
    # 字段完整性抽查
    sample_code = list(meta.keys())[0]
    sample = meta[sample_code]
    has_name = "name" in sample
    has_status = "status" in sample
    check("元数据字段完整", has_name and has_status, f"name={'✓' if has_name else '✗'} status={'✓' if has_status else '✗'}")
else:
    check("元数据文件", False, f"文件不存在: {meta_path}")

# 5. 73K SQLite 数据库
print("\n[5/5] 标准库 SQLite 检查")
db_path = DATA / "bx_standards.db"
if db_path.exists():
    import sqlite3
    conn = sqlite3.connect(str(db_path))
    count = conn.execute("SELECT count(*) FROM standards").fetchone()[0]
    check("标准库文件", True, f"{count} 条标准")
    check("标准库数量", count >= 70000, f"预期 ≥70000，实际 {count}")
    # 字段检查
    cols = [row[1] for row in conn.execute("PRAGMA table_info(standards)").fetchall()]
    has_scope = "scope" in cols
    fp_count = conn.execute("SELECT count(*) FROM standard_fingerprints").fetchone()[0] if "standard_fingerprints" in [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()] else 0
    check("指纹表", has_scope and fp_count > 0, f"scope={'✓' if has_scope else '✗'} fingerprints={fp_count}")
    conn.close()
else:
    check("标准库文件", False, f"文件不存在: {db_path}")

# 汇总
print("\n" + "=" * 60)
total = len(CHECKS)
passed = sum(1 for _, ok, _ in CHECKS if ok)
failed = total - passed
if failed == 0:
    print(f"结果: ALL {total} CHECKS PASSED ✅ — 可以上线")
    sys.exit(0)
else:
    print(f"结果: {failed}/{total} CHECKS FAILED ❌ — 不可上线")
    print("\n失败项:")
    for name, ok, detail in CHECKS:
        if not ok:
            print(f"  ❌ {name}: {detail}")
    sys.exit(1)
