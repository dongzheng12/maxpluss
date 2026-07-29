/**
 * 专家评审投票（P0-1）
 *
 * 责任边界：
 *   - 状态机定义 + CAS 迁移工具
 *   - SystemSetting 读取（单价 / 14 天约束 / 文件上限 / 短信开关）
 *   - 业务编号生成（EVR-）
 *   - 金额计算（不信任前端，按 expertCount × unitPrice 锁快照）
 *
 * 第一版不暴露后台接口，但 SystemSetting key 与状态机已就位，
 * 后续 P0-2 / P0-3 增量补 admin 路由 / 投票 / 签章时不需要再改本模块结构。
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

// ─── 状态机 ───────────────────────────────────────────────────

export type ExpertVoteStatus =
  | 'DRAFT'
  | 'PAYING'
  | 'EXPERT_ARRANGING'
  | 'MEETING_SCHEDULED'
  | 'VOTING'
  | 'VOTED'
  | 'SIGNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED'

export const EXPERT_VOTE_STATUSES: readonly ExpertVoteStatus[] = [
  'DRAFT',
  'PAYING',
  'EXPERT_ARRANGING',
  'MEETING_SCHEDULED',
  'VOTING',
  'VOTED',
  'SIGNING',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
] as const

/**
 * 允许的状态迁移（白名单）
 *
 * 人工流程节点：
 *   DRAFT → PAYING (用户提交并下单)
 *   PAYING → EXPERT_ARRANGING (支付回调；handlePostPaymentInTx)
 *   PAYING → CANCELLED (用户取消 / orderSweeper 超时)
 *   EXPERT_ARRANGING → MEETING_SCHEDULED (后台确认会议)
 *   MEETING_SCHEDULED → VOTING (后台手动进入会后整理；VOTING = 会后结果整理中，会议已开完)
 *   VOTING → VOTED (全部专家提交 或 后台手动关闭)
 *   VOTED → SIGNING (后台生成 Word 确认文件)
 *   SIGNING → COMPLETED (后台上传已签章 PDF，真终态)
 *   会后整理前 → REFUNDED (退款联动；VOTING 起专家资源已实际占用，不可退)
 */
export const EXPERT_VOTE_TRANSITIONS: Record<ExpertVoteStatus, ReadonlyArray<ExpertVoteStatus>> = {
  DRAFT:              ['PAYING', 'CANCELLED'],
  PAYING:             ['EXPERT_ARRANGING', 'CANCELLED'],
  EXPERT_ARRANGING:   ['MEETING_SCHEDULED', 'REFUNDED'],
  MEETING_SCHEDULED:  ['VOTING', 'REFUNDED'],
  VOTING:             ['VOTED'],
  VOTED:              ['SIGNING'],
  SIGNING:            ['COMPLETED'],
  COMPLETED:          [],
  CANCELLED:          [],
  REFUNDED:           [],
}

export const EXPERT_VOTE_REFUNDABLE_STATUSES: readonly ExpertVoteStatus[] = [
  'EXPERT_ARRANGING',
  'MEETING_SCHEDULED',
] as const

export function isExpertVoteRefundableStatus(status: string | null | undefined): status is ExpertVoteStatus {
  return EXPERT_VOTE_REFUNDABLE_STATUSES.includes(status as ExpertVoteStatus)
}

export function isAllowedTransition(from: ExpertVoteStatus, to: ExpertVoteStatus): boolean {
  return EXPERT_VOTE_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * CAS 状态迁移：仅当当前 status 仍为 expectedFrom 时才更新。
 * 双击 / 并发场景下避免状态跳跃。
 *
 * 返回 true = 实际更新，false = 状态已被其他操作改写（调用方应当重读）。
 */
export async function transitionStatus(
  client: Prisma.TransactionClient | typeof prisma,
  requestNo: string,
  expectedFrom: ExpertVoteStatus,
  to: ExpertVoteStatus,
  patch: Record<string, any> = {},
): Promise<boolean> {
  if (!isAllowedTransition(expectedFrom, to)) {
    throw new Error(`非法状态迁移: ${expectedFrom} → ${to}`)
  }
  const result = await client.expertVoteRequest.updateMany({
    where: { requestNo, status: expectedFrom },
    data: { status: to, ...patch },
  })
  return result.count === 1
}

// ─── 业务编号 ────────────────────────────────────────────────

/**
 * 生成 EVR-YYYYMMDDHHmmss-xxxxxx 业务编号
 * 与 makeBusinessNo（appRoutes.ts:580）格式一致，但 prefix 是 'EVR'。
 */
export function makeExpertVoteRequestNo(): string {
  const now = new Date()
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const random = Math.floor(Math.random() * 900000 + 100000)
  return `EVR-${parts}-${random}`
}

// ─── SystemSetting ───────────────────────────────────────────

export const EXPERT_VOTE_SETTING_KEYS = {
  UNIT_PRICE:     'expert_vote_unit_price',     // 单专家单价（分），默认 200000
  MIN_LEAD_DAYS:  'expert_vote_min_lead_days',  // 最早预约提前天数，默认 14
  FILE_MAX_MB:    'expert_vote_file_max_mb',    // 单文件上限（MB），默认 50
  TOTAL_MAX_MB:   'expert_vote_total_max_mb',   // 单申请总上限（MB），默认 200
  SMS_ENABLED:    'expert_vote_sms_enabled',    // 短信开关，默认 'false'
  PATH_A_ENABLED: 'expert_vote_path_a_enabled', // Path A 平台内自动合成开关，默认 'false'
} as const

export const EXPERT_VOTE_DEFAULTS = {
  UNIT_PRICE:    200000, // 2000 元 / 位
  MIN_LEAD_DAYS: 14,
  FILE_MAX_MB:   50,
  TOTAL_MAX_MB:  200,
  SMS_ENABLED:   false,
  PATH_A_ENABLED: false,
} as const

/** 快捷选项（前端 select 列表用）；实际校验只要求奇数 >= 3 */
export const PRESET_EXPERT_COUNTS: readonly number[] = [3, 5, 7, 9] as const

/** 校验专家数：必须是奇数且 >= 3 */
export function isValidExpertCount(n: number): boolean {
  return Number.isInteger(n) && n >= 3 && n % 2 === 1
}

/**
 * 启动时 ensure SystemSetting 默认值（缺则插入，已存在则不动）
 * 在 ensureAppSeed 内调用。
 */
export async function ensureExpertVoteSettings(): Promise<void> {
  const seeds: Array<{ key: string; value: string }> = [
    { key: EXPERT_VOTE_SETTING_KEYS.UNIT_PRICE,    value: String(EXPERT_VOTE_DEFAULTS.UNIT_PRICE) },
    { key: EXPERT_VOTE_SETTING_KEYS.MIN_LEAD_DAYS, value: String(EXPERT_VOTE_DEFAULTS.MIN_LEAD_DAYS) },
    { key: EXPERT_VOTE_SETTING_KEYS.FILE_MAX_MB,   value: String(EXPERT_VOTE_DEFAULTS.FILE_MAX_MB) },
    { key: EXPERT_VOTE_SETTING_KEYS.TOTAL_MAX_MB,  value: String(EXPERT_VOTE_DEFAULTS.TOTAL_MAX_MB) },
    { key: EXPERT_VOTE_SETTING_KEYS.SMS_ENABLED,   value: String(EXPERT_VOTE_DEFAULTS.SMS_ENABLED) },
    { key: EXPERT_VOTE_SETTING_KEYS.PATH_A_ENABLED, value: String(EXPERT_VOTE_DEFAULTS.PATH_A_ENABLED) },
  ]
  for (const s of seeds) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: {}, // 已存在不动 — 运营改过的不被覆盖
      create: { key: s.key, value: s.value },
    })
  }
}

async function readIntSetting(key: string, fallback: number): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key } }).catch(() => null)
  if (!row) return fallback
  const n = Number(row.value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

async function readBoolSetting(key: string, fallback: boolean): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({ where: { key } }).catch(() => null)
  if (!row) return fallback
  return row.value === 'true' || row.value === '1'
}

export async function getExpertVoteUnitPrice(): Promise<number> {
  return readIntSetting(EXPERT_VOTE_SETTING_KEYS.UNIT_PRICE, EXPERT_VOTE_DEFAULTS.UNIT_PRICE)
}

export async function getExpertVoteMinLeadDays(): Promise<number> {
  return readIntSetting(EXPERT_VOTE_SETTING_KEYS.MIN_LEAD_DAYS, EXPERT_VOTE_DEFAULTS.MIN_LEAD_DAYS)
}

export async function getExpertVoteFileMaxBytes(): Promise<number> {
  const mb = await readIntSetting(EXPERT_VOTE_SETTING_KEYS.FILE_MAX_MB, EXPERT_VOTE_DEFAULTS.FILE_MAX_MB)
  return mb * 1024 * 1024
}

export async function getExpertVoteTotalMaxBytes(): Promise<number> {
  const mb = await readIntSetting(EXPERT_VOTE_SETTING_KEYS.TOTAL_MAX_MB, EXPERT_VOTE_DEFAULTS.TOTAL_MAX_MB)
  return mb * 1024 * 1024
}

export async function getExpertVoteSmsEnabled(): Promise<boolean> {
  return readBoolSetting(EXPERT_VOTE_SETTING_KEYS.SMS_ENABLED, EXPERT_VOTE_DEFAULTS.SMS_ENABLED)
}

export async function getExpertVotePathAEnabled(): Promise<boolean> {
  return readBoolSetting(EXPERT_VOTE_SETTING_KEYS.PATH_A_ENABLED, EXPERT_VOTE_DEFAULTS.PATH_A_ENABLED)
}

// ─── 校验 ────────────────────────────────────────────────────

/**
 * 校验期望会议日期符合 14 天硬性提前约束。
 * 双向校验：前端会做一次，后端再做一次，避免被绕过。
 *
 * 抛错时调用方应转 400。
 */
export async function assertDesiredDateLeadTime(desiredDate: Date | null | undefined): Promise<void> {
  if (!desiredDate) return // 字段允许为空（DRAFT 阶段），交由提交时再校验
  const minLeadDays = await getExpertVoteMinLeadDays()
  const now = new Date()
  // 今天 00:00（本地时区，与前端 datepicker 一致）
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const earliest = new Date(today.getTime() + minLeadDays * 24 * 60 * 60 * 1000)
  if (desiredDate.getTime() < earliest.getTime()) {
    throw new Error(`期望会议日期需提前 ${minLeadDays} 天以上`)
  }
}

/**
 * 计算订单金额（分）= expertCount × unitPrice。
 * 第一版固定公式，不含平台费 / 加急费 / 复杂度费用。
 */
export function calcExpertVoteAmount(expertCount: number, unitPrice: number): number {
  if (!Number.isInteger(expertCount) || expertCount <= 0) {
    throw new Error('专家数量非法')
  }
  if (!Number.isInteger(unitPrice) || unitPrice <= 0) {
    throw new Error('单专家单价非法')
  }
  return expertCount * unitPrice
}

// ─── 提交时校验（草稿 → 下单）────────────────────────────────

// 提交（DRAFT → PAYING）时必填字段清单
// ⚠️ 与 apps/web/src/pages/expert-vote/new.tsx buildPayload 必须保持一致
//    & apps/mp-weixin/pages/expert-vote/edit/index.js _toDraftPayload 必须保持一致
// 任一端漏发字段 → assertDraftSubmittable 抛"缺少必填项"，submit 返回 400
export const REQUIRED_FIELDS_ON_SUBMIT: Array<keyof ExpertVoteSubmitCheck> = [
  'contactName',
  'contactPhone',
  'projectName',
  'targetName',
  'projectType',
  'standardType',
  'standardStatus',
  'backgroundDesc',
  'expertSourceType',
  'expertCount',
  'desiredDate',
  'desiredSlot',
]

export interface ExpertVoteSubmitCheck {
  contactName: string | null
  contactPhone: string | null
  projectName: string | null
  targetName: string | null
  projectType: string | null
  standardType: string | null
  standardStatus: string | null
  backgroundDesc: string | null
  expertSourceType: string | null
  expertCount: number | null
  desiredDate: Date | null
  desiredSlot: string | null
  confidentialLevel?: string | null
  confidentialRemark?: string | null
}

/**
 * 草稿提交校验：
 * - 必填字段非空
 * - expertCount ∈ {3,5,7,9}
 * - 涉密时 confidentialRemark 必填
 * - 14 天提前约束
 */
export async function assertDraftSubmittable(req: ExpertVoteSubmitCheck): Promise<void> {
  for (const k of REQUIRED_FIELDS_ON_SUBMIT) {
    const v = (req as any)[k]
    if (v === null || v === undefined || v === '') {
      throw new Error(`缺少必填项: ${String(k)}`)
    }
  }
  // 手机号格式校验（字段为 null 已被 REQUIRED_FIELDS_ON_SUBMIT 拦截）
  if (req.contactPhone && !/^1[3-9]\d{9}$/.test(req.contactPhone)) {
    throw new Error('申请人电话格式无效，请输入有效的中国大陆手机号')
  }
  if (!isValidExpertCount(req.expertCount as number)) {
    throw new Error('专家数量必须为奇数且不少于 3 位')
  }
  if ((req.confidentialLevel === 'SENSITIVE' || req.confidentialLevel === 'STRICT') &&
      !req.confidentialRemark) {
    throw new Error('涉密申请须填写保密要求说明')
  }
  await assertDesiredDateLeadTime(req.desiredDate)
}
