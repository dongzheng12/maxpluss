import crypto from 'crypto'

const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL || ''
const ALERT_SIGN_SECRET = process.env.ALERT_SIGN_SECRET || ''

export function buildDingtalkUrl(baseUrl: string, secret: string): string {
  if (!secret) return baseUrl
  const ts = Date.now()
  const strToSign = `${ts}\n${secret}`
  const sign = encodeURIComponent(
    crypto.createHmac('sha256', secret).update(strToSign).digest('base64')
  )
  const sep = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${sep}timestamp=${ts}&sign=${sign}`
}

export async function alertCritical(module: string, message: string, context?: Record<string, unknown>) {
  const text = `[BXZ-ALERT] ${module}: ${message}${context ? '\n' + JSON.stringify(context).slice(0, 500) : ''}`
  import('./logger.js').then(({ logger }) => logger.error({ module, context }, message)).catch(() => {})
  if (!ALERT_WEBHOOK) return
  try {
    const url = buildDingtalkUrl(ALERT_WEBHOOK, ALERT_SIGN_SECRET)
    const body = JSON.stringify({ msgtype: 'text', text: { content: text } })
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) })
  } catch {}
}
