/**
 * 验证码登录体系
 * - GET  /api/app/auth/captcha          图形验证码
 * - POST /api/app/auth/send-code        发送邮箱/手机验证码
 * - POST /api/app/auth/code-login       验证码登录/注册（自动合并）
 * - POST /api/app/auth/wechat/qr        微信扫码（预留，返回 501）
 * - GET  /api/app/auth/wechat/qr/status 微信扫码状态（预留，返回 501）
 */

import type { Express, Request, Response } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import svgCaptcha from 'svg-captcha'
import nodemailer from 'nodemailer'
import DysmsapiModule, * as $Dysmsapi from '@alicloud/dysmsapi20170525'
import * as $OpenApi from '@alicloud/openapi-client'
import * as $Util from '@alicloud/tea-util'

// ESM 兼容：default export 可能在 .default 上
const Dysmsapi = (DysmsapiModule as any).default || DysmsapiModule
import { prisma } from './db.js'
import { signJwt } from './auth.js'
import { maskEmail, maskPhone } from './utils/pii.js'

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const CODE_TTL_MS    = 10 * 60 * 1000  // 10 分钟有效
const CODE_COOLDOWN  = 60 * 1000       // 同一目标 60s 内不能重复发
const MAX_ATTEMPTS   = 5               // 单个验证码最多尝试 5 次
const IP_HOURLY_LIMIT = 10             // 同一 IP 每小时最多发 10 次

// ─── 图形验证码存储（内存，重启失效，可接受）──────────────────────────────────

const captchaStore = new Map<string, { text: string; expiresAt: number }>()

// 定期清理过期 captcha（每 5 分钟）
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of captchaStore) {
    if (v.expiresAt < now) captchaStore.delete(k)
  }
}, 5 * 60 * 1000)

/** @internal Test-only：向 captchaStore 注入一条已知答案。生产环境下 NODE_ENV !== 'test' 时无操作。 */
export function _testSeedCaptcha(token: string, code: string) {
  if (process.env.NODE_ENV !== 'test') return
  captchaStore.set(token, { text: code.toLowerCase(), expiresAt: Date.now() + 60_000 })
}

// ─── 邮件发送 ─────────────────────────────────────────────────────────────────

function createMailTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 465,
    secure: SMTP_SECURE !== 'false',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
}

async function sendEmailCode(to: string, code: string): Promise<void> {
  const transporter = createMailTransporter()
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@example.com'

  if (!transporter) {
    // 未配置 SMTP：开发模式，验证码打印到控制台
    console.log(`[DEV EMAIL] To: ${maskEmail(to)}  Code: <hidden>`)
    return
  }

  await transporter.sendMail({
    from,
    to,
    subject: '【标准小智】验证码',
    text: `您好，\n\n您正在进行标准小智账号验证，本次验证码为：${code}\n\n验证码 10 分钟内有效，请勿向他人泄露。\n如非本人操作，请忽略本邮件。\n\n本邮件由通标中研标准化研究院标准小智系统发送，请勿直接回复。`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:40px 32px;border:1px solid #e8e8e8;border-radius:8px;color:#333">
        <p style="margin:0 0 24px">您好，</p>
        <p style="margin:0 0 16px">您正在进行标准小智账号验证，本次验证码为：</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:10px;color:#1677ff;margin:24px 0;padding:16px 24px;background:#f0f5ff;border-radius:6px;display:inline-block">${code}</div>
        <p style="margin:24px 0 8px">验证码 10 分钟内有效，请勿向他人泄露。</p>
        <p style="margin:0 0 32px">如非本人操作，请忽略本邮件。</p>
        <hr style="border:none;border-top:1px solid #f0f0f0;margin:0 0 16px">
        <p style="margin:0;color:#999;font-size:12px">本邮件由通标中研标准化研究院标准小智系统发送，请勿直接回复。</p>
      </div>
    `,
  })
}

// ─── 阿里云短信发送 ──────────────────────────────────────────────────────────

function createSmsClient(): InstanceType<typeof Dysmsapi> | null {
  const accessKeyId = process.env.ALI_SMS_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALI_SMS_ACCESS_KEY_SECRET
  if (!accessKeyId || !accessKeySecret) return null
  const config = new $OpenApi.Config({ accessKeyId, accessKeySecret })
  config.endpoint = process.env.ALI_SMS_ENDPOINT || 'dysmsapi.aliyuncs.com'
  return new Dysmsapi(config)
}

async function sendSmsCode(phone: string, code: string): Promise<void> {
  const client = createSmsClient()
  const signName = process.env.ALI_SMS_SIGN_NAME || '通标中研'
  const templateCode = process.env.ALI_SMS_TEMPLATE_CODE || 'SMS_505025095'

  if (!client) {
    console.log(`[DEV SMS] To: ${maskPhone(phone)}  Code: <hidden>`)
    return
  }

  const req = new $Dysmsapi.SendSmsRequest({
    phoneNumbers: phone,
    signName,
    templateCode,
    templateParam: JSON.stringify({ code }),
  })
  const resp = await client.sendSmsWithOptions(req, new $Util.RuntimeOptions({}))
  if (resp.body?.code !== 'OK') {
    throw new Error(`阿里云短信失败: ${resp.body?.code} ${resp.body?.message}`)
  }
}

// ─── 辅助：序列化 membership ──────────────────────────────────────────────────

function serializeMembership(m: any) {
  if (!m) return null
  return {
    id: m.id,
    planId: m.planId,
    plan: m.plan ? { id: m.plan.id, name: m.plan.name } : undefined,
    status: m.status,
    startAt: m.startAt,
    endAt: m.endAt,
  }
}

// ─── 辅助：从 AppUser 生成 JWT + 返回结构 ─────────────────────────────────────

async function loginResponse(user: any): Promise<{ token: string; user: any; membership: any }> {
  const token = signJwt({ sub: user.id, phone: user.phone, email: user.email, role: user.role })
  const membership = await prisma.userMembership.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })
  return {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      email: user.email,
      name: user.name,
      organization: user.organization,
      role: user.role,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    },
    membership: serializeMembership(membership),
  }
}

// ─── 辅助：获取请求 IP ────────────────────────────────────────────────────────

function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

// ─── 路由注册 ─────────────────────────────────────────────────────────────────

export function registerVerificationRoutes(app: Express) {

  // ── GET /api/app/auth/captcha ─────────────────────────────────────────────
  // 返回图形验证码 SVG + token（token 存服务端，5 分钟有效）
  app.get('/api/app/auth/captcha', (_req, res) => {
    const captcha = svgCaptcha.create({
      size: 4,
      noise: 2,
      color: true,
      background: '#f5f5f5',
      width: 120,
      height: 44,
      charPreset: '0123456789',
    })
    const token = crypto.randomUUID()
    captchaStore.set(token, {
      text: captcha.text.toLowerCase(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
    res.json({ token, svg: captcha.data })
  })

  // ── POST /api/app/auth/send-code ──────────────────────────────────────────
  // 发送验证码（邮箱 or 手机号），含图形验证码校验 + 频控
  const sendCodeSchema = z.object({
    target:        z.string().min(3, '请填写邮箱或手机号'),
    type:          z.enum(['email', 'phone']),
    captchaToken:  z.string().optional().default(''),
    captchaCode:   z.string().optional().default(''),
    purpose:       z.enum(['login', 'register', 'bind', 'reset']).optional(),
  })

  app.post('/api/app/auth/send-code', async (req: Request, res: Response) => {
    const parsed = sendCodeSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }

    const { target, type, captchaToken, captchaCode } = parsed.data
    const ip = getIp(req)
    const purpose = parsed.data.purpose || 'login'

    // 1. 图形验证码校验（bind 场景跳过：小程序端无法展示图形验证码）
    if (purpose !== 'bind') {
      const captchaEntry = captchaStore.get(captchaToken)
      if (!captchaEntry || captchaEntry.expiresAt < Date.now()) {
        return res.status(400).json({ error: '图形验证码已过期，请刷新' })
      }
      if (captchaEntry.text !== captchaCode.toLowerCase().trim()) {
        captchaStore.delete(captchaToken) // 用完即删，防复用
        return res.status(400).json({ error: '图形验证码错误' })
      }
      captchaStore.delete(captchaToken)
    }

    // 2. 格式校验
    if (type === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
        return res.status(400).json({ error: '请填写有效的邮箱地址' })
      }
    } else {
      if (!/^1[3-9]\d{9}$/.test(target)) {
        return res.status(400).json({ error: '请填写有效的手机号' })
      }
    }

    // 2.5 注册场景：检查手机号是否已注册
    if (purpose === 'register' && type === 'phone') {
      const existing = await prisma.appUser.findUnique({ where: { phone: target } })
      if (existing?.passwordHash) {
        return res.status(409).json({ error: '该手机号已注册，请直接登录' })
      }
    }

    // 2.6 找回密码场景：检查账号是否已注册，否则提前报错，避免用户收到验证码后才发现账号不存在
    if (purpose === 'reset') {
      if (type === 'phone') {
        const existing = await prisma.appUser.findUnique({ where: { phone: target } })
        if (!existing) {
          return res.status(404).json({ error: '该手机号尚未注册，无法找回密码' })
        }
      } else if (type === 'email') {
        const existing = await prisma.appUser.findUnique({ where: { email: target } })
        if (!existing) {
          return res.status(404).json({ error: '该邮箱尚未注册，无法找回密码' })
        }
      }
    }

    // 3. 同一目标 60s 内不重复发
    const recent = await prisma.verificationCode.findFirst({
      where: { target, type },
      orderBy: { createdAt: 'desc' },
    })
    if (recent && Date.now() - recent.createdAt.getTime() < CODE_COOLDOWN) {
      const wait = Math.ceil((CODE_COOLDOWN - (Date.now() - recent.createdAt.getTime())) / 1000)
      return res.status(429).json({ error: `请等待 ${wait} 秒后再发送` })
    }

    // 4. 同一 IP 每小时最多 10 次
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const ipCount = await prisma.verificationCode.count({
      where: { ip, createdAt: { gte: hourAgo } },
    })
    if (ipCount >= IP_HOURLY_LIMIT) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' })
    }

    // 5. 手机号：阿里云短信发送
    if (type === 'phone') {
      const code = String(Math.floor(100000 + Math.random() * 900000))
      await prisma.verificationCode.create({
        data: {
          id: crypto.randomUUID(),
          target, type, code, purpose: purpose || 'login',
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
          ip,
        },
      })
      try {
        await sendSmsCode(target, code)
      } catch (err: any) {
        console.error('[send-code] 短信发送失败:', err?.message)
        return res.status(500).json({ error: '验证码发送失败，请稍后重试' })
      }
      return res.json({ message: '验证码已发送到您的手机' })
    }

    // 6. 邮箱：真实发送
    const code = String(Math.floor(100000 + Math.random() * 900000))
    await prisma.verificationCode.create({
      data: {
        id: crypto.randomUUID(),
        target, type, code, purpose: purpose || 'login',
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        ip,
      },
    })

    try {
      await sendEmailCode(target, code)
    } catch (err: any) {
      console.error('[send-code] 邮件发送失败:', err?.message)
      return res.status(500).json({ error: '验证码发送失败，请检查邮箱地址或稍后重试' })
    }

    res.json({ message: '验证码已发送，请查收邮件（10 分钟内有效）' })
  })

  // ── POST /api/app/auth/code-login ─────────────────────────────────────────
  // 验证码登录/注册（同一接口，有账号则登录，无账号自动注册）
  const codeLoginSchema = z.object({
    target:  z.string().min(3),
    type:    z.enum(['email', 'phone']),
    code:    z.string().length(6, '请输入6位验证码'),
    name:    z.string().optional(),
    organization: z.string().optional(),
  })

  app.post('/api/app/auth/code-login', async (req: Request, res: Response) => {
    const parsed = codeLoginSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }

    const { target, type, code, name, organization } = parsed.data

    // 1. 查最新未使用且未过期的验证码
    const record = await prisma.verificationCode.findFirst({
      where: { target, type, usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    })

    if (!record) {
      return res.status(400).json({ error: '验证码不存在或已过期，请重新获取' })
    }

    // 2. 尝试次数限制
    if (record.attempts >= MAX_ATTEMPTS) {
      return res.status(400).json({ error: '验证码已失效（错误次数过多），请重新获取' })
    }

    if (record.code !== code.trim()) {
      // 错误次数 +1
      await prisma.verificationCode.update({
        where: { id: record.id },
        data: { attempts: record.attempts + 1 },
      })
      const left = MAX_ATTEMPTS - record.attempts - 1
      return res.status(400).json({
        error: left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码已失效，请重新获取',
      })
    }

    // 3. 标记已使用
    await prisma.verificationCode.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    })

    // 4. 查找或创建用户
    const whereClause = type === 'email' ? { email: target } : { phone: target }
    let user = await prisma.appUser.findUnique({ where: whereClause } as any)

    if (!user) {
      // 自动注册
      const userId = crypto.randomUUID()
      const defaultName = type === 'email'
        ? `用户${target.split('@')[0].slice(0, 8)}`
        : `用户${target.slice(-4)}`

      user = await prisma.appUser.create({
        data: {
          id: userId,
          ...(type === 'email' ? { email: target } : { phone: target }),
          name: name || defaultName,
          organization,
          role: 'user',
        },
      })
    }

    const resp = await loginResponse(user)
    res.json(resp)
  })

  // ── POST /api/app/auth/wechat/qr ─────────────────────────────────────────
  // 微信扫码登录（预留，当前阶段 501）
  app.post('/api/app/auth/wechat/qr', (_req, res) => {
    res.status(501).json({
      error: '微信扫码登录暂未开放，需完成微信开放平台企业资质认证后接入',
      code: 'WECHAT_NOT_AVAILABLE',
    })
  })

  // ── GET /api/app/auth/wechat/qr/status ───────────────────────────────────
  // 微信扫码状态轮询（预留，当前阶段 501）
  app.get('/api/app/auth/wechat/qr/status', (_req, res) => {
    res.status(501).json({
      error: '微信扫码登录暂未开放',
      code: 'WECHAT_NOT_AVAILABLE',
    })
  })
}
