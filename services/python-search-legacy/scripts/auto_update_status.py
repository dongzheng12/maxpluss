#!/opt/biaozhunxiaozhi/services/python-search-legacy/.venv/bin/python3
"""
standards.db 状态自动更新脚本

扫 standards 表里 status='即将实施' 且 impl_date <= 今天 的标准，
自动改为 status='现行'。

设计原则
  - 只 UPDATE 「即将实施 → 现行」单一过渡，不动其他状态
  - impl_date 是 TEXT 格式（YYYY-MM-DD），SQLite 字符串比较等价日期比较
  - impl_date 空串行不动（数据缺失，安全跳过）
  - 单事务原子，失败 ROLLBACK
  - 日志写 /var/log/bxz-standards-status-update.log（每行带时间戳）

调用
  # 手工
  python3 auto_update_status.py [--db /path/to/standards.db] [--dry-run]

  # cron（每天 01:00）
  0 1 * * * /opt/biaozhunxiaozhi/services/python-search-legacy/scripts/auto_update_status.py \
            >> /var/log/bxz-standards-status-update.log 2>&1

注意
  - 跑此脚本**不需要** pm2 stop bxz-pyapi：UPDATE 单行级，sqlite WAL 模式下
    与 SELECT 并发安全
  - 跑完后 engine.py 进程内的 row cache 不会立即看到新 status——
    但 engine.py 没有 row cache（每次 SQL 查），所以下一次搜索就读到新状态
  - 不动 standards_fts（FTS 索引不存 status，无须同步）

【未来强化】
  关联 issue memory/project_psl_status_auto_update_missing.md
  - 「废止」状态触发：需要权威数据源（GB 公告），不靠时间推断
  - 「被代替」检测：series_base 同族 + 较新版上线 → 旧版自动「被代替」
  本脚本仅覆盖最简单一类：即将实施 → 现行（时间触发）
"""
import argparse
import datetime
import os
import sqlite3
import sys

DEFAULT_DB = "/mnt/datadisk0/bxz-pyapi-data/standards.db"


def log(msg: str) -> None:
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def auto_update(db_path: str, dry_run: bool = False) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"DB 不存在: {db_path}")

    today = datetime.date.today().isoformat()  # YYYY-MM-DD
    log(f"=== 启动 auto_update_status (today={today}, db={db_path}, dry_run={dry_run}) ===")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        # 1. 找出候选行
        candidates = conn.execute(
            """
            SELECT code, name, status, impl_date
            FROM standards
            WHERE status = '即将实施'
              AND impl_date != ''
              AND impl_date <= ?
            ORDER BY impl_date
            """,
            (today,),
        ).fetchall()

        log(f"候选行数: {len(candidates)} (即将实施 + impl_date <= {today})")

        if not candidates:
            log("无需更新，退出")
            return {"ok": True, "updated": 0, "today": today}

        # 列出前 10 条，便于审计
        log("候选样本（前 10 条）:")
        for r in candidates[:10]:
            log(f"  {r['code']} | impl_date={r['impl_date']} | {(r['name'] or '')[:50]}")
        if len(candidates) > 10:
            log(f"  ... 另外 {len(candidates) - 10} 条")

        if dry_run:
            log("--dry-run 模式，不实际更新，退出")
            return {"ok": True, "dry_run": True, "would_update": len(candidates), "today": today}

        # 2. 单事务 UPDATE
        conn.execute("BEGIN")
        try:
            cur = conn.execute(
                """
                UPDATE standards
                SET status = '现行'
                WHERE status = '即将实施'
                  AND impl_date != ''
                  AND impl_date <= ?
                """,
                (today,),
            )
            updated = cur.rowcount
            conn.execute("COMMIT")
            log(f"UPDATE 成功，影响 {updated} 行")
        except Exception as e:
            conn.execute("ROLLBACK")
            log(f"UPDATE 失败，事务 ROLLBACK: {e}")
            raise

        return {"ok": True, "updated": updated, "today": today, "candidate_count": len(candidates)}
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=DEFAULT_DB, help=f"standards.db 路径（默认 {DEFAULT_DB}）")
    ap.add_argument("--dry-run", action="store_true", help="只列候选不写")
    args = ap.parse_args()

    try:
        result = auto_update(args.db, args.dry_run)
        log(f"完成: {result}")
        sys.exit(0)
    except Exception as e:
        log(f"!!! 异常: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
