/**
 * 把 AppUser.id 从 `user-{phone}` 迁移到 cuid2。
 *
 * 用法：
 *   dry-run:  pnpm --filter bx-api exec tsx ../../scripts/migrate-user-ids.ts
 *   执行:     pnpm --filter bx-api exec tsx ../../scripts/migrate-user-ids.ts --execute
 *
 * 迁移前务必：cp services/api/prisma/dev.db services/api/prisma/dev.db.bak.pre-cuid
 *
 * 流程（仅 --execute 模式真写库）：
 *   1. PRAGMA foreign_keys = OFF  （SQLite 改主键需关 FK）
 *   2. BEGIN
 *   3. 每个 user- 开头的用户：先更新所有子表的 id 引用，再改 AppUser.id
 *   4. PRAGMA foreign_key_check（必须返回空，否则 ROLLBACK）
 *   5. COMMIT
 *   6. PRAGMA foreign_keys = ON
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'

// 所有存 AppUser.id 的字段（含 FK 字段 + 仅字符串列的逻辑引用）
// 脚本对每对 (oldId, newId) 跑：UPDATE "{table}" SET "{col}" = newId WHERE "{col}" = oldId
const USER_ID_REFS: Array<{ table: string; col: string }> = [
  // FK 列
  { table: 'UserMembership',   col: 'userId' },
  { table: 'AppOrder',         col: 'userId' },
  { table: 'ServiceBooking',   col: 'userId' },
  { table: 'InvoiceRequest',   col: 'userId' },
  { table: 'CompareTask',      col: 'userId' },
  { table: 'Conversation',     col: 'userId' },
  { table: 'UserLabel',        col: 'userId' },
  { table: 'Notification',     col: 'userId' },
  // 仅字符串列（无 FK 约束，但业务上就是 AppUser.id）
  { table: 'SceneRun',         col: 'userId' },
  { table: 'AnalyticsEvent',   col: 'userId' },
  { table: 'SubscribeQuota',   col: 'userId' },
  { table: 'PushLog',          col: 'userId' },
  { table: 'ReferralCode',     col: 'userId' },
  { table: 'ScheduledPush',    col: 'userId' },
  { table: 'Referral',         col: 'inviterId' },
  { table: 'Referral',         col: 'inviteeId' },
  // 管理员/销售/领取人 id 冗余列
  { table: 'UserMembership',   col: 'revokedBy' },
  { table: 'SalesGift',        col: 'createdBy' },
  { table: 'SalesGift',        col: 'claimedBy' },
  { table: 'SalesGift',        col: 'revokedBy' },
]

const EXECUTE = process.argv.includes('--execute')

// 强制 connection_limit=1，保证 PRAGMA 和后续语句在同一个 SQLite 连接上
const originalUrl = process.env.DATABASE_URL || 'file:./dev.db'
const urlWithLimit = originalUrl.includes('?')
  ? `${originalUrl}&connection_limit=1`
  : `${originalUrl}?connection_limit=1`

const prisma = new PrismaClient({
  datasources: { db: { url: urlWithLimit } },
  log: ['error', 'warn'],
})

async function countRefs(oldId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const { table, col } of USER_ID_REFS) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE "${col}" = ?`,
      oldId,
    )
    const n = Number(rows[0]?.n ?? 0)
    if (n > 0) counts[`${table}.${col}`] = n
  }
  return counts
}

async function main() {
  console.log(`[migrate-user-ids] mode = ${EXECUTE ? 'EXECUTE (WILL WRITE)' : 'DRY-RUN'}`)
  console.log(`[migrate-user-ids] DATABASE_URL = ${originalUrl}`)

  // 1. 找出所有 user- 开头的账号
  const users = await prisma.appUser.findMany({
    where: { id: { startsWith: 'user-' } },
    select: { id: true, phone: true },
  })
  console.log(`[migrate-user-ids] found ${users.length} users with legacy id`)
  if (users.length === 0) {
    console.log('[migrate-user-ids] nothing to do.')
    return
  }

  // 2. 生成 mapping
  const mapping = users.map((u) => ({
    oldId: u.id,
    newId: createId(),
    phone: u.phone,
  }))

  // 3. Dry-run 摘要
  console.log('\n[migrate-user-ids] sample mapping (first 3):')
  for (const m of mapping.slice(0, 3)) {
    console.log(`  ${m.oldId}  ->  ${m.newId}   (phone=${m.phone ?? 'null'})`)
    const refs = await countRefs(m.oldId)
    if (Object.keys(refs).length > 0) {
      for (const [k, v] of Object.entries(refs)) console.log(`      ${k}: ${v}`)
    } else {
      console.log('      (no child refs)')
    }
  }

  // 全量引用计数
  const totals: Record<string, number> = {}
  for (const m of mapping) {
    const refs = await countRefs(m.oldId)
    for (const [k, v] of Object.entries(refs)) totals[k] = (totals[k] ?? 0) + v
  }
  console.log('\n[migrate-user-ids] total child rows to update:')
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k}: ${v}`)
  console.log(`  AppUser.id: ${mapping.length}`)

  if (!EXECUTE) {
    console.log('\n[migrate-user-ids] dry-run finished. Re-run with --execute to apply.')
    return
  }

  // 4. 真正执行
  console.log('\n[migrate-user-ids] executing updates...')

  // PRAGMA 必须在事务之外
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  await prisma.$executeRawUnsafe('BEGIN')

  try {
    for (const m of mapping) {
      for (const { table, col } of USER_ID_REFS) {
        await prisma.$executeRawUnsafe(
          `UPDATE "${table}" SET "${col}" = ? WHERE "${col}" = ?`,
          m.newId,
          m.oldId,
        )
      }
      await prisma.$executeRawUnsafe(
        `UPDATE "AppUser" SET "id" = ? WHERE "id" = ?`,
        m.newId,
        m.oldId,
      )
    }

    // 完整性检查：foreign_key_check 必须返回空
    const fkViolations = await prisma.$queryRawUnsafe<Array<unknown>>('PRAGMA foreign_key_check')
    if (fkViolations.length > 0) {
      console.error('[migrate-user-ids] FK check failed:', fkViolations)
      throw new Error('FK check returned violations; rolling back')
    }

    await prisma.$executeRawUnsafe('COMMIT')
    console.log(`[migrate-user-ids] COMMIT ok. migrated ${mapping.length} users.`)
  } catch (e) {
    await prisma.$executeRawUnsafe('ROLLBACK')
    console.error('[migrate-user-ids] ROLLBACK due to error:', e)
    throw e
  } finally {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  }

  // 5. 事后复核
  const remaining = await prisma.appUser.count({ where: { id: { startsWith: 'user-' } } })
  console.log(`[migrate-user-ids] post-check: AppUser rows still starting with 'user-' = ${remaining}`)
  if (remaining > 0) {
    console.error('[migrate-user-ids] WARNING: some legacy ids remain, please investigate.')
    process.exit(2)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
