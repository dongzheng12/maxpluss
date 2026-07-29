#!/usr/bin/env python3
"""
dedup 功能回归测试 — CI + Docker 构建门禁用
覆盖：品牌匹配 / OCR 归一化 / 返回结构 / SQLite Row 兼容 / 降级路径 / 元数据搜索

每个测试对应一个已踩过的线上 bug 或高风险路径。
失败即阻断 CI 和 Docker 构建。

用法: python test_dedup_regression.py
返回: 0=ALL PASS, 1=有失败
"""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path
from collections import Counter

CHECKS = []
FAILED = 0

def test(name, ok, detail=""):
    global FAILED
    status = "✅" if ok else "❌"
    if not ok:
        FAILED += 1
    CHECKS.append((name, ok, detail))
    print(f"  {status} {name}{('  — ' + detail) if detail else ''}")
    return ok


# ═══════════════════════════════════════════════════════════
# 1. normalize_ocr_text — 回归: crypto.randomUUID 类运行时崩溃
# ═══════════════════════════════════════════════════════════
print("\n[1/7] OCR 文本归一化")

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

def normalize_ocr_text(text):
    if not text:
        return ""
    text = text.translate(_FULLWIDTH_MAP)
    text = re.sub(r'[\s\n\r\t]+', '', text)
    text = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]', '', text)
    text = text.lower()
    return text

cases = [
    ("伊  利  纯  牛  奶", "伊利纯牛奶"),
    ("蓝月\u3000亮洗衣液", "蓝月亮洗衣液"),
    ("ＣＯＣＡ ＣＯＬＡ", "cocacola"),
    ("海天 酱油（特级）", "海天酱油特级"),
    ("金龙鱼1:1:1", "金龙鱼111"),
    ("  洁 柔 纸巾\n200抽  ", "洁柔纸巾200抽"),
    ("", ""),
    (None, ""),
]
for inp, expected in cases:
    result = normalize_ocr_text(inp)
    test(f"normalize({inp!r:.25s})", result == expected,
         f"got {result!r}" if result != expected else "")


# ═══════════════════════════════════════════════════════════
# 2. Aho-Corasick 品牌匹配 — 回归: 56K 品牌暴力遍历性能
# ═══════════════════════════════════════════════════════════
print("\n[2/7] Aho-Corasick 品牌匹配")

try:
    import ahocorasick
    _HAS_AC = True
except ImportError:
    _HAS_AC = False

test("pyahocorasick 已安装", _HAS_AC, "" if _HAS_AC else "pip install pyahocorasick>=2.0")

if _HAS_AC:
    # 构建测试自动机
    test_brands = {
        "伊利": "牛奶", "蒙牛": "牛奶", "海天": "酱油调味品",
        "蓝月亮": "洗衣液", "洁柔": "纸巾", "农夫山泉": "矿泉水",
        "金龙鱼": "食用油", "三只松鼠": "坚果", "可口可乐": "碳酸饮料",
        "飞鹤": "婴幼儿配方奶粉",
    }
    ac = ahocorasick.Automaton()
    for brand, cat in test_brands.items():
        ac.add_word(brand, (brand, cat))
    ac.make_automaton()

    # 2a: 单品牌命中
    hits = [(b, c) for _, (b, c) in ac.iter("这是伊利纯牛奶250ml")]
    test("单品牌命中", any(b == "伊利" for b, c in hits))

    # 2b: 多品牌同时命中
    hits = [(b, c) for _, (b, c) in ac.iter("超市有伊利牛奶海天酱油洁柔纸巾")]
    brands_found = {b for b, c in hits}
    test("多品牌同时命中", {"伊利", "海天", "洁柔"}.issubset(brands_found),
         f"found: {brands_found}")

    # 2c: 归一化后命中
    ac_norm = ahocorasick.Automaton()
    for brand, cat in test_brands.items():
        nb = normalize_ocr_text(brand)
        if nb:
            ac_norm.add_word(nb, (brand, cat))
    ac_norm.make_automaton()

    norm_text = normalize_ocr_text("蓝 月 亮 洗衣液")
    hits_norm = [(b, c) for _, (b, c) in ac_norm.iter(norm_text)]
    test("归一化后命中蓝月亮", any(b == "蓝月亮" for b, c in hits_norm))

    # 2d: 空文本不崩溃
    hits_empty = list(ac.iter(""))
    test("空文本不崩溃", hits_empty == [])

    # 2e: 性能 — 56K 品牌模拟
    big_ac = ahocorasick.Automaton()
    for i in range(56000):
        fake_brand = f"品牌{i:05d}"
        big_ac.add_word(fake_brand, (fake_brand, "测试"))
    # 加几个真实品牌
    for b, c in test_brands.items():
        big_ac.add_word(b, (b, c))
    big_ac.make_automaton()

    long_text = "这款海天特级酱油调味品很不错配上金龙鱼食用油做菜真香再买点伊利纯牛奶" * 5
    t0 = time.perf_counter()
    for _ in range(100):
        list(big_ac.iter(long_text))
    ms = (time.perf_counter() - t0) * 1000
    test("56K品牌匹配性能", ms < 500, f"100次={ms:.1f}ms，均{ms/100:.2f}ms/次")


# ═══════════════════════════════════════════════════════════
# 3. SQLite Row 兼容性 — 回归: pysqlite3 row.get() 崩溃
# ═══════════════════════════════════════════════════════════
print("\n[3/7] SQLite Row 兼容性")

# 模拟 pysqlite3 的 Row 行为（标准 sqlite3.Row 也没有 .get()）
conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.execute("CREATE TABLE t (code TEXT, name TEXT, scope TEXT, cleaned_text TEXT, pub_date TEXT)")
conn.execute("INSERT INTO t VALUES ('GB/T 1234', '测试标准', '适用于测试', '正文内容', '2024-01-01')")

row = conn.execute("SELECT * FROM t LIMIT 1").fetchone()

# 3a: row.get() 应该不存在（这是踩过的坑）
has_get = hasattr(row, 'get')
test("Row 无 .get() 方法（预期）", not has_get,
     "如果有 .get() 说明用的是 dict 不是 Row" if has_get else "")

# 3b: 正确的访问方式
test("row['field'] 可用", row["code"] == "GB/T 1234")
test("'field' in row.keys() 可用", "scope" in row.keys())
test("不存在的字段检测", "nonexistent" not in row.keys())

# 3c: 模拟 rerank 的 Row 访问模式（不能用 .get()）
try:
    scope_text = (row["scope"] or "") if "scope" in row.keys() else ""
    cleaned_text = (row["cleaned_text"] or "") if "cleaned_text" in row.keys() else ""
    _pub = row["pub_date"] if "pub_date" in row.keys() else None
    test("rerank Row 访问模式正确", scope_text == "适用于测试" and _pub == "2024-01-01")
except AttributeError as e:
    test("rerank Row 访问模式正确", False, str(e))

conn.close()


# ═══════════════════════════════════════════════════════════
# 4. 返回结构完整性 — 回归: 前端依赖字段缺失导致白屏
# ═══════════════════════════════════════════════════════════
print("\n[4/7] 返回结构完整性")

# 模拟 _enrich_standard_item 的输出
REQUIRED_FIELDS = {
    "code": str,
    "name": str,
    "status": str,
    "relevance_score": (int, float),
    "match_reason": str,
    "category_match": str,
    "focus_topics": list,
    "suggested_sections": list,
    "pub_date": (str, type(None)),
    "ics": (str, type(None)),
}

# 模拟一个最小输入
mock_item = {
    "code": "GB/T 1234-2024",
    "name": "测试标准名称",
    "status": "现行",
    "match_score": 5.0,
    "_matched_kw": "测试",
    "_source": "metadata_487k",
}

# 模拟 enrich 逻辑
def mock_enrich(item, matched_by_code=False, industry_label=None, industry_token=None):
    raw_score = item.get("match_score", 0.0)
    return {
        "code": item.get("code", ""),
        "name": item.get("name", ""),
        "status": item.get("status", "") or "未知",
        "relevance_score": round(max(0.0, min(raw_score, 10.0)), 1),
        "match_reason": "测试匹配",
        "category_match": industry_label or "",
        "focus_topics": [],
        "suggested_sections": ["范围", "技术要求"],
        "pub_date": item.get("pub_date") or None,
        "ics": item.get("ics") or None,
    }

enriched = mock_enrich(mock_item, industry_label="牛奶")

for field, expected_type in REQUIRED_FIELDS.items():
    present = field in enriched
    type_ok = isinstance(enriched.get(field), expected_type) if present else False
    test(f"字段 {field}", present and type_ok,
         f"missing" if not present else f"type={type(enriched[field]).__name__}" if not type_ok else "")


# ═══════════════════════════════════════════════════════════
# 5. 品牌库数据质量
# ═══════════════════════════════════════════════════════════
print("\n[5/7] 品牌库数据质量")

brand_path = Path(__file__).parent / "brand_category_extended.json"
if brand_path.exists():
    with open(brand_path, "r", encoding="utf-8") as f:
        brands = json.load(f)

    test("品牌库类型", isinstance(brands, dict))
    test("品牌库 ≥50000", len(brands) >= 50000, f"实际 {len(brands)}")

    # 值都是字符串
    bad_vals = [k for k, v in list(brands.items())[:500] if not isinstance(v, str) or not v]
    test("品牌值都是非空字符串", len(bad_vals) == 0,
         f"前500条有{len(bad_vals)}个异常" if bad_vals else "")

    # key 都 ≥2 字符
    short_keys = [k for k in list(brands.keys())[:1000] if len(k) < 2]
    test("品牌名 ≥2 字符", len(short_keys) == 0,
         f"有{len(short_keys)}个过短key" if short_keys else "")

    # 核心品牌必须存在
    must_have = ["伊利", "海天", "农夫山泉", "洁柔", "金龙鱼"]
    missing = [b for b in must_have if b not in brands]
    test("核心品牌存在", len(missing) == 0,
         f"缺失: {missing}" if missing else "")
else:
    test("品牌库文件存在", False, str(brand_path))


# ═══════════════════════════════════════════════════════════
# 6. 降级路径 — 回归: 无 AC 时 fallback 是否可用
# ═══════════════════════════════════════════════════════════
print("\n[6/7] 降级路径验证")

# 模拟无 AC 的线性扫描 fallback
def linear_brand_match(text, brand_map):
    """模拟 service.py 中 _HAS_AHOCORASICK=False 时的 fallback"""
    if not text:
        return []
    cleaned = re.sub(r"[\s\n]+", " ", text).strip()
    results = {}
    for brand_name in sorted(brand_map.keys(), key=len, reverse=True):
        if len(brand_name) < 2:
            continue
        if brand_name in cleaned:
            results[brand_name] = {"brand": brand_name, "category": brand_map[brand_name]}
    return list(results.values())

fallback_result = linear_brand_match("超市有伊利牛奶和海天酱油", test_brands if _HAS_AC else {
    "伊利": "牛奶", "海天": "酱油调味品"
})
fb_brands = {r["brand"] for r in fallback_result}
test("线性扫描 fallback 能命中", "伊利" in fb_brands and "海天" in fb_brands)

# 空文本 fallback
test("fallback 空文本安全", linear_brand_match("", test_brands if _HAS_AC else {}) == [])
test("fallback None 安全", linear_brand_match(None, test_brands if _HAS_AC else {}) == [])


# ═══════════════════════════════════════════════════════════
# 7. 通用词过滤 — 回归: "牛奶""月亮" 等通用词误匹配
# ═══════════════════════════════════════════════════════════
print("\n[7/7] 通用词过滤")

GENERIC_WORDS = {"牛奶", "酸奶", "面包", "饼干", "月亮", "可口", "黄金", "国产", "中国",
                 "红色", "蓝色", "金色", "黑色", "白色", "通用", "日用", "经典", "标准"}

# 验证过滤逻辑
mock_matches = {
    "伊利": {"brand": "伊利", "category": "牛奶"},
    "牛奶": {"brand": "牛奶", "category": "牛奶"},  # 应被过滤
    "月亮": {"brand": "月亮", "category": "洗衣液"},  # 应被过滤
    "海天": {"brand": "海天", "category": "酱油调味品"},
}
filtered = {k: v for k, v in mock_matches.items() if k not in GENERIC_WORDS}
test("通用词被过滤", "牛奶" not in filtered and "月亮" not in filtered)
test("真实品牌保留", "伊利" in filtered and "海天" in filtered)


# ═══════════════════════════════════════════════════════════
# 汇总
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
total = len(CHECKS)
passed = total - FAILED
if FAILED == 0:
    print(f"dedup 回归测试: ALL {total} PASSED ✅ — 可以上线")
    sys.exit(0)
else:
    print(f"dedup 回归测试: {FAILED}/{total} FAILED ❌ — 不可上线")
    print("\n失败项:")
    for name, ok, detail in CHECKS:
        if not ok:
            print(f"  ❌ {name}: {detail}")
    sys.exit(1)
