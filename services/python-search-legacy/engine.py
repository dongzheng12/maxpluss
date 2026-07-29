"""
标准小智 · 决策引擎 v3  —  SQLite + FTS5 后端
启动时将 JSON 数据导入 SQLite（仅首次或数据变更时），查询全走 SQL，
内存占用 < 100 MB，支撑 50 万+ 记录不 OOM。

数据模型:
  standards       → 主表（code 唯一索引）
  standards_fts   → FTS4 全文索引（name_clean 去标点 bigram 分词）
  industry_link   → 行业-标准多对多关联
  series_index    → 系列标准索引

@author  通标中研标准化研究院
@version 3.0
@date    2026-03-21
"""

import csv
import json
import glob
import hashlib
import os
import re
import math
import sqlite3
from pathlib import Path
from collections import defaultdict

# 向量召回（可选依赖；未装时降级）
try:
    import numpy as _np
    import faiss as _faiss
    from sentence_transformers import SentenceTransformer as _SentenceTransformer
    _VEC_AVAILABLE = True
except ImportError:
    _VEC_AVAILABLE = False


def _code_search_variants(q_norm: str) -> list:
    """
    生成标准号归一化变体，用于 LIKE 搜索。
    解决 "GB 1.1" 搜不到 "GB/T 1.1" 的问题：
      - 用户输入不含类型字母（GB1.1）→ 也生成含 T/Z 的变体（GBT1.1, GBZ1.1）
      - 用户输入含类型字母（GBT1.1）→ 也生成不含类型字母的变体（GB1.1）

    归一化规则：大写 + 去空格 + 去斜线，与 SQL 侧 REPLACE(REPLACE(UPPER(code),' ',''),'/','') 一致。
    """
    variants = [q_norm]
    # 匹配：前缀(2-4字母) + 可选单个大写字母 + 数字
    m_with_type = re.match(r'^([A-Z]{2,4})([A-Z])(\d.*)$', q_norm)
    m_no_type   = re.match(r'^([A-Z]{2,4})(\d.*)$', q_norm)
    if m_with_type:
        prefix, _type_letter, rest = m_with_type.groups()
        # 去掉类型字母：GBT1.1 → GB1.1
        variants.append(f"{prefix}{rest}")
    elif m_no_type:
        prefix, rest = m_no_type.groups()
        # 加常见类型字母：GB1.1 → GBT1.1, GBZ1.1
        for tl in ('T', 'Z'):
            variants.append(f"{prefix}{tl}{rest}")
    return list(dict.fromkeys(variants))  # 去重保序


def _status_tier(status: str) -> int:
    """
    状态优先级 tier（越小越靠前），用作搜索结果主排序键。
    保证「现行」始终排在「即将实施」之前，「即将实施」始终排在空状态之前，
    「废止 / 作废」始终垫底。

      0 = 现行
      1 = 即将实施 / 暂不实施
      2 = 空 / 其它（数据缺失或非标状态）
      3 = 废止 / 作废
    """
    s = status or ""
    if "废止" in s or "作废" in s:
        return 3
    if "现行" in s:
        return 0
    if "即将实施" in s or "暂不实施" in s:
        return 1
    return 2


def _status_weight(status: str) -> float:
    """
    状态权重 — 用于次级 score 调整（与 _status_tier 配合使用）。
    主排序已经由 _status_tier 保证 现行 > 即将实施 > 空 > 废止 的严格分组，
    本权重仅在「同 tier 内」的相邻分数上做细微拉开。
      现行   ×2.0
      即将实施 / 暂不实施 ×1.2
      空 / 其它          ×1.0
      废止 / 作废        ×0.1
    """
    s = status or ""
    if "废止" in s or "作废" in s:
        return 0.1
    if "现行" in s:
        return 2.0
    if "即将实施" in s or "暂不实施" in s:
        return 1.2
    return 1.0


# ═══════════════════════════════════════════════════════════
# 常量
# ═══════════════════════════════════════════════════════════

STANDARD_TYPE_KEYWORDS = {
    "terminology":       ["术语", "定义", "词汇", "概念", "名词"],
    "symbol":            ["符号", "图形符号", "标志", "图标", "标识", "标记"],
    "classification":    ["分类", "编码", "代码", "类别", "分组", "归类", "目录"],
    "test_method":       ["试验", "检测", "测试", "检验", "分析", "测定", "方法", "测量"],
    "specification":     ["规范", "要求", "技术规范", "规格", "合格", "证实", "判定"],
    "code_of_practice":  ["规程", "操作规程", "作业", "施工", "工艺", "程序", "操作", "安装", "维护"],
    "guide":             ["指南", "指导", "建议", "指引", "导则", "推荐", "实施指南"],
    "product":           ["产品", "技术条件", "质量", "规格", "型号", "技术要求", "消费品"],
    "management_system": ["管理体系", "管理制度", "管理系统", "体系", "认证", "管理", "制度"],
}

TYPE_TAG_TO_TEMPLATE = {
    "terminology": "terminology_standard",
    "symbol": "symbol_standard",
    "classification": "classification_standard",
    "test_method": "test_method_standard",
    "specification": "specification_standard",
    "code_of_practice": "code_of_practice_standard",
    "guide": "guide_standard",
    "product": "product_standard",
    "management_system": "management_system_standard",
}

ICS_PREFIX_TO_TEMPLATE = {
    "01": "terminology_standard",
    "17": "test_method_standard",
    "19": "test_method_standard",
    "03": "management_system_standard",
    "91": "code_of_practice_standard",
    "93": "code_of_practice_standard",
    "25": "code_of_practice_standard",
}

MANDATORY_PREFIXES = ["GB "]
RECOMMENDED_PREFIXES = ["GB/T "]

# 纯前缀词黑名单 — 不带数字编号的标准前缀视为无效查询，避免返回长尾全表
PURE_PREFIX_BLACKLIST = {
    # 国标 / 地标 / 团标 / 行标 / 计量 / 通用
    "GB", "GBT", "GB/T", "GBZ", "GB/Z",
    "YB", "HJ", "JJF", "JJG", "DB", "T",
    "GA", "GA/T", "SY", "NB", "DL", "JT",
    "TB", "JG", "CJ", "CB", "HG", "SH",
    "MT", "JC", "XB", "MZ", "MH", "QB",
    "FZ", "SB", "WB", "WS", "SN", "NY",
    "LY", "JR", "JR/T", "SJ", "GY",
}


def _is_pure_prefix(query: str) -> bool:
    """检查 query 是否只是标准前缀词（无数字、无具体编号）"""
    q = (query or "").strip().upper()
    return q in PURE_PREFIX_BLACKLIST


def _apply_sort(hits: list, sort_by: str) -> list:
    """
    对搜索结果应用排序。
      "" / 其它:        保留默认评分顺序（已按 _score DESC 排好）
      "impl_date_desc": 按实施时间倒序（空值排末尾，保留默认序）
      "impl_date_asc":  按实施时间正序（空值排末尾）
    """
    if sort_by not in ("impl_date_desc", "impl_date_asc"):
        return hits
    have = [h for h in hits if h.get("impl_date")]
    none = [h for h in hits if not h.get("impl_date")]
    have.sort(
        key=lambda h: h.get("impl_date", ""),
        reverse=(sort_by == "impl_date_desc"),
    )
    return have + none

INDUSTRY_ALIAS_TABLE = {
    "A_comprehensive": ["综合", "标准化", "质量管理", "计量", "测量", "认证", "检测"],
    "B_agriculture": ["农业", "林业", "种子", "肥料", "畜牧", "水产", "农产品", "粮食", "茶叶"],
    "C_medical": ["医药", "医疗", "卫生", "药品", "医疗器械", "防护", "消毒", "口罩"],
    "D_mining": ["矿业", "煤炭", "矿山", "采矿", "选矿"],
    "E_petroleum": ["石油", "天然气", "石化", "润滑油", "炼油", "石油化工"],
    "F_energy": ["能源", "电力", "光伏", "风电", "核电", "储能", "新能源", "充电桩", "太阳能", "氢能"],
    "G_chemical": ["化工", "橡胶", "涂料", "塑料", "化学", "危险化学品", "化肥", "胶粘剂"],
    "H_metallurgy": ["冶金", "钢铁", "合金", "焊接", "热处理", "金属", "不锈钢", "铝合金"],
    "J_machinery": ["机械", "铸造", "锻造", "轴承", "齿轮", "液压", "阀门", "泵", "模具", "起重", "包装机械"],
    "K_electrical": ["电工", "电气", "变压器", "电缆", "电池", "照明", "LED", "锂电池", "开关"],
    "L_electronics_it": ["电子", "半导体", "信息技术", "软件", "人工智能", "AI", "物联网", "云计算", "信息安全", "IT", "互联网", "大数据"],
    "M_telecom": ["通信", "5G", "广播", "无线电", "光纤"],
    "N_instruments": ["仪器", "仪表", "传感器", "自动化", "流量计"],
    "P_construction": ["建筑", "建设", "施工", "混凝土", "钢结构", "给排水", "暖通", "装配式", "BIM"],
    "Q_building_materials": ["建材", "水泥", "陶瓷", "玻璃", "防水", "保温", "石材"],
    "R_road_transport": ["公路", "汽车", "交通", "桥梁", "轮胎", "运输", "电动汽车", "智能网联"],
    "S_railway": ["铁路", "高铁", "地铁", "轨道交通", "城轨"],
    "T_vehicles": ["摩托车", "电动自行车", "自行车", "特种车辆"],
    "U_marine": ["船舶", "海洋", "渔船", "游艇", "海洋工程"],
    "V_aerospace": ["航空", "航天", "飞机", "无人机", "卫星", "火箭"],
    "W_textile": ["纺织", "服装", "面料", "印染", "针织", "纤维", "丝绸"],
    "X_food": ["食品", "食品安全", "食品加工", "乳制品", "肉制品", "饮料", "茶", "酒", "粮油", "餐饮",
                "辅食", "婴幼儿食品", "保健食品", "调味品", "罐头", "烘焙", "冷冻食品", "水产品"],
    "Y_consumer": ["轻工", "家具", "家电", "玩具", "化妆品", "造纸", "皮革", "文具", "日用品"],
    "Z_environmental": ["环保", "环境", "污染", "废水", "废气", "固废", "碳排放", "碳中和", "噪声"],
}

KEY_TO_MAP = {
    "X_food": "food", "J_machinery": "manufacturing", "H_metallurgy": "welding",
    "P_construction": "construction", "F_energy": "energy", "W_textile": "textile",
    "R_road_transport": "auto", "Z_environmental": "environmental",
    "G_chemical": "chemical", "C_medical": "medical",
}

GAP_RULES = {
    "出口": {"gap": "出口目的国技术法规和合规要求（EU CE/FDA/ASEAN 等）", "severity": "high", "action": "补充目的国标准对照分析"},
    "东南亚": {"gap": "东盟标准（ASEAN Standards）合规要求", "severity": "high", "action": "查阅目的国食品/产品法规"},
    "欧盟": {"gap": "EU 指令和 EN 标准（CE 标志要求）", "severity": "high", "action": "对照 EU 官方公报查阅协调标准"},
    "美国": {"gap": "FDA/OSHA/ANSI/ASTM 等美国标准体系", "severity": "high", "action": "查阅 FDA 注册要求或 ANSI 标准"},
    "婴幼儿": {"gap": "GB 10765/10767 婴幼儿食品安全国家标准系列", "severity": "critical", "action": "必须逐条核对婴幼儿专用标准"},
    "有机": {"gap": "GB/T 19630 有机产品认证要求", "severity": "medium", "action": "申请有机产品认证"},
    "清真": {"gap": "清真食品认证标准", "severity": "medium", "action": "联系清真认证机构"},
    "冷链": {"gap": "GB/T 28843 冷链物流分类与基本要求", "severity": "medium", "action": "建立冷链全程温控体系"},
    "电商": {"gap": "GB/T 36413 电子商务平台商品信息展示要求", "severity": "low", "action": "规范线上商品信息展示"},
    "3C": {"gap": "CCC 强制性产品认证", "severity": "critical", "action": "确认产品是否在 CCC 目录内"},
    "ISO": {"gap": "国际标准与国标的差异对照", "severity": "medium", "action": "做国际标准-国标转化对照分析"},
    "特种设备": {"gap": "TSG 特种设备安全技术规范", "severity": "critical", "action": "确认是否属于特种设备范畴"},
}


# ═══════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════

def _clean_name(name: str) -> str:
    """
    去标点 + 中文 bigram 切分（空格分隔），用于 FTS 入库和查询。

    FTS schema 是 tokenize=simple，对连续中文当成一个超长 token，bigram 匹配不到。
    本函数把 name 切成 bigram 序列（每相邻 2 字一组，空格分隔），让 simple tokenizer
    切出每个 bigram 作为独立 token，与查询侧 bigram OR-MATCH 对齐命中。
    """
    cleaned = re.sub(r'[（）()、，。/\s]+', '', name or "")
    if len(cleaned) < 2:
        return cleaned
    bigrams = [cleaned[i:i+2] for i in range(len(cleaned) - 1)]
    return ' '.join(bigrams)


def _extract_type_tags(name: str) -> str:
    """从名称提取类型标签，逗号分隔"""
    tags = []
    for tag, keywords in STANDARD_TYPE_KEYWORDS.items():
        if any(kw in name for kw in keywords):
            tags.append(tag)
    return ",".join(tags)


def _categorize(code: str) -> str:
    """判断标准分类"""
    if code.startswith("GB ") or code.startswith("GB/T "):
        return "national"
    if code.startswith("DB"):
        return "local"
    if code.startswith("T/"):
        return "group"
    if "/" in code and not code.startswith("GB"):
        return "industry"
    return "other"


def _extract_series(code: str):
    """提取系列编号 → (base, part)"""
    m = re.match(r'(GB/?T?\s*\d+)(?:\.(\d+))?', code)
    if m:
        return m.group(1).strip(), m.group(2) or ""
    return "", ""


def _extract_year(code: str) -> int:
    m = re.search(r'-(\d{4})$', code)
    return int(m.group(1)) if m else 0


def _is_mandatory(code: str) -> bool:
    return code.startswith("GB ") and not code.startswith("GB/T")


def _file_hash(path: str) -> str:
    """快速 MD5 哈希（只读前 64KB + 文件大小）"""
    h = hashlib.md5()
    sz = os.path.getsize(path)
    h.update(str(sz).encode())
    with open(path, 'rb') as f:
        h.update(f.read(65536))
    return h.hexdigest()


# ═══════════════════════════════════════════════════════════
# 核心类
# ═══════════════════════════════════════════════════════════

class StandardKnowledgeBase:
    """标准知识库 v3 — SQLite + FTS5 后端"""

    def __init__(self, crawled_dir: str, rules_dir: str, csv_dir: str = ""):
        """
        crawled_dir: JSON 爬虫数据目录（国标 all_standards.json）
        rules_dir:   规则 JSON 目录
        csv_dir:     CSV 数据目录（行标/团标/地标 .csv 文件），可选
        """
        # 规则数据仍然内存加载（< 1MB）
        self.ccs = {}
        self.industry_map = {}
        self.outline_templates = {}
        self.terminology = {}
        self.stats = {}

        self._load_rules(rules_dir)

        # SQLite 数据库：优先放 /tmp（避免 virtiofs WAL 问题），服务器上放 crawled_dir 同级
        default_db = os.path.join(os.path.dirname(crawled_dir), "standards.db")
        if os.path.exists("/sessions"):
            # VM 环境 → /tmp
            db_path = "/tmp/standards.db"
        else:
            db_path = default_db
        self.db_path = db_path
        # bx_standards.db（73K 精排库，含 scope 字段），与 standards.db 同目录
        self.bx_db_path = os.path.join(os.path.dirname(crawled_dir), "bx_standards.db")

        # 向量召回索引（可选；同目录 standards.faiss + standards_vec_codes.json）
        self.vec_index = None       # faiss.Index
        self.vec_codes = None       # list[str]，与 faiss 行号一一对应
        self.vec_model = None       # SentenceTransformer
        self._load_vec_index()

        self._init_db(crawled_dir, csv_dir)

    # ───────────────────────────────────────────────────
    # 初始化
    # ───────────────────────────────────────────────────

    def _load_rules(self, rules_dir):
        rd = Path(rules_dir)
        for name, attr in [
            ("ccs_classification.json", "ccs"),
            ("industry_standards_map.json", "industry_map"),
            ("outline_templates.json", "outline_templates"),
            ("terminology_rules.json", "terminology"),
        ]:
            fp = rd / name
            if fp.exists():
                setattr(self, attr, json.loads(fp.read_text("utf-8")))

    def _get_conn(self) -> sqlite3.Connection:
        """获取连接（WAL 模式，只读友好）"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA cache_size=-8000")  # 8MB cache
        return conn

    # ───────────────────────────────────────────────────
    # 向量召回（POC：bge-small-zh + faiss-cpu）
    # ───────────────────────────────────────────────────

    def _load_vec_index(self) -> None:
        """
        启动时加载 faiss 索引和 embedding 模型。
        任何失败都不抛错，self.vec_index 保持 None，search() 自动降级为纯 FTS。

        索引文件（与 standards.db 同目录）：
          - standards.faiss          : faiss IndexFlatIP（cosine via L2 norm + inner product）
          - standards_vec_codes.json : [{"code": "..."} ...] 与 faiss 行号严格一一对应

        模型：BAAI/bge-small-zh-v1.5（512 维，约 100MB，CPU 推理 query ~200-500ms）
        """
        if not _VEC_AVAILABLE:
            print("⚠️  向量召回依赖未安装（faiss-cpu / sentence-transformers），降级为纯 FTS")
            return

        index_path = os.path.join(os.path.dirname(self.db_path), "standards.faiss")
        codes_path = os.path.join(os.path.dirname(self.db_path), "standards_vec_codes.json")
        if not (os.path.exists(index_path) and os.path.exists(codes_path)):
            print(f"⚠️  未找到向量索引（{index_path}），跳过向量召回。运行 build_vec_index.py 生成。")
            return

        try:
            self.vec_index = _faiss.read_index(index_path)
            with open(codes_path, "r", encoding="utf-8") as f:
                self.vec_codes = [item["code"] for item in json.load(f)]
            if len(self.vec_codes) != self.vec_index.ntotal:
                print(f"❌ 向量索引与 code 列表长度不一致（faiss={self.vec_index.ntotal} codes={len(self.vec_codes)}），丢弃")
                self.vec_index = None
                self.vec_codes = None
                return
            model_name = os.environ.get("BXZ_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
            self.vec_model = _SentenceTransformer(model_name)
            print(f"✅ 向量召回就绪: {model_name}, ntotal={self.vec_index.ntotal}")
        except Exception as e:
            print(f"⚠️  向量索引加载失败（降级为纯 FTS）: {type(e).__name__}: {e}")
            self.vec_index = None
            self.vec_codes = None
            self.vec_model = None

    def _vec_search(self, query: str, top_k: int = 50) -> list[tuple[str, float]]:
        """
        向量检索：返回 [(code, cosine_similarity)]，长度 ≤ top_k。
        未加载索引时返回 []。

        cosine 下限过滤：低于 BXZ_VEC_MIN_COS（默认 0.25）的结果直接丢弃，
        避免语义完全不相关的标准以低分污染融合候选池。
        """
        if self.vec_index is None or self.vec_model is None or self.vec_codes is None:
            return []
        try:
            min_cos = float(os.environ.get("BXZ_VEC_MIN_COS", "0.25"))
        except ValueError:
            min_cos = 0.25
        try:
            emb = self.vec_model.encode(
                [query], normalize_embeddings=True, show_progress_bar=False
            ).astype("float32")
            sims, idxs = self.vec_index.search(emb, top_k)
            out: list[tuple[str, float]] = []
            for sim, idx in zip(sims[0], idxs[0]):
                if idx < 0 or idx >= len(self.vec_codes):
                    continue
                sim_f = float(sim)
                if sim_f < min_cos:
                    continue  # cosine 下限过滤
                out.append((self.vec_codes[idx], sim_f))
            return out
        except Exception as e:
            print(f"⚠️  向量检索失败（本次查询降级）: {type(e).__name__}: {e}")
            return []

    def _init_db(self, crawled_dir: str, csv_dir: str = ""):
        """初始化数据库：建表 + 按需导入数据"""
        conn = self._get_conn()

        # 建表
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS standards (
                code        TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                name_clean  TEXT NOT NULL,
                status      TEXT DEFAULT '',
                pub_date    TEXT DEFAULT '',
                impl_date   TEXT DEFAULT '',
                raw_type    TEXT DEFAULT '',
                category    TEXT DEFAULT '',
                is_mandatory INTEGER DEFAULT 0,
                type_tags   TEXT DEFAULT '',
                series_base TEXT DEFAULT '',
                series_part TEXT DEFAULT '',
                pub_year    INTEGER DEFAULT 0,
                source_id    TEXT DEFAULT '',
                publisher    TEXT DEFAULT '',
                ics_code     TEXT DEFAULT '',
                ics_name     TEXT DEFAULT '',
                ccs          TEXT DEFAULT '',
                ccs_name     TEXT DEFAULT '',
                std_source   TEXT DEFAULT '',
                issuing_dept TEXT DEFAULT '',
                tc_committee TEXT DEFAULT '',
                drafting_org TEXT DEFAULT '',
                replaces     TEXT DEFAULT '',
                adopted_intl TEXT DEFAULT '',
                name_en      TEXT DEFAULT '',
                obsolete_date TEXT DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_standards_category ON standards(category);
            CREATE INDEX IF NOT EXISTS idx_standards_status ON standards(status);
            CREATE INDEX IF NOT EXISTS idx_standards_year ON standards(pub_year);
            CREATE INDEX IF NOT EXISTS idx_standards_series ON standards(series_base);

            CREATE VIRTUAL TABLE IF NOT EXISTS standards_fts USING fts4(
                code, name, name_clean,
                tokenize=simple
            );

            CREATE TABLE IF NOT EXISTS industry_link (
                industry_key TEXT NOT NULL,
                code         TEXT NOT NULL,
                PRIMARY KEY (industry_key, code)
            );
            CREATE INDEX IF NOT EXISTS idx_industry_link_code ON industry_link(code);

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        """)
        conn.commit()

        # 兼容旧库：补充新列（已存在时 SQLite 报错，忽略即可）
        for col_def in [
            "ics_code     TEXT DEFAULT ''",
            "ics_name     TEXT DEFAULT ''",
            "ccs          TEXT DEFAULT ''",
            "ccs_name     TEXT DEFAULT ''",
            "std_source   TEXT DEFAULT ''",
            "issuing_dept TEXT DEFAULT ''",
            "tc_committee TEXT DEFAULT ''",
            "drafting_org TEXT DEFAULT ''",
            "replaces     TEXT DEFAULT ''",
            "adopted_intl TEXT DEFAULT ''",
            "name_en      TEXT DEFAULT ''",
            "obsolete_date TEXT DEFAULT ''",
        ]:
            try:
                conn.execute(f"ALTER TABLE standards ADD COLUMN {col_def}")
            except Exception:
                pass
        conn.commit()

        # 计算当前数据指纹（JSON + CSV 综合）
        fingerprint_parts = []
        all_file = os.path.join(crawled_dir, "all_standards.json")
        if os.path.exists(all_file):
            fingerprint_parts.append(_file_hash(all_file))
        else:
            json_files = sorted(glob.glob(os.path.join(crawled_dir, "*.json")))
            fingerprint_parts.append(str(len(json_files)))

        csv_files = []
        if csv_dir and os.path.isdir(csv_dir):
            csv_files = sorted(glob.glob(os.path.join(csv_dir, "*.csv")))
            for cf in csv_files:
                fingerprint_parts.append(_file_hash(cf))

        current_fingerprint = hashlib.md5("|".join(fingerprint_parts).encode()).hexdigest()
        row = conn.execute("SELECT value FROM meta WHERE key='data_fingerprint'").fetchone()
        old_fingerprint = row["value"] if row else ""

        if current_fingerprint != old_fingerprint:
            print("📦 数据变更，重新导入...")
            self._import_data(conn, crawled_dir, csv_files)
            conn.execute("INSERT OR REPLACE INTO meta VALUES('data_fingerprint', ?)", (current_fingerprint,))
            conn.commit()
        else:
            print("✅ 数据库已是最新，跳过导入")

        # 更新统计
        self._update_stats(conn)
        conn.close()

    def _import_data(self, conn: sqlite3.Connection, crawled_dir: str, csv_files: list = None):
        """全量导入 JSON + CSV → SQLite"""
        # 清空旧数据
        conn.executescript("""
            DELETE FROM standards;
            DELETE FROM standards_fts;
            DELETE FROM industry_link;
            DELETE FROM meta;
        """)

        # ── 1. 导入 JSON（国标）──
        all_file = os.path.join(crawled_dir, "all_standards.json")
        if os.path.exists(all_file):
            data = json.load(open(all_file, encoding="utf-8"))
            self._ingest_batch(conn, data.get("standards", []), "all_standards")
            print(f"  JSON: {len(data.get('standards', []))} 条国标")
        else:
            json_files = sorted(glob.glob(os.path.join(crawled_dir, "*.json")))
            total_json = 0
            for fp in json_files:
                industry_key = Path(fp).stem
                data = json.load(open(fp, encoding="utf-8"))
                stds = data.get("standards", [])
                self._ingest_batch(conn, stds, industry_key)
                total_json += len(stds)
            print(f"  JSON: {total_json} 条（{len(json_files)} 个文件）")

        # ── 2. 导入 CSV（行标/团标/地标）──
        if csv_files:
            for csv_path in csv_files:
                fname = Path(csv_path).stem
                count = self._ingest_csv(conn, csv_path, fname)
                print(f"  CSV: {fname} → {count} 条")

        conn.commit()

        # 重建 FTS 索引
        print("  建立 FTS5 全文索引...")
        conn.execute("""
            INSERT INTO standards_fts(rowid, code, name, name_clean)
            SELECT rowid, code, name, name_clean FROM standards
        """)
        conn.commit()

        total = conn.execute("SELECT COUNT(*) FROM standards").fetchone()[0]
        print(f"✅ 导入完成: {total} 条标准")

    # CSV 类型 → category 映射
    CSV_TYPE_MAP = {
        "行业标准": "industry",
        "团体标准": "group",
        "地方标准": "local",
    }

    def _ingest_csv(self, conn: sqlite3.Connection, csv_path: str, label: str) -> int:
        """导入单个 CSV 文件（行标/团标/地标格式）
        CSV 列: 类型,编号,名称,状态,发布日期,实施日期,废止日期,发布机构
        """
        batch = []
        batch_ind = []
        count = 0

        with open(csv_path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                code = (row.get("编号") or "").strip()
                if not code:
                    continue

                name = (row.get("名称") or "").strip()
                name_clean = _clean_name(name)
                raw_type = (row.get("类型") or "").strip()
                category = self.CSV_TYPE_MAP.get(raw_type, "other")
                series_base, series_part = _extract_series(code)
                pub_date = (row.get("发布日期") or "").strip()
                impl_date = (row.get("实施日期") or "").strip()
                publisher = (row.get("发布机构") or "").strip()

                # 从发布日期提取年份
                pub_year = 0
                ym = re.search(r'(\d{4})', pub_date)
                if ym:
                    pub_year = int(ym.group(1))
                if not pub_year:
                    pub_year = _extract_year(code)

                batch.append((
                    code, name, name_clean,
                    (row.get("状态") or "").strip(),
                    pub_date, impl_date, raw_type,
                    category,
                    1 if _is_mandatory(code) else 0,
                    _extract_type_tags(name),
                    series_base, series_part, pub_year,
                    "",  # source_id
                    publisher,
                ))
                batch_ind.append((label, code))
                count += 1

                # 每 5000 条批量插入
                if len(batch) >= 5000:
                    conn.executemany("""
                        INSERT OR IGNORE INTO standards
                        (code, name, name_clean, status, pub_date, impl_date, raw_type,
                         category, is_mandatory, type_tags, series_base, series_part,
                         pub_year, source_id, publisher)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, batch)
                    conn.executemany(
                        "INSERT OR IGNORE INTO industry_link (industry_key, code) VALUES (?,?)",
                        batch_ind,
                    )
                    batch.clear()
                    batch_ind.clear()

        # 剩余
        if batch:
            conn.executemany("""
                INSERT OR IGNORE INTO standards
                (code, name, name_clean, status, pub_date, impl_date, raw_type,
                 category, is_mandatory, type_tags, series_base, series_part,
                 pub_year, source_id, publisher)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, batch)
            conn.executemany(
                "INSERT OR IGNORE INTO industry_link (industry_key, code) VALUES (?,?)",
                batch_ind,
            )

        return count

    def _ingest_batch(self, conn: sqlite3.Connection, standards: list, industry_key: str):
        """批量插入标准记录"""
        batch_std = []
        batch_ind = []

        for s in standards:
            code = s.get("code", "").strip()
            if not code:
                continue
            name = s.get("name", "")
            name_clean = _clean_name(name)
            series_base, series_part = _extract_series(code)
            pub_year = _extract_year(code)

            batch_std.append((
                code, name, name_clean,
                s.get("status", ""),
                s.get("pub_date", "") or s.get("publish_date", ""),
                s.get("impl_date", "") or s.get("implement_date", ""),
                s.get("type", ""),
                _categorize(code),
                1 if _is_mandatory(code) else 0,
                _extract_type_tags(name),
                series_base, series_part, pub_year,
                s.get("id", ""),
                s.get("publisher", ""),
                s.get("ics_code", ""),
                s.get("ics_name", ""),
                s.get("ccs", ""),
                s.get("ccs_name", ""),
                s.get("source", ""),
                s.get("issuing_dept", ""),
                s.get("tc_committee", ""),
                s.get("drafting_org", ""),
                s.get("replaces", ""),
                s.get("adopted_intl", ""),
                s.get("name_en", ""),
                s.get("obsolete_date", ""),
            ))
            batch_ind.append((industry_key, code))

        conn.executemany("""
            INSERT OR IGNORE INTO standards
            (code, name, name_clean, status, pub_date, impl_date, raw_type,
             category, is_mandatory, type_tags, series_base, series_part, pub_year, source_id, publisher,
             ics_code, ics_name, ccs, ccs_name, std_source,
             issuing_dept, tc_committee, drafting_org, replaces, adopted_intl, name_en, obsolete_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, batch_std)

        conn.executemany(
            "INSERT OR IGNORE INTO industry_link (industry_key, code) VALUES (?,?)",
            batch_ind,
        )

    def _update_stats(self, conn: sqlite3.Connection):
        total = conn.execute("SELECT COUNT(*) FROM standards").fetchone()[0]
        mandatory = conn.execute("SELECT COUNT(*) FROM standards WHERE is_mandatory=1").fetchone()[0]
        industries = conn.execute("SELECT COUNT(DISTINCT industry_key) FROM industry_link").fetchone()[0]
        series = conn.execute("SELECT COUNT(DISTINCT series_base) FROM standards WHERE series_base!=''").fetchone()[0]

        self.stats = {
            "total": total,
            "unique_codes": total,
            "industries": industries,
            "series": series,
            "mandatory": mandatory,
            "recommended": total - mandatory,
        }

    # ───────────────────────────────────────────────────
    # 查询方法（公共 API，签名不变）
    # ───────────────────────────────────────────────────

    def search(self, query: str, limit: int = 100, sort_by: str = "") -> list[dict]:
        """
        全文搜索，返回带评分的结果（双源 fallback：先 bx，命中 0 再走 standards）。

        sort_by: 排序方式
          - "" / 默认: 按相关度评分（_score）DESC
          - "impl_date_desc": 按实施时间倒序（空值排末尾）
          - "impl_date_asc":  按实施时间正序（空值排末尾）

        返回结果每条带 match_type:
          - "code_match": 编号变体 LIKE 命中（精准）
          - "fts_match":  FTS bigram MATCH 命中（模糊）
          - "name_match": name LIKE 兜底命中（模糊）
        """
        query = query.strip()
        if not query:
            return []

        # 纯前缀过滤（用户搜 "GB"/"GB/T" 等无具体编号，避免返回全表）
        if _is_pure_prefix(query):
            return []

        # ① 优先源：bx_standards.db（73K 精排，含主流国标如 GB 50011-2010 + scope/fulltext）
        bx_hits = self._search_in_bx_db(query, limit)
        if bx_hits:
            return _apply_sort(bx_hits, sort_by)

        # ② Fallback：standards.db（487K 长尾覆盖）
        conn = self._get_conn()
        results = []  # tuples: (code, score, row, match_type)

        # 1. 编号精确/包含匹配（含格式变体：GB1.1 ↔ GBT1.1）→ match_type=code_match
        q_norm = query.upper().replace(" ", "").replace("/", "")
        q_variants = _code_search_variants(q_norm)
        like_clause = " OR ".join(
            "REPLACE(REPLACE(REPLACE(UPPER(code),' ',''),'/',''), ' ', '') LIKE ?"
            for _ in q_variants
        )
        rows = conn.execute(
            f"SELECT *, 0 as fts_rank FROM standards WHERE ({like_clause}) LIMIT ?",
            [f"%{v}%" for v in q_variants] + [limit],
        ).fetchall()

        seen = set()
        for r in rows:
            code = r["code"]
            seen.add(code)
            # 完全匹配 200 分，包含匹配 100 分
            code_clean = code.upper().replace(" ", "").replace("/", "")
            score = 200 if any(v == code_clean for v in q_variants) else 100
            results.append((code, score, r, "code_match"))

        # 2. FTS 全文搜索（名称匹配）→ match_type=fts_match
        q_clean_raw = re.sub(r'[（）()、，。/\s]+', '', query)  # 不切 bigram 的原始 clean
        if len(q_clean_raw) >= 2:
            # 用 bigram 查询提高中文搜索精度（与 _clean_name 写入侧对齐）
            bigrams = [q_clean_raw[i:i+2] for i in range(len(q_clean_raw)-1)]
            fts_query = " OR ".join(f'"{bg}"' for bg in bigrams[:10])
            # FTS4 默认按 docid 排序（不是相关度），LIMIT 太小会把高相关命中切掉。
            # 扩大候选池到 max(500, limit*20)，由后续 Python 端 score 排序 + status
            # 权重决定最终顺序。487K 全表 FTS 内 500 行 fetch 仍 < 100ms。
            fts_fetch_limit = max(500, limit * 20)
            try:
                fts_rows = conn.execute("""
                    SELECT s.*, 0 as fts_rank
                    FROM standards_fts fts
                    JOIN standards s ON s.rowid = fts.rowid
                    WHERE standards_fts MATCH ?
                    LIMIT ?
                """, (fts_query, fts_fetch_limit)).fetchall()

                for r in fts_rows:
                    code = r["code"]
                    if code not in seen:
                        seen.add(code)
                        # 基础 FTS 分数（bigram 命中数 × 2）
                        score = 2 * len([bg for bg in bigrams if bg in (r["name_clean"] or "")])
                        # 全名包含加分
                        if query.lower() in r["name"].lower():
                            score += 20
                        results.append((code, score, r, "fts_match"))
            except sqlite3.OperationalError:
                pass  # FTS 查询语法问题时降级

        # 3. 全名包含匹配（补漏）→ match_type=name_match
        # 长尾修复：扩 LIMIT 到 200，Python 端按 score 排序后裁剪，避免漏掉高相关短名标准
        if len(results) < limit:
            name_rows = conn.execute("""
                SELECT *, 0 as fts_rank FROM standards
                WHERE name LIKE ? AND code NOT IN ({})
                LIMIT 200
            """.format(",".join(f"'{c}'" for c, _, _, _ in results) or "'__none__'"),
                (f"%{query}%",)).fetchall()
            q_lower = query.lower()
            for r in name_rows:
                code = r["code"]
                if code not in seen:
                    seen.add(code)
                    # 名字越靠前匹配 query 评分越高（vs 旧版固定 20 分）
                    idx = (r["name"] or "").lower().find(q_lower)
                    score = max(20, 50 - idx) if idx >= 0 else 5
                    results.append((code, score, r, "name_match"))

        # 4. 向量召回（双路并集，仅补充未命中的 code）→ match_type=vec_match
        # 评分尺度对齐：cosine ∈ [min_cos, 1]，映射到 [0,60]，权重 0.4 保持精确编号/FTS 命中靠前。
        # _vec_search 已按 BXZ_VEC_MIN_COS（默认 0.25）做下限过滤，避免低相关度污染。
        vec_hits = self._vec_search(query, top_k=50)
        if vec_hits:
            new_codes = [c for c, _ in vec_hits if c not in seen]
            if new_codes:
                placeholders = ",".join("?" * len(new_codes))
                vec_rows = conn.execute(
                    f"SELECT *, 0 as fts_rank FROM standards WHERE code IN ({placeholders})",
                    new_codes,
                ).fetchall()
                row_by_code = {r["code"]: r for r in vec_rows}
                sim_by_code = dict(vec_hits)
                for code in new_codes:
                    r = row_by_code.get(code)
                    if r is None:
                        continue  # faiss 索引与 DB 不同步的脏数据，跳过
                    sim = sim_by_code.get(code, 0.0)
                    # cosine [min_cos, 1] → score [0, 60] × 权重 0.4
                    score = int(max(0.0, sim) * 60 * 0.4)
                    if score <= 0:
                        continue
                    seen.add(code)
                    results.append((code, score, r, "vec_match"))

        # 排序：主键 _status_tier（保证 现行 > 即将实施 > 空 > 废止 严格分组），
        # 次键 -score（组内按相关度倒序）。score 已经按 _status_weight 调整过。
        results = [
            (code, score * _status_weight(r["status"]), r, mt)
            for code, score, r, mt in results
        ]
        results.sort(key=lambda x: (_status_tier(x[2]["status"]), -x[1]))
        conn.close()
        hits = []
        for _, score, r, mt in results[:limit]:
            d = self._row_to_dict(r, score)
            d["match_type"] = mt
            hits.append(d)

        # 批量从 bx_standards.db 补 scope（73K 精排库，94% 覆盖率）
        if hits and os.path.exists(self.bx_db_path):
            codes = [h["code"] for h in hits]
            try:
                bx_conn = sqlite3.connect(self.bx_db_path)
                bx_conn.row_factory = sqlite3.Row
                placeholders = ",".join("?" * len(codes))
                scope_rows = bx_conn.execute(
                    f"SELECT code, scope FROM standards WHERE code IN ({placeholders})",
                    codes
                ).fetchall()
                bx_conn.close()
                scope_map = {row["code"]: (row["scope"] or "").strip() for row in scope_rows}
            except Exception:
                scope_map = {}
            for h in hits:
                h["scope"] = scope_map.get(h["code"], "")
        return _apply_sort(hits, sort_by)

    def query_industry(self, industry_query: str) -> dict:
        """① 行业标准查询"""
        matched_keys = self._match_industry(industry_query)
        if not matched_keys:
            return {"matched": False, "suggestion": "试试：食品、机械、建筑、化工、能源、纺织、汽车、环保、医疗、电子"}

        conn = self._get_conn()

        # 收集该行业所有标准
        placeholders = ",".join("?" * len(matched_keys))
        rows = conn.execute(f"""
            SELECT DISTINCT s.* FROM standards s
            JOIN industry_link il ON s.code = il.code
            WHERE il.industry_key IN ({placeholders})
            ORDER BY s.pub_year DESC
        """, matched_keys).fetchall()

        if not rows:
            # 行业索引没数据时用搜索补充
            conn.close()
            search_results = self.search(industry_query, limit=200)
            rows_data = search_results
        else:
            rows_data = [self._row_to_dict(r) for r in rows]
            conn.close()

        mandatory = [d for d in rows_data if d.get("is_mandatory")]
        recommended = [d for d in rows_data if not d.get("is_mandatory")]

        by_type = defaultdict(list)
        for d in rows_data:
            for tag in d.get("type_tags", []):
                by_type[tag].append(d)

        curated = self._get_curated_standards(industry_query, matched_keys)

        # 精选标准补充 status
        conn2 = self._get_conn()
        for group in curated:
            for lst_key in ("mandatory", "recommended", "testing"):
                for item in group.get(lst_key, []):
                    detail = self._get_record(conn2, item.get("code", ""))
                    if detail:
                        item["status"] = detail["status"]
                        item["pub_date"] = detail["pub_date"]
                        item["impl_date"] = detail["impl_date"]
        conn2.close()
        return {
            "matched": True,
            "matched_industries": matched_keys,
            "total": len(rows_data),
            "mandatory": mandatory,
            "recommended": recommended,
            "by_type": dict(by_type),
            "curated": curated,
            "type_distribution": {tag: len(codes) for tag, codes in by_type.items()},
        }

    def generate_outline(self, description: str, standard_type: str = None) -> dict:
        """② 大纲生成"""
        templates = self.outline_templates.get("templates", [])
        fixed = self.outline_templates.get("fixed_prefix", [])

        scores = []
        for t in templates:
            score = 0
            for kw in t.get("keyword_triggers", []):
                if kw in description:
                    score += 3
            for tag, keywords in STANDARD_TYPE_KEYWORDS.items():
                if any(kw in description for kw in keywords):
                    if tag in t.get("id", ""):
                        score += 5
            if standard_type and standard_type in t.get("name", ""):
                score += 10
            scores.append((t, score))

        scores.sort(key=lambda x: -x[1])

        # 搜索相关标准（多处复用：引用注入、术语填充、ICS 推断）
        related = self.search(description, limit=20)
        related = [r for r in related if r.get("_score", 0) >= 4]

        # 改动5: 全部 0 分时用搜索结果的 type_tags / ICS 推断模板
        if scores and scores[0][1] == 0:
            best = self._infer_template_from_search(related, templates)
        else:
            best = scores[0][0] if scores else templates[0]

        # 改动3: 规范性引用加状态标注
        normative_refs = []
        for r in related[:8]:
            ref = {"code": r["code"], "name": r["name"], "status": r.get("status", "")}
            if r.get("replaces"):
                ref["replaces"] = r["replaces"]
            normative_refs.append(ref)

        subject = description

        # 改动1: 检测领域 → 章节标题覆盖映射
        clause_title_overrides = self._detect_domain_titles(description, best)

        def replace_subject(text: str) -> str:
            return text.replace("{subject}", subject) if text else text

        def process_children(children: list) -> list:
            result = []
            for child in children:
                if isinstance(child, str):
                    result.append(child)
                elif isinstance(child, dict):
                    clause = child.get("clause", "")
                    title = clause_title_overrides.get(clause, child.get("title", ""))
                    processed = {"clause": clause, "title": replace_subject(title)}
                    if child.get("content"):
                        processed["content"] = replace_subject(child["content"])
                    if child.get("note"):
                        processed["note"] = child["note"]
                    if child.get("children"):
                        processed["children"] = process_children(child["children"])
                    result.append(processed)
            return result

        outline = []
        for item in fixed:
            entry = {"clause": item["clause"], "title": item["title"], "editable": False}
            if item.get("content"):
                entry["content"] = replace_subject(item["content"])
            if item.get("note"):
                entry["note"] = item["note"]
            if item.get("hint"):
                entry["hint"] = item["hint"]
            # 改动2: 术语章节自动填充
            if item["clause"] == "3" and related:
                term_sources = [r for r in related[:8] if r.get("_score", 0) >= 6]
                if term_sources:
                    term_lines = "\n".join(
                        f"- {r['code']}《{r['name']}》" for r in term_sources[:5]
                    )
                    base_content = replace_subject(item.get("content", ""))
                    entry["content"] = (
                        base_content
                        + f"\n[建议参考以下标准中的术语定义]\n{term_lines}"
                    )
            if item["clause"] == "2" and normative_refs:
                entry["injected_refs"] = normative_refs
            outline.append(entry)

        for item in best.get("skeleton", []):
            clause = item["clause"]
            title = clause_title_overrides.get(clause, item["title"])
            entry = {
                "clause": clause,
                "title": replace_subject(title),
                "editable": True,
            }
            if item.get("content"):
                entry["content"] = replace_subject(item["content"])
            if item.get("note"):
                entry["note"] = item["note"]
            if item.get("children"):
                entry["children"] = process_children(item["children"])
            outline.append(entry)

        raw_appendices = best.get("typical_appendices", [])
        appendices = []
        for a in raw_appendices:
            if isinstance(a, str):
                appendices.append({"type": "informative", "title": a})
            elif isinstance(a, dict):
                app_entry = {"type": a.get("type", "informative"), "title": a.get("title", "")}
                if a.get("content"):
                    app_entry["content"] = replace_subject(a["content"])
                appendices.append(app_entry)

        return {
            "description": description,
            "matched_template": best["name"],
            "template_id": best["id"],
            "match_score": scores[0][1] if scores else 0,
            "outline": outline,
            "appendices": appendices,
            "normative_references": normative_refs,
            "related_standards": related[:10],
        }

    def _infer_template_from_search(self, search_results: list, templates: list) -> dict:
        """改动5: 搜索结果的 type_tags 统计 → 推断最佳模板（替代默认产品标准）"""
        # 第一优先：type_tags 投票
        tag_counts: dict[str, int] = defaultdict(int)
        for r in search_results[:20]:
            for tag in r.get("type_tags", []):
                if tag in TYPE_TAG_TO_TEMPLATE:
                    tag_counts[tag] += 1

        if tag_counts:
            best_tag = max(tag_counts, key=tag_counts.get)
            target_id = TYPE_TAG_TO_TEMPLATE[best_tag]
            for t in templates:
                if t.get("id") == target_id:
                    return t

        # 第二优先：ICS 分类前缀
        ics_counts: dict[str, int] = defaultdict(int)
        for r in search_results[:20]:
            ics = r.get("ics", "")
            if ics:
                prefix = ics.split(".")[0]
                ics_counts[prefix] += 1

        if ics_counts:
            top_ics = max(ics_counts, key=ics_counts.get)
            target_id = ICS_PREFIX_TO_TEMPLATE.get(top_ics, "product_standard")
            for t in templates:
                if t.get("id") == target_id:
                    return t

        # 最终兜底
        return next((t for t in templates if t.get("id") == "product_standard"), templates[0])

    def _detect_domain_titles(self, description: str, template: dict) -> dict:
        """改动1: 检测领域并返回章节标题覆盖映射 {clause_number: new_title}"""
        variants = template.get("domain_variants", [])
        best_overrides: dict[str, str] = {}
        best_hits = 0
        for v in variants:
            hits = sum(1 for kw in v.get("keywords", []) if kw in description)
            if hits > best_hits:
                best_hits = hits
                best_overrides = v.get("clause_titles", {})
        return best_overrides

    def normalize_clause(self, chapter_title: str, user_input: str, clause_number: str = "X.X") -> dict:
        """③ 条款生成"""
        text = user_input.strip()
        conversions = []

        # 阶段0: 人称代词
        for pronoun in ["我们的", "我方的", "我们", "我方", "本公司", "贵方", "你们"]:
            if pronoun in text:
                text = text.replace(pronoun, "")
                conversions.append({"phase": "句式规范", "from": pronoun, "to": "（删除）", "context": "标准条文不使用人称代词"})

        # 阶段1: 情态动词
        modal_rules = sorted(self.terminology.get("colloquial_to_formal", []), key=lambda r: len(r.get("oral", "")), reverse=True)
        placeholders = {}
        for i, rule in enumerate(modal_rules):
            oral, formal = rule["oral"], rule["formal"]
            if oral in text:
                ph = f"\x00PH{i}\x00"
                placeholders[ph] = formal
                text = text.replace(oral, ph)
                conversions.append({"phase": "情态动词", "from": oral, "to": formal, "context": rule.get("context", "")})
        for ph, formal in placeholders.items():
            text = text.replace(ph, formal)

        # 阶段2: 单位规范化
        for rule in self.terminology.get("unit_normalization", []):
            oral, formal = rule.get("oral", ""), rule.get("formal", "")
            if not oral:
                continue
            pattern = rf'(\d+)\s*{re.escape(oral)}'
            new_text = re.sub(pattern, rf'\1 {formal}', text)
            if new_text != text:
                text = new_text
                conversions.append({"phase": "单位规范", "from": f"数值+{oral}", "to": f"数值 {formal}", "context": rule.get("context", "")})

        # 阶段3: 数值表达
        for rule in self.terminology.get("numeric_expression_rules", []):
            pattern_text = rule.get("pattern", "")
            formal_text = rule.get("formal", "")
            if pattern_text and formal_text:
                sp = pattern_text.replace("X", "").replace("Y", "").strip()
                sf = formal_text.replace("X", "").replace("Y", "").replace("～", "").strip()
                if sp and sp in text:
                    text = text.replace(sp, sf)
                    conversions.append({"phase": "数值规范", "from": sp, "to": sf, "context": rule.get("type", "")})

        related = self.search(chapter_title + " " + user_input[:20], limit=5)
        return {
            "clause_number": clause_number,
            "chapter_title": chapter_title,
            "original_input": user_input,
            "normalized_text": text,
            "formatted_clause": f"{clause_number} {chapter_title}\n\n{text}",
            "conversions": conversions,
            "conversion_count": len(conversions),
            "modal_verbs_ref": self.terminology.get("modal_verbs", {}).get("rules", []),
            "sentence_rules": self.terminology.get("sentence_structure_rules", []),
            "related_standards": [{"code": r["code"], "name": r["name"]} for r in related],
        }

    def diagnose(self, description: str) -> dict:
        """④ 适用性诊断"""
        matched_industries = self._match_industry(description)
        curated = self._get_curated_standards(description, matched_industries)
        mandatory, recommended, testing = [], [], []
        for c in curated:
            mandatory.extend(c.get("mandatory", []))
            recommended.extend(c.get("recommended", []))
            testing.extend(c.get("testing", []))

        search_results = self.search(description, limit=30)

        type_breakdown = defaultdict(list)
        for r in search_results:
            for tag in r.get("type_tags", []):
                type_breakdown[tag].append(r)

        gaps = self._analyze_gaps(description, mandatory, search_results, matched_industries)

        has_mandatory = len(mandatory) > 0
        has_related = len(search_results) > 0
        has_gaps = len(gaps) > 0

        if has_mandatory and not has_gaps:
            coverage, coverage_score = "全覆盖", 95
        elif has_mandatory and has_gaps:
            coverage, coverage_score = "部分覆盖", 60
        elif has_related:
            coverage, coverage_score = "基本覆盖", 40
        else:
            coverage, coverage_score = "数据不足", 10

        return {
            "description": description,
            "matched_industries": matched_industries,
            "coverage_level": coverage,
            "coverage_score": coverage_score,
            "mandatory_standards": mandatory,
            "recommended_standards": recommended,
            "testing_standards": testing,
            "related_by_relevance": search_results[:20],
            "type_breakdown": {k: len(v) for k, v in type_breakdown.items()},
            "gaps": gaps,
            "total_mandatory": len(mandatory),
            "total_recommended": len(recommended),
            "total_related": len(search_results),
        }

    def query_terminology(self, query: str) -> dict:
        """⑤ 术语查询"""
        rules = []
        for rule in self.terminology.get("modal_verbs", {}).get("rules", []):
            if query in rule.get("verb", "") or query in rule.get("usage", "") or query in rule.get("english", ""):
                rules.append({"type": "modal_verb", **rule})
        for rule in self.terminology.get("colloquial_to_formal", []):
            if query in rule.get("oral", "") or query in rule.get("formal", ""):
                rules.append({"type": "conversion", **rule})
        for rule in self.terminology.get("unit_normalization", []):
            if query in rule.get("oral", "") or query in rule.get("formal", ""):
                rules.append({"type": "unit", **rule})

        conn = self._get_conn()
        rows = conn.execute("""
            SELECT * FROM standards WHERE name LIKE ? LIMIT 30
        """, (f"%{query}%",)).fetchall()
        conn.close()

        related = []
        for r in rows:
            related.append({
                "code": r["code"], "name": r["name"],
                "industry": "", "is_terminology_standard": "术语" in r["name"] or "定义" in r["name"],
            })
        related.sort(key=lambda x: (not x["is_terminology_standard"], x["code"]))

        return {"query": query, "rules": rules, "related_standards": related, "total_rules": len(rules), "total_related": len(related)}

    def query_changes(self, industry: str = None, code: str = None) -> dict:
        """⑥ 变更查询"""
        conn = self._get_conn()

        conditions = []
        params = []
        if industry:
            keys = self._match_industry(industry)
            if keys:
                placeholders = ",".join("?" * len(keys))
                conditions.append(f"code IN (SELECT code FROM industry_link WHERE industry_key IN ({placeholders}))")
                params.extend(keys)
        if code:
            code_norm = code.strip().upper().replace(" ", "").replace("/", "")
            conditions.append("REPLACE(REPLACE(REPLACE(UPPER(code),' ',''),'/',''),' ','') LIKE ?")
            params.append(f"%{code_norm}%")

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = conn.execute(f"SELECT * FROM standards {where}", params).fetchall()

        deprecated, active, recent = [], [], []
        by_year = defaultdict(int)

        for r in rows:
            d = self._row_to_dict(r)
            if r["status"] == "废止":
                deprecated.append(d)
            else:
                active.append(d)
            if r["pub_year"] >= 2024:
                recent.append(d)
            if r["pub_year"] > 0:
                by_year[r["pub_year"]] += 1

        # 替代标准检测
        replacements = []
        for r in rows:
            sb = r["series_base"]
            if sb:
                siblings = conn.execute("""
                    SELECT code, name, pub_year FROM standards
                    WHERE series_base=? AND code!=? ORDER BY pub_year DESC LIMIT 1
                """, (sb, r["code"])).fetchone()
                if siblings and siblings["pub_year"] > (r["pub_year"] or 0):
                    replacements.append({"old": r["code"], "new": siblings["code"], "new_name": siblings["name"]})

        conn.close()
        return {
            "query": {"industry": industry, "code": code},
            "active": active[:100], "deprecated": deprecated[:100], "recent": recent,
            "replacements": replacements[:20],
            "total_active": len(active), "total_deprecated": len(deprecated), "total_recent": len(recent),
            "year_distribution": dict(sorted(by_year.items())),
        }

    def list_standards(self, category: str = "all", query: str = "",
                       page: int = 1, page_size: int = 20, status: str = "",
                       sort_by: str = "") -> dict:
        """
        ⑧ 标准列表 — 全库搜索，不截断。

        sort_by 与 search() 保持一致：
          - "" / 默认:      按相关度（或 query 为空时按 pub_year DESC）
          - "impl_date_desc/asc": 按实施时间排序，空值排末尾
        """
        conn = self._get_conn()

        # 纯前缀过滤
        if query and _is_pure_prefix(query):
            conn.close()
            return {"total": 0, "page": page, "page_size": page_size,
                    "categories": {"all": 0}, "status_counts": {}, "items": []}

        if query and query.strip():
            q = query.strip()
            q_norm = q.upper().replace(" ", "").replace("/", "")

            # 方案：用 UNION 合并编号匹配 + FTS 匹配 + 名称 LIKE，不加 LIMIT
            # 先收集所有匹配的 rowid，再做统计和分页

            matched_codes = set()
            code_scores = {}  # code -> score
            code_match_types = {}  # code -> match_type

            # 1. 编号包含匹配（含格式变体）→ code_match
            q_variants = _code_search_variants(q_norm)
            like_clause = " OR ".join(
                "REPLACE(REPLACE(REPLACE(UPPER(code),' ',''),'/',''), ' ', '') LIKE ?"
                for _ in q_variants
            )
            code_rows = conn.execute(
                f"SELECT code FROM standards WHERE ({like_clause})",
                [f"%{v}%" for v in q_variants],
            ).fetchall()
            for r in code_rows:
                c = r["code"]
                matched_codes.add(c)
                c_clean = c.upper().replace(" ", "").replace("/", "")
                code_scores[c] = 200 if any(v == c_clean for v in q_variants) else 100
                code_match_types[c] = "code_match"

            # 2. FTS 全文匹配（不加 LIMIT，取全量）→ fts_match
            q_clean_raw = re.sub(r'[（）()、，。/\s]+', '', q)
            if len(q_clean_raw) >= 2:
                bigrams = [q_clean_raw[i:i+2] for i in range(len(q_clean_raw)-1)]
                fts_query = " OR ".join(f'"{bg}"' for bg in bigrams[:10])
                try:
                    fts_rows = conn.execute("""
                        SELECT s.code, s.name, s.name_clean
                        FROM standards_fts fts
                        JOIN standards s ON s.rowid = fts.rowid
                        WHERE standards_fts MATCH ?
                    """, (fts_query,)).fetchall()
                    for r in fts_rows:
                        c = r["code"]
                        if c not in matched_codes:
                            matched_codes.add(c)
                            score = 2 * len([bg for bg in bigrams if bg in (r["name_clean"] or "")])
                            if q.lower() in r["name"].lower():
                                score += 20
                            code_scores[c] = score
                            code_match_types[c] = "fts_match"
                except Exception:
                    pass

            # 3. 名称 LIKE 补漏 → name_match
            like_rows = conn.execute("""
                SELECT code FROM standards WHERE name LIKE ?
            """, (f"%{q}%",)).fetchall()
            for r in like_rows:
                c = r["code"]
                if c not in matched_codes:
                    matched_codes.add(c)
                    code_scores[c] = 20
                    code_match_types[c] = "name_match"

            if not matched_codes:
                conn.close()
                return {"total": 0, "page": page, "page_size": page_size,
                        "categories": {"all": 0}, "status_counts": {}, "items": []}

            # 取全部匹配行（用于统计）— 用临时表避免 SQL 变量数上限
            conn.execute("CREATE TEMP TABLE IF NOT EXISTS _matched(code TEXT PRIMARY KEY)")
            conn.execute("DELETE FROM _matched")
            batch = list(matched_codes)
            for i in range(0, len(batch), 500):
                chunk = batch[i:i+500]
                conn.executemany("INSERT OR IGNORE INTO _matched(code) VALUES(?)",
                                 [(c,) for c in chunk])
            all_rows = conn.execute(
                "SELECT s.* FROM standards s INNER JOIN _matched m ON s.code = m.code"
            ).fetchall()

            # 按搜索相关度排序：主键 _status_tier（现行 > 即将实施 > 空 > 废止），
            # 次键 -code_scores（组内相关度倒序）。sort_by 在分页后另作用。
            all_rows.sort(key=lambda r: (_status_tier(r["status"]), -code_scores.get(r["code"], 0)))
        else:
            # query 为空：按 sort_by 决定基础排序
            if sort_by == "impl_date_desc":
                all_rows = conn.execute(
                    "SELECT * FROM standards "
                    "ORDER BY CASE WHEN impl_date='' THEN 1 ELSE 0 END, impl_date DESC"
                ).fetchall()
            elif sort_by == "impl_date_asc":
                all_rows = conn.execute(
                    "SELECT * FROM standards "
                    "ORDER BY CASE WHEN impl_date='' THEN 1 ELSE 0 END, impl_date ASC"
                ).fetchall()
            else:
                all_rows = conn.execute(
                    "SELECT * FROM standards ORDER BY pub_year DESC, code DESC"
                ).fetchall()

        # 分类统计（基于全部匹配结果）
        cat_counts = {"all": len(all_rows)}
        for key in ["national", "industry", "local", "group"]:
            cat_counts[key] = sum(1 for r in all_rows if r["category"] == key)

        # 分类过滤
        if category and category != "all":
            all_rows = [r for r in all_rows if r["category"] == category]

        # 状态统计
        status_counts = {}
        for r in all_rows:
            s = r["status"] or "未知"
            status_counts[s] = status_counts.get(s, 0) + 1

        # 状态过滤
        if status and status.strip():
            all_rows = [r for r in all_rows if r["status"] == status.strip()]

        # sort_by 应用（仅当 query 非空时；query 空时已在 SELECT 阶段排过）
        if query and query.strip() and sort_by in ("impl_date_desc", "impl_date_asc"):
            have = [r for r in all_rows if r["impl_date"]]
            none = [r for r in all_rows if not r["impl_date"]]
            have.sort(
                key=lambda r: r["impl_date"] or "",
                reverse=(sort_by == "impl_date_desc"),
            )
            all_rows = have + none

        total = len(all_rows)
        start = (page - 1) * page_size
        items = all_rows[start: start + page_size]

        # 注入 match_type（query 模式下）
        def _to_d(r):
            d = self._row_to_dict(r)
            if query and query.strip():
                mt = code_match_types.get(r["code"])
                if mt:
                    d["match_type"] = mt
            return d

        conn.close()
        return {
            "total": total, "page": page, "page_size": page_size,
            "categories": cat_counts, "status_counts": status_counts,
            "items": [_to_d(r) for r in items],
        }

    def get_standard_detail(self, code: str) -> dict:
        """⑩ 单条标准详情"""
        conn = self._get_conn()
        row = self._get_record(conn, code)
        if not row:
            conn.close()
            return {"error": f"未找到标准 {code}"}

        d = self._row_to_dict(row)
        relations = self.get_relations(row["code"])
        d["relation_count"] = relations.get("total_relations", 0)
        d["has_series"] = "series" in relations.get("relations", {})
        d["has_versions"] = "versions" in relations.get("relations", {})
        conn.close()
        return d

    def get_relations(self, code: str) -> dict:
        """⑨ 标准关系查询"""
        conn = self._get_conn()
        row = self._get_record(conn, code)
        if not row:
            conn.close()
            return {"error": f"未找到标准 {code}", "relations": {}}

        code = row["code"]
        relations = {}

        # 1. 系列标准
        sb = row["series_base"]
        if sb:
            siblings = conn.execute("""
                SELECT * FROM standards WHERE series_base=? AND code!=? LIMIT 20
            """, (sb, code)).fetchall()
            if siblings:
                relations["series"] = {
                    "label": "系列标准", "base": sb,
                    "items": [self._row_to_dict(r) for r in siblings],
                }

        # 2. 历史版本
        base_no_year = re.sub(r'-\d{4}$', '', code).strip()
        if base_no_year:
            versions = conn.execute("""
                SELECT * FROM standards
                WHERE code!=? AND code LIKE ? ORDER BY pub_year
                LIMIT 10
            """, (code, f"{base_no_year}-%")).fetchall()
            if versions:
                relations["versions"] = {
                    "label": "历史版本",
                    "items": [self._row_to_dict(r) for r in versions],
                }

        # 3. 相关标准（基于 FTS bigram 重叠）
        name_clean = row["name_clean"] or _clean_name(row["name"])
        if len(name_clean) >= 4:
            bigrams = [name_clean[i:i+2] for i in range(len(name_clean)-1)]
            # 取代表性 bigrams（最多10个）
            fts_query = " OR ".join(f'"{bg}"' for bg in bigrams[:10])
            try:
                # FTS4 的 fts.rank 是 NULL，ORDER BY rank 无效；LIMIT 30 太小会切掉
                # 高 Jaccard 候选（如 GB 4806 整族）。扩大候选池到 300，由 Python 端
                # Jaccard 阈值 + 排序决定最终 15 条相关标准。
                similar_rows = conn.execute("""
                    SELECT s.*, fts.rank as fts_rank
                    FROM standards_fts fts
                    JOIN standards s ON s.rowid = fts.rowid
                    WHERE standards_fts MATCH ? AND s.code != ?
                    LIMIT 300
                """, (fts_query, code)).fetchall()

                # 计算 Jaccard 相似度
                rec_bigrams = set(bigrams)
                similar = []
                for r in similar_rows:
                    other_clean = r["name_clean"] or _clean_name(r["name"])
                    other_bigrams = set(other_clean[i:i+2] for i in range(len(other_clean)-1))
                    union = rec_bigrams | other_bigrams
                    if union:
                        jaccard = len(rec_bigrams & other_bigrams) / len(union)
                        if jaccard > 0.15:
                            similar.append((r, jaccard))

                similar.sort(key=lambda x: -x[1])
                if similar:
                    relations["similar"] = {
                        "label": "相关标准",
                        "items": [self._row_to_dict(r) for r, _ in similar[:15]],
                    }
            except sqlite3.OperationalError:
                pass

        conn.close()
        return {
            "code": code, "name": row["name"],
            "total_relations": sum(len(v.get("items", [])) for v in relations.values()),
            "relations": relations,
        }

    # ───────────────────────────────────────────────────
    # 内部方法
    # ───────────────────────────────────────────────────

    def _get_record(self, conn: sqlite3.Connection, code: str):
        """按编号查找记录（支持模糊匹配）"""
        row = conn.execute("SELECT * FROM standards WHERE code=?", (code,)).fetchone()
        if row:
            return row
        # 模糊匹配
        code_norm = code.upper().replace(" ", "").replace("/", "")
        row = conn.execute("""
            SELECT * FROM standards
            WHERE REPLACE(REPLACE(REPLACE(UPPER(code),' ',''),'/',''),' ','') = ?
            LIMIT 1
        """, (code_norm,)).fetchone()
        return row

    def _match_industry(self, query: str) -> list[str]:
        """行业别名匹配"""
        matched = set()
        q = query.strip()
        for key, aliases in INDUSTRY_ALIAS_TABLE.items():
            for alias in aliases:
                if alias in q:
                    matched.add(key)
        if not matched:
            conn = self._get_conn()
            keys = conn.execute(
                "SELECT DISTINCT industry_key FROM industry_link WHERE industry_key LIKE ?",
                (f"%{q.lower()}%",)
            ).fetchall()
            conn.close()
            matched = {r[0] for r in keys}
        return list(matched)

    def _get_curated_standards(self, query: str, matched_keys: list) -> list[dict]:
        results = []
        seen_ids = set()
        for ind in self.industry_map.get("industries", []):
            for kw in ind.get("keywords", []):
                if kw in query:
                    if ind["id"] not in seen_ids:
                        seen_ids.add(ind["id"])
                        results.append({
                            "industry": ind["name"],
                            "mandatory": ind.get("mandatory_standards", []),
                            "recommended": ind.get("recommended_standards", []),
                            "testing": ind.get("testing_standards", []),
                        })
                    break
        for key in matched_keys:
            map_id = KEY_TO_MAP.get(key)
            if map_id and map_id not in seen_ids:
                seen_ids.add(map_id)
                for ind in self.industry_map.get("industries", []):
                    if ind["id"] == map_id:
                        results.append({
                            "industry": ind["name"],
                            "mandatory": ind.get("mandatory_standards", []),
                            "recommended": ind.get("recommended_standards", []),
                            "testing": ind.get("testing_standards", []),
                        })
                        break
        return results

    def _analyze_gaps(self, description, mandatory, search_results, industries):
        gaps = []
        for keyword, rule in GAP_RULES.items():
            if keyword in description:
                gaps.append({"trigger": keyword, "gap": rule["gap"], "severity": rule["severity"], "action": rule["action"]})

        found_types = set()
        for r in search_results:
            for tag in r.get("type_tags", []):
                found_types.add(tag)
        essential = {"safety", "testing", "product"}
        TYPE_NAMES = {"safety": "安全标准", "testing": "检测/试验方法标准", "product": "产品技术条件标准"}
        for t in essential - found_types:
            gaps.append({"trigger": f"缺少{TYPE_NAMES.get(t, t)}", "gap": f"未找到匹配的{TYPE_NAMES.get(t, t)}，可能需要补充",
                         "severity": "medium", "action": f"搜索该行业的{TYPE_NAMES.get(t, t)}"})
        return gaps

    # ───────────────────────────────────────────────────
    # bx_standards.db 双源 fallback 辅助方法
    # ───────────────────────────────────────────────────

    # bx 优先源最低分门槛：低于此分数视为弱命中，走 fallback 不截断 standards.db
    # 50 < 100（code partial × 1.0）也 < 30 × 1.5 = 45（纯 name 匹配现行最高分）
    # 即：只有 code 部分匹配或更强的命中才认账，纯 name LIKE 不足以截断长尾
    BX_MIN_SCORE_GATE = 50

    def _search_in_bx_db(self, query: str, limit: int) -> list[dict]:
        """
        优先源查询：bx_standards.db（精排 73K，含主流国标 + scope/fulltext）。
        约束：
          - bx_standards.db 无 FTS 表，仅做 code 变体 LIKE + name LIKE
          - bx_standards.db 同 code 可能重复，按 code dedup（取分数最高那条）
          - 评分含状态权重（废止/作废 ×0.1，现行 ×1.5）
          - 最高分 < BX_MIN_SCORE_GATE → 视为弱命中，返回空触发 fallback
        命中 0 或弱命中 → 返回空列表，调用方 fallback 到 standards.db。
        """
        if not os.path.exists(self.bx_db_path):
            return []

        q = query.strip()
        if not q:
            return []

        q_norm = q.upper().replace(" ", "").replace("/", "")
        q_variants = _code_search_variants(q_norm)

        bx_conn = sqlite3.connect(self.bx_db_path)
        bx_conn.row_factory = sqlite3.Row
        try:
            # 1. code 变体 LIKE
            code_like = " OR ".join(
                "REPLACE(REPLACE(UPPER(code),' ',''),'/','') LIKE ?"
                for _ in q_variants
            )
            code_rows = bx_conn.execute(
                f"SELECT * FROM standards WHERE ({code_like}) LIMIT ?",
                [f"%{v}%" for v in q_variants] + [limit * 3],
            ).fetchall()

            # 2. name LIKE 补漏（仅当 query 长度 ≥ 2）
            name_rows = []
            if len(q) >= 2:
                seen_codes = {r["code"] for r in code_rows}
                exclude_clause = (
                    f" AND code NOT IN ({','.join('?' * len(seen_codes))})"
                    if seen_codes else ""
                )
                name_rows = bx_conn.execute(
                    f"SELECT * FROM standards WHERE name LIKE ?{exclude_clause} LIMIT ?",
                    [f"%{q}%"] + list(seen_codes) + [limit * 2],
                ).fetchall()
        finally:
            bx_conn.close()

        # 评分 + dedup（按 code 取分数最高的一条）+ match_type
        scored: dict[str, tuple[float, sqlite3.Row, str]] = {}
        for r in list(code_rows) + list(name_rows):
            code = r["code"]
            code_clean = code.upper().replace(" ", "").replace("/", "")
            if any(v == code_clean for v in q_variants):
                base, mt = 200, "code_match"
            elif any(v in code_clean for v in q_variants):
                base, mt = 100, "code_match"
            else:
                if q.lower() in (r["name"] or "").lower():
                    base, mt = 30, "name_match"
                else:
                    base, mt = 10, "name_match"
            score = base * _status_weight(r["status"])
            prev = scored.get(code)
            if prev is None or score > prev[0]:
                scored[code] = (score, r, mt)

        if not scored:
            return []

        # 排序：主键 _status_tier（现行 > 即将实施 > 空 > 废止 严格分组），次键 -score
        sorted_items = sorted(
            scored.values(),
            key=lambda x: (_status_tier(x[1]["status"]), -x[0]),
        )[:limit]

        # 弱命中守门：最高分低于阈值 → 返回空触发 fallback，避免截断 standards.db 长尾
        if sorted_items[0][0] < self.BX_MIN_SCORE_GATE:
            return []

        out = []
        for score, r, mt in sorted_items:
            d = self._bx_row_to_dict(r, score)
            d["match_type"] = mt
            out.append(d)
        return out

    def _bx_row_to_dict(self, row, score: float = 0) -> dict:
        """bx_standards.db 行 → API 字典。schema 缺失字段填默认，保持 API 契约不变。"""
        name = row["name"] or ""
        parts = [p.strip() for p in re.split(r'\s{2,}', name) if p.strip()]
        pub_date = row["pub_date"] or ""
        pub_year = int(pub_date[:4]) if pub_date[:4].isdigit() else 0
        return {
            "code": row["code"],
            "name": name,
            "status": row["status"] or "",
            "pub_date": pub_date,
            "impl_date": row["impl_date"] or "",
            "type": "",
            "is_mandatory": False,
            "topics": parts,
            "type_tags": [],
            "series_base": "",
            "industry": "",
            "pub_year": pub_year,
            "_score": round(score, 2),
            "ics": row["ics"] or "",
            "ics_name": row["ics_name"] or "",
            "ccs": row["ccs"] or "",
            "ccs_name": "",
            "source": "",
            "publisher": "",
            "issuing_dept": "",
            "tc_committee": "",
            "drafting_org": "",
            "replaces": "",
            "adopted_intl": "",
            "obsolete_date": "",
            "name_en": "",
            "scope": (row["scope"] or "").strip(),  # bx 独有
        }

    def _row_to_dict(self, row, score: float = 0) -> dict:
        """sqlite3.Row → API 字典"""
        type_tags_str = row["type_tags"] if row["type_tags"] else ""
        type_tags = [t for t in type_tags_str.split(",") if t]

        # topics: 从名称提取
        name = row["name"] or ""
        parts = [p.strip() for p in re.split(r'\s{2,}', name) if p.strip()]

        return {
            "code": row["code"],
            "name": name,
            "status": row["status"] or "",
            "pub_date": row["pub_date"] or "",
            "impl_date": row["impl_date"] or "",
            "type": row["raw_type"] or "",
            "is_mandatory": bool(row["is_mandatory"]),
            "topics": parts,
            "type_tags": type_tags,
            "series_base": row["series_base"] or "",
            "industry": "",
            "pub_year": row["pub_year"] or 0,
            "_score": round(score, 2),
            # 分类字段
            "ics": row["ics_code"] or "",
            "ics_name": row["ics_name"] or "",
            "ccs": row["ccs"] or "",
            "ccs_name": row["ccs_name"] or "",
            "source": row["std_source"] or "",
            "publisher": row["publisher"] or "",
            # 发布主体
            "issuing_dept": row["issuing_dept"] or "",
            "tc_committee": row["tc_committee"] or "",
            "drafting_org": row["drafting_org"] or "",
            # 标准关系
            "replaces": row["replaces"] or "",
            "adopted_intl": row["adopted_intl"] or "",
            "obsolete_date": row["obsolete_date"] or "",
            # 国际化
            "name_en": row["name_en"] or "",
        }
