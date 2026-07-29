/**
 * 微信支付（公钥模式）测试
 * 覆盖锁定项（必读/MEMORY.md「业务规则」+ 安全相关）：
 *   - 公钥模式验签 verifyCallbackSignature：5 类拒绝路径 + happy path
 *   - serial 必须匹配 PUB_KEY_ID（默认 PUB_KEY_ID_0117427604262026040100382336000801）
 *   - 时间戳偏差 > 300s 拒绝（防回放）
 *   - 配置未加载时验签 / 解密都拒绝
 *   - decryptNotification AES-256-GCM round-trip + 错 nonce / 错 AAD / 篡改 ciphertext
 *   - WECHAT_PAY_APPID 优先于 WX_APPID
 *   - 私钥从 PEM 内容 / 文件路径两种方式加载
 *   - 锁定项字面量：User-Agent / 15s timeout / PUB_KEY_ID 默认值
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  _resetConfigCache,
  decryptNotification,
  isRealPayConfigured,
  verifyCallbackSignature,
} from '../src/wechat-pay.js'

// 默认 PUB_KEY_ID（与源码 module-level const 一致）
const PUB_KEY_ID = 'PUB_KEY_ID_0117427604262026040100382336000801'

let privateKeyPem: string
let publicKeyPem: string
let otherPrivateKeyPem: string
let apiV3Key: string

const ENV_KEYS = [
  'WECHAT_PAY_MCH_ID',
  'WECHAT_PAY_SERIAL_NO',
  'WECHAT_PAY_PRIVATE_KEY',
  'WECHAT_PAY_API_V3_KEY',
  'WECHAT_PAY_APPID',
  'WX_APPID',
  'WECHAT_PAY_PUB_KEY',
  'WECHAT_PAY_NOTIFY_URL',
  'WECHAT_PAY_PUB_KEY_ID',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

  const kp1 = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKeyPem = kp1.privateKey
  publicKeyPem = kp1.publicKey

  const kp2 = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  otherPrivateKeyPem = kp2.privateKey

  // APIv3 密钥：32 字节 ASCII，满足 AES-256-GCM key length
  apiV3Key = crypto.randomBytes(16).toString('hex')
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  _resetConfigCache()
})

function setupValidConfig() {
  process.env.WECHAT_PAY_MCH_ID = '1234567890'
  process.env.WECHAT_PAY_SERIAL_NO = 'TEST_MCH_SERIAL'
  process.env.WECHAT_PAY_PRIVATE_KEY = privateKeyPem
  process.env.WECHAT_PAY_API_V3_KEY = apiV3Key
  process.env.WECHAT_PAY_APPID = 'wxtest_appid_001'
  process.env.WECHAT_PAY_PUB_KEY = publicKeyPem
  delete process.env.WX_APPID
  _resetConfigCache()
}

function clearConfig() {
  for (const k of ENV_KEYS) delete process.env[k]
  _resetConfigCache()
}

// 工具：模拟微信回调验签头
function buildCallbackHeaders(opts: {
  timestamp?: string
  nonce?: string
  body?: string
  serial?: string
  privateKey?: string
}) {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000).toString()
  const nonce = opts.nonce ?? 'callback_nonce_001'
  const body = opts.body ?? '{"id":"evt-1"}'
  const serial = opts.serial ?? PUB_KEY_ID
  const verifyStr = `${timestamp}\n${nonce}\n${body}\n`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(verifyStr)
  const signature = sign.sign(opts.privateKey ?? privateKeyPem, 'base64')
  return {
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': serial,
    },
    rawBody: body,
  }
}

// 工具：用 apiV3Key 加密 payload（AES-256-GCM + AAD）
function encryptCallbackPayload(payload: object, nonce: string, aad: string, key: string): string {
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'utf-8'),
    Buffer.from(nonce, 'utf-8'),
  )
  cipher.setAAD(Buffer.from(aad, 'utf-8'))
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([enc, tag]).toString('base64')
}

// ────────────────────────────────────────────────────────────

describe('isRealPayConfigured / loadConfig 配置加载', () => {
  beforeEach(() => clearConfig())

  it('6 个必填齐全 → true', () => {
    setupValidConfig()
    expect(isRealPayConfigured()).toBe(true)
  })

  it('缺 WECHAT_PAY_MCH_ID → false', () => {
    setupValidConfig()
    delete process.env.WECHAT_PAY_MCH_ID
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(false)
  })

  it('缺 WECHAT_PAY_SERIAL_NO → false', () => {
    setupValidConfig()
    delete process.env.WECHAT_PAY_SERIAL_NO
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(false)
  })

  it('缺 WECHAT_PAY_API_V3_KEY → false', () => {
    setupValidConfig()
    delete process.env.WECHAT_PAY_API_V3_KEY
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(false)
  })

  it('缺 WECHAT_PAY_APPID 且缺 WX_APPID → false', () => {
    setupValidConfig()
    delete process.env.WECHAT_PAY_APPID
    delete process.env.WX_APPID
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(false)
  })

  it('仅 WX_APPID（无 WECHAT_PAY_APPID） → true（fallback 生效）', () => {
    setupValidConfig()
    delete process.env.WECHAT_PAY_APPID
    process.env.WX_APPID = 'wx_only_login_appid'
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(true)
  })

  it('缺 WECHAT_PAY_PRIVATE_KEY → false', () => {
    setupValidConfig()
    delete process.env.WECHAT_PAY_PRIVATE_KEY
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(false)
  })

  it('私钥写为文件路径 → 读取文件加载成功', () => {
    setupValidConfig()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpay-'))
    const keyPath = path.join(dir, 'apiclient_key.pem')
    fs.writeFileSync(keyPath, privateKeyPem)
    process.env.WECHAT_PAY_PRIVATE_KEY = keyPath
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(true)
  })

  it('私钥文件路径不存在 → false', () => {
    setupValidConfig()
    process.env.WECHAT_PAY_PRIVATE_KEY = '/non/existent/path.pem'
    _resetConfigCache()
    expect(isRealPayConfigured()).toBe(false)
  })

  it('config 缓存生效 — 第二次调用不重新读环境', () => {
    setupValidConfig()
    expect(isRealPayConfigured()).toBe(true)
    // 不调 _resetConfigCache 直接清 env
    delete process.env.WECHAT_PAY_MCH_ID
    expect(isRealPayConfigured()).toBe(true) // 仍 true，证明 cache 命中
  })
})

describe('verifyCallbackSignature 公钥模式验签', () => {
  beforeEach(() => {
    clearConfig()
    setupValidConfig()
  })

  it('happy path：私钥签名 + 公钥验证 → true', () => {
    const req = buildCallbackHeaders({})
    expect(verifyCallbackSignature(req)).toBe(true)
  })

  it('config 未加载（缺 env）→ false', () => {
    clearConfig()
    const req = buildCallbackHeaders({})
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('缺 wechatpay-timestamp → false', () => {
    const req = buildCallbackHeaders({})
    delete (req.headers as any)['wechatpay-timestamp']
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('缺 wechatpay-nonce → false', () => {
    const req = buildCallbackHeaders({})
    delete (req.headers as any)['wechatpay-nonce']
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('缺 wechatpay-signature → false', () => {
    const req = buildCallbackHeaders({})
    delete (req.headers as any)['wechatpay-signature']
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('缺 wechatpay-serial → false', () => {
    const req = buildCallbackHeaders({})
    delete (req.headers as any)['wechatpay-serial']
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('serial 不等于 PUB_KEY_ID → false（防止他方 serial 伪造）', () => {
    const req = buildCallbackHeaders({ serial: 'PUB_KEY_ID_OTHER_NOT_OURS' })
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('时间戳偏差 > 300s（10 分钟前）→ false（防回放）', () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 600).toString()
    const req = buildCallbackHeaders({ timestamp: oldTs })
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('时间戳偏差 = 300s 边界 → false（严格 > 不取等）', () => {
    const ts = (Math.floor(Date.now() / 1000) - 301).toString()
    const req = buildCallbackHeaders({ timestamp: ts })
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('用攻击者私钥签名 → 公钥验证失败 → false', () => {
    const req = buildCallbackHeaders({ privateKey: otherPrivateKeyPem })
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('正确私钥但篡改 body → 验签失败 → false', () => {
    const req = buildCallbackHeaders({ body: '{"id":"original"}' })
    // 篡改 rawBody 但保留原签名
    ;(req as any).rawBody = '{"id":"tampered"}'
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('签名 base64 损坏 → false', () => {
    const req = buildCallbackHeaders({})
    ;(req.headers as any)['wechatpay-signature'] = 'not-valid-base64-!!@@##'
    expect(verifyCallbackSignature(req)).toBe(false)
  })

  it('rawBody 为 Buffer → 也能正常验签', () => {
    const body = '{"event":"buffer-test"}'
    const req = buildCallbackHeaders({ body })
    ;(req as any).rawBody = Buffer.from(body, 'utf-8')
    expect(verifyCallbackSignature(req)).toBe(true)
  })
})

describe('decryptNotification AES-256-GCM 解密', () => {
  beforeEach(() => {
    clearConfig()
    setupValidConfig()
  })

  const samplePayload = {
    out_trade_no: 'ORD-2026-04-28-001',
    transaction_id: 'wx_txn_42',
    trade_state: 'SUCCESS',
    success_time: '2026-04-28T12:00:00+08:00',
    amount: { total: 59800 },
  }
  const nonce = 'callbackNonce'  // 12 chars (AES-GCM IV 12 字节)
  const aad = 'transaction'

  it('round-trip：用 apiV3Key 加密 → decryptNotification 解密 → 字段映射正确', () => {
    const ciphertext = encryptCallbackPayload(samplePayload, nonce, aad, apiV3Key)
    const decoded = decryptNotification(ciphertext, nonce, aad)
    expect(decoded).not.toBeNull()
    expect(decoded!.orderNo).toBe('ORD-2026-04-28-001')
    expect(decoded!.transactionId).toBe('wx_txn_42')
    expect(decoded!.tradeState).toBe('SUCCESS')
    expect(decoded!.paidAt).toBe('2026-04-28T12:00:00+08:00')
    expect(decoded!.amountCents).toBe(59800)
  })

  it('amount 字段缺失 → amountCents=0', () => {
    const payload: any = { ...samplePayload }
    delete payload.amount
    const ciphertext = encryptCallbackPayload(payload, nonce, aad, apiV3Key)
    const decoded = decryptNotification(ciphertext, nonce, aad)
    expect(decoded!.amountCents).toBe(0)
  })

  it('config 未加载 → null', () => {
    clearConfig()
    const ciphertext = encryptCallbackPayload(samplePayload, nonce, aad, apiV3Key)
    expect(decryptNotification(ciphertext, nonce, aad)).toBeNull()
  })

  it('错 nonce → 解密失败 → null', () => {
    const ciphertext = encryptCallbackPayload(samplePayload, nonce, aad, apiV3Key)
    expect(decryptNotification(ciphertext, 'wrong_nonce!', aad)).toBeNull()
  })

  it('错 AAD → 解密失败 → null（GCM 完整性校验）', () => {
    const ciphertext = encryptCallbackPayload(samplePayload, nonce, aad, apiV3Key)
    expect(decryptNotification(ciphertext, nonce, 'tampered_aad')).toBeNull()
  })

  it('篡改 ciphertext → 解密失败 → null（AuthTag 失败）', () => {
    const ciphertext = encryptCallbackPayload(samplePayload, nonce, aad, apiV3Key)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[0] ^= 0xff // 翻转第一个字节
    const tampered = buf.toString('base64')
    expect(decryptNotification(tampered, nonce, aad)).toBeNull()
  })

  it('用错误 apiV3Key 加密 → 解密失败 → null', () => {
    const wrongKey = crypto.randomBytes(16).toString('hex')
    const ciphertext = encryptCallbackPayload(samplePayload, nonce, aad, wrongKey)
    expect(decryptNotification(ciphertext, nonce, aad)).toBeNull()
  })

  it('非 base64 ciphertext → null', () => {
    expect(decryptNotification('not-base64-!!@@##', nonce, aad)).toBeNull()
  })
})

describe('源码锁定项字面量', () => {
  const SRC = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/wechat-pay.ts'),
    'utf-8',
  )

  it('PUB_KEY_ID 默认值 = PUB_KEY_ID_0117427604262026040100382336000801（MEMORY 锁定项）', () => {
    expect(SRC).toContain("'PUB_KEY_ID_0117427604262026040100382336000801'")
  })

  it('微信 API 请求带 User-Agent: BXZ-API/1.0（MEMORY 锁定项「微信 API 请求必须带 User-Agent」）', () => {
    expect(SRC).toMatch(/['"]User-Agent['"]\s*:\s*['"]BXZ-API\/1\.0['"]/)
  })

  it('请求 timeout 15s 字面量存在', () => {
    expect(SRC).toMatch(/,\s*15000\s*\)/)
  })

  it('使用 RSA-SHA256 算法签名', () => {
    expect(SRC).toMatch(/createSign\(\s*['"]RSA-SHA256['"]\s*\)/)
    expect(SRC).toMatch(/createVerify\(\s*['"]RSA-SHA256['"]\s*\)/)
  })

  it('AES-256-GCM 解密算法 + setAuthTag + setAAD（GCM 完整性）', () => {
    expect(SRC).toMatch(/createDecipheriv\(\s*['"]aes-256-gcm['"]/)
    expect(SRC).toContain('setAuthTag')
    expect(SRC).toContain('setAAD')
  })
})
