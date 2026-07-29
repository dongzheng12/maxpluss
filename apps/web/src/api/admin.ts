import { nodeApi } from './client'

/* ---- Dashboard stats ---- */
export async function getDashboardStats() {
  // aggregate from multiple sources
  const [orders, bookings, tasks] = await Promise.all([
    nodeApi.get('/api/app/orders').catch(() => ({ items: [] })),
    nodeApi.get('/api/app/bookings').catch(() => ({ items: [] })),
    nodeApi.get('/api/app/compare/tasks').catch(() => ({ items: [] })),
  ])
  return { orders, bookings, tasks }
}

/* ---- Users ---- */
export async function adminListUsers(params?: { page?: number; pageSize?: number }) {
  return nodeApi.get('/api/admin/users', { params })
}
export async function adminChangeUserRole(id: string, role: string) {
  return nodeApi.patch(`/api/admin/users/${id}/role`, { role })
}

/* ---- Standards admin ---- */
export async function adminListStandards() {
  return nodeApi.get('/api/admin/standards')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminCreateStandard(data: any) {
  return nodeApi.post('/api/admin/standards', data)
}
export async function adminGetContent(id: string) {
  return nodeApi.get(`/api/admin/standards/${id}/content`)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminUpdateContent(id: string, data: any) {
  return nodeApi.post(`/api/admin/standards/${id}/content`, data)
}

/* ---- Ingestion ---- */
export async function listIngestionJobs() {
  return nodeApi.get('/api/admin/ingestion-jobs')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createIngestionJob(data: any) {
  return nodeApi.post('/api/admin/ingestion-jobs', data)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function importData(data: any) {
  return nodeApi.post('/api/admin/ingestion-jobs/import', data)
}

/* ---- Audit ---- */
export async function listAudits() {
  return nodeApi.get('/api/admin/audits')
}
export async function approveAudit(id: string) {
  return nodeApi.post(`/api/admin/audits/${id}/approve`)
}
export async function rejectAudit(id: string, reason?: string) {
  return nodeApi.post(`/api/admin/audits/${id}/reject`, { reason })
}
export async function listAuditLogs() {
  return nodeApi.get('/api/admin/audit-logs')
}

/* ---- Order receipt management ---- */
export async function adminConfirmReceipt(orderNo: string) {
  return nodeApi.post(`/api/admin/orders/${orderNo}/confirm`)
}
export async function adminRejectReceipt(orderNo: string) {
  return nodeApi.post(`/api/admin/orders/${orderNo}/reject-receipt`)
}

/* ---- System settings ---- */
export async function getSystemSettings() {
  return nodeApi.get('/api/admin/settings')
}
export async function saveSystemSettings(settings: Record<string, string>) {
  return nodeApi.post('/api/admin/settings', settings)
}

/* ---- Scenes ---- */
export async function listScenes() {
  return nodeApi.get('/api/admin/scenes')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createScene(data: any) {
  return nodeApi.post('/api/admin/scenes', data)
}
export async function getScene(id: string) {
  return nodeApi.get(`/api/admin/scenes/${id}`)
}


/* ---- Expert Vote (P0-2A) ---- */
export async function adminListExpertVotes(params?: {
  status?: string; page?: number; pageSize?: number; q?: string; includeDraft?: boolean
}) {
  return nodeApi.get('/api/admin/expert-votes', { params })
}
export async function adminGetExpertVote(no: string) {
  return nodeApi.get(`/api/admin/expert-votes/${no}`)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminPutExpertVoteExperts(no: string, experts: any[], changeReason?: string) {
  return nodeApi.put(`/api/admin/expert-votes/${no}/experts`, { experts, ...(changeReason ? { changeReason } : {}) })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminPatchExpertVoteMeeting(no: string, meeting: any, changeReason?: string) {
  return nodeApi.patch(`/api/admin/expert-votes/${no}/meeting`, { ...meeting, ...(changeReason ? { changeReason } : {}) })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminSaveExpertVoteArrangement(no: string, experts: any[], meeting: any, changeReason?: string) {
  return nodeApi.patch(`/api/admin/expert-votes/${no}/arrangement`, {
    ...meeting,
    experts,
    ...(changeReason ? { changeReason } : {}),
  })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminConfirmExpertVoteMeeting(no: string, meeting?: any) {
  return nodeApi.post(`/api/admin/expert-votes/${no}/confirm-meeting`, meeting || {})
}
export async function adminDownloadExpertVoteAttachment(no: string, aid: string) {
  return nodeApi.get<unknown, Blob>(`/api/admin/expert-votes/${no}/attachments/${aid}/download`, { responseType: 'blob' })
}


// 通知文本 + 标记（P0-2B）
export async function adminGetExpertVoteNotificationTexts(no: string) {
  return nodeApi.get(`/api/admin/expert-votes/${no}/notification-texts`)
}
export async function adminMarkExpertVoteNotified(no: string) {
  return nodeApi.post(`/api/admin/expert-votes/${no}/mark-notified`, {})
}

// 会后整理
export async function adminStartVoting(no: string) {
  return nodeApi.post(`/api/admin/expert-votes/${no}/start-voting`, {})
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminPutVotingResults(no: string, body: { conclusion?: string; conclusionRemark?: string; votes: any[] }) {
  return nodeApi.put(`/api/admin/expert-votes/${no}/voting-results`, body)
}
export async function adminCloseVoting(no: string) {
  return nodeApi.post(`/api/admin/expert-votes/${no}/close-voting`, {})
}

// 确认文件 + 签名
export async function adminGenerateExpertVoteResultDoc(no: string) {
  return nodeApi.post(`/api/admin/expert-votes/${no}/generate-result-doc`, {})
}
export async function adminDownloadExpertVoteResultDoc(no: string) {
  return nodeApi.get<unknown, Blob>(`/api/admin/expert-votes/${no}/download-result-doc`, { responseType: 'blob' })
}
export function adminExpertVoteResultDocUrl(no: string) {
  return `/api/admin/expert-votes/${no}/download-result-doc`
}
// Backward-compatible aliases retained through v1.1; remove in the next major version.
export const adminGenerateExpertVotePdf = adminGenerateExpertVoteResultDoc
export const adminExpertVoteResultPdfUrl = adminExpertVoteResultDocUrl

// 行级通知 + 操作记录 + 交付（Path B 线下上传）— 2026-05-06 重构
export async function adminMarkExpertNotified(no: string, aid: string) {
  return nodeApi.patch(`/api/admin/expert-votes/${no}/experts/${aid}/notify`, {})
}
export async function adminGetExpertVoteSignLogs(no: string) {
  return nodeApi.get(`/api/admin/expert-votes/${no}/sign-logs`)
}

// Path B：上传最终交付 PDF
export const adminUploadFinalDeliverableUrl = (no: string) =>
  `/api/admin/expert-votes/${no}/upload-final-deliverable`

// 后台下载最终交付文件（COMPLETED 后）
export const adminFinalDeliverableUrl = (no: string) =>
  `/api/admin/expert-votes/${no}/download-final-deliverable`
