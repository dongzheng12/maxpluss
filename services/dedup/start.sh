#!/bin/bash
source /opt/biaozhunxiaozhi/services/dedup/.venv/bin/activate
# BXZ_DB_PATH 指向 tmpfs 内存路径（运行时解密产物）
export BXZ_DB_PATH="/opt/biaozhunxiaozhi/data/dedup/ram/bx_standards.db"
cd /opt/biaozhunxiaozhi/services
exec uvicorn dedup.service:app --host 127.0.0.1 --port 8067 --workers 2
