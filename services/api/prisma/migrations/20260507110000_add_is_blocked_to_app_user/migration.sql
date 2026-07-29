-- 用户启用/禁用：管理员可以禁用恶意/违规用户的登录
-- requireAuth 中间件命中 isBlocked=true 时直接返回 403（admin role 用户豁免）
ALTER TABLE "AppUser" ADD COLUMN "isBlocked" BOOLEAN NOT NULL DEFAULT FALSE;
