import Database from 'better-sqlite3'
import type { Client as PgClient } from 'pg'

export const ASIA_SHANGHAI_TZ = 'Asia/Shanghai'
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface TableConfig {
  table: string
  booleans?: string[]
  bigints?: string[]
  datetimes?: string[]
  autoincrementColumn?: string
}

export interface TimeSampleConfig {
  table: string
  keyColumns: string[]
  orderBy: string
  fields: string[]
}

export interface MigrationOptions {
  dryRun: boolean
  sampleLimit: number
  help: boolean
}

export const MIGRATIONS: TableConfig[] = [
  { table: 'MembershipPlan', datetimes: ['createdAt'] },
  { table: 'SystemSetting', datetimes: ['updatedAt'] },
  { table: 'Coupon', datetimes: ['validFrom', 'validTo', 'createdAt', 'updatedAt'] },
  { table: 'SalesInvite', datetimes: ['usedAt', 'expiresAt', 'createdAt', 'updatedAt'] },
  { table: 'ContentConfig', booleans: ['enabled'], datetimes: ['createdAt', 'updatedAt'] },

  { table: 'AppUser', datetimes: ['createdAt', 'firstScanAt', 'firstSearchAt', 'lastActiveAt'] },

  { table: 'UserMembership', datetimes: ['startAt', 'endAt', 'revokedAt', 'createdAt'] },
  {
    table: 'AppOrder',
    datetimes: ['createdAt', 'updatedAt', 'paidAt', 'failedAt', 'refundedAt', 'invoicedAt'],
  },
  { table: 'SalesProfile', booleans: ['contactVisible', 'companyVisible', 'isPublic'], datetimes: ['deletedAt', 'createdAt', 'updatedAt'] },
  { table: 'SalesGift', datetimes: ['expiresAt', 'claimedAt', 'revokedAt', 'createdAt'] },

  { table: 'SalesCode', datetimes: ['createdAt'] },
  { table: 'UserCoupon', datetimes: ['issuedAt', 'expiresAt', 'lockedAt', 'usedAt', 'revokedAt'] },
  { table: 'OrderDiscount', datetimes: ['computedAt', 'createdAt'] },

  { table: 'CompareTask', datetimes: ['fullReportUnlockedAt', 'exportUnlockedAt', 'stageStartedAt', 'createdAt', 'finishedAt'] },
  { table: 'Conversation', datetimes: ['createdAt', 'updatedAt'] },
  { table: 'ChatMessage', datetimes: ['createdAt'] },
  { table: 'ServiceBooking', datetimes: ['createdAt', 'updatedAt'] },
  { table: 'InvoiceRequest', datetimes: ['issuedAt', 'createdAt'] },
  { table: 'VerificationCode', datetimes: ['usedAt', 'expiresAt', 'createdAt'] },

  { table: 'UserLabel', booleans: ['isPaid'], datetimes: ['lastActiveAt', 'updatedAt'] },
  { table: 'SubscribeQuota', datetimes: ['updatedAt'] },
  { table: 'PushLog', datetimes: ['sentAt'] },
  { table: 'ReferralCode', datetimes: ['qrcodeUpdatedAt', 'createdAt'] },
  { table: 'Referral', datetimes: ['createdAt', 'registrationRewardedAt', 'paymentRewardedAt'] },
  { table: 'ScheduledPush', booleans: ['done'], datetimes: ['fireAt', 'createdAt'] },
  { table: 'Notification', datetimes: ['readAt', 'createdAt'] },

  { table: 'AnalyticsEvent', bigints: ['clientTs', 'serverTs'], datetimes: ['createdAt'], autoincrementColumn: 'id' },
]

export const CRITICAL_TIME_SAMPLES: TimeSampleConfig[] = [
  { table: 'AppOrder', keyColumns: ['orderNo'], orderBy: 'createdAt', fields: ['createdAt', 'paidAt', 'updatedAt'] },
  { table: 'UserMembership', keyColumns: ['id'], orderBy: 'createdAt', fields: ['startAt', 'endAt', 'createdAt'] },
  { table: 'CompareTask', keyColumns: ['taskNo'], orderBy: 'createdAt', fields: ['createdAt', 'finishedAt'] },
  { table: 'ChatMessage', keyColumns: ['id'], orderBy: 'createdAt', fields: ['createdAt'] },
  { table: 'ContentConfig', keyColumns: ['key'], orderBy: 'updatedAt', fields: ['updatedAt'] },
]

export function parseMigrationOptions(argv: string[]): MigrationOptions {
  let sampleLimit = 5
  for (const arg of argv) {
    if (arg.startsWith('--sample-limit=')) {
      const parsed = Number.parseInt(arg.split('=')[1] || '', 10)
      if (Number.isFinite(parsed) && parsed > 0) sampleLimit = parsed
    }
  }
  return {
    dryRun: argv.includes('--dry-run'),
    sampleLimit,
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

export function maskPgConnectionString(url: string): string {
  return url.replace(/:[^:@]+@/, ':***@')
}

export function sqliteTableExists(sqlite: Database.Database, table: string): boolean {
  const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { name: string } | undefined
  return Boolean(row?.name)
}

export function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function parseSqliteDateTimeAsShanghai(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === 'bigint' || typeof value === 'number') {
    const raw = Number(value)
    const epochMs = raw < 1e12 ? raw * 1000 : raw
    const direct = new Date(epochMs)
    if (Number.isNaN(direct.getTime())) {
      throw new Error(`时间戳 DateTime 无法解析: ${String(value)}`)
    }
    return direct
  }
  if (typeof value !== 'string') {
    throw new Error(`不支持的 DateTime 值类型: ${typeof value}`)
  }

  const input = value.trim()
  if (!input) {
    throw new Error('DateTime 字段为空字符串，无法按 Asia/Shanghai 解析')
  }

  const normalized = input.includes('T') ? input : input.replace(' ', 'T')
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(normalized)) {
    const direct = new Date(normalized)
    if (Number.isNaN(direct.getTime())) {
      throw new Error(`带时区的 DateTime 无法解析: ${value}`)
    }
    return direct
  }

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/,
  )
  if (!match) {
    throw new Error(`无时区 DateTime 格式无法识别: ${value}`)
  }

  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '0'] = match
  const millis = Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10)
  const utcMillis =
    Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
      millis,
    ) - SHANGHAI_OFFSET_MS

  return new Date(utcMillis)
}

export function normalizeDateTimeForPg(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return value as null | undefined
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number') {
    return parseSqliteDateTimeAsShanghai(value)
  }
  return value as Date
}

export function formatShanghaiDisplay(value: unknown): string | null {
  if (value === null || value === undefined) return null

  let date: Date
  if (value instanceof Date) {
    date = value
  } else if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number') {
    date = parseSqliteDateTimeAsShanghai(value)
  } else {
    throw new Error(`无法格式化的 DateTime 值类型: ${typeof value}`)
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ASIA_SHANGHAI_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${millis}`
}

export function transformSqliteRow(row: Record<string, unknown>, cfg: TableConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }

  if (cfg.booleans) {
    for (const col of cfg.booleans) {
      if (out[col] !== null && out[col] !== undefined) {
        out[col] = out[col] === 1 || out[col] === '1' || out[col] === true
      }
    }
  }

  if (cfg.bigints) {
    for (const col of cfg.bigints) {
      if (out[col] !== null && out[col] !== undefined) {
        out[col] = typeof out[col] === 'bigint' ? out[col] : BigInt(out[col] as string | number)
      }
    }
  }

  if (cfg.datetimes) {
    for (const col of cfg.datetimes) {
      out[col] = normalizeDateTimeForPg(out[col])
    }
  }

  return out
}

export async function fetchPgCount(pg: PgClient, table: string): Promise<number> {
  const result = await pg.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoteIdent(table)}`)
  return Number.parseInt(result.rows[0]?.count || '0', 10)
}

export async function collectTargetCounts(pg: PgClient, tables: TableConfig[]): Promise<Array<{ table: string; count: number }>> {
  const counts: Array<{ table: string; count: number }> = []
  for (const cfg of tables) {
    counts.push({ table: cfg.table, count: await fetchPgCount(pg, cfg.table) })
  }
  return counts
}

export function collectSqliteCounts(
  sqlite: Database.Database,
  tables: TableConfig[],
): Array<{ table: string; count: number }> {
  const counts: Array<{ table: string; count: number }> = []
  for (const cfg of tables) {
    if (!sqliteTableExists(sqlite, cfg.table)) continue
    const row = sqlite.prepare(`SELECT count(*) AS count FROM ${quoteIdent(cfg.table)}`).get() as {
      count: number | bigint
    }
    counts.push({ table: cfg.table, count: Number(row.count) })
  }
  return counts
}

export async function ensureTargetEmpty(pg: PgClient, tables: TableConfig[]): Promise<void> {
  const nonEmpty = await collectTargetCounts(pg, tables)
  const offenders = nonEmpty.filter((item) => item.count > 0)
  if (offenders.length === 0) return

  const details = offenders.map((item) => `${item.table}=${item.count}`).join(', ')
  throw new Error(`目标 PostgreSQL 不是空库。当前策略要求先清空/force-reset POC PG 后再导入。非空表: ${details}`)
}

export function previewShanghaiNormalization(
  sqlite: Database.Database,
  sampleLimit: number,
): Array<{ table: string; key: string; field: string; sqliteRaw: unknown; shanghaiDisplay: string | null }> {
  const previews: Array<{ table: string; key: string; field: string; sqliteRaw: unknown; shanghaiDisplay: string | null }> = []

  for (const sample of CRITICAL_TIME_SAMPLES) {
    if (!sqliteTableExists(sqlite, sample.table)) continue
    const selectCols = [...sample.keyColumns, ...sample.fields]
      .map((col) => quoteIdent(col))
      .join(', ')
    const rows = sqlite
      .prepare(
        `SELECT ${selectCols} FROM ${quoteIdent(sample.table)} ORDER BY ${quoteIdent(sample.orderBy)} DESC LIMIT ?`,
      )
      .all(sampleLimit) as Array<Record<string, unknown>>

    for (const row of rows) {
      const key = sample.keyColumns.map((col) => `${col}=${String(row[col])}`).join(', ')
      for (const field of sample.fields) {
        previews.push({
          table: sample.table,
          key,
          field,
          sqliteRaw: row[field],
          shanghaiDisplay: formatShanghaiDisplay(row[field]),
        })
      }
    }
  }

  return previews
}

export async function verifyCriticalDateTimes(
  sqlite: Database.Database,
  pg: PgClient,
  sampleLimit: number,
): Promise<Array<{
  table: string
  key: string
  field: string
  sqliteDisplay: string | null
  pgDisplay: string | null
  ok: boolean
}>> {
  const results: Array<{
    table: string
    key: string
    field: string
    sqliteDisplay: string | null
    pgDisplay: string | null
    ok: boolean
  }> = []

  for (const sample of CRITICAL_TIME_SAMPLES) {
    if (!sqliteTableExists(sqlite, sample.table)) continue

    const selectCols = [...sample.keyColumns, ...sample.fields]
      .map((col) => quoteIdent(col))
      .join(', ')
    const sqliteRows = sqlite
      .prepare(
        `SELECT ${selectCols} FROM ${quoteIdent(sample.table)} ORDER BY ${quoteIdent(sample.orderBy)} DESC LIMIT ?`,
      )
      .all(sampleLimit) as Array<Record<string, unknown>>

    for (const row of sqliteRows) {
      const whereSql = sample.keyColumns
        .map((col, idx) => `${quoteIdent(col)} = $${idx + 1}`)
        .join(' AND ')
      const whereValues = sample.keyColumns.map((col) => row[col])
      const pgRes = await pg.query<Record<string, unknown>>(
        `SELECT ${selectCols} FROM ${quoteIdent(sample.table)} WHERE ${whereSql} LIMIT 1`,
        whereValues,
      )
      const pgRow = pgRes.rows[0]
      const key = sample.keyColumns.map((col) => `${col}=${String(row[col])}`).join(', ')

      if (!pgRow) {
        for (const field of sample.fields) {
          results.push({
            table: sample.table,
            key,
            field,
            sqliteDisplay: formatShanghaiDisplay(row[field]),
            pgDisplay: null,
            ok: false,
          })
        }
        continue
      }

      for (const field of sample.fields) {
        const sqliteDisplay = formatShanghaiDisplay(row[field])
        const pgDisplay = formatShanghaiDisplay(pgRow[field])
        results.push({
          table: sample.table,
          key,
          field,
          sqliteDisplay,
          pgDisplay,
          ok: sqliteDisplay === pgDisplay,
        })
      }
    }
  }

  return results
}
