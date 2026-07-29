-- 删除 StandardExecutionAttachment 多态字段的 FK 约束
-- 该 FK 仅当 bizType='SUBMISSION' 时合法，'SOURCE' / 'PACKAGE' 时 bizId 指向其他父表会触发约束违反
-- 改由路由层在写入前自行校验 bizId 在对应父表存在（按 bizType 分支查询）
-- 详见 必读/standard-execution-开工指令-v1.md §六.Attachment

ALTER TABLE "StandardExecutionAttachment" DROP CONSTRAINT IF EXISTS "submission_attachment";
