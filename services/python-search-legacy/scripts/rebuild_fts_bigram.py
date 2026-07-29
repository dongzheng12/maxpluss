#!/opt/biaozhunxiaozhi/services/python-search-legacy/.venv/bin/python3
"""
一次性脚本：重算 standards.name_clean（bigram 化）+ 重建 standards_fts + 回填字段缺口。

注意 shebang：写死 venv python3.9 绝对路径
  - 系统 /usr/bin/python3 在该服务器是 3.6.8，不支持 PEP 585 list[dict] 注解
  - engine.py 中的类型注解用了 list[dict] / dict[str, ...]，必须 3.9+ 才能 import
  - 用 venv python3.9 与 pm2 运行时 Python 一致，避免环境分裂

用途
  - engine.py `_clean_name()` 升级到 bigram 化输出后，**必须**跑一次这个脚本，
    否则旧数据的 name_clean 仍是去标点后的整串，FTS bigram MATCH 命中不到。
  - 顺手回填 `category=''` 行（含 2026-05-11 从 bx_standards 同步进来的 15 条
    GB 4806 族）的 category/pub_year/series_base/series_part/is_mandatory 字段。

行为
  1. 备份提醒：必须先备份 standards.db（脚本不自动备份，按 SOP 由发版人手工）
  2. UPDATE 全表 name_clean = _clean_name(name)（bigram 化）
  3. DELETE FROM standards_fts; INSERT 全量
  4. UPDATE category='' 的行 → 通过 _categorize/_extract_year/_extract_series
     补齐 category/pub_year/series_base/series_part/is_mandatory
  5. ANALYZE（可选，更新统计信息加速后续查询）

原子性
  - 步骤 2/3/4 在同一个事务里。失败回滚到执行前状态。
  - 步骤 5 单独事务（ANALYZE 无副作用）。

调用
  python3 rebuild_fts_bigram.py [--db /path/to/standards.db] [--dry-run]
  默认路径 /mnt/datadisk0/bxz-pyapi-data/standards.db。

部署窗口
  按 SOP §0.3 #8 python-search-legacy 子发版流程，pm2 stop bxz-pyapi 后执行。
  487097 行预计 1-3 min，期间不能接读写。

依赖
  仅标准库 sqlite3 + 同级 engine.py 的 _clean_name / _categorize 等辅助函数。
"""
import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

# 让脚本能 import 父目录的 engine.py
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent))

from engine import (  # noqa: E402
    _clean_name,
    _categorize,
    _extract_year,
    _extract_series,
    _is_mandatory,
)

DEFAULT_DB = "/mnt/datadisk0/bxz-pyapi-data/standards.db"


def _progress(prefix: str, done: int, total: int, t0: float) -> None:
    elapsed = time.time() - t0
    rate = done / elapsed if elapsed > 0 else 0
    eta = (total - done) / rate if rate > 0 else 0
    print(
        f"  [{prefix}] {done}/{total} "
        f"({100 * done / total:.1f}%) {rate:.0f}/s ETA {eta:.0f}s",
        flush=True,
    )


def rebuild(db_path: str, dry_run: bool = False) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"DB 不存在: {db_path}")

    print(f"=== 连接 {db_path} ===", flush=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        # ── Step 0: 行数确认 ─────────────────────────────────────────
        total_std = conn.execute("SELECT COUNT(*) FROM standards").fetchone()[0]
        total_fts = conn.execute("SELECT COUNT(*) FROM standards_fts").fetchone()[0]
        empty_cat = conn.execute("SELECT COUNT(*) FROM standards WHERE category=''").fetchone()[0]
        print(f"  standards 行数:     {total_std}")
        print(f"  standards_fts 行数: {total_fts}")
        print(f"  category='' 行数:   {empty_cat}")

        if dry_run:
            print("=== --dry-run 模式，不做任何写操作，直接退出 ===")
            return {"dry_run": True, "total": total_std, "empty_cat": empty_cat}

        # ── Step 1: 一个事务原子完成 name_clean 重算 + FTS 重建 + 字段回填 ──
        print("=== 开始事务（name_clean 重算 + FTS 重建 + 字段回填）===", flush=True)
        conn.execute("BEGIN")

        # 1a. UPDATE name_clean = _clean_name(name) 全表
        print("  [1/3] UPDATE standards.name_clean = _clean_name(name) ...", flush=True)
        t0 = time.time()
        cur = conn.execute("SELECT rowid, name FROM standards")
        batch = []
        BATCH_SIZE = 1000
        done = 0
        for r in cur:
            batch.append((_clean_name(r["name"] or ""), r["rowid"]))
            if len(batch) >= BATCH_SIZE:
                conn.executemany(
                    "UPDATE standards SET name_clean = ? WHERE rowid = ?", batch
                )
                done += len(batch)
                if done % 50000 == 0 or done == total_std:
                    _progress("name_clean", done, total_std, t0)
                batch.clear()
        if batch:
            conn.executemany(
                "UPDATE standards SET name_clean = ? WHERE rowid = ?", batch
            )
            done += len(batch)
            _progress("name_clean", done, total_std, t0)

        # 1b. DELETE + 全量 INSERT standards_fts
        print("  [2/3] 重建 standards_fts（DELETE + INSERT SELECT）...", flush=True)
        t0 = time.time()
        conn.execute("DELETE FROM standards_fts")
        conn.execute(
            "INSERT INTO standards_fts(rowid, code, name, name_clean) "
            "SELECT rowid, code, name, name_clean FROM standards"
        )
        elapsed = time.time() - t0
        new_fts = conn.execute("SELECT COUNT(*) FROM standards_fts").fetchone()[0]
        print(f"  [2/3] done, fts rows={new_fts}, {elapsed:.1f}s", flush=True)
        if new_fts != total_std:
            raise RuntimeError(
                f"FTS 重建后行数 {new_fts} != standards 行数 {total_std}，"
                f"事务回滚"
            )

        # 1c. 回填 category='' 行（多半是手工 INSERT 留下的，含 GB 4806 族 15 条）
        print(
            "  [3/3] 回填 category='' 行字段（category/pub_year/series_base/"
            "series_part/is_mandatory）...",
            flush=True,
        )
        t0 = time.time()
        cur = conn.execute(
            "SELECT rowid, code FROM standards WHERE category=''"
        )
        fixes = []
        for r in cur:
            code = r["code"]
            cat = _categorize(code)
            year = _extract_year(code)
            sb, sp = _extract_series(code)
            is_mand = 1 if _is_mandatory(code) else 0
            fixes.append((cat, year, sb, sp, is_mand, r["rowid"]))
        if fixes:
            conn.executemany(
                "UPDATE standards SET "
                "category = ?, pub_year = ?, series_base = ?, "
                "series_part = ?, is_mandatory = ? "
                "WHERE rowid = ?",
                fixes,
            )
        elapsed = time.time() - t0
        print(f"  [3/3] done, 回填 {len(fixes)} 行, {elapsed:.1f}s", flush=True)

        conn.execute("COMMIT")
        print("=== 事务 COMMIT ===", flush=True)

        # ── Step 2: ANALYZE（独立事务）───────────────────────────────
        print("=== ANALYZE（更新统计信息）...", flush=True)
        t0 = time.time()
        conn.execute("ANALYZE")
        print(f"  done, {time.time() - t0:.1f}s", flush=True)

        # ── Step 3: 校验 ────────────────────────────────────────────
        chk_std = conn.execute("SELECT COUNT(*) FROM standards").fetchone()[0]
        chk_fts = conn.execute("SELECT COUNT(*) FROM standards_fts").fetchone()[0]
        chk_empty_cat = conn.execute(
            "SELECT COUNT(*) FROM standards WHERE category=''"
        ).fetchone()[0]

        # smoke：随机抽一条新数据，确认 name_clean 是 bigram 形式
        sample = conn.execute(
            "SELECT code, name, name_clean FROM standards WHERE code='GB 4806.1-2016'"
        ).fetchone()

        return {
            "ok": True,
            "rebuild": {
                "name_clean_updated": total_std,
                "fts_rows_before": total_fts,
                "fts_rows_after": chk_fts,
                "category_filled": empty_cat - chk_empty_cat,
                "category_still_empty": chk_empty_cat,
            },
            "sample_GB_4806_1_2016": (
                {"code": sample["code"], "name": sample["name"], "name_clean": sample["name_clean"]}
                if sample else None
            ),
        }
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass
        raise
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=DEFAULT_DB, help=f"standards.db 路径（默认 {DEFAULT_DB}）")
    ap.add_argument("--dry-run", action="store_true", help="只打印行数，不写")
    args = ap.parse_args()

    t_total = time.time()
    result = rebuild(args.db, args.dry_run)
    print(f"\n=== 完成，总耗时 {time.time() - t_total:.1f}s ===")
    print("结果摘要：")
    for k, v in result.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
