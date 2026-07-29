/**
 * vitest 全局 setup — 每次测试会话开始前重建 PostgreSQL test DB
 *
 * DATABASE_URL 来源：
 *  - 外部显式设置（CI / 临时指定）优先
 *  - 本地 .env.test
 *  - 兜底 .env.test.template（可提交，指向 bxz-pg-test）
 *
 * sanity guard：URL 必须是 PostgreSQL 且含 'test' 字样，否则 throw（防误打生产/POC PG）
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'

const TEST_ENV_FILES = ['.env.test', '.env.test.template']

function maskDatabaseUrl(databaseUrl: string) {
  return databaseUrl.replace(/:[^@/]*@/, ':***@')
}

function loadTestDatabaseEnv(apiRoot: string) {
  if (process.env.DATABASE_URL) return

  for (const fileName of TEST_ENV_FILES) {
    const envPath = path.join(apiRoot, fileName)
    if (!existsSync(envPath)) continue

    loadDotenv({ path: envPath, override: false })
    if (process.env.DATABASE_URL) return
  }
}

export default async function globalSetup() {
  const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  loadTestDatabaseEnv(apiRoot)

  const testDbUrl = process.env.DATABASE_URL

  if (!testDbUrl) {
    throw new Error('DATABASE_URL is required for vitest. Create services/api/.env.test or use .env.test.template.')
  }

  const isPg = testDbUrl.startsWith('postgresql://') || testDbUrl.startsWith('postgres://')
  if (!isPg) {
    throw new Error(`DATABASE_URL must be PostgreSQL for prisma/schema.prisma: ${maskDatabaseUrl(testDbUrl)}`)
  }

  if (!testDbUrl.includes('test')) {
    throw new Error(`Refusing to initialize non-test database: ${maskDatabaseUrl(testDbUrl)}`)
  }

  execFileSync('npx', ['prisma', 'db', 'push', '--force-reset', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DATABASE_URL: testDbUrl,
    },
    stdio: 'pipe',
  })
}
