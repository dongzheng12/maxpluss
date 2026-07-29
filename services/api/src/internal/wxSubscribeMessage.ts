/**
 * 小程序订阅消息下发封装
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/subscribe-message/subscribeMessage.send.html
 *
 * data 字段格式：微信要求 { key: { value: string } }
 * 这里对调用方友好：传入扁平对象 { key: string | number }，内部包一层。
 */
import https from 'https'
import { getMpAccessToken } from './wxAccessToken.js'
import { logger } from '../logger.js'

export interface SendSubscribeMessageParams {
  touser: string // openid
  templateId: string
  data: Record<string, string | number>
  page?: string // 点击跳转（小程序路径）
  miniprogramState?: 'developer' | 'trial' | 'formal'
}

export interface SendSubscribeMessageResult {
  ok: boolean
  errcode?: number
  errmsg?: string
}

export interface WxSubscribeSender {
  (token: string, body: Record<string, unknown>): Promise<{ errcode?: number; errmsg?: string }>
}

let senderImpl: WxSubscribeSender = defaultSender

export function __setWxSubscribeSender(fn: WxSubscribeSender | null): void {
  senderImpl = fn ?? defaultSender
}

function defaultSender(token: string, body: Record<string, unknown>) {
  return new Promise<{ errcode?: number; errmsg?: string }>((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.weixin.qq.com',
        path: `/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 10000,
      },
      (resp) => {
        let data = ''
        resp.on('data', (c: Buffer) => { data += c })
        resp.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { reject(new Error('WxSubscribe parse error')) }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('WxSubscribe timeout')) })
    req.write(payload)
    req.end()
  })
}

export async function sendSubscribeMessage(params: SendSubscribeMessageParams): Promise<SendSubscribeMessageResult> {
  const { touser, templateId, data, page, miniprogramState } = params
  // 转成微信要求的 { key: { value: string } }
  const wxData: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(data)) {
    wxData[k] = { value: String(v) }
  }
  const body: Record<string, unknown> = {
    touser,
    template_id: templateId,
    data: wxData,
  }
  if (page) body.page = page
  if (miniprogramState) body.miniprogram_state = miniprogramState

  try {
    const token = await getMpAccessToken()
    const res = await senderImpl(token, body)
    if (res.errcode === 0 || res.errcode === undefined) {
      return { ok: true, errcode: 0 }
    }
    logger.warn({ module: 'wxSubscribe', errcode: res.errcode, errmsg: res.errmsg, touser, templateId }, '订阅消息发送失败')
    return { ok: false, errcode: res.errcode, errmsg: res.errmsg }
  } catch (err) {
    logger.error({ module: 'wxSubscribe', err, touser, templateId }, '订阅消息发送异常')
    return { ok: false, errmsg: err instanceof Error ? err.message : 'exception' }
  }
}
