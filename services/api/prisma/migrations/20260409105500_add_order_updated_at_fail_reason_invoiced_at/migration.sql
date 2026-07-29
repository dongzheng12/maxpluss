-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNo" TEXT NOT NULL,
    "userId" TEXT,
    "planId" TEXT,
    "productType" TEXT NOT NULL,
    "productRef" TEXT,
    "title" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "channel" TEXT,
    "receiptImage" TEXT,
    "invoiceStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "failedAt" DATETIME,
    "failReason" TEXT,
    "refundedAt" DATETIME,
    "refundReason" TEXT,
    "invoicedAt" DATETIME,
    CONSTRAINT "AppOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AppOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AppOrder" ("amount", "channel", "createdAt", "failedAt", "id", "invoiceStatus", "orderNo", "paidAt", "payloadJson", "planId", "productRef", "productType", "receiptImage", "refundReason", "refundedAt", "status", "title", "userId") SELECT "amount", "channel", "createdAt", "failedAt", "id", "invoiceStatus", "orderNo", "paidAt", "payloadJson", "planId", "productRef", "productType", "receiptImage", "refundReason", "refundedAt", "status", "title", "userId" FROM "AppOrder";
DROP TABLE "AppOrder";
ALTER TABLE "new_AppOrder" RENAME TO "AppOrder";
CREATE UNIQUE INDEX "AppOrder_orderNo_key" ON "AppOrder"("orderNo");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
