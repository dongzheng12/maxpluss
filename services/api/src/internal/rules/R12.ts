/**
 * R12 — 沉默用户唤醒（lifecycle=SILENT，14-30 天无核心事件，曾激活）
 * 模板：服务进度提醒 cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio
 *
 * 直接用 UserLabel.lifecycle=SILENT（labelSync job 已根据 lastActiveAt 14-30 天计算）
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_SERVICE_PROGRESS } from './types.js'
import { buildCandidateFilters, DAY_MS } from './helpers.js'

const RULE_ID = 'R12'

export const query: RuleQuery = async () => {
  const labels = await prisma.userLabel.findMany({
    where: { lifecycle: 'SILENT' },
    select: { userId: true },
  })
  if (labels.length === 0) return []
  const userIds = labels.map((l) => l.userId)

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds,
    templateId: TEMPLATE_SERVICE_PROGRESS,
    ruleId: RULE_ID,
    cooldownMs: 14 * DAY_MS,
  })

  const result: RuleUser[] = []
  for (const id of userIds) {
    const openid = openIdMap.get(id)
    if (!openid || !quotaSet.has(id) || sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_SERVICE_PROGRESS,
      templateData: {
        thing7: '近期标准库有更新，欢迎回来查看',
        thing6: '点击返回继续使用常用功能，查看与您相关的最新标准内容',
      },
      refId: null,
    })
  }
  return result
}
