/**
 * 微信支付 — JSAPI（小程序）+ Native（PC Web 扫码）
 *
 * 环境变量配置（.env）：
 *   WECHAT_PAY_MCH_ID       — 商户号
 *   WECHAT_PAY_SERIAL_NO    — 商户证书序列号
 *   WECHAT_PAY_PRIVATE_KEY  — 商户 API 私钥（PEM 内容或文件路径）
 *   WECHAT_PAY_API_V3_KEY   — APIv3 密钥（解密回调通知）
 *   WX_APPID                — 小程序 AppID
 *   WECHAT_PAY_NOTIFY_URL   — 支付回调通知地址
 *
 * 未配置时走 mock 支付流程（直接返回成功）。
 */
import crypto from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'

// ─── 配置 ──────────────────────────────────────────────────

interface WechatPayConfig {
  mchId: string
  serialNo: string
  privateKey: string   // PEM 格式私钥内容
  apiV3Key: string
  appId: string
  notifyUrl: string
}

let _cachedConfig: WechatPayConfig | null | undefined

/** 清除配置缓存（仅测试用） */
export function _resetConfigCache() { _cachedConfig = undefined }

function loadConfig(): WechatPayConfig | null {
  if (_cachedConfig !== undefined) return _cachedConfig

  const mchId = process.env.WECHAT_PAY_MCH_ID
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO
  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY
  // 支付用公众号 AppID（与商户号绑定），小程序 AppID 仅用于登录
  const appId = process.env.WECHAT_PAY_APPID || process.env.WX_APPID

  if (!mchId || !serialNo || !apiV3Key || !appId) {
    _cachedConfig = null
    return null
  }

  // 私钥：PEM 内容 或 文件路径
  let privateKey = process.env.WECHAT_PAY_PRIVATE_KEY || ''
  if (privateKey && !privateKey.includes('BEGIN')) {
    try {
      // 相对路径基于 services/api/
      const keyPath = path.isAbsolute(privateKey)
        ? privateKey
        : path.resolve(process.cwd(), privateKey)
      privateKey = readFileSync(keyPath, 'utf-8')
    } catch {
      console.warn('[wechat-pay] 无法读取私钥文件:', privateKey)
      _cachedConfig = null
      return null
    }
  }

  if (!privateKey) {
    _cachedConfig = null
    return null
  }

  const notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL || 'https://biaozhunxiaozhi.com/api/pay/notify'

  _cachedConfig = { mchId, serialNo, privateKey, apiV3Key, appId, notifyUrl }
  console.log(`[wechat-pay] 真实支付模式已加载 — 商户号 ${mchId}`)
  return _cachedConfig
}

// ─── 签名工具 ──────────────────────────────────────────────

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

function getTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString()
}

function signRequest(
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  body: string,
  privateKey: string
): string {
  const signStr = `${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signStr)
  return sign.sign(privateKey, 'base64')
}

function buildAuthHeader(
  config: WechatPayConfig,
  method: string,
  url: string,
  body: string
): string {
  const timestamp = getTimestamp()
  const nonce = generateNonce()
  const signature = signRequest(method, url, timestamp, nonce, body, config.privateKey)
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.serialNo}"`
}

// ─── 通用请求（Node 20 原生 fetch）──────────────────────────

async function wechatPayRequest(config: WechatPayConfig, apiPath: string, body: object): Promise<any> {
  const fullUrl = `https://api.mch.weixin.qq.com${apiPath}`
  const requestBody = JSON.stringify(body)
  const authorization = buildAuthHeader(config, 'POST', apiPath, requestBody)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const resp = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'BXZ-API/1.0',
        'Authorization': authorization,
      },
      body: requestBody,
      signal: controller.signal,
    })

    const data = await resp.text()

    if (!resp.ok) {
      console.error('[wechat-pay] API 错误:', resp.status, data)
      throw new Error(`微信支付 API 错误: ${resp.status} — ${data}`)
    }

    return JSON.parse(data)
  } finally {
    clearTimeout(timeout)
  }
}

// ─── JSAPI 下单（小程序） ───────────────────────────────────

export interface CreatePaymentParams {
  orderNo: string
  description: string
  amountCents: number
  openId: string
}

export interface PaymentResult {
  success: boolean
  mock: boolean
  payParams?: {
    appId: string
    timeStamp: string
    nonceStr: string
    package: string
    signType: 'RSA'
    paySign: string
  }
  mockPaidAt?: string
  error?: string
}

export async function createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
  const config = loadConfig()

  if (!config) {
    console.log(`[wechat-pay] Mock 模式 — 订单 ${params.orderNo} 模拟支付成功`)
    return { success: true, mock: true, mockPaidAt: new Date().toISOString() }
  }

  // JSAPI（小程序）必须用小程序 AppID。Native（PC）才用 WECHAT_PAY_APPID（公众号）。
  // wxbcda91ae07a75f66 = 小程序 / wx6ac98abc51cff07c = 公众号，两者不能混用：
  // JSAPI 下单时 appid 必须与 payer.openid 同源，否则返回「appid 与 openid 不匹配」
  const jsapiAppId = process.env.WX_APPID || config.appId
  if (!jsapiAppId) {
    return { success: false, mock: false, error: 'WX_APPID 未配置（JSAPI 必需小程序 AppID）' }
  }

  try {
    const data = await wechatPayRequest(config, '/v3/pay/transactions/jsapi', {
      appid: jsapiAppId,
      mchid: config.mchId,
      description: params.description,
      out_trade_no: params.orderNo,
      notify_url: config.notifyUrl,
      amount: { total: params.amountCents, currency: 'CNY' },
      payer: { openid: params.openId },
    })

    const prepayId = data.prepay_id
    if (!prepayId) {
      return { success: false, mock: false, error: '未获取到 prepay_id' }
    }

    const timeStamp = getTimestamp()
    const nonceStr = generateNonce()
    const packageStr = `prepay_id=${prepayId}`
    const paySignStr = `${jsapiAppId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`
    const paySignBuf = crypto.createSign('RSA-SHA256')
    paySignBuf.update(paySignStr)
    const paySign = paySignBuf.sign(config.privateKey, 'base64')

    return {
      success: true,
      mock: false,
      payParams: { appId: jsapiAppId, timeStamp, nonceStr, package: packageStr, signType: 'RSA', paySign },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wechat-pay] JSAPI 下单异常:', msg)
    return { success: false, mock: false, error: msg }
  }
}

// ─── Native 下单（PC Web 扫码支付） ────────────────────────

export interface NativePaymentResult {
  success: boolean
  mock: boolean
  codeUrl?: string       // weixin://wxpay/bizpayurl?... 用于生成二维码
  mockPaidAt?: string
  error?: string
}

export async function createNativePayment(params: {
  orderNo: string
  description: string
  amountCents: number
}): Promise<NativePaymentResult> {
  const config = loadConfig()

  if (!config) {
    console.log(`[wechat-pay] Mock 模式 — 订单 ${params.orderNo} Native 模拟支付成功`)
    return { success: true, mock: true, mockPaidAt: new Date().toISOString() }
  }

  try {
    const data = await wechatPayRequest(config, '/v3/pay/transactions/native', {
      appid: config.appId,
      mchid: config.mchId,
      description: params.description,
      out_trade_no: params.orderNo,
      notify_url: config.notifyUrl,
      amount: { total: params.amountCents, currency: 'CNY' },
    })

    const codeUrl = data.code_url
    if (!codeUrl) {
      return { success: false, mock: false, error: '未获取到 code_url' }
    }

    return { success: true, mock: false, codeUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wechat-pay] Native 下单异常:', msg)
    return { success: false, mock: false, error: msg }
  }
}

// ─── 退款 ──────────────────────────────────────────────────

export interface RefundParams {
  orderNo: string          // 原商户订单号
  refundNo: string         // 退款单号（商户自生成）
  totalCents: number       // 原订单金额（分）
  refundCents: number      // 退款金额（分）
  reason?: string
}

export interface RefundResult {
  success: boolean
  mock: boolean
  refundId?: string        // 微信退款单号
  status?: string          // SUCCESS / PROCESSING / ABNORMAL
  error?: string
}

export async function createRefund(params: RefundParams): Promise<RefundResult> {
  const config = loadConfig()

  if (!config) {
    console.log(`[wechat-pay] Mock 模式 — 订单 ${params.orderNo} 模拟退款成功`)
    return { success: true, mock: true, refundId: `MOCK-REFUND-${Date.now()}`, status: 'SUCCESS' }
  }

  try {
    const data = await wechatPayRequest(config, '/v3/refund/domestic/refunds', {
      out_trade_no: params.orderNo,
      out_refund_no: params.refundNo,
      reason: params.reason || '管理员操作退款',
      amount: {
        refund: params.refundCents,
        total: params.totalCents,
        currency: 'CNY',
      },
    })

    return {
      success: true,
      mock: false,
      refundId: data.refund_id,
      status: data.status,  // SUCCESS / PROCESSING
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wechat-pay] 退款异常:', msg)
    return { success: false, mock: false, error: msg }
  }
}

// ─── 回调通知解密 ─────────────────────────────────────────

export interface PayNotification {
  orderNo: string
  transactionId: string
  tradeState: string
  paidAt: string
  amountCents: number
}

export function decryptNotification(
  ciphertext: string,
  nonce: string,
  associatedData: string
): PayNotification | null {
  const config = loadConfig()
  if (!config) return null

  try {
    const key = Buffer.from(config.apiV3Key, 'utf-8')
    const iv = Buffer.from(nonce, 'utf-8')
    const ciphertextBuf = Buffer.from(ciphertext, 'base64')

    const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16)
    const encrypted = ciphertextBuf.subarray(0, ciphertextBuf.length - 16)

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    decipher.setAAD(Buffer.from(associatedData, 'utf-8'))

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const data = JSON.parse(decrypted.toString('utf-8'))

    return {
      orderNo: data.out_trade_no,
      transactionId: data.transaction_id,
      tradeState: data.trade_state,
      paidAt: data.success_time,
      amountCents: data.amount?.total || 0,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wechat-pay] 解密回调失败:', msg)
    return null
  }
}

export function isRealPayConfigured(): boolean {
  return loadConfig() !== null
}

// ─── 回调验签（公钥模式） ──────────────────────────────────

// 微信支付公钥 ID（回调 header wechatpay-serial 值必须匹配）
const WECHAT_PAY_PUB_KEY_ID = process.env.WECHAT_PAY_PUB_KEY_ID || 'PUB_KEY_ID_0117427604262026040100382336000801'

let _pubKeyPem: string | null = null

function loadPubKey(): string | null {
  if (_pubKeyPem !== null) return _pubKeyPem

  // 公钥来源：环境变量 WECHAT_PAY_PUB_KEY（PEM 内容或文件路径）
  let raw = process.env.WECHAT_PAY_PUB_KEY || ''
  if (raw && !raw.includes('BEGIN')) {
    try {
      const keyPath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
      raw = readFileSync(keyPath, 'utf-8')
    } catch {
      console.warn('[wechat-pay] 无法读取公钥文件:', raw)
    }
  }

  // 兜底：尝试从 certs 目录读取
  if (!raw || !raw.includes('BEGIN')) {
    const fallbackPaths = [
      path.resolve(process.cwd(), 'certs/pub_key.pem'),
      path.resolve(process.cwd(), '../certs/pub_key.pem'),
    ]
    for (const fp of fallbackPaths) {
      try {
        raw = readFileSync(fp, 'utf-8')
        if (raw.includes('BEGIN')) break
      } catch { /* continue */ }
    }
  }

  if (raw && raw.includes('BEGIN')) {
    _pubKeyPem = raw
    console.log('[wechat-pay] 微信支付公钥已加载（公钥模式）')
    return _pubKeyPem
  }

  console.warn('[wechat-pay] 微信支付公钥未配置，回调验签将失败')
  _pubKeyPem = ''
  return null
}

/**
 * 验证微信回调请求头签名（公钥模式），防伪造支付成功通知
 *
 * 公钥模式 vs 平台证书模式区别：
 * - 平台证书模式：需调 /v3/certificates 拉取证书 → 解密 → 用证书公钥验签
 * - 公钥模式：商户直接持有微信支付公钥 PEM，不需要拉取证书，直接验签
 */
export function verifyCallbackSignature(req: { headers: Record<string, any>; rawBody?: string | Buffer }): boolean {
  const config = loadConfig()
  if (!config) return false

  const timestamp = req.headers['wechatpay-timestamp'] as string
  const nonce = req.headers['wechatpay-nonce'] as string
  const signature = req.headers['wechatpay-signature'] as string
  const serial = req.headers['wechatpay-serial'] as string

  if (!timestamp || !nonce || !signature || !serial) {
    console.warn('[wechat-pay] 回调缺少验签请求头')
    return false
  }

  // 验证公钥 ID 是否匹配
  if (serial !== WECHAT_PAY_PUB_KEY_ID) {
    console.warn('[wechat-pay] 回调 serial 不匹配:', serial, '期望:', WECHAT_PAY_PUB_KEY_ID)
    return false
  }

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    console.warn('[wechat-pay] 回调时间戳偏差过大')
    return false
  }

  const pubKey = loadPubKey()
  if (!pubKey) {
    console.warn('[wechat-pay] 公钥未加载，无法验签')
    return false
  }

  const body = req.rawBody ? req.rawBody.toString() : ''
  const verifyStr = `${timestamp}\n${nonce}\n${body}\n`

  try {
    const verify = crypto.createVerify('RSA-SHA256')
    verify.update(verifyStr)
    return verify.verify(pubKey, signature, 'base64')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wechat-pay] 验签异常:', msg)
    return false
  }
}

/** 启动时预加载公钥（日志确认） */
export function preloadPlatformCerts(): void {
  loadPubKey()
}
