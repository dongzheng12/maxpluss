/**
 * 微信公众号 JS-SDK 签名（wx.config）
 *
 * 与 [[wxAccessToken]] 区别：
 *   - wxAccessToken 用 WX_APPID/WX_SECRET = 小程序凭证（subscribeMessage/generateScheme）
 *   - 本模块用 WX_MP_APPID/WX_MP_APPSECRET = 公众号（服务号）凭证（JS-SDK）
 *   - 两套凭证微信侧完全独立，不能互用，互用会报 errcode 40013
 *
 * 缓存层级：
 *   ① mp access_token（appid+secret → token），7200s 有效，提前 5min 重取
 *   ② jsapi_ticket（access_token → ticket），7200s 有效，提前 5min 重取
 *
 * 签名算法：
 *   sha1("jsapi_ticket={t}&noncestr={n}&timestamp={ts}&url={u}")
 *   字段按字典序拼接，url 不含 hash（# 后内容前端调 wx.config 时去掉）
 *
 * 文档：https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/JS-SDK.html#62
 */
import https from 'https'
import crypto from 'crypto'
import { logger } from '../logger.js'

// ─── 测试 hook ────────────────────────────────────────────────────────────────

export interface MpTokenFetcher {
  (appid: string, secret: string): Promise<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>
}
export interface JsapiTicketFetcher {
  (accessToken: string): Promise<{ ticket?: string; expires_in?: number; errcode?: number; errmsg?: string }>
}

let tokenFetcher: MpTokenFetcher = defaultTokenFetcher
let ticketFetcher: JsapiTicketFetcher = defaultTicketFetcher

export function __setMpTokenFetcher(fn: MpTokenFetcher | null): void {
  tokenFetcher = fn ?? defaultTokenFetcher
}
export function __setJsapiTicketFetcher(fn: JsapiTicketFetcher | null): void {
  ticketFetcher = fn ?? defaultTicketFetcher
}
export function __clearWxJsapiCache(): void {
  tokenCache = null
  ticketCache = null
  tokenInflight = null
  ticketInflight = null
}

// ─── 默认 fetcher ─────────────────────────────────────────────────────────────

function defaultTokenFetcher(appid: string, secret: string) {
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`
  return httpsGetJson<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>(url)
}

function defaultTicketFetcher(accessToken: string) {
  const url = `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(accessToken)}&type=jsapi`
  return httpsGetJson<{ ticket?: string; expires_in?: number; errcode?: number; errmsg?: string }>(url)
}

function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (resp) => {
      let data = ''
      resp.on('data', (c: Buffer) => { data += c })
      resp.on('end', () => {
        try { resolve(JSON.parse(data) as T) } catch { reject(new Error('WeChat response parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('WeChat request timeout')) })
  })
}

// ─── 缓存 ─────────────────────────────────────────────────────────────────────

interface Cache { value: string; expiresAt: number }
let tokenCache: Cache | null = null
let ticketCache: Cache | null = null
let tokenInflight: Promise<string> | null = null
let ticketInflight: Promise<string> | null = null

async function getMpAccessToken(): Promise<string> {
  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt > now + 5 * 60 * 1000) return tokenCache.value
  if (tokenInflight) return tokenInflight

  const appid = process.env.WX_MP_APPID
  const secret = process.env.WX_MP_APPSECRET
  if (!appid || !secret) {
    throw new Error('WX_MP_APPID / WX_MP_APPSECRET 未配置（公众号凭证，与小程序 WX_APPID 不同）')
  }

  tokenInflight = (async () => {
    try {
      const res = await tokenFetcher(appid, secret)
      if (!res.access_token || typeof res.expires_in !== 'number') {
        throw new Error(`获取公众号 access_token 失败: errcode=${res.errcode} errmsg=${res.errmsg}`)
      }
      tokenCache = { value: res.access_token, expiresAt: Date.now() + (res.expires_in - 300) * 1000 }
      logger.info({ module: 'wxJsapi', step: 'token', expiresIn: res.expires_in }, '已刷新公众号 access_token')
      return tokenCache.value
    } finally {
      tokenInflight = null
    }
  })()
  return tokenInflight
}

async function getJsapiTicket(): Promise<string> {
  const now = Date.now()
  if (ticketCache && ticketCache.expiresAt > now + 5 * 60 * 1000) return ticketCache.value
  if (ticketInflight) return ticketInflight

  ticketInflight = (async () => {
    try {
      const accessToken = await getMpAccessToken()
      const res = await ticketFetcher(accessToken)
      if (!res.ticket || typeof res.expires_in !== 'number') {
        throw new Error(`获取 jsapi_ticket 失败: errcode=${res.errcode} errmsg=${res.errmsg}`)
      }
      ticketCache = { value: res.ticket, expiresAt: Date.now() + (res.expires_in - 300) * 1000 }
      logger.info({ module: 'wxJsapi', step: 'ticket', expiresIn: res.expires_in }, '已刷新 jsapi_ticket')
      return ticketCache.value
    } finally {
      ticketInflight = null
    }
  })()
  return ticketInflight
}

// ─── 签名 ─────────────────────────────────────────────────────────────────────

export interface JsapiSignature {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
}

function randNonce(): string {
  return crypto.randomBytes(8).toString('hex')
}

/**
 * 生成 JS-SDK 签名。url 必须是前端 wx.config 当时所在的页面 URL（不含 #hash 之后部分）。
 */
export async function signJsapi(url: string): Promise<JsapiSignature> {
  const appid = process.env.WX_MP_APPID
  if (!appid) throw new Error('WX_MP_APPID 未配置')
  const ticket = await getJsapiTicket()
  const nonceStr = randNonce()
  const timestamp = Math.floor(Date.now() / 1000)
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`
  const signature = crypto.createHash('sha1').update(raw).digest('hex')
  return { appId: appid, timestamp, nonceStr, signature }
}
