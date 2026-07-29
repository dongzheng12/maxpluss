FROM python:3.9-slim

WORKDIR /app

# 系统依赖（opencv/rapidocr 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（不再需要 paddlepaddle / paddleclas）
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    onnxruntime \
    rapidocr-onnxruntime \
    numpy \
    Pillow \
    fastapi==0.128.8 \
    uvicorn==0.39.0 \
    python-multipart==0.0.20

COPY app.py .
# models/ 由本地 export_clip.py 生成，包含 clip_visual.onnx + text_embeddings.npy + labels.json + config.json
COPY models/ /app/models/

RUN mkdir -p /app/tmp

EXPOSE 8069

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8069", "--workers", "1"]
