-- SalesProfile 加 wxScheme（微信 URL Scheme 缓存，永久有效，lazily 生成）
-- 首次访问公开落地页时后端调 generateScheme API 写入，后续直接复用
ALTER TABLE "SalesProfile" ADD COLUMN "wxScheme" TEXT;
