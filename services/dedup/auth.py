"""
内部鉴权 — HMAC-SHA256 签名校验
仅允许 Node.js 网关 (127.0.0.1) 调用
"""
import hashlib
import hmac
import os
import sys
import time

from fastapi import Request, HTTPException

# fail-fast：BXZ_INTERNAL_SECRET 是 bxz-api ↔ dedup 通信的 HMAC 密钥，缺失会让所有
# 比对/扫一扫调用 401。之前用 default "dev-secret-change-me" 静默 fallback 是
# 4-08 扫一扫事故的真凶（fallback 跟 bxz-api 端 secret 不一致 → HMAC 失败 →
# 用户看到比对失败但系统不报警）。
# service.py:18 已经在 import auth 之前调用 load_dotenv()，理论上 .env 已加载，
# 这里仍然 fail-fast 防止 .env 文件丢失/挂载失败的边角情况。
# docker run 同时挂 .env + -e 双保险，正常永远进不到这个分支。
INTERNAL_SECRET = os.environ.get("BXZ_INTERNAL_SECRET")
if not INTERNAL_SECRET:
    sys.stderr.write(
        "[FATAL] BXZ_INTERNAL_SECRET 未设置，拒绝启动。"
        "请检查 .env 文件 mount 或 docker run -e 是否正确。\n"
    )
    sys.exit(1)

MAX_TIMESTAMP_DRIFT = 1800  # 30 分钟容差（全异步比对任务可能长时间运行）


def verify_internal_request(request: Request) -> bool:
    """校验 X-Internal-Key 头的 HMAC 签名"""
    key_header = request.headers.get("X-Internal-Key", "")
    if not key_header:
        raise HTTPException(status_code=401, detail="missing X-Internal-Key")

    # 格式: timestamp:signature
    parts = key_header.split(":", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=401, detail="invalid key format")

    ts_str, signature = parts
    try:
        ts = int(ts_str)
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid timestamp")

    # 检查时间漂移
    now = int(time.time())
    if abs(now - ts) > MAX_TIMESTAMP_DRIFT:
        raise HTTPException(status_code=401, detail="timestamp expired")

    # 计算预期签名: HMAC-SHA256(secret, timestamp + path)
    path = request.url.path
    expected = hmac.new(
        INTERNAL_SECRET.encode(),
        f"{ts_str}:{path}".encode(),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=403, detail="signature mismatch")

    return True
