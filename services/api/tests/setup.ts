import 'express-async-errors' // patch express：让 async handler 的 throw 流到 error handler（与生产 main.ts 一致），否则 getEnterpriseId 的 403 throw 会让测试 hang
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

/**
 * 测试全局 setup — 设置环境变量
 *
 * DATABASE_URL：外部显式设置优先，否则读取 .env.test / .env.test.template。
 * 数据库重建与 sanity guard 在 globalSetup.ts。
 */
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testEnvFiles = ['.env.test', '.env.test.template']

function loadTestDatabaseEnv() {
  if (process.env.DATABASE_URL) return

  for (const fileName of testEnvFiles) {
    const envPath = path.join(apiRoot, fileName)
    if (!existsSync(envPath)) continue

    loadDotenv({ path: envPath, override: false })
    if (process.env.DATABASE_URL) return
  }
}

// 测试环境变量（在 Prisma 初始化前设置）
loadTestDatabaseEnv()
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for vitest. Create services/api/.env.test or use .env.test.template.')
}
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-32chars-minimum!!'
process.env.BXZ_INTERNAL_SECRET = 'test-internal-secret'
process.env.LOG_LEVEL = 'silent'
// doc-extract 测试用本地 mock dedup server 监听该端口；其他测试不会真实请求 dedup
process.env.DEDUP_SERVICE_URL = process.env.DEDUP_SERVICE_URL || 'http://127.0.0.1:48067'
