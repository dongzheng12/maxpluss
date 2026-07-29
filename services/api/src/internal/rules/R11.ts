/**
 * R11 — 到期未续提醒（已到期 2-4 天 + 未续 + 当周期未推过）
 * 模板：会员到期提醒 9iVB8CETXYt0SwQQCEOL06xXk6HUZnZtIq72ndqwSH8
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_MEMBER_EXPIRE } from './types.js'
import { buildCandidateFilters, fmtDateCN, planDisplayName, DAY_MS } from './helpers.js'

const RULE_ID = 'R11'

export const query: RuleQuery = async () => {
  const now = Date.now()
  const lower = new Date(now - 4 * DAY_MS)
  const upper = new Date(now - 2 * DAY_MS)

  // 2-4 天前到期的 EXPIRED 会员
  const expired = await prisma.userMembership.findMany({
    where: {
      endAt: { gte: lower, lte: upper },
      status: { in: ['EXPIRED', 'ACTIVE'] }, // 未跑过期降级 job 之前可能还标记 ACTIVE 但 endAt 过了
    },
    select: { id: true, userId: true, planId: true, endAt: true },
  })
  if (expired.length === 0) return []
  const userIds = Array.from(new Set(expired.map((m) => m.userId)))

  // 排除已有新 ACTIVE 会员（续费过）的用户
  const fresh = await prisma.userMembership.findMany({
    where: {
      userId: { in: userIds },
      status: 'ACTIVE',
      startAt: { gte: lower },
    },
    select: { userId: true },
  })
  const freshSet = new Set(fresh.map((m) => m.userId))
  const unrenewed = expired.filter((m) => !freshSet.has(m.userId))
  if (unrenewed.length === 0) return []

  const refIds = unrenewed.map((m) => m.id)
  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: unrenewed.map((m) => m.userId),
    templateId: TEMPLATE_MEMBER_EXPIRE,
    ruleId: RULE_ID,
    cooldownMs: 60 * DAY_MS,
    refIds,
  })

  const result: RuleUser[] = []
  for (const m of unrenewed) {
    const openid = openIdMap.get(m.userId)
    if (!openid || !quotaSet.has(m.userId)) continue
    if (sentSet.has(`${m.userId}:${m.id}`)) continue
    result.push({
      userId: m.userId, openid,
      templateId: TEMPLATE_MEMBER_EXPIRE,
      templateData: {
        thing1: planDisplayName(m.planId),
        date2: fmtDateCN(m.endAt),
        thing4: '如需继续使用比对、大纲等功能，可查看当前续费方案',
      },
      refId: m.id,
    })
  }
  return result
}
