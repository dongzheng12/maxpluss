import { nodeApi } from './client'

/* ---- Auth ---- */
export async function register(data: {
  phone: string; smsCode: string;
  password: string; email?: string; name?: string; organization?: string;
  salesCode?: string;
  inviteCode?: string;
}) {
  return nodeApi.post('/api/app/auth/register', data)
}

/** 登录：account 可以是手机号或邮箱 */
export async function login(account: string, password: string) {
  return nodeApi.post('/api/app/auth/login', { account, password })
}

export async function changePassword(oldPassword: string, newPassword: string) {
  return nodeApi.post('/api/app/auth/change-password', { oldPassword, newPassword })
}

export async function resetPassword(phone: string, smsCode: string, newPassword: string) {
  return nodeApi.post('/api/app/auth/reset-password', { phone, smsCode, newPassword })
}

/* ---- Auth: 验证码登录（新增）---- */

/** 获取图形验证码，返回 { token: string, svg: string } */
export async function getCaptcha(): Promise<{ token: string; svg: string }> {
  return nodeApi.get('/api/app/auth/captcha')
}

/** 发送邮箱或手机验证码 */
export async function sendVerifyCode(data: {
  target: string
  type: 'email' | 'phone'
  captchaToken: string
  captchaCode: string
  purpose?: 'login' | 'register' | 'bind' | 'reset'
}) {
  return nodeApi.post('/api/app/auth/send-code', data)
}

/** 验证码登录/注册（同一接口，无账号自动注册）*/
export async function codeLogin(data: {
  target: string
  type: 'email' | 'phone'
  code: string
  name?: string
  organization?: string
}) {
  return nodeApi.post('/api/app/auth/code-login', data)
}

export async function getProfile() {
  return nodeApi.get('/api/app/profile')
}

/* ---- Home ---- */
export async function getHomeData() {
  return nodeApi.get('/api/app/home')
}

export async function getAppConfig(): Promise<{
  copy?: Record<string, Record<string, string>>
  contact?: Record<string, string>
  share?: Record<string, string>
  flags?: Record<string, unknown>
  appMinVersion?: string
  version?: number
  membershipBenefitsMatrix?: unknown
}> {
  return nodeApi.get('/api/app/config')
}

/* ---- Membership ---- */
export async function getMembershipPlans() {
  return nodeApi.get('/api/app/membership/plans')
}

/* ---- Orders ---- */
export async function listOrders() {
  return nodeApi.get('/api/app/orders')
}

export async function createOrder(data: {
  productType: string
  productRef?: string
  planId?: string
  title: string
  amount: number
  channel?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any
}) {
  return nodeApi.post('/api/app/orders', data)
}

export async function payOrder(orderNo: string, channel = 'WECHAT', openId?: string) {
  return nodeApi.post(`/api/app/orders/${orderNo}/pay`, { channel, openId })
}

export async function getPayConfig() {
  return nodeApi.get('/api/app/pay/config')
}

/** 轮询订单支付状态（Native 支付后前端轮询） */
export async function getOrderStatus(orderNo: string): Promise<{ orderNo: string; status: string; paidAt?: string }> {
  return nodeApi.get(`/api/app/orders/${orderNo}/status`)
}

/** 取消订单 */
export async function cancelOrder(orderNo: string) {
  return nodeApi.post(`/api/app/orders/${orderNo}/cancel`)
}

/** 用户申请退款（80%退款，7天窗口） */
export async function requestRefund(orderNo: string, reason?: string) {
  return nodeApi.post(`/api/app/orders/${orderNo}/refund`, { reason })
}

/** 上传支付凭证截图 */
export async function uploadReceipt(orderNo: string, file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return nodeApi.post(`/api/app/orders/${orderNo}/receipt`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

/* ---- Compare ---- */
export async function listCompareTasks() {
  return nodeApi.get('/api/app/compare/tasks')
}

export async function createCompareTask(formData: FormData) {
  return nodeApi.post('/api/app/compare/tasks', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 30_000, // 只等 taskNo 返回，文本提取+比对在后台异步执行
  })
}

/** 全库相似度分析：提交任务（异步，立即返回 PENDING） */
export async function libraryCompare(formData: FormData) {
  return nodeApi.post('/api/app/compare/library', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 30_000, // 只等 taskNo 返回，文本提取+比对在后台异步执行
  })
}

/** 队列状态（排队中的任务数） */
export async function getQueueStatus(): Promise<{ pendingCount: number; estimateMinutes: number }> {
  return nodeApi.get('/api/app/compare/queue-status')
}

/** 轮询任务状态（轻量级） */
export async function getCompareTaskStatus(taskNo: string): Promise<{ taskNo: string; status: string; errorMessage?: string; finishedAt?: string }> {
  return nodeApi.get(`/api/app/compare/tasks/${taskNo}/status`)
}

export async function getCompareTask(taskNo: string) {
  return nodeApi.get(`/api/app/compare/tasks/${taskNo}`)
}

/** 删除比对任务（仅允许删除自己的任务） */
export async function deleteCompareTask(taskNo: string) {
  return nodeApi.delete(`/api/app/compare/tasks/${taskNo}`)
}

/** 重试失败的比对任务 */
export async function retryCompareTask(taskNo: string) {
  return nodeApi.post(`/api/app/compare/tasks/${taskNo}/retry`)
}

/** 解锁完整报告 */
export async function unlockCompareReport(taskNo: string) {
  return nodeApi.post(`/api/app/compare/tasks/${taskNo}/unlock-order`)
}

/** 查询会员全库相似度分析额度（pro 不限次 remaining=-1，personal 10次/年） */
export async function getCompareFreeQuota(): Promise<{ tier: string; used: number; limit: number; remaining: number }> {
  return nodeApi.get('/api/app/compare/free-quota')
}

/** 解锁 PDF 导出 */
export async function unlockCompareExport(taskNo: string) {
  return nodeApi.post(`/api/app/compare/tasks/${taskNo}/export-order`)
}

/* ---- Recognize ---- */
/** 统一识别：拍照/扫码 → 条码扫描优先 → OCR 兜底 */
export async function recognizeFile(formData: FormData) {
  return nodeApi.post('/api/app/recognize', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60_000,
  })
}

/** 识别 + 全库相似度分析一体化 */
export async function recognizeAndCompare(formData: FormData) {
  return nodeApi.post('/api/app/recognize-and-compare', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120_000,
  })
}

/* ---- Invoices ---- */
export async function listInvoices() {
  return nodeApi.get('/api/app/invoices')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createInvoice(data: any) {
  return nodeApi.post('/api/app/invoices', data)
}

export async function getInvoice(invoiceNo: string) {
  return nodeApi.get(`/api/app/invoices/${invoiceNo}`)
}

export async function getInvoiceStatus(orderNo: string) {
  return nodeApi.get(`/api/app/orders/${orderNo}/invoice-status`)
}

/* ---- Bookings ---- */
export async function listBookings() {
  return nodeApi.get('/api/app/bookings')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createBooking(data: any) {
  return nodeApi.post('/api/app/bookings', data)
}

/* ---- Chat (呼叫小智) ---- */
export async function createConversation() {
  return nodeApi.post('/api/app/chat/conversations')
}

export async function getConversations() {
  return nodeApi.get('/api/app/chat/conversations')
}

export async function getChatHistory(conversationId: string) {
  return nodeApi.get(`/api/app/chat/history/${conversationId}`)
}

export async function renameConversation(conversationId: string, title: string) {
  return nodeApi.patch(`/api/app/chat/conversations/${conversationId}`, { title })
}

export async function deleteConversationApi(conversationId: string) {
  return nodeApi.delete(`/api/app/chat/conversations/${conversationId}`)
}

/* ---- Notification 中心（营销自动化任务五）---- */
export interface NotificationItem {
  id: string
  userId: string
  title: string
  body: string
  type: string
  link: string | null
  readAt: string | null
  createdAt: string
}

export async function getNotifications(page = 1, pageSize = 20): Promise<{
  items: NotificationItem[]
  unreadCount: number
  total: number
  page: number
  pageSize: number
}> {
  return nodeApi.get(`/api/app/notifications?page=${page}&pageSize=${pageSize}`)
}

export async function readNotification(id: string): Promise<{ ok: boolean; updated: number }> {
  return nodeApi.post(`/api/app/notifications/${id}/read`)
}

export async function readAllNotifications(): Promise<{ ok: boolean; updated: number }> {
  return nodeApi.post('/api/app/notifications/read-all')
}

/* ---- Referral 邀请（任务六 R14）---- */
export interface ReferralCodeInfo {
  code: string
  qrcodeBase64: string
  totalInvited: number
}

export async function getReferralCode(): Promise<ReferralCodeInfo> {
  return nodeApi.get('/api/app/referral/code')
}

export async function trackReferral(scene: string): Promise<{ ok: boolean; reason?: string; referralId?: string; inviterId?: string }> {
  return nodeApi.post('/api/app/referral/track', { scene })
}

/* ---- 优惠券（阶段三）---- */
export interface ApplicableCoupon {
  id: string                  // UserCoupon.id
  couponId: string
  name: string
  code: string
  discountType: 'FIXED' | 'PERCENT'
  discountValue: number
  minAmount: number
  maxDiscount: number | null
  expiresAt: string
  calculatedDiscount: number  // 在当前订单上的实际抵扣额（分）
  applicable: boolean
  unmatchReason?: string
}

export async function getApplicableCoupons(params: {
  productType: string
  planId?: string
  productRef?: string
}): Promise<{ items: ApplicableCoupon[] }> {
  const qs = new URLSearchParams({
    productType: params.productType,
    ...(params.planId ? { planId: params.planId } : {}),
    ...(params.productRef ? { productRef: params.productRef } : {}),
  }).toString()
  return nodeApi.get(`/api/app/coupons/applicable?${qs}`)
}

export interface MyCoupon {
  id: string
  couponId: string
  status: 'AVAILABLE' | 'LOCKED' | 'USED' | 'EXPIRED' | 'REVOKED'
  source: string
  sourceRef: string | null
  issuedAt: string
  expiresAt: string
  usedAt: string | null
  usedOrderNo: string | null
  coupon: {
    code: string
    name: string
    description: string | null
    discountType: 'FIXED' | 'PERCENT'
    discountValue: number
    minAmount: number
    maxDiscount: number | null
    applicableScope: string
  }
}

export async function getMyCoupons(status?: string): Promise<{ items: MyCoupon[] }> {
  const qs = status ? `?status=${status}` : ''
  return nodeApi.get(`/api/app/coupons/my${qs}`)
}

/* ---- Admin 优惠券管理 ---- */
export interface AdminCoupon {
  id: string
  code: string
  name: string
  description: string | null
  discountType: 'FIXED' | 'PERCENT'
  discountValue: number
  minAmount: number
  maxDiscount: number | null
  applicableScope: string
  validFrom: string
  validTo: string
  totalQuota: number | null
  issuedCount: number
  status: 'ACTIVE' | 'DISABLED'
  createdBy: string
  createdAt: string
  updatedAt: string
}

export async function adminListCoupons(status?: string): Promise<{ items: AdminCoupon[] }> {
  const qs = status ? `?status=${status}` : ''
  return nodeApi.get(`/api/admin/coupons${qs}`)
}

export async function adminCreateCoupon(data: {
  code: string
  name: string
  description?: string
  discountType: 'FIXED' | 'PERCENT'
  discountValue: number
  minAmount?: number
  maxDiscount?: number
  applicableScope?: string
  validFrom: string
  validTo: string
  totalQuota?: number
}): Promise<AdminCoupon> {
  return nodeApi.post('/api/admin/coupons', data)
}

export async function adminUpdateCoupon(
  id: string,
  data: { status?: 'ACTIVE' | 'DISABLED'; description?: string; validTo?: string }
): Promise<AdminCoupon> {
  return nodeApi.patch(`/api/admin/coupons/${id}`, data)
}

export interface AdminGrant {
  id: string
  userId: string
  status: string
  source: string
  sourceRef: string | null
  issuedAt: string
  expiresAt: string
  usedAt: string | null
  usedOrderNo: string | null
  revokedAt: string | null
  revokedBy: string | null
  revokeReason: string | null
  user?: { phone?: string; email?: string; name?: string }
}

export async function adminListGrants(couponId: string, status?: string): Promise<{ items: AdminGrant[] }> {
  const qs = status ? `?status=${status}` : ''
  return nodeApi.get(`/api/admin/coupons/${couponId}/grants${qs}`)
}

export async function adminIssueCouponBatch(
  couponId: string,
  data: { userIds: string[]; expiresAt?: string }
): Promise<{ batchId: string; success: number; skipped: number; failed: number; errors: Array<{ userId: string; reason: string }> }> {
  return nodeApi.post(`/api/admin/coupons/${couponId}/issue`, data)
}

export async function adminRevokeUserCoupon(
  userCouponId: string,
  reason: string
): Promise<{ ok: boolean }> {
  return nodeApi.post(`/api/admin/user-coupons/${userCouponId}/revoke`, { reason })
}

// ─── Expert Vote (用户端) ─────────────────────────
export interface ExpertVotePricing {
  unitPrice: number
  unitPriceYuan: number
  minLeadDays: number
  expertCountOptions: number[]
  fileMaxMb: number
  totalMaxMb: number
  error?: string
}
export async function getExpertVotePricing(): Promise<ExpertVotePricing> {
  return nodeApi.get('/api/app/expert-votes/pricing')
}

export interface ExpertVoteAttachmentLite {
  id: string; category: string; originalName: string; size: number; mimeType?: string; createdAt?: string
}
export interface ExpertVoteRequestRow {
  requestNo: string; status: string; orderNo?: string | null
  projectName: string; targetName: string; projectType: string
  expertCount: number; totalAmount?: number | null
  desiredDate?: string | null
  meetingStartAt?: string | null
  createdAt: string
}

export async function listExpertVotes(): Promise<{ items: ExpertVoteRequestRow[] }> {
  return nodeApi.get('/api/app/expert-votes')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getExpertVote(no: string): Promise<any> {
  return nodeApi.get(`/api/app/expert-votes/${no}`)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createExpertVoteDraft(data: any): Promise<any> {
  return nodeApi.post('/api/app/expert-votes', data)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updateExpertVoteDraft(no: string, data: any): Promise<any> {
  return nodeApi.patch(`/api/app/expert-votes/${no}`, data)
}
export async function deleteExpertVoteDraft(no: string): Promise<{ ok: boolean }> {
  return nodeApi.delete(`/api/app/expert-votes/${no}`)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function submitExpertVote(no: string): Promise<{ request: any; order: any }> {
  return nodeApi.post(`/api/app/expert-votes/${no}/submit`, {})
}
export async function cancelExpertVote(no: string): Promise<{ ok: boolean }> {
  return nodeApi.post(`/api/app/expert-votes/${no}/cancel`, {})
}
export async function deleteExpertVoteAttachment(no: string, aid: string): Promise<{ ok: boolean }> {
  return nodeApi.delete(`/api/app/expert-votes/${no}/attachments/${aid}`)
}
