"""
CLIP 模型导出脚本（本地运行一次）

导出 ONNX 视觉编码器 + 预计算全部标签的文本嵌入
运行后生成 models/ 目录，Docker build 时直接 COPY 进镜像

使用方法:
  cd services/ppshitu
  pip install torch transformers numpy
  python export_clip.py
"""

import json
import os
import sys

import numpy as np
import torch
from transformers import CLIPModel, CLIPTokenizer

MODEL_NAME = "openai/clip-vit-base-patch32"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# ═══ 品类标签定义（超市场景优先）═══════════════════════════════════════════════
# (英文 CLIP prompt, 中文标签 — 作为 class_name 返回给 dedup 搜索)
# 89 → 118 标签，超市品类大幅扩充，建材精简
LABELS = [
    # ── 食品（30）──
    ("a bottle of milk", "牛奶"),
    ("a carton of yogurt", "酸奶"),
    ("a box of cheese", "奶酪"),
    ("a bottle of cooking oil", "食用油"),
    ("a bag of rice", "大米"),
    ("a bag of flour", "面粉"),
    ("a package of dried noodles", "挂面"),
    ("a package of instant noodles", "方便面"),
    ("a package of frozen dumplings", "冷冻食品"),
    ("a tin can of food", "罐头"),
    ("a package of sausage", "火腿肠"),
    ("a package of bread", "面包"),
    ("a package of cookies", "饼干"),
    ("a bag of potato chips", "薯片"),
    ("a chocolate bar", "巧克力"),
    ("a package of candy", "糖果"),
    ("a bag of nuts", "坚果"),
    ("a bag of dried fruit", "蜜饯果干"),
    ("a jar of honey", "蜂蜜"),
    ("a carton of eggs", "鸡蛋"),
    ("a package of tofu", "豆制品"),
    ("a bottle of soy sauce", "酱油"),
    ("a bottle of vinegar", "食醋"),
    ("a bottle of oyster sauce", "蚝油"),
    ("a bottle of chili sauce", "辣椒酱"),
    ("a bottle of sesame oil", "芝麻油"),
    ("a bottle of seasoning", "调味品"),
    ("a bag of salt", "食盐"),
    ("a bag of sugar", "白砂糖"),
    ("a bag of monosodium glutamate seasoning", "味精鸡精"),

    # ── 饮料（12）──
    ("a bottle of mineral water", "矿泉水"),
    ("a bottle of drinking water", "饮用水"),
    ("a can of soda", "碳酸饮料"),
    ("a bottle of fruit juice", "果汁"),
    ("a box of tea beverage", "茶饮料"),
    ("a bottle of functional sports drink", "功能饮料"),
    ("a cup of milk tea", "奶茶"),
    ("a box of tea", "茶叶"),
    ("a jar of coffee", "咖啡"),
    ("a bottle of plant protein drink like soy milk", "植物蛋白饮料"),
    ("a box of coconut water", "椰汁"),
    ("a carton of oat milk", "燕麦奶"),

    # ── 日化（15）──
    ("a bottle of shampoo", "洗发水"),
    ("a bottle of hair conditioner", "护发素"),
    ("a bottle of body wash", "沐浴露"),
    ("a bar of soap", "香皂"),
    ("a tube of toothpaste", "牙膏"),
    ("a toothbrush", "牙刷"),
    ("a bottle of mouthwash", "漱口水"),
    ("a bottle of laundry detergent", "洗衣液"),
    ("a box of laundry pods", "洗衣凝珠"),
    ("a bottle of dish soap", "洗洁精"),
    ("a bottle of toilet cleaner", "洁厕剂"),
    ("a package of facial tissue", "纸巾"),
    ("a roll of toilet paper", "卫生纸"),
    ("a package of wet wipes", "湿巾"),
    ("a package of sanitary pads", "卫生巾"),

    # ── 母婴（8）──
    ("a can of infant formula milk powder", "婴幼儿配方奶粉"),
    ("a bag of infant formula", "奶粉"),
    ("a package of baby diapers", "纸尿裤"),
    ("a baby feeding bottle", "奶瓶"),
    ("a jar of baby food puree", "婴儿辅食"),
    ("children's clothing", "童装"),
    ("a children's toy", "玩具"),
    ("a child safety seat", "儿童安全座椅"),

    # ── 个护（10）──
    ("a bottle of face cream moisturizer", "面霜"),
    ("a facial sheet mask", "面膜"),
    ("a bottle of sunscreen", "防晒霜"),
    ("a bottle of body lotion", "身体乳"),
    ("a lipstick", "口红"),
    ("a bottle of hand cream", "护手霜"),
    ("a bottle of perfume", "香水"),
    ("a razor shaving kit", "剃须刀"),
    ("a bottle of hand sanitizer gel", "免洗洗手液"),
    ("a bottle of contact lens solution", "隐形眼镜护理液"),

    # ── 生鲜（12）──
    ("fresh apples on a shelf", "水果"),
    ("fresh bananas", "香蕉"),
    ("fresh oranges", "橙子"),
    ("fresh grapes", "葡萄"),
    ("fresh vegetables", "蔬菜"),
    ("fresh raw meat", "肉类"),
    ("fresh raw pork", "猪肉"),
    ("fresh raw beef", "牛肉"),
    ("fresh raw chicken", "鸡肉"),
    ("fresh fish and seafood", "水产海鲜"),
    ("fresh shrimp", "虾"),
    ("frozen seafood package", "冻品"),

    # ── 酒类（4）──
    ("a can of beer", "啤酒"),
    ("a bottle of wine", "葡萄酒"),
    ("a bottle of baijiu Chinese liquor", "白酒"),
    ("a bottle of rice wine", "黄酒"),

    # ── 家电（精简 7）──
    ("a thermos bottle", "保温杯"),
    ("a rice cooker", "电饭煲"),
    ("an electric kettle", "电热水壶"),
    ("a cooking pot", "炊具"),
    ("a vacuum cleaner", "吸尘器"),
    ("a refrigerator", "冰箱"),
    ("a washing machine", "洗衣机"),

    # ── 电子（精简 5）──
    ("a smartphone", "手机"),
    ("a pair of headphones", "耳机"),
    ("a portable power bank", "移动电源"),
    ("a battery", "电池"),
    ("an LED light bulb", "LED灯"),

    # ── 建材（精简 5）──
    ("a can of paint", "涂料"),
    ("an electric wire", "电线"),
    ("a water faucet", "水龙头"),
    ("a ceramic tile", "瓷砖"),
    ("a bathroom sanitary fixture", "卫浴洁具"),

    # ── 医疗健康（4）──
    ("a surgical face mask", "口罩"),
    ("a box of medicine", "药品"),
    ("a thermometer", "体温计"),
    ("a bottle of hand sanitizer disinfectant", "消毒液"),

    # ── 服装（精简 3）──
    ("a piece of clothing", "服装"),
    ("a pair of shoes", "鞋"),
    ("a towel", "毛巾"),

    # ── 汽车（3）──
    ("a car tire", "轮胎"),
    ("a bottle of motor oil", "润滑油"),
    ("a bottle of windshield washer fluid", "玻璃水"),
]


class _VisualEncoder(torch.nn.Module):
    """将 vision_model + visual_projection 合并为单一 ONNX 模型"""

    def __init__(self, clip_model):
        super().__init__()
        self.vision_model = clip_model.vision_model
        self.visual_projection = clip_model.visual_projection

    def forward(self, pixel_values):
        vision_outputs = self.vision_model(pixel_values=pixel_values)
        return self.visual_projection(vision_outputs.pooler_output)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"[1/4] 下载 CLIP 模型: {MODEL_NAME}")
    model = CLIPModel.from_pretrained(MODEL_NAME)
    tokenizer = CLIPTokenizer.from_pretrained(MODEL_NAME)
    model.eval()

    # ── 导出视觉编码器 ──
    print("[2/4] 导出视觉编码器 → clip_visual.onnx")
    visual_encoder = _VisualEncoder(model)
    visual_encoder.eval()

    dummy = torch.randn(1, 3, 224, 224)
    onnx_path = os.path.join(OUTPUT_DIR, "clip_visual.onnx")
    torch.onnx.export(
        visual_encoder,
        dummy,
        onnx_path,
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        dynamic_axes={
            "pixel_values": {0: "batch"},
            "image_embeds": {0: "batch"},
        },
        opset_version=14,
    )

    # ── 预计算文本嵌入 ──
    print(f"[3/4] 预计算 {len(LABELS)} 个标签的文本嵌入")
    prompts = [en for en, _ in LABELS]
    inputs = tokenizer(prompts, padding=True, return_tensors="pt")

    with torch.no_grad():
        text_outputs = model.text_model(
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
        )
        text_embeds = model.text_projection(text_outputs.pooler_output)
        text_embeds = text_embeds / text_embeds.norm(dim=-1, keepdim=True)

    np.save(os.path.join(OUTPUT_DIR, "text_embeddings.npy"), text_embeds.numpy())

    # ── 保存标签和配置 ──
    labels_cn = [cn for _, cn in LABELS]
    with open(os.path.join(OUTPUT_DIR, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(labels_cn, f, ensure_ascii=False, indent=2)

    logit_scale = model.logit_scale.exp().item()
    with open(os.path.join(OUTPUT_DIR, "config.json"), "w") as f:
        json.dump({"logit_scale": logit_scale}, f)

    # ── 汇总 ──
    onnx_size = os.path.getsize(onnx_path) / 1024 / 1024
    print(f"[4/4] 导出完成 → {OUTPUT_DIR}/")
    print(f"  clip_visual.onnx : {onnx_size:.1f} MB")
    print(f"  text_embeddings.npy : {len(labels_cn)} 个标签")
    print(f"  logit_scale : {logit_scale:.2f}")
    print()
    print("下一步: docker buildx build --platform linux/amd64 -t bxz-shitu:latest --load .")


if __name__ == "__main__":
    main()
