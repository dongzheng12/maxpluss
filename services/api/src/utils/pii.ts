/**
 * PII 脱敏工具
 *
 * 2026-04-21：统一 dev fallback 日志 / 赠送码列表 / 管理员视图 的脱敏逻辑，
 * 避免 `services/api/src/verificationRoutes.ts` 与 `giftRoutes.ts` 两份副本漂移。
 *
 * 原则：输入异常（空 / 非法格式 / 过短）一律返回 `'***'`，绝不回显原值。
 */

export function maskEmail(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '***'
  const at = value.indexOf('@')
  if (at <= 0 || at === value.length - 1) return '***'
  const head = value.slice(0, 1)
  const domain = value.slice(at)
  return `${head}***${domain}`
}

export function maskPhone(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '***'
  const digits = value.replace(/\D/g, '')
  if (digits.length < 7) return '***'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}
