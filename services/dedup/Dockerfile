FROM python:3.9-slim

# 时区基线：固定为北京时间。
# python:3.9-slim base image 自带 /usr/share/zoneinfo/Asia/Shanghai。
# 影响：Python datetime.now() / time.localtime() / logging timestamp 跟随北京时间。
# 注意：仅 ENV TZ 不够，base image 的 /etc/localtime 默认 UTC（C 标准库 localtime() 走
# /etc/localtime 不读 env），必须 symlink + 写 /etc/timezone。
# 生产 docker run 仍然显式 -e TZ=Asia/Shanghai 三重保险（Dockerfile env + symlink + run-time env）。
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo Asia/Shanghai > /etc/timezone

# 系统依赖（pyzbar 需要 libzbar，opencv 需要 libgl）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libzbar0 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制 Python 源码 + 扩展品牌库 + 自检脚本
COPY __init__.py auth.py compare.py report.py service.py jobs.py ./dedup/
COPY brand_category_extended.json ./dedup/
COPY preflight_check_ci.py test_dedup_regression.py ./dedup/

# ── 构建门禁：自检 + 回归测试，任一失败则构建中止 ──
RUN python dedup/preflight_check_ci.py || { echo "❌ Dedup preflight FAILED — build aborted"; exit 1; }
RUN python dedup/test_dedup_regression.py || { echo "❌ Dedup regression FAILED — build aborted"; exit 1; }

# 测试通过后删除测试脚本（不进生产镜像）
RUN rm -f dedup/preflight_check_ci.py dedup/test_dedup_regression.py

# 记录核心 .py 的 md5 到 BUILD_INFO.txt（deploy-dedup.sh 构建后校验用）
# 目的：防止 buildx cache 命中导致镜像里是旧源码（2026-04-21 踩坑）
RUN cd /app/dedup && md5sum *.py | sort > /app/BUILD_INFO.txt && cat /app/BUILD_INFO.txt

# 编译为 .pyc 并删除 .py 源码
RUN python -m compileall -b dedup/ && \
    find dedup/ -name "*.py" -delete

EXPOSE 8067

# 多 worker 部署：单 worker 串行处理是 1对1 / 全库比对队列堵塞的根因。
# 2 worker prefork 模式让 PyMuPDF 提取 + PaddleOCR + MinHash 比对真并行。
# 内存评估见 必读/MEMORY.md 2026-04-09 dedup 并发化 section：
# 单 worker idle 1.3 GB / OCR 峰值 2.7 GB；2 worker 最坏 5.4 GB，
# 服务器 30 G 总内存 / 16 G available，余地充足。
# 后续观察稳定 1-2 天后可考虑升级到 3 worker。
CMD ["uvicorn", "dedup.service:app", "--host", "0.0.0.0", "--port", "8067", "--workers", "2"]
