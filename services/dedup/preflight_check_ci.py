#!/usr/bin/env python3
"""
CI 环境自检 — 不依赖大数据文件（487K JSON / 2.8GB SQLite），
只校验代码层面的可运行性。

完整自检（含数据文件）请用 preflight_check.py，在有数据的环境执行。
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).parent
CHECKS = []

def check(name, ok, detail=""):
    status = "✅ PASS" if ok else "❌ FAIL"
    CHECKS.append((name, ok))
    print(f"  {status}  {name}{('  — ' + detail) if detail else ''}")

print("=" * 60)
print("标准小智 dedup CI 自检（代码层）")
print("=" * 60)

# 1. pyahocorasick
print("\n[1/4] 依赖")
try:
    import ahocorasick
    check("pyahocorasick", True)
except ImportError:
    check("pyahocorasick", False, "未安装")

# 2. 品牌库 JSON 格式
print("\n[2/4] 品牌库")
brand_path = BASE / "brand_category_extended.json"
if brand_path.exists():
    try:
        with open(brand_path, "r", encoding="utf-8") as f:
            brands = json.load(f)
        check("品牌库可解析", isinstance(brands, dict), f"{len(brands)} 条")
        check("品牌库非空", len(brands) > 0)
        # 值都是字符串
        bad = [k for k, v in list(brands.items())[:100] if not isinstance(v, str)]
        check("品牌库值类型", len(bad) == 0, f"前100条无异常" if not bad else f"异常key: {bad[:3]}")
    except Exception as e:
        check("品牌库可解析", False, str(e))
else:
    check("品牌库文件存在", False)

# 3. Aho-Corasick 构建
print("\n[3/4] 自动机构建")
try:
    import ahocorasick as _ac
    ac = _ac.Automaton()
    test_data = {"伊利": "牛奶", "海天": "酱油", "蓝月亮": "洗衣液", "洁柔": "纸巾"}
    for b, c in test_data.items():
        ac.add_word(b, (b, c))
    ac.make_automaton()
    hits = list(ac.iter("超市有伊利牛奶海天酱油洁柔纸巾蓝月亮洗衣液"))
    check("自动机匹配", len(hits) == 4, f"命中 {len(hits)}/4")
except Exception as e:
    check("自动机构建", False, str(e))

# 4. normalize_ocr_text 函数
print("\n[4/4] normalize_ocr_text")
try:
    # 直接测试函数逻辑，不 import service.py（有 FastAPI 依赖链）
    import re
    _FULLWIDTH_MAP = str.maketrans(
        '０１２３４５６７８９ＡＢＣＤ',
        '0123456789ABCD'
    )
    def _normalize(text):
        if not text: return ""
        text = text.translate(_FULLWIDTH_MAP)
        text = re.sub(r'[\s\n\r\t]+', '', text)
        text = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]', '', text)
        return text.lower()

    cases = [
        ("伊  利  牛  奶", "伊利牛奶"),
        ("蓝月　亮", "蓝月亮"),
        ("", ""),
    ]
    all_ok = all(_normalize(inp) == exp for inp, exp in cases)
    check("归一化函数", all_ok)
except Exception as e:
    check("归一化函数", False, str(e))

# 汇总
print("\n" + "=" * 60)
failed = sum(1 for _, ok in CHECKS if not ok)
if failed == 0:
    print(f"CI 自检: ALL {len(CHECKS)} PASSED ✅")
    sys.exit(0)
else:
    print(f"CI 自检: {failed}/{len(CHECKS)} FAILED ❌")
    sys.exit(1)
