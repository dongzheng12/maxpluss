#!/bin/bash
source /mnt/datadisk0/ppshitu/venv/bin/activate
cd /mnt/datadisk0/ppshitu
exec uvicorn app:app --host 127.0.0.1 --port 8069 --workers 1
