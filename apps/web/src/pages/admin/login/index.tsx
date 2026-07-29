import { useState } from 'react'
import { Form, Input, Button, Typography, message, Card } from 'antd'
import { PhoneOutlined, LockOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../../contexts/AuthContext'
import { login as apiLogin } from '../../../api/app'
import { nodeApi } from '../../../api/client'

const { Title, Text } = Typography

export default function AdminLoginPage() {
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const { login } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (location.state as any)?.from || '/admin'

  const handleSubmit = async (values: { phone: string; password: string }) => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await apiLogin(values.phone, values.password)
      const u = res?.user

      // 先写入 token，me/permissions 接口需要 Bearer token
      if (res?.token) {
        localStorage.setItem('bxz_token', res.token)
        localStorage.setItem('bxz_user_id', u?.id ?? '')
      }

      // admin 直接放行，无需额外查询
      if (u?.role !== 'admin') {
        // 非 admin：检查是否被分配了后台角色
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const perm: any = await nodeApi.get('/api/admin/me/permissions')
        if (!perm?.hasAdminAccess) {
          // 无后台权限，清 token 并提示
          localStorage.removeItem('bxz_token')
          localStorage.removeItem('bxz_user')
          localStorage.removeItem('bxz_user_id')
          message.error('暂无后台访问权限，请联系管理员')
          return
        }
      }

      login({
        id: u.id,
        phone: u.phone,
        email: u.email,
        nickName: u.name || u.phone || u.email,
        memberTier: res?.membership?.plan?.id || 'free',
        memberExpire: res?.membership?.endAt,
        role: u.role,
      })
      message.success('登录成功')
      nav(from, { replace: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      // 任何异常（含权限接口报错）都清 token 防止半登录态
      localStorage.removeItem('bxz_token')
      localStorage.removeItem('bxz_user')
      localStorage.removeItem('bxz_user_id')
      message.error(e?.response?.data?.error || '登录失败，请检查账号或密码')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(160deg, #0a0f1e 0%, #0d1a3a 60%, #112244 100%)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* 背景装饰 */}
      <div style={{
        position: 'absolute', top: -100, right: -100,
        width: 400, height: 400, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,82,217,0.15) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', bottom: -80, left: -80,
        width: 300, height: 300, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(43,127,255,0.08) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <div style={{ width: '100%', maxWidth: 400, padding: '0 20px', position: 'relative', zIndex: 1 }}>
        {/* 品牌区 */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 14,
              background: 'linear-gradient(135deg, #1a3a6e, #0052d9)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 14,
              boxShadow: '0 6px 24px rgba(0, 82, 217, 0.35)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <SettingOutlined style={{ fontSize: 26, color: '#fff' }} />
          </div>
          <Title level={2} style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 24, color: '#fff' }}>
            管理后台
          </Title>
          <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>
            标准小智 · 管理人员登录
          </Text>
        </div>

        <Card
          style={{
            borderRadius: 16,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}
          styles={{ body: { padding: '32px 28px 28px' } }}
        >
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Form.Item
              name="phone"
              rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '请输入有效手机号' },
              ]}
            >
              <Input
                prefix={<PhoneOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
                placeholder="手机号"
                size="large"
                maxLength={11}
                style={{
                  background: 'rgba(255,255,255,0.07)',
                  borderColor: 'rgba(255,255,255,0.12)',
                  color: '#fff',
                }}
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
                placeholder="密码"
                size="large"
                style={{
                  background: 'rgba(255,255,255,0.07)',
                  borderColor: 'rgba(255,255,255,0.12)',
                  color: '#fff',
                }}
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                block
                size="large"
                loading={loading}
                style={{
                  background: 'linear-gradient(90deg, #0052d9, #2b7fff)',
                  border: 'none',
                  fontWeight: 600,
                  letterSpacing: 1,
                  height: 46,
                }}
              >
                登录
              </Button>
            </Form.Item>
          </Form>
        </Card>

        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <Text
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}
            onClick={() => nav('/')}
          >
            返回用户端首页
          </Text>
        </div>
      </div>
    </div>
  )
}
