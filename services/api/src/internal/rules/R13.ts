/**
 * R13 — 流失付费用户召回（lifecycle=CHURNED + isPaid=true）
 * 模板：服务进度提醒 cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio
 *
 * push/send 成功时在 routes.ts 里额外 +1 AppUser.bonusCompareQuota（临时体验权益）
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_SERVICE_PROGRESS } from './types.js'
import { buildCandidateFilters, DAY_MS } from './helpers.js'

const RULE_ID = 'R13'

export const query: RuleQuery = async () => {
  const labels = await prisma.userLabel.findMany({
    where: { lifecycle: 'CHURNED', isPaid: true },
    select: { userId: true },
  })
  if (labels.length === 0) return []
  const userIds = labels.map((l) => l.userId)

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds,
    templateId: TEMPLATE_SERVICE_PROGRESS,
    ruleId: RULE_ID,
    cooldownMs: 30 * DAY_MS,
  })

  const result: RuleUser[] = []
  for (const id of userIds) {
    const openid = openIdMap.get(id)
    if (!openid || !quotaSet.has(id) || sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_SERVICE_PROGRESS,
      templateData: {
        thing7: '好久不见，已为您保留一次体验权益',
        thing6: '点击查看限时全库比对体验次数，继续上次未完成的工作',
      },
      refId: null,
    })
  }
  return result
}
