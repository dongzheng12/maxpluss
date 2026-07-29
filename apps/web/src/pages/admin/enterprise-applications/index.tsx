import { useState, useEffect, useMemo } from 'react'
import { Table, Typography, Button, Space, Select, Input, Tag, Tooltip, message, Modal } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'

const { Title } = Typography

const STATUS_OPTIONS = [
  { value: 'all',       label: '全部'    },
  { value: 'pending',   label: '待跟进'  },
  { value: 'contacted', label: '已联系'  },
  { value: 'converted', label: '已转化'  },
]

const STATUS_COLOR: Record<string, string> = {
  pending:   'orange',
  contacted: 'blue',
  converted: 'green',
}

const STATUS_LABEL: Record<string, string> = {
  pending:   '待跟进',
  contacted: '已联系',
  converted: '已转化',
}

const ENTERPRISE_ROLE_OPTIONS = [
  { value: 'MANAGER', label: '企业管理员（MANAGER）' },
  { value: 'ADMIN', label: '企业所有者（ADMIN）' },
  { value: 'REVIEWER', label: '审核员（REVIEWER）' },
  { value: 'EMPLOYEE', label: '员工（EMPLOYEE）' },
]

interface EnterpriseRow {
  id: string
  name: string
  position: string
  company: string
  phone: string
  requirement: string
  status: string
  createdAt: string
}

export default function AdminEnterpriseApplicationsPage() {
  const [items, setItems] = useState<EnterpriseRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/enterprise/applications', {
        params: { status: statusFilter, page, pageSize },
      })
      setItems(res?.data || [])
      setTotal(res?.total || 0)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [statusFilter, page])

  const filtered = useMemo(() => {
    if (!keyword) return items
    const k = keyword.toLowerCase()
    return items.filter((i) =>
      (i.name || '').toLowerCase().includes(k) ||
      (i.phone || '').toLowerCase().includes(k) ||
      (i.company || '').toLowerCase().includes(k),
    )
  }, [items, keyword])

  const changeStatus = (id: string, status: string) => {
    Modal.confirm({
      title: '更新申请状态',
      content: `确认将该申请标记为「${STATUS_LABEL[status]}」？`,
      onOk: async () => {
        try {
          await nodeApi.patch(`/api/admin/enterprise/applications/${id}/status`, { status })
          message.success('状态已更新')
          load()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  const activate = (row: EnterpriseRow) => {
    let enterpriseRole = 'MANAGER'
    Modal.confirm({
      title: '一键开通企业版',
      content: (
        <div>
          <p>将为「{row.company}」开通企业版，并绑定/创建申请人 {row.name}（{row.phone}）。</p>
          <div style={{ margin: '12px 0' }}>
            <div style={{ marginBottom: 6 }}>企业角色</div>
            <Select
              defaultValue={enterpriseRole}
              options={ENTERPRISE_ROLE_OPTIONS}
              style={{ width: '100%' }}
              onChange={(value) => { enterpriseRole = value }}
            />
          </div>
          <p style={{ color: '#8a93a3', fontSize: 12 }}>系统将自动创建 Enterprise + 绑定/创建 AppUser；AppUser 平台角色保持 user；申请状态置为「已转化」。</p>
        </div>
      ),
      okText: '确认开通',
      onOk: async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res: any = await nodeApi.post(`/api/admin/enterprise/applications/${row.id}/activate`, { enterpriseRole })
          message.success(`已开通：${res?.data?.enterprise?.name || row.company}`)
          load()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '开通失败')
        }
      },
    })
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Title level={4} style={{ margin: 0 }}>企业申请</Title>
        <Space wrap>
          <Input.Search
            placeholder="搜索姓名 / 手机 / 公司"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 240 }}
          />
          <Select
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            style={{ width: 140 }}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        scroll={{ x: 1200 }}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          { title: '姓名',     dataIndex: 'name',     width: 100 },
          { title: '职位',     dataIndex: 'position', width: 120 },
          { title: '公司',     dataIndex: 'company',  width: 160 },
          { title: '手机',     dataIndex: 'phone',    width: 130 },
          {
            title: '需求描述',
            dataIndex: 'requirement',
            ellipsis: { showTitle: false },
            width: 300,
            render: (v: string) =>
              v
                ? <Tooltip title={v}><span>{v}</span></Tooltip>
                : <span style={{ color: '#bbb' }}>未填写</span>,
          },
          {
            title: '提交时间',
            dataIndex: 'createdAt',
            width: 160,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (v: string) => (
              <Tag color={STATUS_COLOR[v] || 'default'}>{STATUS_LABEL[v] || v}</Tag>
            ),
          },
          {
            title: '操作',
            width: 320,
            render: (_: unknown, row: EnterpriseRow) => (
              <Space>
                <Select
                  size="small"
                  value={row.status}
                  style={{ width: 110 }}
                  onChange={(v) => changeStatus(row.id, v)}
                  options={[
                    { value: 'pending',   label: '待跟进' },
                    { value: 'contacted', label: '已联系' },
                  ]}
                />
                {row.status !== 'converted' && (
                  <Button size="small" type="primary" onClick={() => activate(row)}>一键开通</Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </div>
  )
}
