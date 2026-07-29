#!/usr/bin/env python3
"""
品牌匹配优化测试 — 独立脚本，不依赖 FastAPI/auth
测试: Aho-Corasick + normalize_ocr_text + signal brands
"""
import json
import re
import sys
from pathlib import Path

# ── 1. 测试 normalize_ocr_text ──

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
    if not text:
        return ""
    text = text.translate(_FULLWIDTH_MAP)
    text = re.sub(r'[\s\n\r\t]+', '', text)
    text = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]', '', text)
    text = text.lower()
    return text

print("=== 测试 1: normalize_ocr_text ===")
cases = [
    ("伊  利  纯  牛  奶", "伊利纯牛奶"),
    ("蓝月　亮洗衣液", "蓝月亮洗衣液"),
    ("ＣＯＣＡ　ＣＯＬＡ", "cocacola"),
    ("海天 酱油（特级）", "海天酱油特级"),
    ("金龙鱼1:1:1", "金龙鱼111"),
    ("  洁 柔 纸巾\n200抽  ", "洁柔纸巾200抽"),
]
all_pass = True
for inp, expected in cases:
    result = normalize_ocr_text(inp)
    ok = result == expected
    if not ok:
        all_pass = False
    print(f"  {'✓' if ok else '✗'} {inp!r:30s} → {result!r} {'(expected: '+expected+')' if not ok else ''}")
print(f"  归一化: {'全部通过' if all_pass else '有失败'}\n")

# ── 2. 测试 Aho-Corasick 构建 ──

print("=== 测试 2: Aho-Corasick 自动机 ===")
try:
    import ahocorasick
    print("  ahocorasick 可用")
except ImportError:
    print("  ✗ ahocorasick 未安装，请运行: pip install pyahocorasick>=2.0")
    sys.exit(1)

# 加载品牌库
ext_path = Path(__file__).parent / "brand_category_extended.json"
brand_map = {}

# 手工品牌（部分模拟）
_HANDCODED = {
    "伊利": "牛奶", "蒙牛": "牛奶", "海天": "酱油调味品",
    "洁柔": "纸巾", "蓝月亮": "洗衣液", "农夫山泉": "矿泉水",
    "金龙鱼": "食用油", "三只松鼠": "坚果",
}
brand_map.update(_HANDCODED)

if ext_path.exists():
    with open(ext_path, "r", encoding="utf-8") as f:
        ext = json.load(f)
    for b, c in ext.items():
        brand_map.setdefault(b, c)
    print(f"  品牌库加载: {len(brand_map)} 条")

# 模拟 CATEGORY_INDUSTRY_MAP（简化版）
_KNOWN_CATEGORIES = {
    "牛奶", "酸奶", "酱油调味品", "食醋", "食用油", "纸巾", "卫生纸",
    "洗衣液", "矿泉水", "坚果", "白酒", "啤酒", "面包", "饼干",
    "牙膏", "洗发水", "沐浴露", "面霜", "方便面", "大米", "面粉",
    "火腿肠", "茶叶", "咖啡", "果汁", "OTC药品", "宠物食品",
    "调味品", "食品调味品", "冷冻食品", "蜜饯果干", "水产海鲜",
    "肉类", "服装", "鞋", "箱包", "小家电", "大家电", "数码配件",
    "厨房用品", "家居日用", "母婴用品", "护肤品/化妆品", "防晒霜",
    "面膜", "洗面奶", "文具", "玩具", "汽车用品", "瓷砖", "涂料",
    "电线电缆", "卫浴洁具", "运动户外", "眼镜", "电池", "灯具",
    "床上用品", "香皂", "消毒液", "纸尿裤", "卫生巾", "婴幼儿配方奶粉",
    "碳酸饮料", "茶饮料", "功能饮料", "饮料冲调", "葡萄酒", "黄酒",
    "洗洁精", "洗衣粉", "身体乳", "护发素", "洗护清洁", "珠宝饰品",
}

# 构建自动机
def build_ac(brands_dict, use_norm=False):
    ac = ahocorasick.Automaton()
    for brand, cat in brands_dict.items():
        if len(brand) < 2:
            continue
        key = normalize_ocr_text(brand) if use_norm else brand
        if key:
            has_cat = cat in _KNOWN_CATEGORIES
            ac.add_word(key, (brand, cat, has_cat))
    ac.make_automaton()
    return ac

ac_cat_raw = build_ac({b: c for b, c in brand_map.items() if c in _KNOWN_CATEGORIES})
ac_sig_raw = build_ac({b: c for b, c in brand_map.items() if c not in _KNOWN_CATEGORIES})
ac_cat_norm = build_ac({b: c for b, c in brand_map.items() if c in _KNOWN_CATEGORIES}, use_norm=True)
ac_sig_norm = build_ac({b: c for b, c in brand_map.items() if c not in _KNOWN_CATEGORIES}, use_norm=True)

cat_count = sum(1 for b, c in brand_map.items() if c in _KNOWN_CATEGORIES and len(b) >= 2)
sig_count = sum(1 for b, c in brand_map.items() if c not in _KNOWN_CATEGORIES and len(b) >= 2)
print(f"  有品类自动机: {cat_count} 品牌")
print(f"  无品类(signal)自动机: {sig_count} 品牌")

# ── 3. 测试匹配 ──

def brand_match_all(text):
    if not text:
        return []
    cleaned = re.sub(r'[\s\n]+', ' ', text).strip()
    matches = {}

    # Pass 1: raw text
    for ac in [ac_cat_raw, ac_sig_raw]:
        for end_idx, (brand, cat, has_cat) in ac.iter(cleaned):
            if brand not in matches or len(brand) > len(matches[brand]["brand"]):
                matches[brand] = {
                    "brand": brand, "category": cat if has_cat else None,
                    "has_category": has_cat, "normalized_match": False,
                }

    # Pass 2: normalized text
    norm = normalize_ocr_text(text)
    if norm != cleaned:
        for ac in [ac_cat_norm, ac_sig_norm]:
            for end_idx, (brand, cat, has_cat) in ac.iter(norm):
                if brand not in matches:
                    matches[brand] = {
                        "brand": brand, "category": cat if has_cat else None,
                        "has_category": has_cat, "normalized_match": True,
                    }

    result = sorted(matches.values(), key=lambda m: len(m["brand"]), reverse=True)
    return result

print("\n=== 测试 3: brand_match_all ===")

# Test 3a: 原始文本直接命中
r = brand_match_all("这是伊利纯牛奶250ml")
cat_brands = [m for m in r if m["has_category"]]
print(f"  3a 原始命中: {[(m['brand'], m['category']) for m in cat_brands]}")
assert any(m["brand"] == "伊利" for m in cat_brands), "伊利未命中"
print("    ✓ 伊利命中")

# Test 3b: 归一化后命中
r = brand_match_all("蓝 月 亮 洗衣液")
norm_matches = [m for m in r if m.get("normalized_match")]
print(f"  3b 归一化命中: {[(m['brand'], m.get('normalized_match')) for m in r]}")
assert any(m["brand"] == "蓝月亮" for m in r), "蓝月亮未命中"
print("    ✓ 蓝月亮命中（归一化）")

# Test 3c: 多品牌同时命中
r = brand_match_all("超市里有伊利牛奶和海天酱油还有洁柔纸巾")
brands_found = {m["brand"] for m in r if m["has_category"]}
print(f"  3c 多品牌: {brands_found}")
assert "伊利" in brands_found and "海天" in brands_found and "洁柔" in brands_found
print("    ✓ 三品牌同时命中")

# Test 3d: category_brand vs signal_brand
r = brand_match_all("伊利纯牛奶和某个不知名品牌")
cat_b = [m for m in r if m["has_category"]]
sig_b = [m for m in r if not m["has_category"]]
print(f"  3d 分类: category={len(cat_b)}, signal={len(sig_b)}")

# Test 3e: 短品牌保护（<2字不入自动机）
r = brand_match_all("a2奶粉很好喝")
print(f"  3e 短品牌: {[(m['brand'], m['category']) for m in r]}")

# Test 3f: 空文本
r = brand_match_all("")
assert r == [], "空文本应返回空列表"
print("  3f 空文本: ✓")

# Test 3g: 全角文本命中
r = brand_match_all("我买了ＣＯＣＡ　ＣＯＬＡ可口可乐")
print(f"  3g 全角: {[(m['brand'], m['category']) for m in r]}")

# ── 4. 性能测试 ──

print("\n=== 测试 4: 性能 ===")
import time
long_text = "这款海天特级酱油调味品很不错配上金龙鱼食用油做菜真香再买点伊利纯牛奶和三只松鼠坚果当零食吧" * 10
iterations = 1000

start = time.perf_counter()
for _ in range(iterations):
    brand_match_all(long_text)
elapsed = time.perf_counter() - start
print(f"  {iterations} 次匹配 ({len(long_text)} 字文本): {elapsed*1000:.1f}ms 总计, {elapsed/iterations*1000:.3f}ms/次")

print("\n=== 全部测试完成 ===")
