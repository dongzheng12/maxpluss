#!/usr/bin/env tsx
/**
 * SQLite → PostgreSQL 数据迁移脚本(POC 用)
 *
 * 用法:
 *   SQLITE_PATH=/tmp/dev.db.snapshot \
 *   DATABASE_URL='postgresql://bxz_poc:<pwd>@127.0.0.1:5433/bxz_poc' \
 *   pnpm tsx services/api/scripts/migrate-sqlite-to-pg.ts [--dry-run] [--sample-limit=5]
 *
 * 设计原则:
 *   - 只读 SQLite,只写 PG。任何一边出错立刻退出
 *   - 历史 DateTime 一律按 Asia/Shanghai 业务口径解释，不按 UTC 猜测
 *   - 默认要求目标 PG 为空库；不做幂等 upsert，避免静默覆盖脏数据
 *   - dry-run 只做前置检查 / 目标空库检查 / 上海时间归一化预览，不写 PG
 *   - 每表完成后立即校验 count 一致
 *   - 迁移完成后抽样校验关键 DateTime 展示值：SQLite vs PG(Asia/Shanghai) 必须一致
 *   - autoincrement 表(AnalyticsEvent)迁完后 setval('"X_id_seq"', max(id))
 *   - 全局 transaction: 不做；逐表提交，失败后由空库重置 + 重跑处理
 *
 * 不做的事:
 *   - 不动生产 SQLite(只读 snapshot 副本)
 *   - 不写 PG schema(假定 schema.poc.prisma 已 db push 过)
 *   - 不重启容器
 *
 * 前置:
 *   1. SQLite snapshot 副本就位(从生产 cp 出来)
 *   2. PG schema 已建(prisma db push --schema=schema.poc.prisma --force-reset)
 *   3. POC API 容器停掉(避免 ensureAppSeed 与迁移争抢)
 *   4. 目标 PG 已 force-reset / 确认为空库
 *
 * 退出码:
 *   0 成功
 *   1 环境变量缺失
 *   2 SQLite 打不开
 *   3 PG 连不上
 *   4 表迁移失败
 *   5 校验失败(count mismatch)
 *   6 目标 PG 非空，拒绝导入
 *   7 关键 DateTime 抽样校验失败
 */

import Database from 'better-sqlite3'
import { Client as PgClient } from 'pg'
import {
  MIGRATIONS,
  collectSqliteCounts,
  collectTargetCounts,
  ensureTargetEmpty,
  maskPgConnectionString,
  parseMigrationOptions,
  previewShanghaiNormalization,
  sqliteTableExists,
  transformSqliteRow,
  verifyCriticalDateTimes,
} from './sqlite-pg-migration-shared.js'

const SQLITE_PATH = process.env.SQLITE_PATH
const DATABASE_URL = process.env.DATABASE_URL
const options = parseMigrationOptions(process.argv.slice(2))

if (options.help) {
  console.log(`用法:
  SQLITE_PATH=/tmp/dev.db.snapshot \\
  DATABASE_URL='postgresql://bxz_poc:<pwd>@127.0.0.1:5433/bxz_poc' \\
  pnpm tsx services/api/scripts/migrate-sqlite-to-pg.ts [--dry-run] [--sample-limit=5]

说明:
  --dry-run         只检查 SQLite / PG 连通性、目标库当前行数、核心表 count 预览、时间归一化样例
  --sample-limit=N  控制 dry-run 与迁后校验的时间抽样数量，默认 5

导入策略:
  - 当前脚本只支持“空库导入”
  - 不做幂等 upsert
  - 不在脚本内 force-reset PG
  - 正式导入前请先手动 force-reset POC PG，再运行本脚本`)
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

async function migrateOne(
  sqlite: Database.Database,
  pg: PgClient,
  cfg: (typeof MIGRATIONS)[number],
): Promise<{ table: string; sqliteCount: number; pgCount: number }> {
  const { table } = cfg
  const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>
  console.log(`[${table}] SQLite: ${rows.length} 行`)

  if (rows.length === 0) {
    return { table, sqliteCount: 0, pgCount: 0 }
  }

  const transformed = rows.map((row) => transformSqliteRow(row, cfg))
  const columns = Object.keys(transformed[0])
  const colsSql = columns.map((col) => `"${col}"`).join(', ')

  const BATCH = 500
  let inserted = 0
  for (let i = 0; i < transformed.length; i += BATCH) {
    const batch = transformed.slice(i, i + BATCH)
    const placeholders = batch
      .map((_, rowIndex) => `(${columns.map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`).join(', ')})`)
      .join(', ')
    const values = batch.flatMap((row) => columns.map((col) => row[col]))

    await pg.query(`INSERT INTO "${table}" (${colsSql}) VALUES ${placeholders}`, values)
    inserted += batch.length
    if (transformed.length > BATCH) {
      console.log(`[${table}]   写入 ${inserted}/${transformed.length}`)
    }
  }

  if (cfg.autoincrementColumn) {
    const seqName = `${table}_${cfg.autoincrementColumn}_seq`
    await pg.query(
      `SELECT setval('"${seqName}"', COALESCE((SELECT MAX("${cfg.autoincrementColumn}") FROM "${table}"), 1))`,
    )
    console.log(`[${table}]   setval ${seqName} ✓`)
  }

  const result = await pg.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`)
  const pgCount = Number.parseInt(result.rows[0].count, 10)
  if (pgCount !== rows.length) {
    throw new Error(`[${table}] count mismatch: SQLite=${rows.length} PG=${pgCount}`)
  }

  console.log(`[${table}] ✅ ${rows.length} → ${pgCount}`)
  return { table, sqliteCount: rows.length, pgCount }
}

function printTargetCounts(title: string, counts: Array<{ table: string; count: number }>) {
  console.log(`\n=== ${title} ===`)
  for (const item of counts) {
    console.log(`${item.table.padEnd(25)} ${String(item.count).padStart(8)}`)
  }
}

async function main() {
  console.log(`SQLite 源:  ${SQLITE_PATH}`)
  console.log(`PG 目标:    ${maskPgConnectionString(DATABASE_URL!)}`)
  console.log(`模式:       ${options.dryRun ? 'dry-run' : 'write'}`)
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

  try {
    const sqliteCounts = collectSqliteCounts(sqlite, MIGRATIONS)
    printTargetCounts('源 SQLite 核心表行数预览', sqliteCounts)

    const targetCounts = await collectTargetCounts(pg, MIGRATIONS)
    printTargetCounts('目标 PG 当前行数', targetCounts)

    if (options.dryRun) {
      const nonEmpty = targetCounts.filter((item) => item.count > 0)
      if (nonEmpty.length > 0) {
        console.log('\n⚠️ dry-run 风险提示：目标 PG 当前不是空库')
        for (const item of nonEmpty) {
          console.log(`- ${item.table}: ${item.count}`)
        }
      }

      const previews = previewShanghaiNormalization(sqlite, options.sampleLimit)
      console.log('\n=== dry-run: 上海时间归一化预览 ===')
      for (const item of previews) {
        console.log(
          `[${item.table}] ${item.key} ${item.field}: raw=${String(item.sqliteRaw)} -> shanghai=${item.shanghaiDisplay}`,
        )
      }
      console.log('\n✅ dry-run 完成（PASS，未写 PostgreSQL）')
      await pg.end()
      sqlite.close()
      return
    }

    try {
      await ensureTargetEmpty(pg, MIGRATIONS)
    } catch (e: any) {
      console.error(`❌ ${e.message}`)
      await pg.end()
      sqlite.close()
      process.exit(6)
    }

    const summary: Array<{ table: string; sqliteCount: number; pgCount: number }> = []
    for (const cfg of MIGRATIONS) {
      if (!sqliteTableExists(sqlite, cfg.table)) {
        console.log(`[${cfg.table}] SQLite 不存在该表,跳过`)
        continue
      }
      const result = await migrateOne(sqlite, pg, cfg)
      summary.push(result)
    }

    console.log('\n=== 迁移总结 ===')
    console.log('表'.padEnd(25), 'SQLite'.padStart(10), 'PG'.padStart(10), '状态')
    console.log('-'.repeat(60))
    let allOk = true
    for (const item of summary) {
      const ok = item.sqliteCount === item.pgCount
      if (!ok) allOk = false
      console.log(
        item.table.padEnd(25),
        String(item.sqliteCount).padStart(10),
        String(item.pgCount).padStart(10),
        ok ? '✅' : '❌',
      )
    }
    console.log('-'.repeat(60))

    if (!allOk) {
      console.error('\n❌ 有表 count mismatch,迁移未完整')
      await pg.end()
      sqlite.close()
      process.exit(5)
    }

    const timeChecks = await verifyCriticalDateTimes(sqlite, pg, options.sampleLimit)
    const mismatches = timeChecks.filter((item) => !item.ok)
    console.log('\n=== 关键 DateTime 抽样校验（Asia/Shanghai） ===')
    for (const item of timeChecks) {
      console.log(
        `[${item.table}] ${item.key} ${item.field}: sqlite=${item.sqliteDisplay} pg=${item.pgDisplay} ${item.ok ? '✅' : '❌'}`,
      )
    }

    await pg.end()
    sqlite.close()

    if (mismatches.length > 0) {
      console.error('\n❌ 关键 DateTime 抽样校验失败：SQLite 业务展示时间与 PG Asia/Shanghai 展示值不一致')
      process.exit(7)
    }

    console.log('\n✅ 全部表迁移成功 + count 一致 + 关键 DateTime 抽样校验通过')
  } catch (e: any) {
    console.error(`\n❌ 迁移失败: ${e.message}\n`)
    console.error(e.stack)
    await pg.end()
    sqlite.close()
    process.exit(4)
  }
}

main().catch((e) => {
  console.error('未预期错误:', e)
  process.exit(99)
})
