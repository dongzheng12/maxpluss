/**
 * R14 — 裂变邀请推送（PAID / HIGH_ACTIVE 且尚未生成过 ReferralCode）
 * 模板：好友充能成功提醒 UtPIdDEn7g_p8mcspWlie_cvq_QTqiZ1TcCkCI1KKuM（借用为邀请引导）
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_REFERRAL } from './types.js'
import { buildCandidateFilters, DAY_MS } from './helpers.js'

const RULE_ID = 'R14'

export const query: RuleQuery = async () => {
  // 付费 / 高活用户
  const labels = await prisma.userLabel.findMany({
    where: { lifecycle: { in: ['PAID', 'HIGH_ACTIVE'] } },
    select: { userId: true },
  })
  if (labels.length === 0) return []
  const userIds = labels.map((l) => l.userId)

  // 排除已生成 ReferralCode 的（已邀请过）
  const hasCodes = await prisma.referralCode.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true },
  })
  const codedSet = new Set(hasCodes.map((r) => r.userId))
  const candidates = userIds.filter((id) => !codedSet.has(id))
  if (candidates.length === 0) return []

  const { openIdMap, quotaSet, sentSet } = await buildCandidateFilters({
    userIds: candidates,
    templateId: TEMPLATE_REFERRAL,
    ruleId: RULE_ID,
    cooldownMs: 30 * DAY_MS,
  })

  const result: RuleUser[] = []
  for (const id of candidates) {
    const openid = openIdMap.get(id)
    if (!openid || !quotaSet.has(id) || sentSet.has(id)) continue
    result.push({
      userId: id, openid,
      templateId: TEMPLATE_REFERRAL,
      templateData: {
        thing1: '邀请好友得7天体验会员',
        thing2: '好友完成首次付费后双方均可获得体验权益，点击查看专属邀请码',
      },
      refId: null,
    })
  }
  return result
}
