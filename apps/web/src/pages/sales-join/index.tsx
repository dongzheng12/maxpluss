/**
 * 销售凭邀请码绑定页 — 7 种场景
 *
 * 1. 邀请码无效 → 显示错误页
 * 2. 未登录 + 手机号未注册 → 注册新销售 + 直接发 token，跳 /sales/dashboard
 * 3. 未登录 + 手机号已注册 → 后端 409 hint=login_and_bind → 自动切到登录 Tab
 * 4. 已登录 + 非销售 → 升级（确认弹窗）
 * 5. 已登录 + sales 但无 SalesProfile → 补建（确认弹窗）
 * 6. 已登录 + 已有 SalesProfile → 显示「已是销售」
 * 7. 已登录 admin → 后端 403 → 显示「不支持转换」
 */
import { useState } from 'react'
import {
  Card, Form, Input, Button, Typography, message, Alert, Result, Tabs, Modal, Spin,
} from 'antd'
import {
  UserOutlined, LockOutlined, PhoneOutlined, BankOutlined, SafetyOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { nodeApi } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { login as apiLogin } from '../../api/app'

const { Title, Text } = Typography

type JoinResp = {
  success: true
  note: 'register' | 'upgraded' | 'profile_created'
  token: string
  salesCode: string
  user: { id: string; phone: string | null; role: string; name: string | null }
}

export default function SalesJoinPage() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const inviteCode = (searchParams.get('invite') || '').trim().toUpperCase()
  const { user, login: setAuthUser } = useAuth()

  const [registerForm] = Form.useForm()
  const [loginForm] = Form.useForm()
  const [activeTab, setActiveTab] = useState<'register' | 'login'>('register')
  const [submitting, setSubmitting] = useState(false)

  // 已登录态：自动调一次 /join 探测当前用户的场景，但弹窗确认后才真正绑定
  // 这里不预探测（避免重复消耗），点击确认时才发请求

  /** 把 join 成功响应写入 storage + AuthContext，跳 dashboard */
  const finalizeJoin = (resp: JoinResp) => {
    if (resp.token) localStorage.setItem('bxz_token', resp.token)
    setAuthUser({
      id: resp.user.id,
      phone: resp.user.phone || undefined,
      nickName: resp.user.name || resp.user.phone || '销售',
      role: 'sales' as const,
    })
    sessionStorage.removeItem('bxz_manual_logout')
    message.success(
      resp.note === 'register' ? '注册成功，欢迎加入销售团队'
        : resp.note === 'upgraded' ? '账号已升级为销售'
        : '销售身份已开通'
    )
    setTimeout(() => nav('/sales/dashboard'), 600)
  }

  // ── 已登录路径：调 /join 携带 token 直接绑定（场景 4/5/6/7） ──
  const handleAuthedBind = async () => {
    setSubmitting(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await nodeApi.post('/api/app/sales/join', { inviteCode }) as any
      finalizeJoin(res as JoinResp)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const data = e?.response?.data
      message.error(data?.error || '绑定失败')
    }
    setSubmitting(false)
  }

  // ── 未登录路径 1：注册新账号（场景 2/3） ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRegister = async (values: any) => {
    setSubmitting(true)
    try {
      const res = await nodeApi.post('/api/app/sales/join', {
        inviteCode,
        phone: values.phone,
        password: values.password,
        realName: values.realName,
        companyName: values.companyName || undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
      finalizeJoin(res as JoinResp)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const data = e?.response?.data
      // 场景 3：hint=login_and_bind → 自动切到登录 Tab
      if (data?.hint === 'login_and_bind') {
        message.warning(data.error || '该手机号已注册，请登录后再绑定')
        setActiveTab('login')
        loginForm.setFieldValue('phone', values.phone)
      } else {
        message.error(data?.error || '注册失败')
      }
    }
    setSubmitting(false)
  }

  // ── 未登录路径 2：登录已有账号 → 拿 token → 调 /join 绑定 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleLoginThenBind = async (values: any) => {
    setSubmitting(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loginRes: any = await apiLogin(values.phone, values.password)
      if (loginRes?.token) localStorage.setItem('bxz_token', loginRes.token)

      // admin 拒绝
      if (loginRes?.user?.role === 'admin') {
        message.error('管理员账号不支持转为销售')
        setSubmitting(false)
        return
      }

      // 紧接调 /join 走已登录路径（后端 optionalAuth 读 token）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const joinRes = await nodeApi.post('/api/app/sales/join', { inviteCode }) as any
      finalizeJoin(joinRes as JoinResp)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '登录或绑定失败')
    }
    setSubmitting(false)
  }

  // ── 邀请码缺失：直接错误页 ──
  if (!inviteCode) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f7fa' }}>
        <Result
          status="error"
          title="邀请码缺失"
          subTitle="请通过管理员发送的完整链接进入（含 ?invite=XXX 参数）"
          extra={<Button onClick={() => nav('/')}>返回首页</Button>}
        />
      </div>
    )
  }

  // ═════════════════════════════════════════════════════════
  // 已登录态分支
  // ═════════════════════════════════════════════════════════
  if (user) {
    if (user.role === 'admin') {
      return (
        <PageShell inviteCode={inviteCode}>
          <Alert
            type="error"
            message="管理员账号不支持转为销售"
            description="请先退出当前账号，再用其他手机号或邀请链接注册销售身份。"
            showIcon
          />
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <Button onClick={() => nav('/admin')}>返回管理后台</Button>
          </div>
        </PageShell>
      )
    }

    if (user.role === 'sales') {
      // 场景 5/6：可能已有 profile（场景 6）或缺 profile（场景 5）
      // 让用户主动确认，由后端区分（场景 6 返回 409，场景 5 返回 200 note=profile_created）
      return (
        <PageShell inviteCode={inviteCode}>
          <Alert
            type="info"
            message="检测到当前账号已有销售身份"
            description="如果你的销售推广页已配置好，可直接前往「销售工作台」。如果异常缺失，可点下方按钮补建。"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <Button type="primary" onClick={() => nav('/sales/dashboard')}>前往工作台</Button>
            <Button loading={submitting} onClick={() => Modal.confirm({
              title: '补建销售推广页',
              content: '如果你的账号没有正常工作的销售推广页，点击确定让系统补建。已正常的账号会被告知"已是销售"。',
              onOk: handleAuthedBind,
            })}>尝试补建</Button>
          </div>
        </PageShell>
      )
    }

    // 场景 4：普通用户升级
    return (
      <PageShell inviteCode={inviteCode}>
        <Alert
          type="success"
          message="已检测到您的账号"
          description={`当前账号 ${user.phone || user.nickName || ''} 将升级为销售身份。点击下方按钮确认绑定邀请码。`}
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Button
          type="primary"
          block
          size="large"
          loading={submitting}
          onClick={() => Modal.confirm({
            title: '确认升级为销售',
            content: '升级后将开通销售推广页 / 工作台 / 邀请订单归因等能力，原账号信息保留。',
            onOk: handleAuthedBind,
          })}
        >
          升级为销售
        </Button>
      </PageShell>
    )
  }

  // ═════════════════════════════════════════════════════════
  // 未登录态：双 Tab
  // ═════════════════════════════════════════════════════════
  return (
    <PageShell inviteCode={inviteCode}>
      <Tabs
        activeKey={activeTab}
        onChange={(k) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setActiveTab(k as any)
        }
        centered
        items={[
          {
            key: 'register',
            label: '我还没有账号',
            children: (
              <Form form={registerForm} layout="vertical" onFinish={handleRegister}>
                <Form.Item
                  label="姓名"
                  name="realName"
                  rules={[{ required: true, max: 30 }]}
                >
                  <Input prefix={<UserOutlined />} placeholder="销售真实姓名" />
                </Form.Item>
                <Form.Item
                  label="手机号"
                  name="phone"
                  rules={[
                    { required: true, message: '请输入手机号' },
                    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式错误' },
                  ]}
                >
                  <Input prefix={<PhoneOutlined />} placeholder="登录用手机号" />
                </Form.Item>
                <Form.Item
                  label="公司 / 部门"
                  name="companyName"
                  rules={[{ max: 60 }]}
                >
                  <Input prefix={<BankOutlined />} placeholder="留空使用默认" />
                </Form.Item>
                <Form.Item
                  label="设置密码"
                  name="password"
                  rules={[{ required: true, min: 6, max: 64, message: '6-64 位密码' }]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="至少 6 位" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
                  完成注册并绑定
                </Button>
              </Form>
            ),
          },
          {
            key: 'login',
            label: '我已有账号',
            children: (
              <Form form={loginForm} layout="vertical" onFinish={handleLoginThenBind}>
                <Alert
                  type="info"
                  message="登录后将自动把邀请码绑定到当前账号"
                  showIcon
                  style={{ marginBottom: 16 }}
                />
                <Form.Item
                  label="手机号"
                  name="phone"
                  rules={[
                    { required: true, message: '请输入手机号' },
                    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式错误' },
                  ]}
                >
                  <Input prefix={<PhoneOutlined />} placeholder="已注册的手机号" />
                </Form.Item>
                <Form.Item
                  label="密码"
                  name="password"
                  rules={[{ required: true }]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="登录密码" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
                  登录并绑定
                </Button>
              </Form>
            ),
          },
        ]}
      />
      {submitting && <div style={{ textAlign: 'center', marginTop: 16 }}><Spin /></div>}
    </PageShell>
  )
}

// ─────────────────────────────────────────────────────────────────────
// 通用页面外壳（品牌区 + 邀请码徽标）
// ─────────────────────────────────────────────────────────────────────
function PageShell({ inviteCode, children }: { inviteCode: string; children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(160deg, #f0f5ff 0%, #e8f4fd 50%, #f6f9fc 100%)',
      padding: '40px 20px',
    }}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'linear-gradient(135deg, #0052d9, #2b7fff)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 14,
            boxShadow: '0 6px 20px rgba(0, 82, 217, 0.2)',
          }}>
            <SafetyOutlined style={{ fontSize: 28, color: '#fff' }} />
          </div>
          <Title level={3} style={{ margin: '0 0 4px', fontWeight: 700 }}>销售身份绑定</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            邀请码：<Text code>{inviteCode}</Text>
          </Text>
        </div>
        <Card style={{ borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.06)', border: 'none' }}>
          {children}
        </Card>
      </div>
    </div>
  )
}
