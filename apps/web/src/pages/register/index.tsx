import { useState, useEffect, useCallback } from 'react'
import {
  Card, Form, Input, Button, Typography, message, Divider, Tooltip, Checkbox,
} from 'antd'
import {
  PhoneOutlined, LockOutlined, MailOutlined, UserOutlined,
  BankOutlined, SafetyOutlined, ReloadOutlined, GiftOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { register as apiRegister, getCaptcha, sendVerifyCode } from '../../api/app'
import { nodeApi } from '../../api/client'

const INVITE_CODE_STORAGE_KEY = 'bxz_pending_referral'

const { Title, Text } = Typography

/** 图形验证码 */
function CaptchaInput({
  value, onChange, captchaSvg, onRefresh, loading: captchaLoading,
}: {
  value?: string; onChange?: (v: string) => void
  captchaSvg: string; onRefresh: () => void; loading: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Input
        value={value} onChange={e => onChange?.(e.target.value)}
        placeholder="图形验证码" maxLength={4} size="large" style={{ flex: 1 }}
        prefix={<SafetyOutlined style={{ color: '#bfbfbf' }} />}
      />
      <Tooltip title="看不清？点击刷新">
        <div
          style={{
            height: 44, width: 120, borderRadius: 6, border: '1px solid #d9d9d9',
            overflow: 'hidden', cursor: 'pointer', flexShrink: 0, background: '#f5f5f5',
          }}
          onClick={onRefresh}
        >
          {captchaSvg
            ? <div dangerouslySetInnerHTML={{ __html: captchaSvg }} style={{ lineHeight: 0 }} />
            : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {captchaLoading ? <ReloadOutlined spin style={{ color: '#999' }} /> : <ReloadOutlined style={{ color: '#999' }} />}
              </div>}
        </div>
      </Tooltip>
    </div>
  )
}

/** 发送验证码按钮 */
function SendCodeButton({ onClick, disabled, loading: btnLoading }: {
  onClick: () => void; disabled: boolean; loading: boolean
}) {
  const [countdown, setCountdown] = useState(0)
  const handleClick = () => { onClick(); setCountdown(60) }
  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])
  return (
    <Button
      onClick={handleClick} disabled={disabled || countdown > 0} loading={btnLoading}
      style={{ width: 120, flexShrink: 0, height: 40, fontWeight: 500 }}
    >
      {countdown > 0 ? `${countdown}s` : '获取验证码'}
    </Button>
  )
}

export default function RegisterPage() {
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaSvg, setCaptchaSvg] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [form] = Form.useForm()

  // 销售专属注册模式：URL ?salesCode= 或 cookie bxz_sales_code 有值即启用
  const [salesInfo, setSalesInfo] = useState<{ salesCode: string; realName: string } | null>(null)
  const { login } = useAuth()
  const nav = useNavigate()

  const loadCaptcha = useCallback(async (clearInput = true) => {
    setCaptchaLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await getCaptcha()
      setCaptchaToken(res.token)
      setCaptchaSvg(res.svg)
      if (clearInput) form.setFieldValue('captchaCode', '')
    } catch { message.error('图形验证码加载失败') }
    finally { setCaptchaLoading(false) }
  }, [form])

  useEffect(() => { loadCaptcha() }, [loadCaptcha])

  // 预填邀请码：优先 URL ?ref=，其次 localStorage（由 App.tsx 早期捕获写入）
  useEffect(() => {
    try {
      const urlRef = new URLSearchParams(window.location.search).get('ref')
      const stored = localStorage.getItem(INVITE_CODE_STORAGE_KEY)
      const prefill = (urlRef || stored || '').trim().toUpperCase()
      if (prefill) form.setFieldValue('inviteCode', prefill)
    } catch { /* ignore */ }
  }, [form])

  // 销售归因：URL ?salesCode= > cookie bxz_sales_code；拉公开接口拿 realName
  useEffect(() => {
    const urlSalesCode = new URLSearchParams(window.location.search).get('salesCode')?.trim()
    const cookieMatch = document.cookie.match(/(?:^|;\s*)bxz_sales_code=([^;]+)/)
    const cookieSalesCode = cookieMatch ? decodeURIComponent(cookieMatch[1]) : undefined
    const salesCode = urlSalesCode || cookieSalesCode
    if (!salesCode) return
    nodeApi.get(`/api/public/sales/${encodeURIComponent(salesCode)}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => {
        if (res?.realName) setSalesInfo({ salesCode: res.salesCode, realName: res.realName })
      })
      .catch(() => { /* 静默：销售码无效 fallback 到普通注册模式 */ })
  }, [])

  const handleSendCode = async () => {
    const vals = form.getFieldsValue(['phone', 'captchaCode'])
    if (!vals.phone) return message.warning('请先填写手机号')
    if (!/^1[3-9]\d{9}$/.test(vals.phone)) return message.warning('请输入有效手机号')
    if (!vals.captchaCode) return message.warning('请先填写图形验证码')
    setSendingCode(true)
    try {
      await sendVerifyCode({
        target: vals.phone, type: 'phone',
        captchaToken, captchaCode: vals.captchaCode,
        purpose: 'register',
      })
      message.success('验证码已发送到您的手机')
      // 埋点：短信验证码发送成功
      import('../../utils/tracker').then(({ track }) => track('reg_sms_sent', { phone_prefix: vals.phone.slice(0, 3) }))
      // 成功后刷新图片但不清输入框（用户不需要再操作图形验证码）
      loadCaptcha(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '发送失败')
      // 失败时刷新图片但保留用户输入，方便重试
      loadCaptcha(false)
    } finally { setSendingCode(false) }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRegister = async (values: any) => {
    if (values.password !== values.confirm) return message.error('两次密码不一致')
    // 埋点：注册开始
    import('../../utils/tracker').then(({ track }) => track('reg_start', { entry_point: 'register_page' }))
    setLoading(true)
    try {
      // 归因互斥：手填 inviteCode 优先，命中则忽略 salesCode；后端再做一次互斥兜底
      const formInviteCode = (values.inviteCode || '').trim().toUpperCase()
      const storedInviteCode = (() => {
        try { return (localStorage.getItem(INVITE_CODE_STORAGE_KEY) || '').trim().toUpperCase() } catch { return '' }
      })()
      const inviteCode = formInviteCode || storedInviteCode || undefined

      const urlSalesCode = new URLSearchParams(window.location.search).get('salesCode')?.trim()
      const cookieMatch = document.cookie.match(/(?:^|;\s*)bxz_sales_code=([^;]+)/)
      const cookieSalesCode = cookieMatch ? decodeURIComponent(cookieMatch[1]) : undefined
      const salesCode = inviteCode ? undefined : (urlSalesCode || cookieSalesCode || undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await apiRegister({
        phone: values.phone,
        smsCode: values.smsCode,
        password: values.password,
        email: values.email || undefined,
        name: values.name,
        organization: values.organization,
        salesCode,
        inviteCode,
      })
      sessionStorage.removeItem('bxz_manual_logout')
      // 注册成功后清掉本地邀请码缓存（无论命中与否都不再消费）
      try { localStorage.removeItem(INVITE_CODE_STORAGE_KEY) } catch { /* ignore */ }
      // 埋点：注册完成
      import('../../utils/tracker').then(({ track }) => track('reg_complete', { method: 'sms' }))
      if (res?.token) localStorage.setItem('bxz_token', res.token)
      const u = res?.user
      login({
        id: u?.id, phone: u?.phone, email: u?.email,
        nickName: u?.name || u?.phone || u?.email,
        memberTier: res?.membership?.plan?.id || 'free',
        memberExpire: res?.membership?.endAt,
        role: u?.role || 'user',
      })

      message.success('注册成功')
      nav('/')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const errData = e?.response?.data
      // 邀请码错误：聚焦输入框，让用户改而不是清表单
      if (errData?.field === 'inviteCode') {
        message.error(errData.error || '邀请码无效或已停用')
        form.setFields([{ name: 'inviteCode', errors: [errData.error || '邀请码无效或已停用'] }])
      } else {
        message.error(errData?.error || '注册失败')
      }
    } finally { setLoading(false) }
  }

  return (
    <div
      style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(160deg, #f0f5ff 0%, #e8f4fd 50%, #f6f9fc 100%)',
        position: 'relative', overflow: 'hidden',
      }}
    >
      <div style={{ width: '100%', maxWidth: 440, padding: '0 20px', position: 'relative', zIndex: 1 }}>
        {/* 品牌区 */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'linear-gradient(135deg, #0052d9, #2b7fff)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 14, boxShadow: '0 6px 20px rgba(0, 82, 217, 0.2)',
            position: 'relative', overflow: 'hidden',
          }}>
            {salesInfo ? (
              <div style={{
                position: 'absolute', inset: 8,
                backgroundImage: 'url(/logo-smart-standard.png)',
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'left center',
                backgroundSize: 'auto 85%',
                filter: 'invert(1) brightness(2)',
              }} />
            ) : (
              <SafetyOutlined style={{ fontSize: 28, color: '#fff' }} />
            )}
          </div>
          <Title level={2} style={{ margin: '0 0 2px', fontWeight: 700, fontSize: 26, letterSpacing: 1 }}>
            {salesInfo ? '标准小智' : '注册账号'}
          </Title>
          <Text type="secondary" style={{ fontSize: 14 }}>
            {salesInfo ? '标准智能平台' : '使用手机号快速注册'}
          </Text>
        </div>

        {salesInfo && (
          <div style={{
            background: 'linear-gradient(135deg, #e6f4ff 0%, #f0f9ff 100%)',
            border: '1px solid #91caff',
            borderRadius: 12,
            padding: '12px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
            color: '#0958d9',
          }}>
            <GiftOutlined style={{ fontSize: 18, color: '#1677ff', flexShrink: 0 }} />
            <span>
              你正在通过 <b>{salesInfo.realName}</b> 的专属链接注册，注册即获 <b>7 天免费试用</b> 🎁
            </span>
          </div>
        )}

        <Card
          style={{ borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.06)', border: 'none' }}
          styles={{ body: { padding: '28px 28px 20px' } }}
        >
          <Form form={form} layout="vertical" onFinish={handleRegister}>
            {/* 手机号 */}
            <Form.Item name="phone" rules={[
              { required: true, message: '请输入手机号' },
              { pattern: /^1[3-9]\d{9}$/, message: '请输入有效手机号' },
            ]}>
              <Input prefix={<PhoneOutlined />} placeholder="手机号" size="large" maxLength={11} />
            </Form.Item>

            {/* 图形验证码 */}
            <Form.Item name="captchaCode" rules={[{ required: true, message: '请填写图形验证码' }]}>
              <CaptchaInput captchaSvg={captchaSvg} onRefresh={loadCaptcha} loading={captchaLoading} />
            </Form.Item>

            {/* 短信验证码 */}
            <Form.Item>
              <div style={{ display: 'flex', gap: 8 }}>
                <Form.Item name="smsCode" noStyle rules={[
                  { required: true, message: '请输入短信验证码' },
                  { len: 6, message: '验证码为6位' },
                ]}>
                  <Input prefix={<SafetyOutlined />} placeholder="短信验证码（6位）" size="large" maxLength={6} style={{ flex: 1 }} />
                </Form.Item>
                <SendCodeButton onClick={handleSendCode} disabled={false} loading={sendingCode} />
              </div>
            </Form.Item>

            {/* 密码 */}
            <Form.Item name="password" rules={[
              { required: true, message: '请设置密码' },
              { min: 6, message: '密码至少6位' },
            ]}>
              <Input.Password prefix={<LockOutlined />} placeholder="设置密码（至少6位）" size="large" />
            </Form.Item>

            {/* 确认密码 */}
            <Form.Item name="confirm" rules={[{ required: true, message: '请确认密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="确认密码" size="large" />
            </Form.Item>

            {/* 销售专属模式隐藏所有选填字段；普通模式展示 */}
            {!salesInfo && (
              <>
                <Divider style={{ margin: '4px 0 12px', fontSize: 12, color: '#bfbfbf' }}>选填信息</Divider>
                <Form.Item name="email" style={{ marginBottom: 12 }} rules={[
                  { type: 'email' as const, message: '请输入有效邮箱' },
                ]}>
                  <Input prefix={<MailOutlined />} placeholder="邮箱（选填）" size="large" />
                </Form.Item>
                <Form.Item name="name" style={{ marginBottom: 12 }}>
                  <Input prefix={<UserOutlined />} placeholder="姓名（选填）" size="large" />
                </Form.Item>
                <Form.Item name="organization" style={{ marginBottom: 12 }}>
                  <Input prefix={<BankOutlined />} placeholder="单位（选填）" size="large" />
                </Form.Item>
                <Form.Item
                  name="inviteCode"
                  style={{ marginBottom: 16 }}
                  rules={[{
                    validator: (_, v) => {
                      if (!v) return Promise.resolve()
                      const s = String(v).trim().toUpperCase()
                      if (/^[A-Z2-9]{8}$/.test(s)) return Promise.resolve()
                      return Promise.reject('邀请码为 8 位字母数字（不含 I/O/0/1）')
                    },
                  }]}
                  extra="填写邀请好友提供的邀请码，你和 TA 各得 7 天会员体验"
                  normalize={(v: string) => (v ? v.trim().toUpperCase() : v)}
                >
                  <Input prefix={<GiftOutlined />} placeholder="邀请码（选填，8 位）" size="large" maxLength={8} />
                </Form.Item>
              </>
            )}

            <Form.Item
              name="agreement" valuePropName="checked"
              rules={[{ validator: (_, v) => v ? Promise.resolve() : Promise.reject('请先同意服务条款和隐私政策') }]}
              style={{ marginBottom: 12 }}
            >
              <Checkbox>
                <Text style={{ fontSize: 13 }}>
                  我已阅读并同意{' '}
                  <a href="/terms" target="_blank" style={{ color: '#1677ff' }}>服务条款</a>
                  {' '}和{' '}
                  <a href="/privacy" target="_blank" style={{ color: '#1677ff' }}>隐私政策</a>
                </Text>
              </Checkbox>
            </Form.Item>

            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                注册
              </Button>
            </Form.Item>
          </Form>

          {!salesInfo && (
            <div style={{ textAlign: 'center' }}>
              <a onClick={() => nav('/login')} style={{ cursor: 'pointer', fontSize: 14, color: '#1677ff' }}>
                已有账号？去登录
              </a>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
