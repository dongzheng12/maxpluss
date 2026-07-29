/**
 * 埋点服务 — 统一事件写入
 * @date   2026-04-13
 *
 * 两端（PC Web / 小程序）共用同一套事件名和字段，数据统一入 AnalyticsEvent 表。
 * 客户端通过 POST /api/app/track 上报；后端关键路径直接调用 trackServerEvent()。
 */
import { prisma } from './db.js'
import { logger } from './logger.js'

interface TrackPayload {
  event: string
  props?: Record<string, unknown>
  platform: 'pc' | 'mp' | 'server'
  userId?: string | null
  sessionId?: string | null
  clientTs?: number | null
  ip?: string | null
  ua?: string | null
}

/**
 * 写入一条埋点事件（异步，不阻塞主流程）
 */
export async function trackEvent(payload: TrackPayload): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: {
        event: payload.event,
        props: payload.props ? JSON.stringify(payload.props) : null,
        platform: payload.platform,
        userId: payload.userId ?? null,
        sessionId: payload.sessionId ?? null,
        clientTs: payload.clientTs ? BigInt(payload.clientTs) : null,
        serverTs: BigInt(Date.now()),
        ip: payload.ip ?? null,
        ua: payload.ua ?? null,
      },
    })
  } catch (err) {
    // 埋点写入失败不影响主流程，只记日志
    logger.warn({ module: 'tracker', err, event: payload.event }, '埋点写入失败')
  }
}

/**
 * 后端直接上报事件（不经客户端），用于支付回调、任务完成等场景
 */
export function trackServerEvent(
  event: string,
  props: Record<string, unknown> = {},
  userId?: string | null,
): void {
  // fire-and-forget，不 await
  trackEvent({
    event,
    props,
    platform: 'server',
    userId,
  }).catch(() => {})
}

/**
 * 更新用户最近一次核心功能活跃时间（fire-and-forget）。
 * 供 search/compare/outline/chat/scan 等核心事件触发时调用。
 * 用于沉默唤醒(R12)/流失召回(R13)规则的 lastActiveAt 判定。
 */
export function markUserActive(userId: string | null | undefined): void {
  if (!userId) return
  prisma.appUser
    .updateMany({ where: { id: userId }, data: { lastActiveAt: new Date() } })
    .catch((err) => {
      logger.warn({ module: 'tracker', err, userId }, 'lastActiveAt 更新失败')
    })
}

/**
 * 记录一次扫码成功。
 * - 始终上报 scan_success
 * - 若该用户此前 firstScanAt 为空，原子写入 + 额外上报一次 first_scan（保证一生仅触发一次）
 * - 同步刷新 lastActiveAt
 * 对未登录用户（userId 缺失）只上报 scan_success。
 */
export async function trackScanSuccess(
  userId: string | null | undefined,
  props: Record<string, unknown> = {},
): Promise<void> {
  if (userId) {
    try {
      const r = await prisma.appUser.updateMany({
        where: { id: userId, firstScanAt: null },
        data: { firstScanAt: new Date() },
      })
      if (r.count === 1) {
        trackServerEvent('first_scan', props, userId)
      }
    } catch (err) {
      logger.warn({ module: 'tracker', err, userId }, '首扫标记失败')
    }
    markUserActive(userId)
  }
  trackServerEvent('scan_success', props, userId)
}

/**
 * 记录一次检索成功。
 * - 始终上报 search_success
 * - 若该用户此前 firstSearchAt 为空，原子写入 + 额外上报一次 first_search
 * - 同步刷新 lastActiveAt
 */
export async function trackSearchSuccess(
  userId: string | null | undefined,
  props: Record<string, unknown> = {},
): Promise<void> {
  if (userId) {
    try {
      const r = await prisma.appUser.updateMany({
        where: { id: userId, firstSearchAt: null },
        data: { firstSearchAt: new Date() },
      })
      if (r.count === 1) {
        trackServerEvent('first_search', props, userId)
      }
    } catch (err) {
      logger.warn({ module: 'tracker', err, userId }, '首检索标记失败')
    }
    markUserActive(userId)
  }
  trackServerEvent('search_success', props, userId)
}
