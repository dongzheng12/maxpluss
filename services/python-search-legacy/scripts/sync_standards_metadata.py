#!/opt/biaozhunxiaozhi/services/python-search-legacy/.venv/bin/python3
"""
定期同步脚本：从 bx_standards.db 提取纯元数据同步到 standards.db。

注意 shebang：写死 venv python3.9 绝对路径（理由同 rebuild_fts_bigram.py）。

设计原则
  - **只同步元数据**：code / name / status / pub_date / impl_date / ics / ics_name
    / ccs。**不取 fulltext / scope**（版权敏感 + 体积大）。
  - **只 INSERT 不覆盖**：按 code 判断，已存在则 skip；不修改任何已有行。
  - **同时维护 standards_fts**：新插入的行同步进 FTS 表，name_clean 走 bigram 化。
  - **同步派生字段**：插入时用 _categorize / _extract_year / _extract_series /
    _is_mandatory 计算 category / pub_year / series_base / series_part /
    is_mandatory，避免手工 INSERT 留字段空洞。
  - **只读 bx_standards.db**：ATTACH 后只跑 SELECT；mtime / size 保持不变。

调用
  python3 sync_standards_metadata.py
    [--target /mnt/datadisk0/bxz-pyapi-data/standards.db]
    [--source /opt/biaozhunxiaozhi/data/dedup/ram/bx_standards.db]
    [--filter "GB 4806%"]   # 可选：只同步某个 code 前缀
    [--dry-run]

部署节奏
  - 一次性手工跑：补缺漏（如 GB 4806 族那种）
  - cron 周期跑：每周一次扫 bx_standards 新增标准，自动同步元数据
    建议放凌晨低峰窗口（与 engine.py 子发版 SOP 一致），跑前最好备份

依赖
  仅标准库 sqlite3 + 同级 engine.py 的辅助函数。
"""
import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent))

from engine import (  # noqa: E402
    _clean_name,
    _categorize,
    _extract_year,
    _extract_series,
    _is_mandatory,
)

DEFAULT_TARGET = "/mnt/datadisk0/bxz-pyapi-data/standards.db"
DEFAULT_SOURCE = "/opt/biaozhunxiaozhi/data/dedup/ram/bx_standards.db"


def sync(
    target_db: str,
    source_db: str,
    filter_like: str = "",
    dry_run: bool = False,
) -> dict:
    if not os.path.exists(target_db):
        raise FileNotFoundError(f"target DB 不存在: {target_db}")
    if not os.path.exists(source_db):
        raise FileNotFoundError(f"source DB 不存在: {source_db}")

    print(f"=== source: {source_db}", flush=True)
    print(f"=== target: {target_db}", flush=True)
    if filter_like:
        print(f"=== filter: code LIKE '{filter_like}'", flush=True)

    # 记录 source 文件 mtime/size，结束时校验未变
    src_stat_before = os.stat(source_db)

    conn = sqlite3.connect(target_db)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute(f"ATTACH '{source_db}' AS src")

        # 1. 找出 source 有但 target 没有的 code
        where_extra = f"AND s.code LIKE '{filter_like}'" if filter_like else ""
        # 注意 filter_like 走拼接，因为 ATTACH 之后整体 sqlite3 dotted 表达式不允许 ?
        # 上层调用者控制 filter_like 安全（脚本输入）
        missing_rows = conn.execute(
            f"""
            SELECT s.code, s.name, s.status, s.pub_date, s.impl_date,
                   s.ics, s.ics_name, s.ccs
            FROM src.standards s
            WHERE NOT EXISTS (SELECT 1 FROM standards t WHERE t.code = s.code)
              {where_extra}
            """
        ).fetchall()

        missing_count = len(missing_rows)
        print(f"  source 中缺失的 code 数: {missing_count}", flush=True)

        if missing_count == 0:
            print("=== 无需同步，退出 ===")
            return {"ok": True, "inserted": 0, "skipped_dup": 0}

        if dry_run:
            print("=== --dry-run 模式，列出前 20 条要插入的 code 然后退出 ===")
            for r in missing_rows[:20]:
                print(f"  {r['code']} | {r['name']} | {r['status']}")
            return {"ok": True, "dry_run": True, "would_insert": missing_count}

        # 2. 构造插入数据
        # bx_standards 同 code 可能重复，按 code dedup（取首条）
        seen_codes: set[str] = set()
        rows_to_insert: list[tuple] = []
        rows_for_fts: list[tuple] = []
        for r in missing_rows:
            code = r["code"]
            if code in seen_codes:
                continue
            seen_codes.add(code)
            name = r["name"] or ""
            name_clean = _clean_name(name)
            cat = _categorize(code)
            year = _extract_year(code)
            sb, sp = _extract_series(code)
            is_mand = 1 if _is_mandatory(code) else 0
            rows_to_insert.append(
                (
                    code,
                    name,
                    name_clean,
                    r["status"] or "",
                    r["pub_date"] or "",
                    r["impl_date"] or "",
                    cat,
                    is_mand,
                    sb,
                    sp,
                    year,
                    r["ics"] or "",
                    r["ics_name"] or "",
                    r["ccs"] or "",
                )
            )

        dedup_count = missing_count - len(rows_to_insert)
        if dedup_count > 0:
            print(f"  source 内同 code 重复，dedup 跳过: {dedup_count}", flush=True)

        # 3. 单事务 INSERT 主表 + 同步 FTS
        print(f"  开始 INSERT {len(rows_to_insert)} 条到 standards + FTS ...", flush=True)
        t0 = time.time()
        conn.execute("BEGIN")
        try:
            conn.executemany(
                """
                INSERT INTO standards
                (code, name, name_clean, status, pub_date, impl_date,
                 category, is_mandatory, series_base, series_part, pub_year,
                 ics_code, ics_name, ccs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows_to_insert,
            )

            # 同步进 FTS：按 code 列表精确同步，分批避免 SQL 变量数上限（默认 999）
            codes = [row[0] for row in rows_to_insert]
            CHUNK = 500
            for i in range(0, len(codes), CHUNK):
                chunk = codes[i:i + CHUNK]
                placeholders = ",".join("?" * len(chunk))
                # 先 DELETE 万一已有同 code FTS 行（防 ghost）
                conn.execute(
                    f"DELETE FROM standards_fts WHERE code IN ({placeholders})",
                    chunk,
                )
                conn.execute(
                    f"""
                    INSERT INTO standards_fts(rowid, code, name, name_clean)
                    SELECT rowid, code, name, name_clean FROM standards
                    WHERE code IN ({placeholders})
                    """,
                    chunk,
                )

            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        elapsed = time.time() - t0
        print(f"  done, {elapsed:.1f}s", flush=True)

        # 4. 校验 source 未变 + 总行数对账
        src_stat_after = os.stat(source_db)
        src_unchanged = (
            src_stat_before.st_size == src_stat_after.st_size
            and src_stat_before.st_mtime == src_stat_after.st_mtime
        )

        chk_std = conn.execute("SELECT COUNT(*) FROM standards").fetchone()[0]
        chk_fts = conn.execute("SELECT COUNT(*) FROM standards_fts").fetchone()[0]

        return {
            "ok": True,
            "source_unchanged": src_unchanged,
            "missing_in_target": missing_count,
            "dedup_in_source": dedup_count,
            "inserted": len(rows_to_insert),
            "standards_total_after": chk_std,
            "standards_fts_total_after": chk_fts,
        }
    finally:
        try:
            conn.execute("DETACH src")
        except sqlite3.OperationalError:
            pass
        conn.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", default=DEFAULT_TARGET, help=f"目标 DB（默认 {DEFAULT_TARGET}）")
    ap.add_argument("--source", default=DEFAULT_SOURCE, help=f"源 DB（默认 {DEFAULT_SOURCE}）")
    ap.add_argument("--filter", default="", help="可选 code LIKE 过滤，如 'GB 4806%'")
    ap.add_argument("--dry-run", action="store_true", help="只看清单不写")
    args = ap.parse_args()

    t_total = time.time()
    result = sync(args.target, args.source, args.filter, args.dry_run)
    print(f"\n=== 完成，总耗时 {time.time() - t_total:.1f}s ===")
    print("结果摘要：")
    for k, v in result.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
