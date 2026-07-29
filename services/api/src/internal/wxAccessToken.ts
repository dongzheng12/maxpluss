/**
 * 微信小程序 client_credential access_token 获取与缓存
 *
 * 与 jscode2session（用户侧）不同，subscribeMessage.send 这类服务端接口需要
 * 小程序 access_token（appid+secret）。token 有效期 7200s，这里维持 2h 内存缓存，
 * 提前 5 分钟过期重取。并发保护：同一时刻只允许一个 fetch in-flight。
 *
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getAccessToken.html
 */
import https from 'https'
import { logger } from '../logger.js'

interface TokenCache {
  token: string
  expiresAt: number // ms timestamp
}

let cache: TokenCache | null = null
let inflight: Promise<string> | null = null

// 测试 hook：允许单测注入假 fetcher，避免真连微信
export interface WxTokenFetcher {
  (appid: string, secret: string): Promise<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>
}

let fetcherImpl: WxTokenFetcher = defaultFetcher

export function __setWxTokenFetcher(fn: WxTokenFetcher | null): void {
  fetcherImpl = fn ?? defaultFetcher
}

export function __clearWxTokenCache(): void {
  cache = null
  inflight = null
}

function defaultFetcher(appid: string, secret: string) {
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`
  return new Promise<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (resp) => {
      let data = ''
      resp.on('data', (c: Buffer) => { data += c })
      resp.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('WeChat token response parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('WeChat token request timeout')) })
  })
}

/**
 * 拿一个可用的小程序 access_token（2h 缓存 + 并发去重）
 */
export async function getMpAccessToken(): Promise<string> {
  const now = Date.now()
  if (cache && cache.expiresAt > now + 5 * 60 * 1000) {
    return cache.token
  }
  if (inflight) return inflight

  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) {
    throw new Error('WX_APPID / WX_SECRET 未配置，无法获取小程序 access_token')
  }

  inflight = (async () => {
    try {
      const res = await fetcherImpl(appid, secret)
      if (!res.access_token || typeof res.expires_in !== 'number') {
        throw new Error(`获取 access_token 失败: errcode=${res.errcode} errmsg=${res.errmsg}`)
      }
      cache = {
        token: res.access_token,
        // 提前 5 分钟标记过期，避免边界抖动
        expiresAt: Date.now() + (res.expires_in - 300) * 1000,
      }
      logger.info({ module: 'wxAccessToken', expiresIn: res.expires_in }, '已刷新小程序 access_token')
      return cache.token
    } finally {
      inflight = null
    }
  })()

  return inflight
}
