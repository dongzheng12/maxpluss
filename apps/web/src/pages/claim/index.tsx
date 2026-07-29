/**
 * 赠送权益领取页 /claim/:code
 * 状态流：加载中 → 赠送信息卡（已登录直接领/未登录选注册或登录）→ 领取成功/错误
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Card, Button, Typography, Spin, Result, message, Descriptions,
  Form, Input, Tooltip, Divider,
} from 'antd'
import {
  GiftOutlined, CheckCircleOutlined, LoginOutlined, UserAddOutlined,
  PhoneOutlined, LockOutlined, SafetyOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { nodeApi } from '../../api/client'
import { getCaptcha, sendVerifyCode } from '../../api/app'

const { Title, Text } = Typography

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
    <Button onClick={handleClick} disabled={disabled || countdown > 0} loading={btnLoading}
      style={{ width: 120, flexShrink: 0, height: 40, fontWeight: 500 }}>
      {countdown > 0 ? `${countdown}s` : '获取验证码'}
    </Button>
  )
}

export default function ClaimPage() {
  const { code } = useParams<{ code: string }>()
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [gift, setGift] = useState<any>(null)
  const [error, setError] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [success, setSuccess] = useState<any>(null)
  const [showRegister, setShowRegister] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaSvg, setCaptchaSvg] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [form] = Form.useForm()
  const { user, login: authLogin } = useAuth()
  const nav = useNavigate()

  useEffect(() => {
    if (!code) return
    setLoading(true)
    nodeApi.get(`/api/app/gifts/${code}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => { setGift(res); setError('') })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((e: any) => { setError(e?.response?.data?.error || '赠送链接无效') })
      .finally(() => setLoading(false))
  }, [code])

  const loadCaptcha = useCallback(async (clearInput = true) => {
    setCaptchaLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await getCaptcha()
      setCaptchaToken(res.token)
      setCaptchaSvg(res.svg)
      if (clearInput) form.setFieldValue('captchaCode', '')
    } catch { /* ignore */ }
    finally { setCaptchaLoading(false) }
  }, [form])

  useEffect(() => { if (showRegister) loadCaptcha() }, [showRegister, loadCaptcha])

  const handleSendCode = async () => {
    const vals = form.getFieldsValue(['phone', 'captchaCode'])
    if (!vals.phone) return message.warning('请输入手机号')
    if (!/^1[3-9]\d{9}$/.test(vals.phone)) return message.warning('请输入有效手机号')
    if (!vals.captchaCode) return message.warning('请填写图形验证码')
    setSendingCode(true)
    try {
      await sendVerifyCode({
        target: vals.phone, type: 'phone',
        captchaToken, captchaCode: vals.captchaCode,
        purpose: 'register',
      })
      message.success('验证码已发送到您的手机')
      loadCaptcha(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '发送失败')
      loadCaptcha(false)
    } finally { setSendingCode(false) }
  }

  // 已登录用户直接领取
  const handleClaim = async () => {
    if (!code) return
    setClaiming(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post(`/api/app/gifts/${code}/claim`)
      setSuccess(res)
      message.success('领取成功！')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '领取失败')
    } finally { setClaiming(false) }
  }

  // 注册并领取
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRegisterAndClaim = async (values: any) => {
    if (!code) return
    if (values.password !== values.confirm) return message.error('两次密码不一致')
    setClaiming(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post(`/api/app/gifts/${code}/claim-with-register`, {
        phone: values.phone,
        smsCode: values.smsCode,
        password: values.password,
        name: values.name,
        organization: values.organization,
      })
      // 自动登录
      if (res.token) localStorage.setItem('bxz_token', res.token)
      const u = res.user
      authLogin({
        id: u?.id, phone: u?.phone,
        nickName: u?.name || u?.phone,
        memberTier: res.membership?.planId || 'free',
        memberExpire: res.membership?.endAt,
        role: u?.role || 'user',
      })
      setSuccess(res)
      message.success('注册并领取成功！')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    } finally { setClaiming(false) }
  }

  const durationLabel = (days: number) => {
    if (days >= 365) return `${Math.round(days / 365)}年`
    if (days >= 30) return `${Math.round(days / 30)}个月`
    return `${days}天`
  }

  // ── 加载中 ──
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f8fc' }}>
        <Spin size="large" tip="正在加载赠送信息..." />
      </div>
    )
  }

  // ── 错误 ──
  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f8fc' }}>
        <Card style={{ maxWidth: 480, width: '100%', borderRadius: 16, textAlign: 'center' }}>
          <Result status="warning" title="无法领取" subTitle={error}
            extra={<Button type="primary" onClick={() => nav('/')}>返回首页</Button>} />
        </Card>
      </div>
    )
  }

  // ── 领取成功 ──
  if (success) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f8fc' }}>
        <Card style={{ maxWidth: 480, width: '100%', borderRadius: 16, textAlign: 'center', padding: '24px 0' }}>
          <CheckCircleOutlined style={{ fontSize: 56, color: '#52c41a', marginBottom: 16 }} />
          <Title level={3} style={{ marginBottom: 8 }}>领取成功！</Title>
          <Text type="secondary">恭喜您获得以下权益</Text>
          <div style={{ margin: '24px auto', maxWidth: 320 }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="权益类型">{gift?.planName}</Descriptions.Item>
              <Descriptions.Item label="生效日期">{new Date(success.membership.startAt).toLocaleDateString()}</Descriptions.Item>
              <Descriptions.Item label="到期日期">{new Date(success.membership.endAt).toLocaleDateString()}</Descriptions.Item>
            </Descriptions>
          </div>
          <Button type="primary" size="large" onClick={() => nav('/')}>进入首页</Button>
        </Card>
      </div>
    )
  }

  // ── 赠送信息卡 ──
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(160deg, #f0f5ff 0%, #e8f4fd 50%, #f6f9fc 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 480, padding: '0 20px' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'linear-gradient(135deg, #ff6b35, #ff9558)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 14, boxShadow: '0 6px 20px rgba(255, 107, 53, 0.3)',
          }}>
            <GiftOutlined style={{ fontSize: 28, color: '#fff' }} />
          </div>
          <Title level={3} style={{ margin: '0 0 4px', fontWeight: 700 }}>赠送权益领取</Title>
          <Text type="secondary">您收到一份标准小智会员权益</Text>
        </div>

        <Card style={{ borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.06)', border: 'none', marginBottom: 16 }}
          styles={{ body: { padding: 28 } }}>
          {/* 权益信息 */}
          <div style={{
            padding: '16px 20px', borderRadius: 12, marginBottom: 20,
            background: 'linear-gradient(135deg, #fff7e6 0%, #fff2cc 100%)',
            border: '1px solid #ffe58f',
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#d48806', marginBottom: 4 }}>
              {gift?.planName}
            </div>
            <div style={{ fontSize: 14, color: '#ad6800' }}>
              使用时长：{durationLabel(gift?.durationDays || 365)}
            </div>
          </div>

          <Descriptions column={1} size="small" style={{ marginBottom: 20 }}>
            {gift?.createdByName && <Descriptions.Item label="赠送方">{gift.createdByName}</Descriptions.Item>}
            <Descriptions.Item label="领取截止">{new Date(gift?.expiresAt).toLocaleDateString()}</Descriptions.Item>
            <Descriptions.Item label="接收手机号">{gift?.phone}</Descriptions.Item>
            {gift?.note && <Descriptions.Item label="备注">{gift.note}</Descriptions.Item>}
          </Descriptions>

          {user ? (
            // ── 已登录：直接领取 ──
            <Button type="primary" block size="large" icon={<GiftOutlined />}
              loading={claiming} onClick={handleClaim}>
              立即领取
            </Button>
          ) : showRegister ? (
            // ── 未登录 + 展开注册表单 ──
            <>
              <Divider style={{ margin: '8px 0 16px', fontSize: 13, color: '#bfbfbf' }}>注册并领取</Divider>
              <Form form={form} layout="vertical" onFinish={handleRegisterAndClaim}>
                <Form.Item name="phone" rules={[
                  { required: true, message: '请输入手机号' },
                  { pattern: /^1[3-9]\d{9}$/, message: '请输入有效手机号' },
                ]}>
                  <Input prefix={<PhoneOutlined />} placeholder="手机号" size="large" maxLength={11} />
                </Form.Item>

                <Form.Item name="captchaCode" rules={[{ required: true, message: '请填写图形验证码' }]}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input
                      value={form.getFieldValue('captchaCode')}
                      onChange={e => form.setFieldValue('captchaCode', e.target.value)}
                      placeholder="图形验证码" maxLength={4} size="large" style={{ flex: 1 }}
                      prefix={<SafetyOutlined style={{ color: '#bfbfbf' }} />}
                    />
                    <Tooltip title="看不清？点击刷新">
                      <div style={{
                        height: 44, width: 120, borderRadius: 6, border: '1px solid #d9d9d9',
                        overflow: 'hidden', cursor: 'pointer', flexShrink: 0, background: '#f5f5f5',
                      }} onClick={() => loadCaptcha()}>
                        {captchaSvg
                          ? <div dangerouslySetInnerHTML={{ __html: captchaSvg }} style={{ lineHeight: 0 }} />
                          : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <ReloadOutlined style={{ color: '#999' }} spin={captchaLoading} />
                            </div>}
                      </div>
                    </Tooltip>
                  </div>
                </Form.Item>

                <Form.Item>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Form.Item name="smsCode" noStyle rules={[
                      { required: true, message: '请输入短信验证码' },
                      { len: 6, message: '验证码为6位' },
                    ]}>
                      <Input prefix={<SafetyOutlined />} placeholder="短信验证码" size="large" maxLength={6} style={{ flex: 1 }} />
                    </Form.Item>
                    <SendCodeButton onClick={handleSendCode} disabled={false} loading={sendingCode} />
                  </div>
                </Form.Item>

                <Form.Item name="password" rules={[{ required: true, message: '请设置密码' }, { min: 6, message: '密码至少6位' }]}>
                  <Input.Password prefix={<LockOutlined />} placeholder="设置密码（至少6位）" size="large" />
                </Form.Item>
                <Form.Item name="confirm" rules={[{ required: true, message: '请确认密码' }]}>
                  <Input.Password prefix={<LockOutlined />} placeholder="确认密码" size="large" />
                </Form.Item>

                <Form.Item style={{ marginBottom: 8 }}>
                  <Button type="primary" htmlType="submit" block size="large" loading={claiming}
                    icon={<GiftOutlined />}>
                    注册并领取
                  </Button>
                </Form.Item>
              </Form>
              <div style={{ textAlign: 'center' }}>
                <a onClick={() => setShowRegister(false)} style={{ fontSize: 13, color: '#8c8c8c', cursor: 'pointer' }}>
                  返回
                </a>
              </div>
            </>
          ) : (
            // ── 未登录：选择登录或注册 ──
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Button type="primary" block size="large" icon={<LoginOutlined />}
                onClick={() => nav(`/login?redirect=/claim/${code}`)}>
                已有账号，登录后领取
              </Button>
              <Button block size="large" icon={<UserAddOutlined />}
                onClick={() => setShowRegister(true)}>
                没有账号，注册并领取
              </Button>
            </div>
          )}
        </Card>

        <div style={{ textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>标准小智 — 标准智能检索与比对平台</Text>
        </div>
      </div>
    </div>
  )
}
