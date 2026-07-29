/**
 * R15 — 首扫奖励（小程序专有）
 *
 * 触发条件：
 *  - AppUser.firstScanAt 在过去 30-60 分钟内
 *  - 用户对 TEMPLATE_R15 的 SubscribeQuota > 0
 *  - 无 PushLog（userId + ruleId=R15）
 *
 * 推送话术：沿用最终版-全量话术优化版
 *   主体：「您已完成首次扫码识别，当前可领取 7 天体验会员权益，期间可继续体验更多功能与服务」
 *   备注：「点击查看体验权益说明并开始使用」
 *
 * 成功后：push/send 层额外给用户开通 7 天体验会员（见 routes.ts）
 */
import { prisma } from '../../db.js'
import type { RuleQuery, RuleUser } from './types.js'
import { TEMPLATE_R15 } from './types.js'

const RULE_ID = 'R15'
const REWARD_DAYS = 7
// phrase 类型限 5 字。原文案「首次扫码体验权益」8 字被 wx 拒，缩为「首扫奖励」
const REWARD_TITLE = '首扫奖励'
// thing 类型限 20 字；当前 14 字，沿用最终版-全量话术
const REWARD_NOTE = '点击查看体验权益说明并开始使用'

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const query: RuleQuery = async () => {
  const now = Date.now()
  const lower = new Date(now - 60 * 60 * 1000)
  const upper = new Date(now - 30 * 60 * 1000)

  const users = await prisma.appUser.findMany({
    where: {
      firstScanAt: { gte: lower, lte: upper },
      openId: { not: null },
    },
    select: { id: true, openId: true, firstScanAt: true },
  })
  if (users.length === 0) return []

  const userIds = users.map((u) => u.id)

  const [quotas, existingLogs] = await Promise.all([
    prisma.subscribeQuota.findMany({
      where: { userId: { in: userIds }, templateId: TEMPLATE_R15, quota: { gt: 0 } },
    }),
    prisma.pushLog.findMany({
      where: { ruleId: RULE_ID, userId: { in: userIds } },
      select: { userId: true },
    }),
  ])

  const quotaSet = new Set(quotas.map((q) => q.userId))
  const sentSet = new Set(existingLogs.map((l) => l.userId))

  const result: RuleUser[] = []
  for (const u of users) {
    if (!quotaSet.has(u.id)) continue
    if (sentSet.has(u.id)) continue

    const expireAt = new Date(u.firstScanAt!.getTime() + REWARD_DAYS * 24 * 60 * 60 * 1000)

    result.push({
      userId: u.id,
      openid: u.openId!,
      templateId: TEMPLATE_R15,
      templateData: {
        // 模板 9rWcAqy1... 的实际字段 key（2026-04-14 与公众平台核对）：
        //   phrase1  奖励说明（phrase 限 5 字）
        //   time2    奖励时长
        //   thing3   备注（thing 限 20 字）
        //   number4  奖励天数（number 类型必须是整数）
        //   time5    到期时间（wx 模板标记为 time 类型）
        phrase1: REWARD_TITLE,
        time2: `${REWARD_DAYS}天`,
        thing3: REWARD_NOTE,
        number4: REWARD_DAYS,
        time5: fmtDate(expireAt),
      },
      refId: null,
    })
  }
  return result
}
