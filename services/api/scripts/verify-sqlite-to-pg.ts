#!/usr/bin/env tsx
/**
 * SQLite → PostgreSQL 迁移后校验脚本
 *
 * 用法:
 *   SQLITE_PATH=/tmp/dev.db.snapshot \
 *   DATABASE_URL='postgresql://bxz_poc:<pwd>@127.0.0.1:5433/bxz_poc' \
 *   pnpm tsx services/api/scripts/verify-sqlite-to-pg.ts [--sample-limit=5]
 *
 * 校验范围:
 *   1. 所有迁移表的 count 是否一致
 *   2. 关键 DateTime 字段在 Asia/Shanghai 展示口径下是否一致
 *
 * 说明:
 *   - 只读 SQLite / 只读 PG
 *   - 不修数据，不补写，不改 sequence
 */

import Database from 'better-sqlite3'
import { Client as PgClient } from 'pg'
import {
  MIGRATIONS,
  maskPgConnectionString,
  parseMigrationOptions,
  sqliteTableExists,
  verifyCriticalDateTimes,
} from './sqlite-pg-migration-shared.js'

const SQLITE_PATH = process.env.SQLITE_PATH
const DATABASE_URL = process.env.DATABASE_URL
const options = parseMigrationOptions(process.argv.slice(2))

if (options.help) {
  console.log(`用法:
  SQLITE_PATH=/tmp/dev.db.snapshot \\
  DATABASE_URL='postgresql://bxz_poc:<pwd>@127.0.0.1:5433/bxz_poc' \\
  pnpm tsx services/api/scripts/verify-sqlite-to-pg.ts [--sample-limit=5]

说明:
  - 只读校验 SQLite 与 PostgreSQL
  - 对比核心表 count
  - 抽样核对关键 DateTime 在 Asia/Shanghai 展示口径下是否一致
  - 不修改任何数据库`)
  process.exit(0)
}

if (!SQLITE_PATH) {
  console.error('❌ SQLITE_PATH env 缺失')
  process.exit(1)
}
if (!DATABASE_URL || !DATABASE_URL.startsWith('postgresql://')) {
  console.error('❌ DATABASE_URL env 缺失或不是 postgresql://')
  process.exit(1)
}

async function main() {
  console.log(`SQLite 源:  ${SQLITE_PATH}`)
  console.log(`PG 目标:    ${maskPgConnectionString(DATABASE_URL!)}`)
  console.log(`抽样数:     ${options.sampleLimit}`)
  console.log('')

  let sqlite: Database.Database
  try {
    sqlite = new Database(SQLITE_PATH!, { readonly: true, fileMustExist: true })
    sqlite.defaultSafeIntegers(true)
  } catch (e: any) {
    console.error(`❌ SQLite 打开失败: ${e.message}`)
    process.exit(2)
  }

  const pg = new PgClient({ connectionString: DATABASE_URL! })
  try {
    await pg.connect()
  } catch (e: any) {
    console.error(`❌ PG 连接失败: ${e.message}`)
    process.exit(3)
  }

  let hasMismatch = false

  console.log('=== Count 校验 ===')
  for (const cfg of MIGRATIONS) {
    if (!sqliteTableExists(sqlite, cfg.table)) {
      console.log(`[${cfg.table}] SQLite 不存在该表,跳过`)
      continue
    }

    const sqliteCount = Number(
      (sqlite.prepare(`SELECT count(*) AS count FROM "${cfg.table}"`).get() as { count: number | bigint }).count,
    )
    const pgResult = await pg.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${cfg.table}"`)
    const pgCount = Number.parseInt(pgResult.rows[0].count, 10)
    const ok = sqliteCount === pgCount
    if (!ok) hasMismatch = true
    console.log(
      `${cfg.table.padEnd(25)} sqlite=${String(sqliteCount).padStart(8)} pg=${String(pgCount).padStart(8)} ${ok ? '✅' : '❌'}`,
    )
  }

  console.log('\n=== 关键 DateTime 抽样校验（Asia/Shanghai） ===')
  const timeChecks = await verifyCriticalDateTimes(sqlite, pg, options.sampleLimit)
  for (const item of timeChecks) {
    if (!item.ok) hasMismatch = true
    console.log(
      `[${item.table}] ${item.key} ${item.field}: sqlite=${item.sqliteDisplay} pg=${item.pgDisplay} ${item.ok ? '✅' : '❌'}`,
    )
  }

  await pg.end()
  sqlite.close()

  if (hasMismatch) {
    console.error('\nFAIL: verify 失败，count 或关键 DateTime 存在不一致')
    process.exit(4)
  }

  console.log('\nPASS: verify 通过，count 与关键 DateTime 抽样全部一致')
}

main().catch((e) => {
  console.error('未预期错误:', e)
  process.exit(99)
})
