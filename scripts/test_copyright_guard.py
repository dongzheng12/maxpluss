"""
_copyright_guard 单元测试（2026-04-21）

对应 2026-04-16 版权合规硬拦截策略（bx_standards.db 不得再写入任何正文字段）。

用例：
  - assert_no_body_fields：dict 入库路径
  - assert_no_body_write：裸 SQL 单列 UPDATE 路径
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _copyright_guard import (  # type: ignore  # noqa: E402
    FORBIDDEN_BODY_FIELDS,
    assert_no_body_fields,
    assert_no_body_write,
)


class TestAssertNoBodyFields(unittest.TestCase):
    """dict 入库路径"""

    def test_passes_clean_row(self):
        """合法元数据字段 → 放行"""
        row = {
            "standard_no": "GB/T 1.1-2020",
            "title": "标准化工作导则",
            "scope": "规定了标准化工作的通用术语和定义",
            "publish_date": "2020-03-31",
        }
        assert_no_body_fields(row, caller="test")

    def test_rejects_non_empty_fulltext(self):
        row = {"standard_no": "GB 1", "fulltext": "第一章 总则 ..."}
        with self.assertRaises(ValueError) as ctx:
            assert_no_body_fields(row, caller="test_caller")
        self.assertIn("fulltext", str(ctx.exception))
        self.assertIn("test_caller", str(ctx.exception))

    def test_rejects_non_empty_cleaned_text(self):
        row = {"standard_no": "GB 2", "cleaned_text": "正文内容…"}
        with self.assertRaises(ValueError):
            assert_no_body_fields(row, caller="test")

    def test_rejects_multiple_forbidden_fields(self):
        row = {"fulltext": "a", "content": "b", "body": "c"}
        with self.assertRaises(ValueError) as ctx:
            assert_no_body_fields(row, caller="test")
        # 异常消息应列出所有命中的禁止字段（排序后）
        msg = str(ctx.exception)
        self.assertIn("body", msg)
        self.assertIn("content", msg)
        self.assertIn("fulltext", msg)

    def test_allows_empty_forbidden_fields(self):
        """禁止字段存在但值为空（上游占位）→ 警告不抛异常"""
        row = {"standard_no": "GB 3", "fulltext": "", "cleaned_text": None}
        # 不应抛异常
        assert_no_body_fields(row, caller="test")

    def test_rejects_html_field(self):
        row = {"html": "<html>…</html>"}
        with self.assertRaises(ValueError):
            assert_no_body_fields(row, caller="test")

    def test_rejects_markdown_field(self):
        row = {"markdown": "# 正文"}
        with self.assertRaises(ValueError):
            assert_no_body_fields(row, caller="test")

    def test_allows_legitimate_text_metadata(self):
        """scope / definition / source_context 等合法文本字段不能被误伤"""
        row = {
            "standard_no": "GB 4",
            "scope": "本标准规定了...（标准元数据，合规）",
            "definition": "XX 指...",
            "source_context": "来源于 2020-03 公开资料",
        }
        assert_no_body_fields(row, caller="test")

    def test_caller_appears_in_error(self):
        row = {"fulltext": "abc"}
        with self.assertRaises(ValueError) as ctx:
            assert_no_body_fields(row, caller="crawl_standards.save_one")
        self.assertIn("crawl_standards.save_one", str(ctx.exception))


class TestAssertNoBodyWrite(unittest.TestCase):
    """裸 SQL 单列 UPDATE 路径"""

    def test_allows_non_forbidden_column(self):
        assert_no_body_write("title", "GB/T 1.1", caller="test")
        assert_no_body_write("scope", "本标准规定了...", caller="test")
        assert_no_body_write("publish_date", "2020-01-01", caller="test")

    def test_rejects_fulltext_non_empty(self):
        with self.assertRaises(ValueError) as ctx:
            assert_no_body_write("fulltext", "第一章…", caller="dedup_pipeline")
        self.assertIn("fulltext", str(ctx.exception))
        self.assertIn("dedup_pipeline", str(ctx.exception))

    def test_rejects_cleaned_text_non_empty(self):
        with self.assertRaises(ValueError):
            assert_no_body_write("cleaned_text", "正文…", caller="merge_ocr_export")

    def test_allows_empty_value_on_forbidden_column(self):
        """允许清空操作（reset / prepare_reocr 合规路径）"""
        assert_no_body_write("fulltext", "", caller="prepare_reocr")
        assert_no_body_write("fulltext", None, caller="prepare_reocr")
        assert_no_body_write("cleaned_text", "", caller="reset")

    def test_rejects_all_forbidden_columns(self):
        for col in FORBIDDEN_BODY_FIELDS:
            with self.assertRaises(ValueError, msg=f"column {col} should be blocked"):
                assert_no_body_write(col, "non-empty value", caller="test")

    def test_error_message_includes_caller_and_column(self):
        with self.assertRaises(ValueError) as ctx:
            assert_no_body_write("body", "xxx", caller="merge_text_results.flush")
        msg = str(ctx.exception)
        self.assertIn("body", msg)
        self.assertIn("merge_text_results.flush", msg)


class TestForbiddenFieldsList(unittest.TestCase):
    """防回归：禁止字段名单不应被意外缩减"""

    def test_expected_fields_present(self):
        expected = {
            "fulltext", "full_text", "cleaned_text", "content",
            "raw_text", "body", "html", "markdown",
        }
        self.assertEqual(FORBIDDEN_BODY_FIELDS, expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
