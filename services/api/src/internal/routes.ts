/**
 * 营销自动化路由
 *  - /api/internal/*        n8n 调用，x-internal-token 验签
 *  - /api/subscribe/grant   小程序调用，用户登录态
 */
import type { Express, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { logger } from '../logger.js'
import { requireAuth, type AuthRequest } from '../auth.js'
import { trackServerEvent, markUserActive } from '../tracker.js'
import { RULES, isKnownRule } from './rules/index.js'
import { sendSubscribeMessage } from './wxSubscribeMessage.js'
import { buildNotificationFromPush } from './notificationContent.js'
import { writeAuditLog } from '../utils/auditLog.js'

// ─── 内部认证中间件 ─────────────────────────────────────────

function requireInternalToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_SECRET
  if (!expected) {
    // 未配置秘钥 = 禁用内部接口（避免无密码裸奔）
    logger.error({ module: 'internal' }, 'INTERNAL_API_SECRET 未配置，内部接口全部拒绝')
    return res.status(503).json({ error: '内部接口未启用' })
  }
  const got = req.headers['x-internal-token']
  if (typeof got !== 'string' || got !== expected) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

// ─── R15 首扫奖励：发送成功后开通 7 天体验会员 ───────────────

async function grantR15TrialMembership(userId: string, refId: string | null) {
  // 叠加模式：若当前有 ACTIVE 会员，从最晚 endAt 续 7 天；否则从现在起 7 天
  const current = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE', endAt: { gte: new Date() } },
    orderBy: { endAt: 'desc' },
  })
  const startAt = current ? current.endAt : new Date()
  const endAt = new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000)

  const membership = await prisma.userMembership.create({
    data: {
      userId,
      planId: 'personal',
      status: 'ACTIVE',
      source: 'SYSTEM',
      sourceRef: `R15_FIRST_SCAN_REWARD${refId ? ':' + refId : ''}`,
      startAt,
      endAt,
    },
  })
  trackServerEvent('membership_activated', {
    planId: 'personal',
    source: 'SYSTEM',
    sourceRef: membership.sourceRef,
    isRenewal: !!current,
    endAt: membership.endAt.toISOString(),
    rewardRule: 'R15',
  }, userId)
  markUserActive(userId)
  await writeAuditLog({
    actor: userId,
    action: 'MEMBERSHIP_CREATED',
    targetType: 'UserMembership',
    targetId: membership.id,
    diff: {
      userId,
      planId: 'personal',
      source: 'SYSTEM',
      sourceRef: membership.sourceRef,
      startAt: membership.startAt.toISOString(),
      endAt: membership.endAt.toISOString(),
      isRenewal: !!current,
      rewardRule: 'R15',
    },
  })
  return membership
}

// ─── 请求体 schema ─────────────────────────────────────────

const pushSendSchema = z.object({
  userId: z.string().min(1),
  openid: z.string().min(1),
  ruleId: z.string().min(1),
  templateId: z.string().min(1),
  templateData: z.record(z.union([z.string(), z.number()])),
  refId: z.string().nullable().optional(),
  page: z.string().optional(),
})

const subscribeGrantSchema = z.object({
  templateId: z.string().min(1),
})

// ─── 路由注册 ───────────────────────────────────────────────

export function registerInternalRoutes(app: Express): void {
  // GET /api/internal/users/rule/:ruleId — 返回待推用户
  app.get('/api/internal/users/rule/:ruleId', requireInternalToken, async (req, res) => {
    const ruleId = String(req.params.ruleId)
    if (!isKnownRule(ruleId)) {
      return res.status(404).json({ error: `未知规则: ${ruleId}` })
    }
    try {
      const users = await RULES[ruleId]()
      res.json({ ruleId, users })
    } catch (err: any) {
      logger.error({ module: 'internal', ruleId, err }, '规则查询失败')
      res.status(500).json({ error: '规则查询异常' })
    }
  })

  // POST /api/internal/push/send — 下发 + 扣配额 + 写日志
  app.post('/api/internal/push/send', requireInternalToken, async (req, res) => {
    const parsed = pushSendSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ success: false, reason: 'BAD_REQUEST' })
    const { userId, openid, ruleId, templateId, templateData, refId, page } = parsed.data

    // 1) 去重：同 userId+ruleId+refId 的 SUCCESS 已发过？
    const already = await prisma.pushLog.findFirst({
      where: { userId, ruleId, refId: refId ?? null, status: 'SUCCESS' },
    })
    if (already) {
      return res.json({ success: false, reason: 'ALREADY_SENT' })
    }

    // 2) 配额：SubscribeQuota[userId,templateId].quota > 0 才放行
    const quotaRow = await prisma.subscribeQuota.findUnique({
      where: { userId_templateId: { userId, templateId } },
    })
    if (!quotaRow || quotaRow.quota <= 0) {
      return res.json({ success: false, reason: 'NO_QUOTA' })
    }

    // 3) 下发
    const sendResult = await sendSubscribeMessage({
      touser: openid,
      templateId,
      data: templateData,
      page,
    })

    if (sendResult.ok) {
      // 扣配额 + 写成功日志 + 写站内通知（同事务）
      const notif = buildNotificationFromPush({ ruleId, templateData, refId: refId ?? null })
      const log = await prisma.$transaction(async (tx) => {
        await tx.subscribeQuota.update({
          where: { userId_templateId: { userId, templateId } },
          data: { quota: { decrement: 1 } },
        })
        await tx.notification.create({
          data: {
            userId,
            title: notif.title,
            body: notif.body,
            type: notif.type,
            link: notif.link,
          },
        })
        return tx.pushLog.create({
          data: { userId, ruleId, templateId, status: 'SUCCESS', refId: refId ?? null },
        })
      })

      // R15 附带权益发放（独立事务，发放失败只记日志不撤销推送）
      if (ruleId === 'R15') {
        try {
          await grantR15TrialMembership(userId, refId ?? null)
        } catch (err) {
          logger.error({ module: 'internal', userId, err }, 'R15 权益发放失败（推送已成功）')
        }
      }

      // R13 附带体验权益：全库比对 +1 次
      if (ruleId === 'R13') {
        try {
          await prisma.appUser.update({
            where: { id: userId },
            data: { bonusCompareQuota: { increment: 1 } },
          })
          trackServerEvent('bonus_quota_granted', { source: 'R13', delta: 1 }, userId)
        } catch (err) {
          logger.error({ module: 'internal', userId, err }, 'R13 bonus quota 发放失败（推送已成功）')
        }
      }

      return res.json({ success: true, pushLogId: log.id })
    }

    // 下发失败：写失败日志
    await prisma.pushLog.create({
      data: {
        userId, ruleId, templateId,
        status: 'FAILED',
        refId: refId ?? null,
        errorMsg: `errcode=${sendResult.errcode ?? ''} errmsg=${sendResult.errmsg ?? ''}`.slice(0, 500),
      },
    })
    return res.json({ success: false, reason: 'WECHAT_ERROR', errcode: sendResult.errcode, errmsg: sendResult.errmsg })
  })

  // GET /api/internal/push/stats — 最近 7 天各规则推送统计
  app.get('/api/internal/push/stats', requireInternalToken, async (_req, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const rows = await prisma.pushLog.groupBy({
      by: ['ruleId', 'status'],
      where: { sentAt: { gte: since } },
      _count: { _all: true },
    })
    const stats: Record<string, { total: number; success: number; failed: number; skipped: number }> = {}
    for (const r of rows) {
      if (!stats[r.ruleId]) stats[r.ruleId] = { total: 0, success: 0, failed: 0, skipped: 0 }
      const n = r._count._all
      stats[r.ruleId].total += n
      if (r.status === 'SUCCESS') stats[r.ruleId].success += n
      else if (r.status === 'FAILED') stats[r.ruleId].failed += n
      else if (r.status === 'SKIPPED') stats[r.ruleId].skipped += n
    }
    res.json({ windowDays: 7, since: since.toISOString(), stats })
  })

  // POST /api/subscribe/grant — 小程序调用：用户同意订阅后，quota +1
  app.post('/api/subscribe/grant', requireAuth as any, async (req: AuthRequest, res) => {
    const parsed = subscribeGrantSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: '参数错误' })
    const userId = req.userId!
    const { templateId } = parsed.data

    const row = await prisma.subscribeQuota.upsert({
      where: { userId_templateId: { userId, templateId } },
      create: { userId, templateId, quota: 1 },
      update: { quota: { increment: 1 } },
    })
    res.json({ ok: true, templateId, quota: row.quota })
  })
}

