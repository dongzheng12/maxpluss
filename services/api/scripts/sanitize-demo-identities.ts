/**
 * T13 演示身份改名治理：只改展示名，不删数据、不改 FK。
 *
 * 用法：
 *   npx tsx scripts/sanitize-demo-identities.ts --force-local --dry-run
 *   DEMO_IDENTITY_ENTERPRISE_IDS=DEFAULT npx tsx scripts/sanitize-demo-identities.ts --force-local
 *
 * 保护：
 *   - NODE_ENV=production 拒绝
 *   - DATABASE_URL 命中生产关键字拒绝
 *   - 必须显式 --force-local
 *   - 非本地 DB 必须 ALLOW_DEMO_IDENTITY_RENAME=1
 */
import { PrismaClient } from '@prisma/client'
import {
  securityEnterpriseName,
  securityUserName,
  shouldRenameEnterprise,
  shouldRenameUser,
} from '../src/standard-execution/demoIdentitySanitizer.js'

const PROD_PATH_HINTS = [
  'biaozhunxiaozhi-data',
  'biaozhunxiaozhi/data',
  '/opt/biaozhunxiaozhi',
  'production',
  '154.8.197.13',
  'api.biaozhunxiaozhi.com',
]

function refuse(msg: string): never {
  console.error('[sanitize-demo-identities] 拒绝执行：' + msg)
  process.exit(2)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const cliEnterpriseIds = args
    .filter((arg) => arg.startsWith('--enterprise-id='))
    .flatMap((arg) => arg.slice('--enterprise-id='.length).split(','))
  const envEnterpriseIds = (process.env.DEMO_IDENTITY_ENTERPRISE_IDS || '').split(',')
  return {
    dryRun: args.includes('--dry-run'),
    forceLocal: args.includes('--force-local'),
    targetEnterpriseIds: new Set([...cliEnterpriseIds, ...envEnterpriseIds].map((id) => id.trim()).filter(Boolean)),
  }
}

function preflight(forceLocal: boolean) {
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    refuse('NODE_ENV=production')
  }
  const dbUrl = process.env.DATABASE_URL || ''
  for (const hint of PROD_PATH_HINTS) {
    if (dbUrl.includes(hint)) refuse(`DATABASE_URL 含生产路径关键字 "${hint}"`)
  }
  if (!forceLocal) refuse('必须显式传 --force-local')
  const local = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') || dbUrl.startsWith('file:')
  if (!local && process.env.ALLOW_DEMO_IDENTITY_RENAME !== '1') {
    refuse('非本地 DB 必须设置 ALLOW_DEMO_IDENTITY_RENAME=1（仅限已确认 POC）')
  }
  console.log('[sanitize-demo-identities] DB=' + (dbUrl || '<env DATABASE_URL 未设置，使用 prisma 默认>'))
}

async function main() {
  const { dryRun, forceLocal, targetEnterpriseIds } = parseArgs()
  preflight(forceLocal)

  const prisma = new PrismaClient()
  try {
    const enterprises = await prisma.enterprise.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { createdAt: 'asc' },
    })
    const enterpriseTargets = enterprises.filter((enterprise) => shouldRenameEnterprise(enterprise, targetEnterpriseIds))
    const effectiveEnterpriseIds = new Set([...targetEnterpriseIds, ...enterpriseTargets.map((enterprise) => enterprise.id)])

    const users = await prisma.appUser.findMany({
      where: { enterpriseId: { not: null }, enterpriseRole: { not: null } },
      select: { id: true, name: true, organization: true, enterpriseId: true, enterpriseRole: true },
      orderBy: { createdAt: 'asc' },
    })
    const userTargets = users.filter((user) => shouldRenameUser(user, effectiveEnterpriseIds))

    console.log(`[sanitize-demo-identities] mode=${dryRun ? 'dry-run' : 'write'} enterprises=${enterpriseTargets.length} users=${userTargets.length}`)

    if (!dryRun) {
      await prisma.$transaction(async (tx) => {
        for (let index = 0; index < enterpriseTargets.length; index += 1) {
          const enterprise = enterpriseTargets[index]
          await tx.enterprise.update({
            where: { id: enterprise.id },
            data: { name: securityEnterpriseName(index) },
          })
        }
        for (let index = 0; index < userTargets.length; index += 1) {
          const user = userTargets[index]
          await tx.appUser.update({
            where: { id: user.id },
            data: {
              name: securityUserName(user.enterpriseRole, index),
              organization: user.organization || '安保运营部',
            },
          })
        }
      })
    }

    for (let index = 0; index < enterpriseTargets.length; index += 1) {
      const enterprise = enterpriseTargets[index]
      console.log(`enterprise ${enterprise.id}: "${enterprise.name}" -> "${securityEnterpriseName(index)}"`)
    }
    for (let index = 0; index < userTargets.length; index += 1) {
      const user = userTargets[index]
      console.log(`appUser ${user.id}: "${user.name || ''}" -> "${securityUserName(user.enterpriseRole, index)}"`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
