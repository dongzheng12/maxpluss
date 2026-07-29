/**
 * R02 — 首检索后功能引导（first_search 后 1-2h 无其他功能事件）
 * 模板：服务进度提醒 cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_SERVICE_PROGRESS } from './types.js'
import { buildCandidateFilters, DAY_MS } from './helpers.js'

const RULE_ID = 'R02'

export const query: RuleQuery = async () => {
  const now = Date.now()
  const lower = BigInt(now - 2 * 60 * 60 * 1000)
  const upper = BigInt(now - 60 * 60 * 1000)

  // 1-2h 前有 first_search 事件的用户
  const firstSearches = await prisma.analyticsEvent.findMany({
    where: { event: 'first_search', userId: { not: null }, serverTs: { gte: lower, lte: upper } },
    select: { userId: true },
  })
  if (firstSearches.length === 0) return []
  const userIds = Array.from(new Set(firstSearches.map((e) => e.userId!).filter(Boolean)))

  // 排除已使用 compare/outline/chat 任一功能的
  const advancedEvents = ['compare_complete', 'outline_generated', 'chat_sent']
  const advanced = await prisma.analyticsEvent.findMany({
    where: { userId: { in: userIds }, event: { in: advancedEvents } },
    distinct: ['userId'],
    select: { userId: true },
  })
  const advancedSet = new Set(advanced.map((e) => e.userId!))
  const candidates = userIds.filter((id) => !advancedSet.has(id))
  if (candidates.length === 0) return []

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: candidates,
    templateId: TEMPLATE_SERVICE_PROGRESS,
    ruleId: RULE_ID,
    cooldownMs: 30 * DAY_MS,
  })

  const result: RuleUser[] = []
  for (const id of candidates) {
    const openid = openIdMap.get(id)
    if (!openid || !quotaSet.has(id) || sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_SERVICE_PROGRESS,
      templateData: {
        thing7: '首次检索完成！还有更多功能等您探索',
        thing6: '相似度比对、AI大纲生成、小智问答均已开放使用',
      },
      refId: null,
    })
  }
  return result
}
