/**
 * Smoke runner
 *
 * 用法：
 *   tsx scripts/smoke/runner.ts --env=local
 *   tsx scripts/smoke/runner.ts --env=preprod --module=rbac
 *   tsx scripts/smoke/runner.ts --env=prod --bail
 *
 * 强保护：
 *   - 启动时调 GET /health 哨兵，base URL 不通直接退出
 *   - 写保护开启时自动跳过 readonly=false 的模块
 *   - 失败时输出 module/test/status/error 摘要 + 退出码非 0
 *   - 写动作模块结束后调 cleanupBySmokePrefix（local + preprod + 允许写）
 */
import { loadSmokeEnv } from './env'
import { createHttp, login } from './http'
import { cleanupBySmokePrefix } from './helpers/cleanup'
import { errorMessage } from './helpers/shape'
import type { SmokeContext, SmokeModuleFn, SmokeModuleMeta, SmokeResult } from './types'

import * as health from './modules/00-health.smoke'
import * as auth from './modules/10-auth.smoke'
import * as rbac from './modules/20-rbac.smoke'
import * as sales from './modules/30-sales.smoke'
import * as chat from './modules/35-chat.smoke'
import * as content from './modules/40-content-config.smoke'
import * as orders from './modules/50-orders.smoke'
import * as enterpriseSe from './modules/60-enterprise-se.smoke'
import * as enterpriseSePreview from './modules/61-enterprise-se-preview.smoke'
import * as expertVote from './modules/70-expert-vote.smoke'
import * as sechat from './modules/80-sechat.smoke'

interface ModuleEntry { meta: SmokeModuleMeta; fn: SmokeModuleFn }

const MODULES: ModuleEntry[] = [
  { meta: health.meta,  fn: health.default  },
  { meta: auth.meta,    fn: auth.default    },
  { meta: rbac.meta,    fn: rbac.default    },
  { meta: sales.meta,   fn: sales.default   },
  { meta: chat.meta,    fn: chat.default    },
  { meta: content.meta, fn: content.default },
  { meta: orders.meta,  fn: orders.default  },
  { meta: enterpriseSe.meta, fn: enterpriseSe.default },
  { meta: enterpriseSePreview.meta, fn: enterpriseSePreview.default },
  { meta: expertVote.meta,   fn: expertVote.default   },
  { meta: sechat.meta,       fn: sechat.default       },
]

function parseArgs(argv: string[]): { env: string; modules?: string[]; bail: boolean } {
  let env = ''
  let modules: string[] | undefined
  let bail = false
  for (const a of argv) {
    if (a.startsWith('--env=')) env = a.slice('--env='.length)
    else if (a.startsWith('--module=')) modules = a.slice('--module='.length).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--bail') bail = true
  }
  if (!env) {
    console.error('用法: tsx scripts/smoke/runner.ts --env=local|preprod|prod [--module=health,auth,...] [--bail]')
    process.exit(1)
  }
  return { env, modules, bail }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = loadSmokeEnv(args.env)

  console.log(`[smoke] env=${env.env}  base=${env.baseUrl}  writes=${env.allowWrites}  prefix=${env.cleanupPrefix}`)

  // ── 启动哨兵：调 /health，确认 base URL 通
  const probe = createHttp(env)
  try {
    const r = await probe.get<{ ok?: boolean; service?: string; commit?: string }>('/health')
    if (!r.ok || !r.body?.ok) throw new Error(`status=${r.status} body=${JSON.stringify(r.body).slice(0, 100)}`)
    console.log(`[smoke] /health PASS  service=${r.body.service}  commit=${r.body.commit}`)
  } catch (e: unknown) {
    console.error(`[smoke] FATAL: /health 哨兵失败 ${env.baseUrl}/health  ${errorMessage(e)}`)
    process.exit(3)
  }

  const ctx: SmokeContext = { env, http: (token) => createHttp(env, token) }

  // ── 模块筛选
  let toRun = MODULES
  if (args.modules && args.modules.length > 0) {
    toRun = MODULES.filter((m) => args.modules!.includes(m.meta.name))
    if (toRun.length === 0) {
      console.error(`[smoke] FATAL: 无匹配模块 ${args.modules.join(',')}`)
      process.exit(1)
    }
  }
  // 写保护开启时（prod 或 SMOKE_ALLOW_WRITES=false）跳过非 readonly 模块
  if (env.env === 'prod' || !env.allowWrites) {
    const skipped = toRun.filter((m) => !m.meta.readonly)
    if (skipped.length > 0) {
      const reason = env.env === 'prod' ? 'prod' : `${env.env} 写保护`
      console.log(`[smoke] ${reason} 跳过非只读模块: ${skipped.map((m) => m.meta.name).join(', ')}`)
    }
    toRun = toRun.filter((m) => m.meta.readonly)
  }

  // ── 跑模块
  const all: SmokeResult[] = []
  for (const m of toRun) {
    console.log(`\n[smoke] === module: ${m.meta.name} ===`)
    let modResults: SmokeResult[]
    try {
      modResults = await m.fn(ctx)
    } catch (e: unknown) {
      modResults = [{
        module: m.meta.name, test: '<module crash>', ok: false,
        error: errorMessage(e), durationMs: 0,
      }]
    }
    for (const r of modResults) {
      const tag = r.ok ? '✓ PASS' : '✗ FAIL'
      const detail = r.ok
        ? (env.verbose ? ` (${r.durationMs}ms)` : '')
        : `  status=${r.status ?? '-'}  err=${(r.error || '').slice(0, 200)}`
      console.log(`  ${tag}  ${r.test}${detail}`)
    }
    all.push(...modResults)
    if (args.bail && modResults.some((r) => !r.ok)) break
  }

  // ── cleanup（只在 local/preprod 跑写动作且允许写时）
  if (env.env !== 'prod' && env.allowWrites) {
    try {
      const adminToken = await login(env, env.adminPhone, env.adminPassword)
      const adminClient = createHttp(env, adminToken)
      const rep = await cleanupBySmokePrefix(env, adminClient)
      console.log(`\n[smoke] cleanup: rolesDeleted=${rep.rolesDeleted} assignmentsCleared=${rep.roleAssignmentsCleared} errors=${rep.errors.length}`)
      if (rep.errors.length > 0) {
        for (const e of rep.errors) console.log(`  cleanup err: ${e}`)
      }
    } catch (e: unknown) {
      console.warn(`[smoke] cleanup 跳过: ${errorMessage(e)}`)
    }
  } else if (env.env !== 'prod') {
    console.log('\n[smoke] cleanup 跳过: 写保护开启')
  }

  // ── 汇总
  const pass = all.filter((r) => r.ok).length
  const fail = all.length - pass
  console.log(`\n[smoke] Total: ${all.length}  PASS: ${pass}  FAIL: ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('[smoke] uncaught:', e)
  process.exit(1)
})
