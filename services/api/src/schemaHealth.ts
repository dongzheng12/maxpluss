import type { PrismaClient } from '@prisma/client'

type RuntimeField = {
  name: string
  dbName?: string | null
  kind?: string
  relationName?: string | null
}

type RuntimeModel = {
  name?: string
  dbName?: string | null
  fields?: RuntimeField[]
}

type ExpectedColumn = {
  model: string
  field: string
  table: string
  column: string
}

type ActualColumns = Map<string, Set<string>>

export type SchemaHealthReport = {
  ok: boolean
  provider: string
  checkedAt: string
  expectedTables: number
  expectedColumns: number
  actualTables: number
  actualColumns: number
  missingTableCount: number
  missingColumnCount: number
  missingTables: string[]
  missingColumns: ExpectedColumn[]
  truncated: boolean
  error?: string
}

const MAX_DETAILS = 80

export async function checkPrismaSchemaHealth(prisma: PrismaClient): Promise<SchemaHealthReport> {
  const checkedAt = new Date().toISOString()

  try {
    const expectedColumns = getExpectedColumns(prisma)
    const provider = getPrismaProvider(prisma)
    const actualColumns = await loadActualColumns(prisma, provider)

    const expectedTables = new Set(expectedColumns.map((column) => column.table))
    const missingTables = [...expectedTables].filter((table) => !actualColumns.has(table)).sort()
    const missingTableSet = new Set(missingTables)
    const missingColumns = expectedColumns
      .filter((expected) => !missingTableSet.has(expected.table) && !actualColumns.get(expected.table)?.has(expected.column))
      .sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`))

    return {
      ok: missingTables.length === 0 && missingColumns.length === 0,
      provider,
      checkedAt,
      expectedTables: expectedTables.size,
      expectedColumns: expectedColumns.length,
      actualTables: actualColumns.size,
      actualColumns: countActualColumns(actualColumns),
      missingTableCount: missingTables.length,
      missingColumnCount: missingColumns.length,
      missingTables: missingTables.slice(0, MAX_DETAILS),
      missingColumns: missingColumns.slice(0, MAX_DETAILS),
      truncated: missingTables.length > MAX_DETAILS || missingColumns.length > MAX_DETAILS,
    }
  } catch (error: any) {
    return {
      ok: false,
      provider: getPrismaProvider(prisma),
      checkedAt,
      expectedTables: 0,
      expectedColumns: 0,
      actualTables: 0,
      actualColumns: 0,
      missingTableCount: 0,
      missingColumnCount: 0,
      missingTables: [],
      missingColumns: [],
      truncated: false,
      error: error?.message || String(error),
    }
  }
}

function getExpectedColumns(prisma: PrismaClient): ExpectedColumn[] {
  const client = prisma as any
  const runtimeModels = client._runtimeDataModel?.models ?? client._dmmf?.datamodel?.models
  if (!runtimeModels) {
    throw new Error('Prisma runtime data model is not available')
  }

  const entries: Array<[string, RuntimeModel]> = Array.isArray(runtimeModels)
    ? runtimeModels.map((model: RuntimeModel) => [model.name || '', model])
    : Object.entries(runtimeModels)

  const expected: ExpectedColumn[] = []
  for (const [modelKey, model] of entries) {
    const modelName = model.name || modelKey
    if (!modelName || !Array.isArray(model.fields)) continue

    const table = model.dbName || modelName
    for (const field of model.fields) {
      if (!field.name) continue
      if (field.kind && field.kind !== 'scalar' && field.kind !== 'enum') continue
      if (field.relationName) continue
      expected.push({
        model: modelName,
        field: field.name,
        table,
        column: field.dbName || field.name,
      })
    }
  }

  if (expected.length === 0) {
    throw new Error('Prisma runtime data model has no scalar columns')
  }

  return expected
}

function getPrismaProvider(prisma: PrismaClient): string {
  const client = prisma as any
  const activeProvider = client._activeProvider
  if (typeof activeProvider === 'string' && activeProvider) return activeProvider

  const databaseUrl = process.env.DATABASE_URL || ''
  if (databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')) return 'postgresql'
  if (databaseUrl.startsWith('file:')) return 'sqlite'
  return 'unknown'
}

async function loadActualColumns(prisma: PrismaClient, provider: string): Promise<ActualColumns> {
  if (provider === 'postgresql' || provider === 'postgres') {
    return loadPostgresColumns(prisma)
  }
  if (provider === 'sqlite') {
    return loadSqliteColumns(prisma)
  }
  throw new Error(`Unsupported Prisma provider for schema health: ${provider}`)
}

async function loadPostgresColumns(prisma: PrismaClient): Promise<ActualColumns> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tableName: string; columnName: string }>>(`
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
  `)

  const columns: ActualColumns = new Map()
  for (const row of rows) {
    if (!columns.has(row.tableName)) columns.set(row.tableName, new Set())
    columns.get(row.tableName)!.add(row.columnName)
  }
  return columns
}

async function loadSqliteColumns(prisma: PrismaClient): Promise<ActualColumns> {
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `)

  const columns: ActualColumns = new Map()
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`)
    columns.set(table.name, new Set(rows.map((row) => row.name)))
  }
  return columns
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function countActualColumns(columns: ActualColumns): number {
  let count = 0
  for (const tableColumns of columns.values()) count += tableColumns.size
  return count
}
