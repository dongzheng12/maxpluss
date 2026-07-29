/**
 * 微信小程序 URL Scheme 生成（generateScheme API）
 *
 * 用途：H5 销售落地页在普通微信浏览器内，点击"打开小程序"时通过
 *   window.location.href = scheme
 * 直接拉起小程序企业版申请页，无需公众号 wx.config / JSSDK。
 *
 * 策略：
 *   - 永久 scheme（is_expire=false），每个 salesCode 只调一次微信 API
 *   - 生成结果由调用方存入 SalesProfile.wxScheme 字段缓存
 *   - 测试 hook 模式与 wxAccessToken.ts 保持一致
 *
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/qrcode-link/url-scheme/generateScheme.html
 */
import https from 'https'
import { getMpAccessToken } from './wxAccessToken.js'
import { logger } from '../logger.js'

// ─── 测试 hook ────────────────────────────────────────────────────────────────

export interface WxSchemeFetcher {
  (
    accessToken: string,
    path: string,
    query: string,
  ): Promise<{ openlink?: string; errcode?: number; errmsg?: string }>
}

let fetcherImpl: WxSchemeFetcher = defaultFetcher

/** 单测注入假 fetcher，传 null 恢复默认 */
export function __setWxSchemeFetcher(fn: WxSchemeFetcher | null): void {
  fetcherImpl = fn ?? defaultFetcher
}

// ─── 默认 HTTPS fetcher ───────────────────────────────────────────────────────

function defaultFetcher(
  accessToken: string,
  path: string,
  query: string,
): Promise<{ openlink?: string; errcode?: number; errmsg?: string }> {
  const url = `https://api.weixin.qq.com/wxa/generatescheme?access_token=${encodeURIComponent(accessToken)}`
  const body = JSON.stringify({
    jump_wxa: {
      path,
      query,
      env_version: 'release', // 正式版；小程序审核通过发布后生效
    },
    is_expire: false, // 永久有效
    expire_type: 0,
  })

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (resp) => {
        let data = ''
        resp.on('data', (c: Buffer) => { data += c })
        resp.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error('WeChat generateScheme response parse error'))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('WeChat generateScheme request timeout'))
    })
    req.write(body)
    req.end()
  })
}

// ─── 公开接口 ─────────────────────────────────────────────────────────────────

/**
 * 为指定 salesCode 生成一条永久 URL Scheme。
 * 不做本地缓存——调用方（salesV2Routes）负责将结果存入 SalesProfile.wxScheme。
 *
 * @throws 若 WX_APPID/WX_SECRET 未配置或微信 API 返回错误
 */
export async function generateSalesScheme(salesCode: string): Promise<string> {
  const token = await getMpAccessToken()
  const res = await fetcherImpl(
    token,
    '/pages/enterprise-apply/index',
    `salesCode=${encodeURIComponent(salesCode)}`,
  )
  if (!res.openlink) {
    throw new Error(
      `generateScheme 失败: errcode=${res.errcode} errmsg=${res.errmsg}`,
    )
  }
  logger.info({ module: 'wxScheme', salesCode }, '已生成 URL Scheme')
  return res.openlink
}
