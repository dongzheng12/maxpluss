/**
 * Smoke 环境变量加载 + 写保护
 *
 * 严格用 === 'true' 判断布尔（dotenv 全是字符串，"false" 在 JS 里是 truthy）。
 * prod 环境硬阻：SMOKE_ALLOW_WRITES 必须 false，否则进程退出码 2。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { config as dotenvConfig } from 'dotenv'
import type { SmokeEnv, SmokeEnvName } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ENV_NAMES: SmokeEnvName[] = ['local', 'preprod', 'prod']

function isEnvName(v: string): v is SmokeEnvName {
  return (ENV_NAMES as string[]).includes(v)
}

function requireString(key: string, fallback?: string): string {
  const v = process.env[key]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`必填环境变量缺失: ${key}`)
  }
  return v
}

function strictBool(key: string): boolean {
  // dotenv 加载后是字符串。"false" 在 JS 里是 truthy，必须 === 'true' 严格判
  const raw = process.env[key]
  return raw === 'true'
}

export function loadSmokeEnv(envArg: string): SmokeEnv {
  if (!isEnvName(envArg)) {
    throw new Error(`非法 --env=${envArg}，仅支持: ${ENV_NAMES.join(' | ')}`)
  }
  const env = envArg

  // 1) 加载对应 dotenv 文件
  const apiRoot = path.resolve(__dirname, '..', '..')
  const envFile = path.join(apiRoot, `.env.smoke.${env}`)
  if (!existsSync(envFile)) {
    throw new Error(`找不到 ${envFile}（请按 .env.smoke.example 创建，且不要提交 git）`)
  }
  dotenvConfig({ path: envFile })

  // 2) 校验 SMOKE_ENV 与命令行一致
  const declaredEnv = process.env.SMOKE_ENV
  if (declaredEnv && declaredEnv !== env) {
    throw new Error(`.env.smoke.${env} 内 SMOKE_ENV=${declaredEnv} 与命令行 --env=${env} 不一致`)
  }

  // 3) 关键写保护：prod 严禁写
  const allowWrites = strictBool('SMOKE_ALLOW_WRITES')
  if (env === 'prod' && allowWrites) {
    console.error('[smoke] FATAL: 生产环境严禁写入测试，要求 SMOKE_ALLOW_WRITES=false')
    process.exit(2)
  }

  // 4) 装填
  const baseUrl = requireString('SMOKE_BASE_URL').replace(/\/+$/, '')
  // prefix 设计为短串（受 AdminRole.name max 40 限制）：SMK_<env简写>_<时间戳后6位>_
  // 例 SMK_L_761415_  ≤ 14 字符，给后续命名留 26 字符
  const envShort = env === 'local' ? 'L' : env === 'preprod' ? 'P' : 'X'
  const tsTail = String(Date.now()).slice(-6)
  const cleanupPrefix = `${requireString('SMOKE_CLEANUP_PREFIX', 'SMK_')}${envShort}_${tsTail}_`

  return {
    env,
    baseUrl,
    allowWrites,
    adminPhone: requireString('SMOKE_ADMIN_PHONE'),
    adminPassword: requireString('SMOKE_ADMIN_PASSWORD'),
    salesPhone: requireString('SMOKE_SALES_PHONE'),
    salesPassword: requireString('SMOKE_SALES_PASSWORD'),
    userPhone: requireString('SMOKE_USER_PHONE', ''),       // prod 可以不要 user 账号
    userPassword: requireString('SMOKE_USER_PASSWORD', ''),
    cleanupPrefix,
    timeoutMs: parseInt(requireString('SMOKE_TIMEOUT_MS', '15000'), 10),
    verbose: strictBool('SMOKE_VERBOSE'),
  }
}

/** prod 写保护：模块内调写动作前的辅助断言 */
export function assertWritesAllowed(env: SmokeEnv, action: string): void {
  if (env.env === 'prod') {
    throw new Error(`prod 环境禁止写动作: ${action}`)
  }
  if (!env.allowWrites) {
    throw new Error(`SMOKE_ALLOW_WRITES=false，跳过写动作: ${action}`)
  }
}
