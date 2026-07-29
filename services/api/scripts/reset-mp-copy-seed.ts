/**
 * 强制重置 mp 远程配置文案到最新 seed 值
 *
 * 用途：本地 / POC 数据库已经 seed 过旧值（与 wxml 不一致），
 *      ensureAppSeed 的 update:{} 不会覆盖；本脚本 force-update 以下 group 的字段。
 *
 * 范围（仅小程序提审相关）：
 *   - mp_copy_register
 *   - mp_copy_membership
 *   - share_text
 *
 * ⚠️ 仅本地 / POC 跑。生产请走"备份 → 单条 upsert"流程，不要直接执行此脚本。
 *
 * 用法：
 *   # 在 services/api 目录下执行：
 *   npx tsx scripts/reset-mp-copy-seed.ts --force-local
 *   # 在仓库根目录执行：
 *   npx tsx services/api/scripts/reset-mp-copy-seed.ts --force-local
 *
 * 生产保护（4 重）：
 *   1. NODE_ENV=production 直接拒绝
 *   2. DATABASE_URL 含生产路径关键字（biaozhunxiaozhi / production / prod / 154.8.197.13）直接拒绝
 *   3. 必须显式传 --force-local 才执行
 *   4. 执行前打印当前 DB 路径，让人有机会 Ctrl-C
 */
import { PrismaClient } from '@prisma/client'
import { MP_REMOTE_CONFIG_SEEDS } from '../src/internal/seedMpRemoteConfig.js'

const TARGET_GROUPS = new Set([
  'mp_copy_register',
  'mp_copy_membership',
  'share_text',
])

const PROD_PATH_HINTS = [
  'biaozhunxiaozhi-data',
  'biaozhunxiaozhi/data',
  '/opt/biaozhunxiaozhi',
  'production',
  '154.8.197.13',
  'api.biaozhunxiaozhi.com',
]

function refuse(msg: string): never {
  console.error('[reset-mp-copy-seed] ❌ 拒绝执行：' + msg)
  process.exit(2)
}

function preflight() {
  // 1) NODE_ENV
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    refuse('NODE_ENV=production')
  }

  // 2) DATABASE_URL 模式
  const dbUrl = process.env.DATABASE_URL || ''
  for (const hint of PROD_PATH_HINTS) {
    if (dbUrl.includes(hint)) {
      refuse(`DATABASE_URL 含生产路径关键字 "${hint}" — ${dbUrl}`)
    }
  }

  // 3) --force-local
  const args = process.argv.slice(2)
  if (!args.includes('--force-local')) {
    refuse('必须显式传 --force-local（这是为了防止误跑生产）')
  }

  // 4) 打印当前 DB 路径，给人手动中断窗口
  console.log('[reset-mp-copy-seed] 即将连接 DB：' + (dbUrl || '<env DATABASE_URL 未设置，使用 prisma 默认>'))
  console.log('[reset-mp-copy-seed] 目标 groups：' + Array.from(TARGET_GROUPS).join(', '))
  console.log('[reset-mp-copy-seed] 仅适用于本地 / POC 环境')
}

async function main() {
  preflight()

  const prisma = new PrismaClient()
  const updatedKeys: string[] = []
  const createdKeys: string[] = []
  let skipped = 0

  try {
    for (const s of MP_REMOTE_CONFIG_SEEDS) {
      if (!TARGET_GROUPS.has(s.group)) { skipped++; continue }
      const existing = await (prisma as any).contentConfig.findUnique({ where: { key: s.key } })
      if (existing) {
        await (prisma as any).contentConfig.update({
          where: { key: s.key },
          data: {
            group: s.group,
            platform: s.platform,
            type: s.type,
            title: s.title ?? null,
            subtitle: s.subtitle ?? null,
            content: s.content ?? null,
            description: s.description ?? null,
            extraJson: s.extraJson ?? null,
            sortOrder: s.sortOrder,
          },
        })
        updatedKeys.push(s.key)
      } else {
        await (prisma as any).contentConfig.create({
          data: {
            key: s.key,
            group: s.group,
            platform: s.platform,
            type: s.type,
            title: s.title,
            subtitle: s.subtitle,
            content: s.content,
            description: s.description,
            extraJson: s.extraJson,
            sortOrder: s.sortOrder,
            enabled: true,
          },
        })
        createdKeys.push(s.key)
      }
    }
    console.log('[reset-mp-copy-seed] ✅ 完成')
    console.log(`  更新 ${updatedKeys.length} 条：${updatedKeys.join(', ')}`)
    console.log(`  新建 ${createdKeys.length} 条：${createdKeys.join(', ')}`)
    console.log(`  跳过 ${skipped} 条（其他分组不动）`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
