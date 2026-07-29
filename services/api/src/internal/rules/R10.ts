/**
 * R10 — 会员到期提醒（未来 6-8 天到期 + 当周期未推过）
 * 模板：会员到期提醒 9iVB8CETXYt0SwQQCEOL06xXk6HUZnZtIq72ndqwSH8
 * 字段：thing1=会员类型, date2=到期时间, thing4=温馨提示
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_MEMBER_EXPIRE } from './types.js'
import { buildCandidateFilters, fmtDateCN, planDisplayName, DAY_MS } from './helpers.js'

const RULE_ID = 'R10'

export const query: RuleQuery = async () => {
  const now = Date.now()
  const lower = new Date(now + 6 * DAY_MS)
  const upper = new Date(now + 8 * DAY_MS)

  const memberships = await prisma.userMembership.findMany({
    where: {
      status: 'ACTIVE',
      endAt: { gte: lower, lte: upper },
    },
    select: { id: true, userId: true, planId: true, endAt: true },
  })
  if (memberships.length === 0) return []

  const userIds = memberships.map((m) => m.userId)
  // 当周期内（用 membership.id 作为 refId）去重
  const refIds = memberships.map((m) => m.id)
  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds,
    templateId: TEMPLATE_MEMBER_EXPIRE,
    ruleId: RULE_ID,
    cooldownMs: 60 * DAY_MS,
    refIds,
  })

  const result: RuleUser[] = []
  for (const m of memberships) {
    const openid = openIdMap.get(m.userId)
    if (!openid || !quotaSet.has(m.userId)) continue
    if (sentSet.has(`${m.userId}:${m.id}`)) continue
    result.push({
      userId: m.userId, openid,
      templateId: TEMPLATE_MEMBER_EXPIRE,
      templateData: {
        thing1: planDisplayName(m.planId),
        date2: fmtDateCN(m.endAt),
        thing4: '续费后可继续使用全部会员权益，避免使用中断',
      },
      refId: m.id,
    })
  }
  return result
}
