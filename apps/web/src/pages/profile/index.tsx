import { useState, useEffect } from 'react'
import { Card, Avatar, Typography, Descriptions, Tag, Button, Result, Modal, Form, Input, message } from 'antd'
import {
  UserOutlined, CrownOutlined, ShoppingCartOutlined, FileTextOutlined,
  DiffOutlined, PhoneOutlined, LoginOutlined, StarOutlined, EditOutlined,
  CustomerServiceOutlined, TagOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { nodeApi } from '../../api/client'
import { POC_GATE_ENABLED, clearPocAccess } from '../../components/PocGate'

const { Title, Text } = Typography

const tierLabels: Record<string, { text: string; color: string; bg: string }> = {
  free: { text: '免费用户', color: 'default', bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  personal: { text: '个人会员', color: 'blue', bg: 'linear-gradient(135deg, #1677ff 0%, #69b1ff 100%)' },
  pro: { text: 'Pro 会员', color: 'gold', bg: 'linear-gradient(135deg, #f5a623 0%, #f7d794 100%)' },
  enterprise: { text: '企业会员', color: 'purple', bg: 'linear-gradient(135deg, #722ed1 0%, #b37feb 100%)' },
}

export default function ProfilePage() {
  const { user, isLoggedIn, logout, login } = useAuth()
  const nav = useNavigate()
  const [editOpen, setEditOpen] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [form] = Form.useForm()

  // 每次进入页面刷新会员状态，避免登录后才赠送会员导致显示不更新
  useEffect(() => {
    if (!isLoggedIn) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeApi.get('/api/app/profile').then((res: any) => {
      const u = res?.user
      const m = res?.membership
      if (u) {
        login({
          ...user!,
          nickName: u.name || u.phone || u.email,
          memberTier: m?.plan?.id || 'free',
          memberExpire: m?.endAt,
        })
      }
    }).catch(() => {})
  }, [])

  const openEdit = () => {
    form.setFieldsValue({ name: user?.name || user?.nickName || '', organization: user?.organization || '' })
    setEditOpen(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEditSave = async (values: any) => {
    setEditLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.patch('/api/app/profile', { name: values.name, organization: values.organization })
      login({ ...user!, name: res.name, nickName: res.name, organization: res.organization })
      message.success('修改成功')
      setEditOpen(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '修改失败')
    }
    setEditLoading(false)
  }

  if (!isLoggedIn) {
    return (
      <Result
        icon={<UserOutlined style={{ color: '#bfbfbf' }} />}
        title="请先登录"
        subTitle="登录后可查看个人信息和管理订单"
        extra={<Button type="primary" size="large" icon={<LoginOutlined />} onClick={() => nav('/login')}>登录 / 注册</Button>}
      />
    )
  }

  const tier = tierLabels[user?.memberTier || 'free'] ?? tierLabels['free']

  return (
    <div>
      {/* 个人信息卡片 — 顶部渐变区域 */}
      <Card
        style={{ marginBottom: 16, overflow: 'hidden' }}
        styles={{ body: { padding: 0 } }}
      >
        <div style={{
          background: tier.bg,
          padding: '32px 32px 24px',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          gap: 20,
        }}>
          <Avatar
            size={72}
            src={user?.avatarUrl || '/bxz-logo-mark.png'}
            style={{ border: '3px solid rgba(255,255,255,0.6)', background: '#fff', flexShrink: 0 }}
          />
          <div>
            <Title level={4} style={{ color: '#fff', margin: 0 }}>
              {user?.nickName || user?.phone || '用户'}
            </Title>
            <Tag
              color="rgba(255,255,255,0.25)"
              style={{ marginTop: 6, border: '1px solid rgba(255,255,255,0.4)', color: '#fff' }}
            >
              <CrownOutlined /> {tier.text}
            </Tag>
            {user?.memberExpire && (
              <Text style={{ color: 'rgba(255,255,255,0.8)', marginLeft: 8, fontSize: 13 }}>
                到期：{new Date(user.memberExpire).toLocaleDateString('zh-CN')}
              </Text>
            )}
          </div>
        </div>

        <div style={{ padding: '20px 32px' }}>
          <Descriptions column={2} size="small">
            <Descriptions.Item label="手机号">{user?.phone || '-'}</Descriptions.Item>
            <Descriptions.Item label="会员等级">{tier.text}</Descriptions.Item>
            {user?.organization && <Descriptions.Item label="单位">{user.organization}</Descriptions.Item>}
          </Descriptions>
          <Button icon={<EditOutlined />} size="small" style={{ marginTop: 12 }} onClick={openEdit}>修改用户名</Button>
        </div>
      </Card>

      <Modal title="修改用户名" open={editOpen} onCancel={() => setEditOpen(false)}
        onOk={() => form.submit()} confirmLoading={editLoading} okText="保存">
        <Form form={form} layout="vertical" onFinish={handleEditSave} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="用户名" rules={[{ required: true, message: '请输入用户名' }, { max: 20, message: '最多20个字符' }]}>
            <Input placeholder="请输入用户名" maxLength={20} />
          </Form.Item>
          <Form.Item name="organization" label="单位（选填）">
            <Input placeholder="公司/机构名称" maxLength={50} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 快捷入口 — 网格样式 */}
      <Card title="快捷入口" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {[
            { icon: <ShoppingCartOutlined />, label: '我的订单', path: '/orders', color: '#1677ff' },
            { icon: <TagOutlined />, label: '我的优惠券', path: '/coupons', color: '#fa8c16' },
            { icon: <FileTextOutlined />, label: '我的发票', path: '/invoices', color: '#52c41a' },
            { icon: <DiffOutlined />, label: '比对任务', path: '/compare', color: '#722ed1' },
            { icon: <StarOutlined />, label: '我的收藏', path: '/favorites', color: '#faad14' },
            { icon: <CrownOutlined />, label: '会员中心', path: '/membership', color: '#f5222d' },
            { icon: <PhoneOutlined />, label: '服务预约', path: '/booking', color: '#eb2f96' },
            { icon: <CustomerServiceOutlined />, label: '联系客服', path: '__contact__', color: '#8c8c8c' },
          ].map((item) => (
            <div
              key={item.label}
              onClick={() => {
                if (item.path === '__contact__') {
                  Modal.info({
                    title: '联系客服',
                    content: (
                      <div>
                        <p>如有订单、发票、会员服务或使用问题，请通过邮箱联系我们</p>
                        <p style={{ fontSize: 16, fontWeight: 700, color: '#1677ff', margin: '12px 0', userSelect: 'all' }}>biaozhunxiaozhi@tbzy.org.cn</p>
                      </div>
                    ),
                    okText: '关闭',
                  })
                  return
                }
                nav(item.path)
              }}
              style={{
                textAlign: 'center',
                padding: '16px 8px',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f5')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontSize: 24, color: item.color, marginBottom: 6 }}>{item.icon}</div>
              <Text style={{ fontSize: 13 }}>{item.label}</Text>
            </div>
          ))}
        </div>
      </Card>

      <div style={{ textAlign: 'center' }}>
        <Button danger type="text" onClick={() => logout('/')} style={{ padding: '4px 32px' }}>退出登录</Button>
      </div>

      {POC_GATE_ENABLED && (
        <div style={{ textAlign: 'center', marginTop: 4 }}>
          <Button
            type="text"
            size="small"
            onClick={() => { clearPocAccess(); window.location.reload() }}
            style={{ color: '#bbb', fontSize: 12 }}
          >
            退出 POC 测试环境
          </Button>
        </div>
      )}
    </div>
  )
}
