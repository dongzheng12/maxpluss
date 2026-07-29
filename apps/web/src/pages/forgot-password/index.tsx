import { useState, useEffect, useCallback } from 'react'
import { Card, Form, Input, Button, Typography, message, Steps, Tooltip } from 'antd'
import {
  PhoneOutlined, LockOutlined, SafetyOutlined, ReloadOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getCaptcha, sendVerifyCode, resetPassword } from '../../api/app'

const { Title, Text } = Typography

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

export default function ForgotPasswordPage() {
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaSvg, setCaptchaSvg] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [phone, setPhone] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [form] = Form.useForm()
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
        purpose: 'reset',
      })
      message.success('验证码已发送到您的手机')
      setPhone(vals.phone)
      loadCaptcha(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '发送失败')
      loadCaptcha(false)
    } finally { setSendingCode(false) }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleVerify = async (values: any) => {
    setSmsCode(values.smsCode)
    setStep(1)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleReset = async (values: any) => {
    if (values.newPassword !== values.confirm) return message.error('两次密码不一致')
    setLoading(true)
    try {
      await resetPassword(phone, smsCode, values.newPassword)
      message.success('密码重置成功')
      setStep(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '重置失败')
    } finally { setLoading(false) }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(160deg, #f0f5ff 0%, #e8f4fd 50%, #f6f9fc 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 440, padding: '0 20px' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'linear-gradient(135deg, #0052d9, #2b7fff)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 14, boxShadow: '0 6px 20px rgba(0, 82, 217, 0.2)',
          }}>
            <SafetyOutlined style={{ fontSize: 28, color: '#fff' }} />
          </div>
          <Title level={2} style={{ margin: '0 0 2px', fontWeight: 700, fontSize: 26 }}>重置密码</Title>
          <Text type="secondary" style={{ fontSize: 14 }}>通过手机短信验证码重置您的账户密码</Text>
        </div>

        <Card style={{ borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.06)', border: 'none' }}
          styles={{ body: { padding: '28px 28px 20px' } }}>

          <Steps current={step} size="small" style={{ marginBottom: 24 }}
            items={[{ title: '验证手机号' }, { title: '设置新密码' }, { title: '完成' }]} />

          {step === 0 && (
            <Form form={form} layout="vertical" onFinish={handleVerify}>
              <Form.Item name="phone" rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '请输入有效手机号' },
              ]}>
                <Input prefix={<PhoneOutlined />} placeholder="注册手机号" size="large" maxLength={11} />
              </Form.Item>

              <Form.Item name="captchaCode" rules={[{ required: true, message: '请填写图形验证码' }]}>
                <CaptchaInput captchaSvg={captchaSvg} onRefresh={() => loadCaptcha()} loading={captchaLoading} />
              </Form.Item>

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

              <Form.Item style={{ marginBottom: 12 }}>
                <Button type="primary" htmlType="submit" block size="large">下一步</Button>
              </Form.Item>
            </Form>
          )}

          {step === 1 && (
            <Form layout="vertical" onFinish={handleReset}>
              <div style={{ marginBottom: 16, padding: '8px 12px', background: '#f0f5ff', borderRadius: 8, fontSize: 13 }}>
                验证手机号：<Text strong>{phone}</Text>
              </div>
              <Form.Item name="newPassword" rules={[
                { required: true, message: '请输入新密码' },
                { min: 6, message: '密码至少6位' },
              ]}>
                <Input.Password prefix={<LockOutlined />} placeholder="新密码（至少6位）" size="large" />
              </Form.Item>
              <Form.Item name="confirm" rules={[{ required: true, message: '请确认密码' }]}>
                <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" size="large" />
              </Form.Item>
              <Form.Item style={{ marginBottom: 12 }}>
                <Button type="primary" htmlType="submit" block size="large" loading={loading}>重置密码</Button>
              </Form.Item>
            </Form>
          )}

          {step === 2 && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a', marginBottom: 16 }} />
              <Title level={4} style={{ marginBottom: 8 }}>密码重置成功</Title>
              <Text type="secondary">请使用新密码登录您的账户</Text>
              <div style={{ marginTop: 20 }}>
                <Button type="primary" block size="large" onClick={() => nav('/login')}>去登录</Button>
              </div>
            </div>
          )}
        </Card>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a onClick={() => nav('/login')} style={{ cursor: 'pointer', fontSize: 14, color: '#1677ff' }}>
            返回登录
          </a>
        </div>
      </div>
    </div>
  )
}
