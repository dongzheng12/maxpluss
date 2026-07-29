/**
 * 微信公众号 JS-SDK 签名接口测试
 *
 * 覆盖：
 *  - 正常路径：合法 https://biaozhunxiaozhi.com URL → 200 + {appId,timestamp,nonceStr,signature}
 *  - 缺 url 参数 → 400
 *  - url 不是合法 URL → 400
 *  - url host 不在白名单 → 400
 *  - WX_MP_APPID 未配置 → 500
 *  - 签名算法正确性：手工 sha1 校验
 *
 * 不真连微信，使用 __set*Fetcher 注入 mock。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'crypto'
import { registerWechatRoutes } from '../src/wechatRoutes.js'
import {
  __setMpTokenFetcher,
  __setJsapiTicketFetcher,
  __clearWxJsapiCache,
} from '../src/internal/wxJsapi.js'

const app = express()
app.use(express.json())

const ORIGINAL_APPID = process.env.WX_MP_APPID
const ORIGINAL_SECRET = process.env.WX_MP_APPSECRET

beforeAll(() => {
  process.env.WX_MP_APPID = 'wx_test_appid_001'
  process.env.WX_MP_APPSECRET = 'test_secret_001'
  registerWechatRoutes(app)
})

afterAll(() => {
  if (ORIGINAL_APPID === undefined) delete process.env.WX_MP_APPID
  else process.env.WX_MP_APPID = ORIGINAL_APPID
  if (ORIGINAL_SECRET === undefined) delete process.env.WX_MP_APPSECRET
  else process.env.WX_MP_APPSECRET = ORIGINAL_SECRET
  __setMpTokenFetcher(null)
  __setJsapiTicketFetcher(null)
  __clearWxJsapiCache()
})

beforeEach(() => {
  __clearWxJsapiCache()
  __setMpTokenFetcher(async () => ({ access_token: 'fake_token_AAA', expires_in: 7200 }))
  __setJsapiTicketFetcher(async () => ({ ticket: 'fake_ticket_BBB', expires_in: 7200 }))
})

describe('GET /api/wechat/jsapi-signature', () => {
  it('合法 URL → 200 + 四字段，且 signature 是正确 SHA1', async () => {
    const targetUrl = 'https://biaozhunxiaozhi.com/s/ABC123?ref=foo'
    const res = await request(app).get('/api/wechat/jsapi-signature').query({ url: targetUrl })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      appId: 'wx_test_appid_001',
      timestamp: expect.any(Number),
      nonceStr: expect.any(String),
      signature: expect.any(String),
    })
    expect(res.body.nonceStr.length).toBeGreaterThanOrEqual(8)

    // 手工校验 SHA1
    const expected = crypto
      .createHash('sha1')
      .update(`jsapi_ticket=fake_ticket_BBB&noncestr=${res.body.nonceStr}&timestamp=${res.body.timestamp}&url=${targetUrl}`)
      .digest('hex')
    expect(res.body.signature).toBe(expected)
  })

  it('URL 含 #hash → 签名时去除 hash 后部分', async () => {
    const targetUrl = 'https://biaozhunxiaozhi.com/s/ABC#section'
    const res = await request(app).get('/api/wechat/jsapi-signature').query({ url: targetUrl })
    expect(res.status).toBe(200)
    const cleanUrl = 'https://biaozhunxiaozhi.com/s/ABC'
    const expected = crypto
      .createHash('sha1')
      .update(`jsapi_ticket=fake_ticket_BBB&noncestr=${res.body.nonceStr}&timestamp=${res.body.timestamp}&url=${cleanUrl}`)
      .digest('hex')
    expect(res.body.signature).toBe(expected)
  })

  it('www 子域也在白名单', async () => {
    const res = await request(app)
      .get('/api/wechat/jsapi-signature')
      .query({ url: 'https://www.biaozhunxiaozhi.com/' })
    expect(res.status).toBe(200)
  })

  it('缺 url 参数 → 400', async () => {
    const res = await request(app).get('/api/wechat/jsapi-signature')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/url/)
  })

  it('url 不是合法 URL → 400', async () => {
    const res = await request(app).get('/api/wechat/jsapi-signature').query({ url: 'not-a-url' })
    expect(res.status).toBe(400)
  })

  it('url host 不在白名单 → 400', async () => {
    const res = await request(app)
      .get('/api/wechat/jsapi-signature')
      .query({ url: 'https://evil.example.com/' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/白名单|host/i)
  })

  it('WX_MP_APPID 缺失 → 500', async () => {
    const saved = process.env.WX_MP_APPID
    delete process.env.WX_MP_APPID
    const res = await request(app)
      .get('/api/wechat/jsapi-signature')
      .query({ url: 'https://biaozhunxiaozhi.com/' })
    expect(res.status).toBe(500)
    process.env.WX_MP_APPID = saved
  })

  it('上游 token fetcher 报 errcode → 500', async () => {
    __clearWxJsapiCache()
    __setMpTokenFetcher(async () => ({ errcode: 40013, errmsg: 'invalid appid' }))
    const res = await request(app)
      .get('/api/wechat/jsapi-signature')
      .query({ url: 'https://biaozhunxiaozhi.com/' })
    expect(res.status).toBe(500)
  })
})
