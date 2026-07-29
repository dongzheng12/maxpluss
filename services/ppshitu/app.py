"""
CLIP + RapidOCR 服务
Docker 容器部署，端口 8069
/recognize — CLIP 零样本品类识别（替代 PaddleClas）
/ocr — RapidOCR 文字提取（不变）
空闲 10 分钟自动释放模型实例
"""

import asyncio
import gc
import json
import logging
import os
import tempfile
import time

import numpy as np
from PIL import Image
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

log = logging.getLogger("clip-ocr")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

app = FastAPI(title="CLIP + RapidOCR Service", docs_url=None, redoc_url=None)

# ── 路径 ──
_script_dir = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(_script_dir, "models"))
TMP_DIR = "/app/tmp" if os.path.isdir("/app/tmp") else tempfile.gettempdir()

# ── CLIP 图像预处理常量（ViT-B/32）──
CLIP_SIZE = 224
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)

# ── 预计算数据（启动时加载，不释放）──
_text_embeddings = None   # type: np.ndarray | None
_labels = None            # type: list[str] | None
_logit_scale = 100.0


def _load_precomputed():
    global _text_embeddings, _labels, _logit_scale
    if _text_embeddings is not None:
        return
    _text_embeddings = np.load(os.path.join(MODEL_DIR, "text_embeddings.npy")).astype(np.float64)
    with open(os.path.join(MODEL_DIR, "labels.json"), "r", encoding="utf-8") as f:
        _labels = json.load(f)
    config_path = os.path.join(MODEL_DIR, "config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            _logit_scale = json.load(f).get("logit_scale", 100.0)
    log.info(f"预计算数据已加载: {len(_labels)} 个标签, logit_scale={_logit_scale:.1f}")


# ── 空闲管理 ──
_last_active = 0.0
IDLE_TIMEOUT = 0  # 禁用自动卸载，模型常驻内存（30G 服务器够用）


def _touch():
    global _last_active
    _last_active = time.time()


# ── CLIP 视觉编码器（延迟加载）──
_visual_session = None


def _get_visual_session():
    global _visual_session
    _touch()
    _load_precomputed()
    if _visual_session is None:
        import onnxruntime as ort
        model_path = os.path.join(MODEL_DIR, "clip_visual.onnx")
        log.info(f"加载 CLIP 视觉编码器: {model_path}")
        _visual_session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        log.info("CLIP 视觉编码器已加载")
    return _visual_session


# ── RapidOCR（延迟加载）──
_ocr_engine = None


def _get_ocr():
    global _ocr_engine
    _touch()
    if _ocr_engine is None:
        log.info("加载 RapidOCR...")
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
        log.info("RapidOCR 已加载")
    return _ocr_engine


def _release_models():
    global _visual_session, _ocr_engine
    released = []
    if _ocr_engine is not None:
        _ocr_engine = None
        released.append("RapidOCR")
    if _visual_session is not None:
        _visual_session = None
        released.append("CLIP")
    if released:
        gc.collect()
        log.info(f"[idle] 释放模型: {', '.join(released)}")


async def _idle_watcher():
    while True:
        await asyncio.sleep(60)
        if IDLE_TIMEOUT <= 0:
            continue  # 禁用自动卸载
        if _last_active > 0 and (time.time() - _last_active) > IDLE_TIMEOUT:
            if _ocr_engine is not None or _visual_session is not None:
                _release_models()


@app.on_event("startup")
async def startup():
    asyncio.create_task(_idle_watcher())


@app.get("/health")
def health():
    idle_sec = int(time.time() - _last_active) if _last_active > 0 else -1
    return {
        "status": "ok",
        "clip_loaded": _visual_session is not None,
        "ocr_loaded": _ocr_engine is not None,
        "idle_seconds": idle_sec,
    }


# ═══════════════════════════════════════
# 图像预处理
# ═══════════════════════════════════════

def _preprocess_image(image_path: str) -> np.ndarray:
    """CLIP ViT-B/32 标准预处理：resize → center crop → normalize → NCHW"""
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    # Resize：短边缩放到 224
    short = min(w, h)
    scale = CLIP_SIZE / short
    new_w, new_h = round(w * scale), round(h * scale)
    img = img.resize((new_w, new_h), Image.BICUBIC)
    # Center crop 224×224
    left = (new_w - CLIP_SIZE) // 2
    top = (new_h - CLIP_SIZE) // 2
    img = img.crop((left, top, left + CLIP_SIZE, top + CLIP_SIZE))
    # 归一化
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - CLIP_MEAN) / CLIP_STD
    return arr.transpose(2, 0, 1)[np.newaxis, :]  # HWC → 1CHW


# ═══════════════════════════════════════
# 端点1：CLIP 品类识别
# ═══════════════════════════════════════

@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    content = await file.read()
    if not content:
        return JSONResponse({"success": False, "labels": [], "error": "空文件"})

    suffix = ".jpg"
    fn = file.filename or ""
    if "." in fn:
        suffix = "." + fn.rsplit(".", 1)[-1].lower()

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=TMP_DIR) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        session = _get_visual_session()
        pixel_values = _preprocess_image(tmp_path)

        # 视觉编码
        image_embeds = session.run(None, {"pixel_values": pixel_values})[0]
        image_embeds = image_embeds / np.linalg.norm(image_embeds, axis=-1, keepdims=True)

        # 余弦相似度 → softmax
        similarity = (image_embeds.astype(np.float64) @ _text_embeddings.T)[0]
        logits = np.clip(similarity * _logit_scale, -100, 100)
        exp_logits = np.exp(logits - np.max(logits))
        probs = exp_logits / np.sum(exp_logits)

        # Top 3，过滤低置信度
        top_indices = np.argsort(probs)[::-1][:3]
        labels = []
        for idx in top_indices:
            score = float(probs[idx])
            if score < 0.01:
                break
            labels.append({"class_name": _labels[idx], "score": round(score, 4)})

        log.info(f"[recognize] labels={labels}")
        return {"success": True, "labels": labels, "error": None}

    except Exception as e:
        log.error(f"[recognize] error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "labels": [], "error": str(e)})
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        gc.collect()


# ═══════════════════════════════════════
# 端点2：RapidOCR 文字提取（不变）
# ═══════════════════════════════════════

@app.post("/ocr")
async def ocr(file: UploadFile = File(...)):
    content = await file.read()
    if not content:
        return JSONResponse({"success": False, "text": "", "error": "空文件"})

    suffix = ".jpg"
    fn = file.filename or ""
    if "." in fn:
        suffix = "." + fn.rsplit(".", 1)[-1].lower()

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=TMP_DIR) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        engine = _get_ocr()
        result, _ = engine(tmp_path)

        lines = []
        if result:
            for item in result:
                if item and len(item) >= 2:
                    lines.append(str(item[1]))

        text = "\n".join(lines)
        log.info(f"[ocr] extracted {len(text)} chars, {len(lines)} lines")
        return {"success": True, "text": text, "error": None}

    except Exception as e:
        log.error(f"[ocr] error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "text": "", "error": str(e)})
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        gc.collect()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8069, workers=1)
