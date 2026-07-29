-- UserMembership: 加销售归因字段（source=SALES_REFERRAL 时记录来源销售码）
ALTER TABLE "UserMembership" ADD COLUMN "salesCode" TEXT;
