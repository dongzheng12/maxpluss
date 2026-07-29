/**
 * R01 — 注册未激活（注册后 24h 无核心事件）
 * 模板：服务进度提醒 cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio
 * 字段：thing7=服务名称, thing6=温馨提示
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_SERVICE_PROGRESS } from './types.js'
import { buildCandidateFilters, CORE_EVENTS, DAY_MS } from './helpers.js'

const RULE_ID = 'R01'

export const query: RuleQuery = async () => {
  const now = Date.now()
  const lower = new Date(now - 48 * 60 * 60 * 1000) // 24-48h 前注册（保留 24h 窗口避免漏触达）
  const upper = new Date(now - 24 * 60 * 60 * 1000)

  const users = await prisma.appUser.findMany({
    where: {
      createdAt: { gte: lower, lte: upper },
      openId: { not: null },
    },
    select: { id: true },
  })
  if (users.length === 0) return []

  const userIds = users.map((u) => u.id)

  // 排除已有任一核心事件的用户
  const activated = await prisma.analyticsEvent.findMany({
    where: { userId: { in: userIds }, event: { in: [...CORE_EVENTS] } },
    distinct: ['userId'],
    select: { userId: true },
  })
  const activatedSet = new Set(activated.map((e) => e.userId!))
  const inactive = userIds.filter((id) => !activatedSet.has(id))
  if (inactive.length === 0) return []

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: inactive,
    templateId: TEMPLATE_SERVICE_PROGRESS,
    ruleId: RULE_ID,
    cooldownMs: 30 * DAY_MS,
  })

  const result: RuleUser[] = []
  for (const id of inactive) {
    const openid = openIdMap.get(id)
    if (!openid) continue
    if (!quotaSet.has(id)) continue
    if (sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_SERVICE_PROGRESS,
      templateData: {
        thing7: '您尚未完成首次标准检索',
        thing6: '点击搜索第一个标准，只需3秒，48.7万+标准库即刻可用',
      },
      refId: null,
    })
  }
  return result
}
