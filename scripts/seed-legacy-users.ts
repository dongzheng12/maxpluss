/**
 * 造 3 个 user-{phone} 历史用户 + 关联记录，用于验证 migrate-user-ids.ts。
 * 仅本地 dev.db 使用。跑完 migrate 后可以 DELETE 清理，或直接回滚 dev.db.bak。
 *
 * 用法:  npx tsx ../../scripts/seed-legacy-users.ts
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const FIXTURES = [
  { phone: '13900000001', name: '迁移测试A' }, // 有全套关联
  { phone: '13900000002', name: '迁移测试B' }, // 只有会员
  { phone: '13900000003', name: '迁移测试C' }, // 孤立账号
]

async function main() {
  console.log('[seed-legacy] creating 3 legacy users + associations...')

  // 清理残留（如果上次没跑完）
  for (const f of FIXTURES) {
    const oldId = `user-${f.phone}`
    await prisma.notification.deleteMany({ where: { userId: oldId } })
    await prisma.chatMessage.deleteMany({ where: { conversation: { userId: oldId } } })
    await prisma.conversation.deleteMany({ where: { userId: oldId } })
    await prisma.compareTask.deleteMany({ where: { userId: oldId } })
    await prisma.appOrder.deleteMany({ where: { userId: oldId } })
    await prisma.userMembership.deleteMany({ where: { userId: oldId } })
    await prisma.referral.deleteMany({ where: { OR: [{ inviterId: oldId }, { inviteeId: oldId }] } })
    await prisma.analyticsEvent.deleteMany({ where: { userId: oldId } })
    await prisma.appUser.deleteMany({ where: { id: oldId } })
  }

  // 创建 3 个 legacy user
  for (const f of FIXTURES) {
    await prisma.appUser.create({
      data: {
        id: `user-${f.phone}`,
        phone: f.phone,
        name: f.name,
        role: 'user',
        passwordHash: 'fake-hash-for-migration-test',
      },
    })
  }

  const [a, b] = FIXTURES

  // A：全套关联
  await prisma.userMembership.create({
    data: {
      userId: `user-${a.phone}`,
      planId: 'personal',
      status: 'ACTIVE',
      source: 'PURCHASE',
      startAt: new Date(),
      endAt: new Date(Date.now() + 365 * 86400 * 1000),
    },
  })
  await prisma.appOrder.create({
    data: {
      orderNo: `TEST-ORDER-${Date.now()}`,
      userId: `user-${a.phone}`,
      productType: 'membership',
      title: '迁移测试订单',
      amount: 59800,
      status: 'PAID',
      paidAt: new Date(),
    },
  })
  const conv = await prisma.conversation.create({
    data: { userId: `user-${a.phone}`, title: '迁移前的对话' },
  })
  await prisma.chatMessage.createMany({
    data: [
      { conversationId: conv.id, role: 'user', content: '你好' },
      { conversationId: conv.id, role: 'assistant', content: '你好呀' },
    ],
  })
  await prisma.compareTask.create({
    data: {
      taskNo: `TEST-TASK-${Date.now()}`,
      userId: `user-${a.phone}`,
      documentName: '迁移测试文档.pdf',
      compareMode: 'single',
      selectedStandardIds: '[]',
      status: 'COMPLETED',
    },
  })
  await prisma.notification.create({
    data: {
      userId: `user-${a.phone}`,
      title: '欢迎',
      body: '测试通知',
      type: 'SYSTEM',
    },
  })
  await prisma.analyticsEvent.create({
    data: {
      event: 'test.migration',
      platform: 'pc',
      userId: `user-${a.phone}`,
      serverTs: BigInt(Date.now()),
    },
  })

  // B：仅会员 + 作为被邀请人
  await prisma.userMembership.create({
    data: {
      userId: `user-${b.phone}`,
      planId: 'pro',
      status: 'ACTIVE',
      source: 'SALES_GIFT',
      startAt: new Date(),
      endAt: new Date(Date.now() + 365 * 86400 * 1000),
    },
  })
  await prisma.referral.create({
    data: {
      inviterId: `user-${a.phone}`,
      inviteeId: `user-${b.phone}`,
    },
  })

  // C：孤立账号，无任何关联

  console.log('[seed-legacy] done. Users created:')
  for (const f of FIXTURES) console.log(`  user-${f.phone}  (${f.name})`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
