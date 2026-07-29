/**
 * R05 — 小智问答次数快用完（免费用户剩余 ≤ 1 次）
 * 模板：次数卡消费通知 ZpOoHsHH5L_xhgH6n2oe7ZIZmalSaPNQbjlLulIM7mg
 *
 * 免费用户每日 5 次 chat，按今天 chatMessage role='user' 计数。
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_QUOTA_LOW } from './types.js'
import { buildCandidateFilters, DAILY_FREE_LIMIT, SEVEN_DAYS_MS } from './helpers.js'

const RULE_ID = 'R05'

export const query: RuleQuery = async () => {
  const twoHoursAgo = BigInt(Date.now() - 2 * 60 * 60 * 1000)
  const recent = await prisma.analyticsEvent.findMany({
    where: { event: 'chat_sent', userId: { not: null }, serverTs: { gte: twoHoursAgo } },
    distinct: ['userId'],
    select: { userId: true },
  })
  if (recent.length === 0) return []
  const userIds = Array.from(new Set(recent.map((e) => e.userId!).filter(Boolean)))

  const paidMembers = await prisma.userMembership.findMany({
    where: { userId: { in: userIds }, status: 'ACTIVE' },
    select: { userId: true },
  })
  const paidSet = new Set(paidMembers.map((m) => m.userId))
  const freeUsers = userIds.filter((id) => !paidSet.has(id))
  if (freeUsers.length === 0) return []

  // 今日聊天计数（chat_sent 大致对应 role='user' 的消息条数）
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const convs = await prisma.conversation.findMany({
    where: { userId: { in: freeUsers } },
    select: { id: true, userId: true },
  })
  const convToUser = new Map(convs.map((c) => [c.id, c.userId]))
  const convIds = convs.map((c) => c.id)
  const counts = await prisma.chatMessage.groupBy({
    by: ['conversationId'],
    where: {
      role: 'user',
      conversationId: { in: convIds },
      createdAt: { gte: todayStart },
    },
    _count: { _all: true },
  })
  const userCounts = new Map<string, number>()
  for (const r of counts) {
    const uid = convToUser.get(r.conversationId)
    if (!uid) continue
    userCounts.set(uid, (userCounts.get(uid) || 0) + r._count._all)
  }

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
        short_thing7: '小智问答',
        number4: remaining,
        thing5: '开通会员可继续使用更多问答配额',
      },
      refId: null,
    })
  }
  return result
}
