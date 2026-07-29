"""
build_vec_index.py — 标准小智向量索引离线构建

读 standards.db 的 name → bge-small-zh 编码 → 写 standards.faiss + standards_vec_codes.json

用法：
  cd services/python-search-legacy
  python build_vec_index.py --limit 1000 --sample     # POC 随机采样（推荐先跑这个）
  python build_vec_index.py --limit 1000              # POC 顺序取前 N 条（不反映真实召回质量）
  python build_vec_index.py                           # 全量（487K，CPU 1-2h）
  python build_vec_index.py --db /path/to/standards.db --out-dir /path/to/out

输出（与 db 同目录或 --out-dir 指定）：
  - standards.faiss             : IndexFlatIP（内积 + L2 归一化 = cosine）
  - standards_vec_codes.json    : [{"code": "...", "name": "..."}]，行号严格对齐 faiss

时间预估（CPU bge-small-zh-v1.5，batch=64，向量维度 512）：
  - 1000 条（POC，--sample 随机采样）≈ 3-10s
  - 487K 全量 ≈ 60-90 min，输出 standards.faiss ≈ 960MB（487K × 512维 × 4B）
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import faiss
from sentence_transformers import SentenceTransformer


def load_codes_and_names(
    db_path: str,
    limit: int | None = None,
    sample: bool = False,
) -> list[tuple[str, str]]:
    """
    sample=True 时使用 ORDER BY RANDOM() 做均匀随机抽样（POC 评估召回质量必用）。
    sample=False 时按 DB rowid 顺序返回（速度更快，但不反映真实召回分布）。
    全量构建（limit=None）时 sample 无意义，自动忽略。
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    sql = "SELECT code, name FROM standards WHERE name IS NOT NULL AND name != ''"
    if limit:
        if sample:
            sql += f" ORDER BY RANDOM() LIMIT {int(limit)}"
        else:
            sql += f" LIMIT {int(limit)}"
    rows = conn.execute(sql).fetchall()
    conn.close()
    return [(r["code"], r["name"]) for r in rows]


def build(
    db_path: str,
    out_dir: str,
    model_name: str,
    batch_size: int,
    limit: int | None,
    sample: bool = False,
) -> None:
    print(f"📖 读取 {db_path}")
    items = load_codes_and_names(db_path, limit, sample)
    if not items:
        print("❌ DB 内无可索引数据")
        sys.exit(1)
    print(f"   共 {len(items)} 条待索引")

    print(f"🔧 加载模型: {model_name}")
    model = SentenceTransformer(model_name)

    print(f"⚙️  开始编码（batch={batch_size}）")
    t0 = time.time()
    names = [n for _, n in items]
    emb = model.encode(
        names,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=True,
        convert_to_numpy=True,
    ).astype("float32")
    print(f"   编码耗时: {time.time() - t0:.1f}s, shape={emb.shape}")

    dim = emb.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(emb)
    print(f"📦 faiss 索引: ntotal={index.ntotal}, dim={dim}")

    os.makedirs(out_dir, exist_ok=True)
    index_path = os.path.join(out_dir, "standards.faiss")
    codes_path = os.path.join(out_dir, "standards_vec_codes.json")
    faiss.write_index(index, index_path)
    with open(codes_path, "w", encoding="utf-8") as f:
        json.dump(
            [{"code": c, "name": n} for c, n in items],
            f, ensure_ascii=False,
        )
    print("✅ 写出:")
    print(f"   {index_path}  ({os.path.getsize(index_path) / 1024 / 1024:.1f} MB)")
    print(f"   {codes_path}  ({os.path.getsize(codes_path) / 1024 / 1024:.1f} MB)")


def main() -> None:
    default_db = str(
        Path(__file__).resolve().parent.parent.parent / "data" / "crawled_v2" / "standards.db"
    )
    if not os.path.exists(default_db):
        # 兼容服务器布局：可能与 crawled_v2 同级
        alt = str(Path(default_db).parent.parent / "standards.db")
        if os.path.exists(alt):
            default_db = alt

    p = argparse.ArgumentParser()
    p.add_argument("--db", default=default_db, help=f"standards.db 路径（默认 {default_db}）")
    p.add_argument("--out-dir", default="", help="输出目录（默认与 --db 同目录）")
    p.add_argument("--model", default=os.environ.get("BXZ_EMBED_MODEL", "BAAI/bge-small-zh-v1.5"))
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--limit", type=int, default=0, help="只索引前 N 条（POC 验证用，0=全量）")
    p.add_argument("--sample", action="store_true",
                   help="配合 --limit 用 ORDER BY RANDOM() 均匀抽样（POC 评估召回质量必加）")
    args = p.parse_args()

    out_dir = args.out_dir or os.path.dirname(args.db)
    build(args.db, out_dir, args.model, args.batch_size, args.limit or None, args.sample)


if __name__ == "__main__":
    main()
