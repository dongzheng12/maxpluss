-- 给存量 SalesProfile 中 displayProducts 为空的记录补默认 4 个产品
-- code 对应 services/salesProducts.ts：xiaozhi / guan / bian / kong
UPDATE "SalesProfile"
SET "displayProducts" = '[{"code":"xiaozhi","sort":1},{"code":"guan","sort":2},{"code":"bian","sort":3},{"code":"kong","sort":4}]'
WHERE "displayProducts" IS NULL OR "displayProducts" = '' OR "displayProducts" = '[]';
