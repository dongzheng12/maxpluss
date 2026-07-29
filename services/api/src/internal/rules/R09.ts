/**
 * R09 — 全库比对次数快用完（personal 会员剩余 ≤ 2 次）
 * 模板：次数卡消费通知 ZpOoHsHH5L_xhgH6n2oe7ZIZmalSaPNQbjlLulIM7mg
 *
 * 当前 personal 年度 10 次免费额度；用 COMPARE_REPORT + channel=MEMBER_FREE 订单计数
 * （与 /api/app/compare/free-quota 端点同口径）
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_QUOTA_LOW } from './types.js'
import { buildCandidateFilters, DAY_MS, PERSONAL_ANNUAL_COMPARE_LIMIT } from './helpers.js'

const RULE_ID = 'R09'

export const query: RuleQuery = async () => {
  // 近 6 小时内 compare_complete 的用户（个人会员）
  const sixHoursAgo = BigInt(Date.now() - 6 * 60 * 60 * 1000)
  const recent = await prisma.analyticsEvent.findMany({
    where: { event: 'compare_complete', userId: { not: null }, serverTs: { gte: sixHoursAgo } },
    distinct: ['userId'],
    select: { userId: true },
  })
  if (recent.length === 0) return []
  const userIds = Array.from(new Set(recent.map((e) => e.userId!).filter(Boolean)))

  const personalMembers = await prisma.userMembership.findMany({
    where: { userId: { in: userIds }, status: 'ACTIVE', planId: 'personal' },
    select: { userId: true, createdAt: true },
  })
  if (personalMembers.length === 0) return []
  const memberMap = new Map(personalMembers.map((m) => [m.userId, m.createdAt]))

  // 每个个人会员的年度已用次数（与 free-quota 端点口径一致）
  const userRemaining = new Map<string, number>()
  for (const { userId, createdAt } of Array.from(memberMap.entries()).map(([k, v]) => ({ userId: k, createdAt: v }))) {
    const used = await prisma.appOrder.count({
      where: {
        userId,
        productType: 'COMPARE_REPORT',
        channel: 'MEMBER_FREE',
        status: 'PAID',
        paidAt: { gte: createdAt },
      },
    })
    const remaining = Math.max(0, PERSONAL_ANNUAL_COMPARE_LIMIT - used)
    if (remaining <= 2) userRemaining.set(userId, remaining)
  }
  if (userRemaining.size === 0) return []

  const candidateIds = Array.from(userRemaining.keys())
  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: candidateIds,
    templateId: TEMPLATE_QUOTA_LOW,
    ruleId: RULE_ID,
    cooldownMs: 365 * DAY_MS, // "当年不重推"，给大冷却
  })

  const result: RuleUser[] = []
  for (const [userId, remaining] of userRemaining.entries()) {
    const openid = openIdMap.get(userId)
    if (!openid || !quotaSet.has(userId) || sentSet.has(userId)) continue
    result.push({
      userId, openid,
      templateId: TEMPLATE_QUOTA_LOW,
      templateData: {
        short_thing7: '全库相似度比对',
        number4: remaining,
        thing5: '建议优先用于重点文档；如需更多次数可查看当前会员方案',
      },
      refId: null,
    })
  }
  return result
}
