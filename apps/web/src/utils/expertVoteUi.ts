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

export const USER_EXPERT_VOTE_STATUS_LABEL: Record<ExpertVoteStatus, string> = {
  DRAFT: '草稿',
  PAYING: '支付中',
  EXPERT_ARRANGING: '专家组织中',
  MEETING_SCHEDULED: '会议已定',
  VOTING: '会后结果整理中',
  VOTED: '整理已完成',
  SIGNING: '确认文件处理中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

export const USER_EXPERT_VOTE_STATUS_COLOR: Record<ExpertVoteStatus, string> = {
  DRAFT: 'default',
  PAYING: 'gold',
  EXPERT_ARRANGING: 'processing',
  MEETING_SCHEDULED: 'cyan',
  VOTING: 'blue',
  VOTED: 'geekblue',
  SIGNING: 'purple',
  COMPLETED: 'success',
  CANCELLED: 'default',
  REFUNDED: 'warning',
}

export const ADMIN_EXPERT_VOTE_STATUS_LABEL: Record<ExpertVoteStatus, string> = {
  DRAFT: '草稿',
  PAYING: '待支付',
  EXPERT_ARRANGING: '待安排',
  MEETING_SCHEDULED: '会议已定',
  VOTING: '待整理结果',
  VOTED: '待生成确认文件',
  SIGNING: '待上传交付文件',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

export const ADMIN_EXPERT_VOTE_STATUS_COLOR: Record<ExpertVoteStatus, string> = {
  DRAFT: 'default',
  PAYING: 'orange',
  EXPERT_ARRANGING: 'processing',
  MEETING_SCHEDULED: 'cyan',
  VOTING: 'purple',
  VOTED: 'geekblue',
  SIGNING: 'purple',
  COMPLETED: 'success',
  CANCELLED: 'default',
  REFUNDED: 'warning',
}

// Keep in sync with services/api/src/services/expertVote.ts:EXPERT_VOTE_REFUNDABLE_STATUSES.
export const EXPERT_VOTE_REFUNDABLE_STATUSES = [
  'EXPERT_ARRANGING',
  'MEETING_SCHEDULED',
] as const satisfies readonly ExpertVoteStatus[]

export type ExpertVoteRefundableStatus = typeof EXPERT_VOTE_REFUNDABLE_STATUSES[number]

export function isExpertVoteRefundableStatus(status: unknown): status is ExpertVoteRefundableStatus {
  return typeof status === 'string'
    && (EXPERT_VOTE_REFUNDABLE_STATUSES as readonly string[]).includes(status)
}

export interface RefundableOrderCandidate {
  status?: string | null
  productType?: string | null
  expertVoteRequestStatus?: string | null
}

export function canRefundOrder(order?: RefundableOrderCandidate | null): boolean {
  if (!order || order.status !== 'PAID') return false
  if (order.productType !== 'EXPERT_VOTE') return true
  return isExpertVoteRefundableStatus(order.expertVoteRequestStatus)
}

export function getExpertVoteStatusLabel(status: string | null | undefined, audience: 'user' | 'admin' = 'user'): string {
  const labels = audience === 'admin' ? ADMIN_EXPERT_VOTE_STATUS_LABEL : USER_EXPERT_VOTE_STATUS_LABEL
  return status && status in labels ? labels[status as ExpertVoteStatus] : '未知状态'
}

export function getExpertVoteStatusColor(status: string | null | undefined, audience: 'user' | 'admin' = 'user'): string {
  const colors = audience === 'admin' ? ADMIN_EXPERT_VOTE_STATUS_COLOR : USER_EXPERT_VOTE_STATUS_COLOR
  return status && status in colors ? colors[status as ExpertVoteStatus] : 'default'
}

export function getAdminDisplayStatus(record: { status?: string | null } | null | undefined): { label: string; color: string } {
  const status = record?.status
  return {
    label: getExpertVoteStatusLabel(status, 'admin'),
    color: getExpertVoteStatusColor(status, 'admin'),
  }
}
