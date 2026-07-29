/**
 * 内部直调推送辅助 — 供后端主动触发 push（非 n8n 驱动）
 *
 * 与 POST /api/internal/push/send 同义，但：
 *  - 不经 HTTP，直接函数调用
 *  - 不用 x-internal-token（已在进程内，信任）
 *  - 失败静默（不影响主流程）
 *
 * 使用场景：
 *  - 裂变奖励到账后给邀请人推送（R14 REWARD 变种）
 *  - 其他服务端主动触达场景
 */
import { prisma } from '../db.js'
import { logger } from '../logger.js'
import { sendSubscribeMessage } from './wxSubscribeMessage.js'
import { buildNotificationFromPush } from './notificationContent.js'

export interface InternalPushParams {
  userId: string
  ruleId: string
  templateId: string
  templateData: Record<string, string | number>
  refId?: string | null
  page?: string
}

export async function sendPushForRule(params: InternalPushParams): Promise<{ ok: boolean; reason?: string }> {
  const { userId, ruleId, templateId, templateData, refId = null, page } = params

  try {
    // 1) 取 openid
    const user = await prisma.appUser.findUnique({ where: { id: userId }, select: { openId: true } })
    if (!user?.openId) return { ok: false, reason: 'NO_OPENID' }

    // 2) 去重
    const already = await prisma.pushLog.findFirst({
      where: { userId, ruleId, refId, status: 'SUCCESS' },
    })
    if (already) return { ok: false, reason: 'ALREADY_SENT' }

    // 3) 查配额
    const quota = await prisma.subscribeQuota.findUnique({
      where: { userId_templateId: { userId, templateId } },
    })
    if (!quota || quota.quota <= 0) return { ok: false, reason: 'NO_QUOTA' }

    // 4) 调微信
    const send = await sendSubscribeMessage({
      touser: user.openId, templateId, data: templateData, page,
    })

    if (send.ok) {
      const notif = buildNotificationFromPush({ ruleId, templateData, refId })
      await prisma.$transaction(async (tx) => {
        await tx.subscribeQuota.update({
          where: { userId_templateId: { userId, templateId } },
          data: { quota: { decrement: 1 } },
        })
        await tx.notification.create({
          data: { userId, title: notif.title, body: notif.body, type: notif.type, link: notif.link },
        })
        await tx.pushLog.create({
          data: { userId, ruleId, templateId, status: 'SUCCESS', refId },
        })
      })
      return { ok: true }
    }

    await prisma.pushLog.create({
      data: {
        userId, ruleId, templateId, status: 'FAILED', refId,
        errorMsg: `errcode=${send.errcode ?? ''} errmsg=${send.errmsg ?? ''}`.slice(0, 500),
      },
    })
    return { ok: false, reason: 'WECHAT_ERROR' }
  } catch (err) {
    logger.error({ module: 'pushHelper', err, userId, ruleId }, 'sendPushForRule 异常')
    return { ok: false, reason: 'EXCEPTION' }
  }
}
