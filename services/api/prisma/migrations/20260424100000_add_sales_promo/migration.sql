-- AlterTable
ALTER TABLE "AppOrder" ADD COLUMN "salesCode" TEXT;

-- AlterTable
ALTER TABLE "AppUser" ADD COLUMN "salesCode" TEXT;

-- CreateTable
CREATE TABLE "SalesProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesCode" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "realName" TEXT NOT NULL,
    "companyName" TEXT,
    "avatar" TEXT,
    "bio" TEXT,
    "wechat" TEXT,
    "phone" TEXT,
    "qrcode" TEXT,
    "displayProducts" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ENABLED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesProfile_salesCode_key" ON "SalesProfile"("salesCode");

-- CreateIndex
CREATE UNIQUE INDEX "SalesProfile_userId_key" ON "SalesProfile"("userId");

-- CreateIndex
CREATE INDEX "SalesProfile_status_idx" ON "SalesProfile"("status");

-- CreateIndex
CREATE INDEX "AppOrder_salesCode_idx" ON "AppOrder"("salesCode");

-- CreateIndex
CREATE INDEX "AppUser_salesCode_idx" ON "AppUser"("salesCode");

