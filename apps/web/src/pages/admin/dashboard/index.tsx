import { useState, useEffect } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Card, Row, Col, Statistic, Typography, Table, Tag, Alert, Button, Space } from 'antd'
import {
  TeamOutlined, ShoppingCartOutlined, DiffOutlined, FileTextOutlined,
  PhoneOutlined, DollarOutlined, ExclamationCircleOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { nodeApi } from '../../../api/client'
import { useAuth } from '../../../contexts/AuthContext'
import { usePermission } from '../../../contexts/PermissionContext'

const { Title } = Typography

const STATUS_COLOR: Record<string, string> = {
  PAID: 'green', PENDING: 'orange', PAYING: 'blue', PENDING_VERIFY: 'geekblue',
  CANCELLED: 'default', FAILED: 'red', COMPLETED: 'green', DONE: 'green',
}

const STATUS_TEXT: Record<string, string> = {
  PAID: '已支付', PENDING: '待支付', PAYING: '支付中', PENDING_VERIFY: '待确认',
  CANCELLED: '已取消', FAILED: '失败', COMPLETED: '完成', DONE: '完成',
}


export default function AdminDashboard() {
  const { user } = useAuth()
  const perm = usePermission()
  const isSales = perm.isSales   // 三信号识别（含 AdminUserRole 销售 / SalesProfile），覆盖 role=user 但分配了销售角色的 staff
  const isStaff = perm.isStaff

  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [stats, setStats] = useState<any>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [recentOrders, setRecentOrders] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [recentTasks, setRecentTasks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const nav = useNavigate()

  useEffect(() => {
    // sales / staff 角色不调用任何 admin 接口，避免 403 噪声与空数据视觉异常
    if (isSales || isStaff) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false)
      return
    }
    const load = async () => {
      try {
        const [statsRes, ordersRes, tasksRes] = await Promise.all([
          nodeApi.get('/api/admin/stats').catch(() => ({})),
          nodeApi.get('/api/admin/orders').catch(() => ({ items: [] })),
          nodeApi.get('/api/admin/compare-tasks').catch(() => ({ items: [] })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any[]
        setStats(statsRes || {})
        setRecentOrders((ordersRes?.items || []).slice(0, 8))
        setRecentTasks((tasksRes?.items || []).slice(0, 8))
      } catch { /* ignore */ }
      setLoading(false)
    }
    load()
  }, [isSales, isStaff])

  if (isSales) {
    return (
      <div>
        <Title level={4}>欢迎回来，{user?.nickName || '销售顾问'}</Title>
        <Card style={{ marginTop: 16 }}>
          <Space direction="vertical" size={16}>
            <Typography.Text>请进入"我的销售工作台"查看推广数据、归因订单和推广素材。</Typography.Text>
            <Button type="primary" onClick={() => nav('/admin/sales/workspace')}>
              前往销售工作台
            </Button>
          </Space>
        </Card>
      </div>
    )
  }

  if (isStaff) {
    return (
      <div>
        <Title level={4}>欢迎回来，{user?.nickName || '管理人员'}</Title>
        <Card style={{ marginTop: 16 }}>
          <Space direction="vertical" size={16}>
            <Typography.Text>请通过左侧菜单进入您有权限的模块。</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前可见菜单数：{perm.menuPaths.length} · 当前操作权限数：{perm.actionKeys.length}
            </Typography.Text>
          </Space>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <Title level={4}>数据概览</Title>

      {/* 待处理提醒 */}
      {(stats.pendingVerifyOrders > 0 || stats.pendingInvoices > 0) && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          style={{ marginBottom: 16 }}
          message={
            <Space>
              {stats.pendingVerifyOrders > 0 && (
                <Button type="link" size="small" onClick={() => nav('/admin/orders')}>
                  {stats.pendingVerifyOrders} 笔订单待确认凭证
                </Button>
              )}
              {stats.pendingInvoices > 0 && (
                <Button type="link" size="small" onClick={() => nav('/admin/invoices')}>
                  {stats.pendingInvoices} 张发票待审核
                </Button>
              )}
            </Space>
          }
        />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/users')}>
            <Statistic title="注册用户" value={stats.users || 0} prefix={<TeamOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/orders')}>
            <Statistic title="总订单" value={stats.orders || 0} prefix={<ShoppingCartOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/orders')}>
            <Statistic title="已支付" value={stats.paidOrders || 0} prefix={<DollarOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/orders')}>
            <Statistic
              title="待确认凭证"
              value={stats.pendingVerifyOrders || 0}
              prefix={<SafetyCertificateOutlined />}
              valueStyle={stats.pendingVerifyOrders > 0 ? { color: '#1677ff' } : undefined}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/compare-tasks')}>
            <Statistic title="比对任务" value={stats.compareTasks || 0} prefix={<DiffOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/bookings')}>
            <Statistic title="服务预约" value={stats.bookings || 0} prefix={<PhoneOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => nav('/admin/invoices')}>
            <Statistic title="发票申请" value={stats.invoices || 0} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={12}>
          <Card title="最近订单" size="small" loading={loading} extra={<Button type="link" size="small" onClick={() => nav('/admin/orders')}>查看全部</Button>}>
            <Table scroll={{ x: "max-content" }}
              rowKey="orderNo"
              dataSource={recentOrders}
              pagination={false}
              size="small"
              columns={[
                { title: '订单号', dataIndex: 'orderNo', width: 140, ellipsis: true, hidden: isMobile },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                { title: '用户', dataIndex: ['user', 'phone'], width: 110, render: (_: any, r: any) => r.user?.name || r.user?.phone || '-' },
                { title: '金额', dataIndex: 'amount', width: 80, render: (v: number) => `¥${(v / 100).toFixed(0)}` },
                { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => (
                  <Tag color={STATUS_COLOR[s] || 'default'}>{STATUS_TEXT[s] || s}</Tag>
                )},
              ].filter(c => !('hidden' in c && c.hidden))}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="最近比对" size="small" loading={loading} extra={<Button type="link" size="small" onClick={() => nav('/admin/compare-tasks')}>查看全部</Button>}>
            <Table scroll={{ x: "max-content" }}
              rowKey="taskNo"
              dataSource={recentTasks}
              pagination={false}
              size="small"
              columns={[
                { title: '任务号', dataIndex: 'taskNo', width: 140, ellipsis: true, hidden: isMobile },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                { title: '用户', dataIndex: ['user', 'phone'], width: 110, hidden: isMobile, render: (_: any, r: any) => r.user?.name || r.user?.phone || '-' },
                { title: '文档', dataIndex: 'documentName', ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => (
                  <Tag color={STATUS_COLOR[s] || 'blue'}>{STATUS_TEXT[s] || s}</Tag>
                )},
              ].filter(c => !('hidden' in c && c.hidden))}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
