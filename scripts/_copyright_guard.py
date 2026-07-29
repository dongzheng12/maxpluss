"""
版权合规硬拦截（2026-04-21）

2026-04-16 已清空 bx_standards.db 中 fulltext / cleaned_text 等正文字段。
本模块提供共享的字段校验助手，供所有直接写入 standards 表的脚本调用，
防止任何路径（爬虫主入口、OCR 回灌、dedup 流水线、文本合并脚本）把正文重新
灌回数据库。

精确字段名匹配，不使用包含匹配（避免误伤 scope / definition / source_context
等合法文本元数据）。
"""
from __future__ import annotations

import logging
from typing import Iterable, Mapping

log = logging.getLogger(__name__)

FORBIDDEN_BODY_FIELDS = frozenset({
    "fulltext", "full_text", "cleaned_text", "content",
    "raw_text", "body", "html", "markdown",
})


def assert_no_body_fields(row: Mapping, caller: str) -> None:
    """校验 dict 入库路径不含禁止字段。

    - 命中且非空：raise ValueError
    - 命中但全为空：log.warning 不抛（兼容上游可能传空占位）
    """
    hit = FORBIDDEN_BODY_FIELDS.intersection(row.keys())
    if not hit:
        return
    non_empty = {k: row[k] for k in hit if row.get(k)}
    if non_empty:
        log.error(
            "[COPYRIGHT-GUARD] %s 拒绝入库：检测到禁止字段 %s (非空)",
            caller, sorted(non_empty.keys()),
        )
        raise ValueError(
            f"refuse to write forbidden body fields {sorted(non_empty.keys())} "
            f"via {caller}; copyright compliance 2026-04-16"
        )
    log.warning(
        "[COPYRIGHT-GUARD] %s 传入包含禁止字段但均为空 %s；已忽略但请清理上游代码",
        caller, sorted(hit),
    )


def assert_no_body_write(column: str, value, caller: str) -> None:
    """校验裸 SQL 路径（UPDATE standards SET <col>=?）。

    用于 dedup_pipeline / merge_ocr_export / merge_text_results 等直接写列的脚本。
    - 列名在禁止名单内且 value 非空 → raise ValueError
    - 列名在禁止名单但 value 为空（清空操作）→ 放行，这是合规清理路径
    - 列名不在禁止名单 → 放行
    """
    if column not in FORBIDDEN_BODY_FIELDS:
        return
    if not value:
        # 允许写空值（清空 / reset 操作是合规路径，见 prepare_reocr.py）
        return
    log.error(
        "[COPYRIGHT-GUARD] %s 拒绝写入 standards.%s 非空值 (长度=%d)",
        caller, column, len(value) if hasattr(value, "__len__") else -1,
    )
    raise ValueError(
        f"refuse to write non-empty body column {column!r} via {caller}; "
        f"copyright compliance 2026-04-16"
    )


__all__ = ["FORBIDDEN_BODY_FIELDS", "assert_no_body_fields", "assert_no_body_write"]
