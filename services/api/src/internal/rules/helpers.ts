/**
 * 规则查询的公共辅助：候选用户筛选（有 openId + 有配额 + 近期无同规则 PushLog）
 */
import { prisma } from '../../db.js'

export interface CandidateFilterOpts {
  userIds: string[]
  templateId: string
  ruleId: string
  /** PushLog 去重时间窗口（毫秒）；比如 R04 = 7天，R10 = 仅按周期判定传 null */
  cooldownMs?: number | null
  /** refId 列表：若提供，则按 (userId,ruleId,refId) 去重；否则按 (userId,ruleId) 去重 */
  refIds?: string[] | null
}

export interface CandidateFilterResult {
  openIdMap: Map<string, string>
  quotaSet: Set<string>
  /** key 格式：`userId` 或 `userId:refId` */
  sentSet: Set<string>
}

/**
 * 统一筛查：
 *  - openIdMap[userId] = openid（没 openId 的用户直接排除）
 *  - quotaSet 包含 SubscribeQuota.quota > 0 的 userId
 *  - sentSet 包含冷却期内已推过的去重 key
 */
export async function buildCandidateFilters(opts: CandidateFilterOpts): Promise<CandidateFilterResult> {
  const { userIds, templateId, ruleId, cooldownMs, refIds } = opts
  if (userIds.length === 0) {
    return { openIdMap: new Map(), quotaSet: new Set(), sentSet: new Set() }
  }

  const pushLogWhere: Record<string, unknown> = { ruleId }
  if (userIds.length > 0) pushLogWhere.userId = { in: userIds }
  if (cooldownMs != null) {
    pushLogWhere.sentAt = { gte: new Date(Date.now() - cooldownMs) }
  }
  if (refIds && refIds.length > 0) {
    pushLogWhere.refId = { in: refIds }
  }
  pushLogWhere.status = 'SUCCESS'

  const [users, quotas, logs] = await Promise.all([
    prisma.appUser.findMany({
      where: { id: { in: userIds }, openId: { not: null } },
      select: { id: true, openId: true },
    }),
    prisma.subscribeQuota.findMany({
      where: { userId: { in: userIds }, templateId, quota: { gt: 0 } },
      select: { userId: true },
    }),
    prisma.pushLog.findMany({
      where: pushLogWhere,
      select: { userId: true, refId: true },
    }),
  ])

  const openIdMap = new Map(users.map((u) => [u.id, u.openId!]))
  const quotaSet = new Set(quotas.map((q) => q.userId))
  const sentSet = new Set<string>()
  for (const l of logs) {
    if (refIds) sentSet.add(`${l.userId}:${l.refId}`)
    else sentSet.add(l.userId)
  }
  return { openIdMap, quotaSet, sentSet }
}

/** 日期格式化：YYYY 年 MM 月 DD 日 */
export function fmtDateCN(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`
}

/** 日期格式化：YYYY-MM-DD */
export function fmtDateISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const DAY_MS = 24 * 60 * 60 * 1000
export const SEVEN_DAYS_MS = 7 * DAY_MS
export const CORE_EVENTS = [
  'search_success',
  'scan_success',
  'compare_complete',
  'outline_generated',
  'chat_sent',
] as const

/** planId → 面向用户的中文展示名 */
export function planDisplayName(planId: string | null | undefined): string {
  if (planId === 'pro') return '个人会员'
  if (planId === 'enterprise') return '企业会员'
  return '个人会员'
}

/** 每日每功能免费额度 */
export const DAILY_FREE_LIMIT = 5
/** personal 会员年度全库比对额度 */
export const PERSONAL_ANNUAL_COMPARE_LIMIT = 10
