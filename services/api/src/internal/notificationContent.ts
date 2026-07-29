/**
 * 推送成功后的站内通知文案生成（push/send → Notification 顺手写）
 *
 * 文案来源：营销自动化方案-最终版-全量话术优化版
 * 未登记的 ruleId 走通用 fallback，不会报错
 */
import type { Prisma } from '@prisma/client'

export interface NotificationPayload {
  title: string
  body: string
  link: string | null
  type: string // RULE_PUSH 为主，其他来源可扩展
}

export function buildNotificationFromPush(params: {
  ruleId: string
  templateData: Record<string, string | number>
  refId: string | null
}): NotificationPayload {
  const { ruleId, templateData, refId } = params

  switch (ruleId) {
    case 'R01':
      return {
        title: '还没开始使用？',
        body: '您尚未完成首次标准检索。搜索第一个标准只需 3 秒，48.7万+ 标准库即刻可用',
        link: '/standards',
        type: 'RULE_PUSH',
      }
    case 'R02':
      return {
        title: '还有更多功能等您探索',
        body: '首次检索完成！相似度比对、AI 大纲生成、小智问答均已开放使用',
        link: '/',
        type: 'RULE_PUSH',
      }
    case 'R04':
      return {
        title: 'AI 大纲生成次数即将用完',
        body: `剩余 ${String(templateData.number4 ?? '')} 次。开通会员可继续使用更多配额，保持创作不中断`,
        link: '/membership',
        type: 'RULE_PUSH',
      }
    case 'R05':
      return {
        title: '小智问答次数即将用完',
        body: `剩余 ${String(templateData.number4 ?? '')} 次。开通会员可继续使用更多问答配额`,
        link: '/membership',
        type: 'RULE_PUSH',
      }
    case 'R06':
      return {
        title: '订单待支付提醒',
        body: '您有一笔会员订单待支付，可在有效期内继续完成，相关权益将在支付成功后生效',
        link: refId ? `/orders?orderNo=${encodeURIComponent(refId)}` : '/orders',
        type: 'RULE_PUSH',
      }
    case 'R07':
      return {
        title: '您近期使用频繁，可解锁更多功能',
        body: '会员可获得更多比对次数、AI 大纲配额与完整结果查看能力',
        link: '/membership',
        type: 'RULE_PUSH',
      }
    case 'R08':
      return {
        title: '欢迎开通标准小智会员',
        body: '建议从全库相似度分析功能入手，开始您的首次会员体验',
        link: '/compare',
        type: 'RULE_PUSH',
      }
    case 'R09':
      return {
        title: '全库比对次数即将用完',
        body: `剩余 ${String(templateData.number4 ?? '')} 次。建议优先用于重点文档；如需更多次数可查看当前会员方案`,
        link: '/compare',
        type: 'RULE_PUSH',
      }
    case 'R10':
      return {
        title: '会员即将到期',
        body: `您的会员将于 ${String(templateData.date2 ?? '近期')} 到期。续费后可继续使用全部会员权益，避免使用中断`,
        link: '/membership',
        type: 'RULE_PUSH',
      }
    case 'R11':
      return {
        title: '会员已到期',
        body: '如需继续使用比对、大纲等功能，可查看当前续费方案',
        link: '/membership',
        type: 'RULE_PUSH',
      }
    case 'R12':
      return {
        title: '近期标准库有更新',
        body: '点击返回继续使用常用功能，查看与您相关的最新标准内容',
        link: '/',
        type: 'RULE_PUSH',
      }
    case 'R13':
      return {
        title: '已为您保留一次体验权益',
        body: '点击查看限时全库比对体验次数，继续上次未完成的工作',
        link: '/compare',
        type: 'REWARD',
      }
    case 'R14':
      // 兼容两种 R14 场景：邀请引导推送 + 奖励到账推送
      if (String(templateData.thing1 ?? '').includes('奖励已到账')) {
        return {
          title: '邀请奖励已到账',
          body: '您邀请的好友已完成首次付费，30 天会员已发放至您的账户',
          link: '/membership',
          type: 'REWARD',
        }
      }
      return {
        title: '邀请好友得7天体验会员',
        body: '好友完成首次付费后双方均可获得体验权益，点击查看专属邀请码',
        link: '/membership',
        type: 'RULE_PUSH',
      }
    case 'R15':
      return {
        title: '首扫体验权益已送达',
        body: '您已完成首次扫码识别，当前可领取 7 天体验会员权益，期间可继续体验更多功能与服务',
        link: '/membership/benefits',
        type: 'REWARD',
      }
    default:
      return {
        title: `标准小智消息（${ruleId}）`,
        body: Object.values(templateData).slice(0, 2).join(' · ') || '您有一条新消息，请查收',
        link: null,
        type: 'RULE_PUSH',
      }
  }
}

/**
 * 生成 prisma notification.create 的 data，便于在事务内复用
 */
export function buildNotificationCreateData(
  userId: string,
  payload: NotificationPayload,
): Prisma.NotificationCreateInput {
  return {
    appUser: { connect: { id: userId } },
    title: payload.title,
    body: payload.body,
    type: payload.type,
    link: payload.link,
  }
}
