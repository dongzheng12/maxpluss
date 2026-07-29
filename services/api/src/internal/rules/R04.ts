/**
 * R04 — AI 大纲次数快用完（免费用户剩余 ≤ 1 次）
 * 模板：次数卡消费通知 ZpOoHsHH5L_xhgH6n2oe7ZIZmalSaPNQbjlLulIM7mg
 * 字段：short_thing7=交易类型, number4=剩余次数, thing5=备注
 *
 * 免费用户每日 5 次 outline，服务端按今天 chatMessage intent='write_outline' 计数。
 * 付费会员不限次，不纳入此规则。
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_QUOTA_LOW } from './types.js'
import { buildCandidateFilters, DAILY_FREE_LIMIT, SEVEN_DAYS_MS } from './helpers.js'

const RULE_ID = 'R04'

export const query: RuleQuery = async () => {
  const now = Date.now()
  const twoHoursAgo = BigInt(now - 2 * 60 * 60 * 1000)
  // 查 2 小时内触发过 outline_generated 的用户
  const recent = await prisma.analyticsEvent.findMany({
    where: { event: 'outline_generated', userId: { not: null }, serverTs: { gte: twoHoursAgo } },
    distinct: ['userId'],
    select: { userId: true },
  })
  if (recent.length === 0) return []
  const userIds = Array.from(new Set(recent.map((e) => e.userId!).filter(Boolean)))

  // 排除付费会员
  const paidMembers = await prisma.userMembership.findMany({
    where: { userId: { in: userIds }, status: 'ACTIVE' },
    select: { userId: true },
  })
  const paidSet = new Set(paidMembers.map((m) => m.userId))
  const freeUsers = userIds.filter((id) => !paidSet.has(id))
  if (freeUsers.length === 0) return []

  // 统计每个 free 用户今日 outline 使用次数
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayCounts = await prisma.chatMessage.groupBy({
    by: ['conversationId'],
    where: {
      role: 'user',
      intent: 'write_outline',
      createdAt: { gte: todayStart },
      conversation: { userId: { in: freeUsers } },
    },
    _count: { _all: true },
  })
  // groupBy 返回 conversationId 维度，再合并到 userId 维度
  const convMap = await prisma.conversation.findMany({
    where: { id: { in: todayCounts.map((r) => r.conversationId) } },
    select: { id: true, userId: true },
  })
  const convToUser = new Map(convMap.map((c) => [c.id, c.userId]))
  const userCounts = new Map<string, number>()
  for (const r of todayCounts) {
    const uid = convToUser.get(r.conversationId)
    if (!uid) continue
    userCounts.set(uid, (userCounts.get(uid) || 0) + r._count._all)
  }

  // 剩余 ≤ 1 (即用了 ≥ 4 次)
  const lowUsers: Array<{ userId: string; remaining: number }> = []
  for (const uid of freeUsers) {
    const used = userCounts.get(uid) || 0
    const remaining = Math.max(0, DAILY_FREE_LIMIT - used)
    if (remaining <= 1) lowUsers.push({ userId: uid, remaining })
  }
  if (lowUsers.length === 0) return []

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: lowUsers.map((u) => u.userId),
    templateId: TEMPLATE_QUOTA_LOW,
    ruleId: RULE_ID,
    cooldownMs: SEVEN_DAYS_MS,
  })

  const result: RuleUser[] = []
  for (const { userId, remaining } of lowUsers) {
    const openid = openIdMap.get(userId)
    if (!openid || !quotaSet.has(userId) || sentSet.has(userId)) continue
    result.push({
      userId, openid,
      templateId: TEMPLATE_QUOTA_LOW,
      templateData: {
        short_thing7: 'AI大纲生成',
        number4: remaining,
        thing5: '开通会员可继续使用更多配额，保持创作不中断',
      },
      refId: null,
    })
  }
  return result
}
