/**
 * R06 — 下单未支付召回
 *
 * 触发条件：
 *  - orders.status = PENDING
 *  - createdAt 在 30-60 分钟前
 *  - 用户对 TEMPLATE_R06 的 SubscribeQuota > 0
 *  - 无 PushLog（userId + ruleId=R06 + refId=orderNo）
 *
 * 温馨提示文案：沿用最终版-全量话术优化版
 *   「您有一笔会员订单待支付，可在有效期内继续完成，相关权益将在支付成功后生效」
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_R06 } from './types.js'

const RULE_ID = 'R06'
// 温馨提示：wx thing 类型限 20 字。最终版-全量话术原文 36 字，
// 此处截取核心语义至 16 字：「订单待支付，可在有效期内继续完成」
const TIP = '订单待支付，可在有效期内继续完成'

function fmtYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

// wx date 类型只接受 YYYY-MM-DD，不能带时分；原设计的下单时分这里丢失
function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const query: RuleQuery = async () => {
  const now = Date.now()
  const lower = new Date(now - 60 * 60 * 1000)
  const upper = new Date(now - 30 * 60 * 1000)

  const orders = await prisma.appOrder.findMany({
    where: {
      status: 'PENDING',
      userId: { not: null },
      createdAt: { gte: lower, lte: upper },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (orders.length === 0) return []

  const userIds = [...new Set(orders.map((o) => o.userId!).filter(Boolean))]

  const [users, quotas, existingLogs] = await Promise.all([
    prisma.appUser.findMany({
      where: { id: { in: userIds }, openId: { not: null } },
      select: { id: true, openId: true },
    }),
    prisma.subscribeQuota.findMany({
      where: { userId: { in: userIds }, templateId: TEMPLATE_R06, quota: { gt: 0 } },
    }),
    prisma.pushLog.findMany({
      where: { ruleId: RULE_ID, refId: { in: orders.map((o) => o.orderNo) } },
      select: { refId: true, userId: true },
    }),
  ])

  const userMap = new Map(users.map((u) => [u.id, u.openId!]))
  const quotaSet = new Set(quotas.map((q) => q.userId))
  const sentSet = new Set(existingLogs.map((l) => `${l.userId}:${l.refId}`))

  const result: RuleUser[] = []
  for (const order of orders) {
    const userId = order.userId!
    const openid = userMap.get(userId)
    if (!openid) continue
    if (!quotaSet.has(userId)) continue
    if (sentSet.has(`${userId}:${order.orderNo}`)) continue

    result.push({
      userId,
      openid,
      templateId: TEMPLATE_R06,
      templateData: {
        // 模板 xnZcI8RV... 的实际字段 key（2026-04-14 与公众平台核对）：
        //   character_string1  订单号
        //   amount2            待支付金额
        //   date3              下单时间（date 类型仅 YYYY-MM-DD，丢失时分）
        //   thing4             温馨提示（thing 限 20 字）
        //   phrase5            订单状态（phrase 限 5 字）
        character_string1: order.orderNo,
        amount2: fmtYuan(order.amount),
        date3: fmtDate(order.createdAt),
        thing4: TIP,
        phrase5: '待支付',
      },
      refId: order.orderNo,
    })
  }
  return result
}
