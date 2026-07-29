/**
 * 微信公众号 JS-SDK 相关公开路由
 *
 * GET /api/wechat/jsapi-signature?url=<encoded-page-url>
 *   返回 { appId, timestamp, nonceStr, signature } 供前端 wx.config 使用
 *   公开接口，但 url host 必须在白名单（防止被当作免费签名 oracle）
 */
import type { Express } from 'express'
import { z } from 'zod'
import { signJsapi } from './internal/wxJsapi.js'
import { logger } from './logger.js'

const ALLOWED_HOSTS = new Set<string>([
  'biaozhunxiaozhi.com',
  'www.biaozhunxiaozhi.com',
])

const querySchema = z.object({
  url: z.string().url().max(2048),
})

export function registerWechatRoutes(app: Express): void {
  app.get('/api/wechat/jsapi-signature', async (req, res) => {
    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      return res.status(400).json({ error: 'url 参数缺失或非法 URL' })
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(parsed.data.url)
    } catch {
      return res.status(400).json({ error: 'url 解析失败' })
    }

    if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
      return res.status(400).json({ error: `host 不在白名单：${parsedUrl.hostname}` })
    }

    // 微信要求 url 不含 # 之后内容，前端调用时一般已经处理，这里再加一层防御
    const signingUrl = parsed.data.url.split('#')[0]

    try {
      const sig = await signJsapi(signingUrl)
      res.json(sig)
    } catch (err) {
      logger.error({ module: 'wechatRoutes', err: (err as Error).message }, 'jsapi-signature 失败')
      res.status(500).json({ error: '签名生成失败' })
    }
  })
}
