/**
 * 小程序码生成 — wxacode.getUnlimited
 *
 * 返回 base64-encoded PNG buffer（不走文件系统）。
 * 调用方（referral 路由）负责缓存到 ReferralCode.qrcodeBase64 避免重复调。
 *
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/qrcode-link/qr-code/wxacode.getUnlimited.html
 */
import https from 'https'
import { getMpAccessToken } from './wxAccessToken.js'
import { logger } from '../logger.js'

export interface GetWxaCodeParams {
  scene: string            // 最大 32 个可见字符，用于 miniprogram onLaunch 解析
  page?: string            // 扫码打开的小程序路径，默认 pages/home/index
  check_path?: boolean     // 检查 page 是否存在；开发期建议 false
  env_version?: 'release' | 'trial' | 'develop'
  width?: number           // 二维码宽度 px，默认 430
}

export interface GetWxaCodeResult {
  ok: boolean
  base64?: string
  errcode?: number
  errmsg?: string
}

export interface WxaCodeFetcher {
  (token: string, body: Record<string, unknown>): Promise<{ status: number; buffer: Buffer; bodyText?: string; contentType?: string }>
}

let fetcherImpl: WxaCodeFetcher = defaultFetcher

export function __setWxaCodeFetcher(fn: WxaCodeFetcher | null): void {
  fetcherImpl = fn ?? defaultFetcher
}

function defaultFetcher(token: string, body: Record<string, unknown>) {
  return new Promise<{ status: number; buffer: Buffer; bodyText?: string; contentType?: string }>((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.weixin.qq.com',
        path: `/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 15000,
      },
      (resp) => {
        const chunks: Buffer[] = []
        resp.on('data', (c: Buffer) => { chunks.push(c) })
        resp.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({
            status: resp.statusCode || 0,
            buffer: buf,
            contentType: String(resp.headers['content-type'] || ''),
          })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Wxacode request timeout')) })
    req.write(payload)
    req.end()
  })
}

export async function getWxaCode(params: GetWxaCodeParams): Promise<GetWxaCodeResult> {
  const body: Record<string, unknown> = {
    scene: params.scene,
    page: params.page || 'pages/home/index',
    check_path: params.check_path ?? false,
    env_version: params.env_version || 'release',
    width: params.width || 430,
  }

  try {
    const token = await getMpAccessToken()
    const { status, buffer, contentType } = await fetcherImpl(token, body)

    // 微信 API 特性：成功返回 binary PNG（Content-Type: image/jpeg or image/png）；
    // 失败返回 JSON 字节串（如 {"errcode":40001,"errmsg":"invalid access_token"}）
    const asText = buffer.slice(0, 500).toString('utf8').trim()
    if (asText.startsWith('{') && asText.includes('errcode')) {
      try {
        const err = JSON.parse(buffer.toString('utf8'))
        logger.warn({ module: 'wxacode', err, scene: params.scene, page: body.page }, 'wxacode.getUnlimited 返回错误')
        return { ok: false, errcode: err.errcode, errmsg: err.errmsg }
      } catch {
        return { ok: false, errmsg: asText }
      }
    }

    const looksLikePng = buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4E
      && buffer[3] === 0x47
      && buffer[4] === 0x0D
      && buffer[5] === 0x0A
      && buffer[6] === 0x1A
      && buffer[7] === 0x0A
    const looksLikeJpeg = buffer.length >= 3
      && buffer[0] === 0xFF
      && buffer[1] === 0xD8
      && buffer[2] === 0xFF
    if (!looksLikePng && !looksLikeJpeg) {
      logger.warn({
        module: 'wxacode',
        status,
        contentType,
        scene: params.scene,
        page: body.page,
        bodyPreview: asText.slice(0, 200),
      }, 'wxacode.getUnlimited 返回非图片内容')
      return { ok: false, errmsg: `微信小程序码返回非图片内容 status=${status || 'unknown'}` }
    }

    const mime = looksLikeJpeg ? 'image/jpeg' : 'image/png'
    const base64 = `data:${mime};base64,${buffer.toString('base64')}`
    return { ok: true, base64 }
  } catch (err) {
    logger.error({ module: 'wxacode', err, scene: params.scene, page: body.page }, 'wxacode.getUnlimited 异常')
    return { ok: false, errmsg: err instanceof Error ? err.message : 'exception' }
  }
}
