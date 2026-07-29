/**
 * R07 — 高频使用未转化（7天核心事件 ≥ 5 + 未付费）
 * 模板：服务进度提醒 cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_SERVICE_PROGRESS } from './types.js'
import { buildCandidateFilters, CORE_EVENTS, SEVEN_DAYS_MS } from './helpers.js'

const RULE_ID = 'R07'

export const query: RuleQuery = async () => {
  const since = BigInt(Date.now() - SEVEN_DAYS_MS)

  // 7 天内核心事件计数
  const events = await prisma.analyticsEvent.groupBy({
    by: ['userId'],
    where: {
      userId: { not: null },
      event: { in: [...CORE_EVENTS] },
      serverTs: { gte: since },
    },
    _count: { _all: true },
  })
  const heavyUsers = events.filter((e) => e._count._all >= 5).map((e) => e.userId!).filter(Boolean)
  if (heavyUsers.length === 0) return []

  // 排除付费会员
  const paidMembers = await prisma.userMembership.findMany({
    where: { userId: { in: heavyUsers }, status: 'ACTIVE' },
    select: { userId: true },
  })
  const paidSet = new Set(paidMembers.map((m) => m.userId))
  const freeHeavy = heavyUsers.filter((id) => !paidSet.has(id))
  if (freeHeavy.length === 0) return []

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: freeHeavy,
    templateId: TEMPLATE_SERVICE_PROGRESS,
    ruleId: RULE_ID,
    cooldownMs: SEVEN_DAYS_MS,
  })

  const result: RuleUser[] = []
  for (const id of freeHeavy) {
    const openid = openIdMap.get(id)
    if (!openid || !quotaSet.has(id) || sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_SERVICE_PROGRESS,
      templateData: {
        thing7: '您近期使用频繁，可解锁更多功能',
        thing6: '会员可获得更多比对次数、AI大纲配额与完整结果查看能力',
      },
      refId: null,
    })
  }
  return result
}
