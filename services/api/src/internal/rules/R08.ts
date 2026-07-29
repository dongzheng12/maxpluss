/**
 * R08 — 首次付费欢迎（历史仅一条 pay_success + 无 R08 历史推送）
 * 模板：服务进度提醒 cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_SERVICE_PROGRESS } from './types.js'
import { buildCandidateFilters, DAY_MS } from './helpers.js'

const RULE_ID = 'R08'

export const query: RuleQuery = async () => {
  // 近 2 小时内有 pay_success 的用户
  const twoHoursAgo = BigInt(Date.now() - 2 * 60 * 60 * 1000)
  const recentPays = await prisma.analyticsEvent.findMany({
    where: { event: 'pay_success', userId: { not: null }, serverTs: { gte: twoHoursAgo } },
    distinct: ['userId'],
    select: { userId: true },
  })
  if (recentPays.length === 0) return []
  const userIds = Array.from(new Set(recentPays.map((e) => e.userId!).filter(Boolean)))

  // 过滤出"历史仅一条 pay_success"的用户（首次付费）
  const totals = await prisma.analyticsEvent.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, event: 'pay_success' },
    _count: { _all: true },
  })
  const firstPayers = totals.filter((t) => t._count._all === 1).map((t) => t.userId!)
  if (firstPayers.length === 0) return []

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: firstPayers,
    templateId: TEMPLATE_SERVICE_PROGRESS,
    ruleId: RULE_ID,
    cooldownMs: 365 * DAY_MS, // R08 对每个用户终身只应触发一次，给个非常长的冷却
  })

  const result: RuleUser[] = []
  for (const id of firstPayers) {
    const openid = openIdMap.get(id)
    if (!openid || !quotaSet.has(id) || sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_SERVICE_PROGRESS,
      templateData: {
        thing7: '欢迎开通标准小智会员',
        thing6: '建议从全库相似度分析功能入手，开始您的首次会员体验',
      },
      refId: null,
    })
  }
  return result
}
