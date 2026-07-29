/**
 * 营销规则查询契约：每个 ruleId 一个文件，导出 query() 函数返回待推用户列表。
 * 返回的每条 RuleUser 由 /api/internal/push/send 接受并下发。
 */
export interface RuleUser {
  userId: string
  openid: string
  templateId: string
  templateData: Record<string, string | number>
  refId: string | null
}

export interface RuleQuery {
  (): Promise<RuleUser[]>
}

// 微信订阅消息模板 ID（2026-04-14 全部申请到位）
export const TEMPLATE_R06 = 'xnZcI8RVPgkt4aXoWKETo-c7WupIorHVvG70zelPQEY'  // 订单待支付提醒
export const TEMPLATE_R15 = '9rWcAqy1RFBdwrZqP9GjLE5lkEjMlW1TrbdEaQMxfdg'  // 会员时长奖励通知
export const TEMPLATE_MEMBER_EXPIRE = '9iVB8CETXYt0SwQQCEOL06xXk6HUZnZtIq72ndqwSH8'  // R10/R11 会员到期提醒
export const TEMPLATE_QUOTA_LOW = 'ZpOoHsHH5L_xhgH6n2oe7ZIZmalSaPNQbjlLulIM7mg'  // R04/R05/R09 次数卡消费通知
export const TEMPLATE_SERVICE_PROGRESS = 'cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio' // R01/R02/R07/R08/R12/R13 服务进度提醒
export const TEMPLATE_REFERRAL = 'UtPIdDEn7g_p8mcspWlie_cvq_QTqiZ1TcCkCI1KKuM'  // R14 好友充能成功提醒（借用为邀请推送 + 奖励到账）

// 默认跳转路径
export const PAGE_ORDERS = 'pages/orders/index'
export const PAGE_MEMBERSHIP = 'pages/membership/index'
export const PAGE_HOME = 'pages/home/index'
export const PAGE_REFERRAL = 'pages/referral/index'
export const PAGE_COMPARE = 'pages/compare/index'
export const PAGE_CHAT = 'pages/chat/index'
