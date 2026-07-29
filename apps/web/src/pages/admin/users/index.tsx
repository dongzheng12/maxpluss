import { useState, useEffect, useRef } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Table, Card, Typography, Button, Space, Tag, Tooltip, Input, Modal, message } from 'antd'
import { ReloadOutlined, StopOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'

const { Title, Text } = Typography

const tierMap: Record<string, { text: string; color: string }> = {
  free: { text: '普通用户', color: 'default' },
  personal: { text: '个人会员', color: 'blue' },
  pro: { text: '专业会员', color: 'gold' },
  enterprise: { text: '企业会员', color: 'purple' },
}

interface UserRow {
  id: string
  phone?: string
  name?: string
  organization?: string
  isBlocked: boolean
  memberTier: string
  createdAt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}

export default function AdminUsersPage() {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<UserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [batchLoading, setBatchLoading] = useState(false)
  const [toggling, setToggling] = useState<string>('')

  const load = async (p: number, kw: string) => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = { page: p, pageSize: 20 }
      if (kw.trim()) params.keyword = kw.trim()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/users', { params })
      setItems(res?.items || [])
      setTotal(res?.total || 0)
      setSelectedRowKeys([])
    } catch { /* ignore */ }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(page, keyword) /* eslint-disable-next-line */ }, [page])

  const debounceRef = useRef<number | null>(null)
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setPage(1)
      load(1, keyword)
    }, 300)
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current) }
    // eslint-disable-next-line
  }, [keyword])

  const toggleSingle = (u: UserRow) => {
    const willBlock = !u.isBlocked
    Modal.confirm({
      title: willBlock ? '禁用用户' : '启用用户',
      icon: <ExclamationCircleOutlined style={{ color: willBlock ? '#ff4d4f' : undefined }} />,
      content: (
        <div>
          <p>确认{willBlock ? '禁用' : '启用'}用户 <strong>{u.name || u.phone || u.id}</strong>？</p>
          <p style={{ color: '#ff4d4f' }}>此操作将影响用户登录，请谨慎操作。</p>
        </div>
      ),
      okText: willBlock ? '确认禁用' : '确认启用',
      okType: willBlock ? 'danger' : 'primary',
      cancelText: '取消',
      onOk: async () => {
        setToggling(u.id)
        try {
          await nodeApi.patch(`/api/admin/users/${u.id}/toggle-blocked`)
          message.success(willBlock ? '已禁用' : '已启用')
          load(page, keyword)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '操作失败')
        }
        setToggling('')
      },
    })
  }

  const selectedActive = items.filter(u => selectedRowKeys.includes(u.id) && !u.isBlocked)
  const selectedBlocked = items.filter(u => selectedRowKeys.includes(u.id) && u.isBlocked)

  const batchToggle = (toBlock: boolean) => {
    const targets = toBlock ? selectedActive : selectedBlocked
    if (targets.length === 0) return message.warning(toBlock ? '请选择正常用户' : '请选择已禁用用户')
    Modal.confirm({
      title: toBlock ? '批量禁用' : '批量启用',
      icon: <ExclamationCircleOutlined style={{ color: toBlock ? '#ff4d4f' : undefined }} />,
      content: (
        <div>
          <p>选中 <strong>{targets.length}</strong> 名用户进行{toBlock ? '禁用' : '启用'}</p>
          <p style={{ color: '#ff4d4f' }}>此操作将影响用户登录，请谨慎操作。</p>
        </div>
      ),
      okText: `${toBlock ? '禁用' : '启用'} ${targets.length} 名`,
      okType: toBlock ? 'danger' : 'primary',
      cancelText: '取消',
      onOk: async () => {
        setBatchLoading(true)
        let ok = 0, fail = 0
        for (const u of targets) {
          try {
            await nodeApi.patch(`/api/admin/users/${u.id}/toggle-blocked`)
            ok++
          } catch { fail++ }
        }
        message.success(`批量${toBlock ? '禁用' : '启用'}完成：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`)
        setBatchLoading(false)
        load(page, keyword)
      },
    })
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Title level={4} style={{ margin: 0 }}>用户管理</Title>
        <Space wrap>
          <Input.Search
            placeholder="搜索手机号 / 姓名 / 单位"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 260 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => load(page, keyword)}>刷新</Button>
        </Space>
      </Space>

      {selectedRowKeys.length > 0 && (
        <Card size="small" style={{ marginBottom: 12, background: '#f0f5ff', border: '1px solid #d6e4ff' }}>
          <Space wrap>
            <Text>已选 <Text strong>{selectedRowKeys.length}</Text> 名用户</Text>
            {selectedActive.length > 0 && (
              <Button danger size="small" icon={<StopOutlined />} loading={batchLoading} onClick={() => batchToggle(true)}>
                批量禁用 ({selectedActive.length})
              </Button>
            )}
            {selectedBlocked.length > 0 && (
              <Button type="primary" size="small" icon={<CheckCircleOutlined />} loading={batchLoading} onClick={() => batchToggle(false)}>
                批量启用 ({selectedBlocked.length})
              </Button>
            )}
            <Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
          </Space>
        </Card>
      )}

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="id"
          dataSource={items}
          loading={loading}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: (p) => setPage(p),
            showTotal: (t) => `共 ${t} 名用户`,
          }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 180, ellipsis: { showTitle: false }, hidden: isMobile,
              render: (v: string) => v ? <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip> : '-',
            },
            { title: '手机号', dataIndex: 'phone', width: 130 },
            { title: '邮箱', dataIndex: 'email', width: 200, ellipsis: { showTitle: false }, hidden: isMobile,
              render: (v: string) => v ? <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip> : '-',
            },
            { title: '姓名', dataIndex: 'name', width: 120, ellipsis: { showTitle: false },
              render: (v: string) => v ? <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip> : '-',
            },
            { title: '单位', dataIndex: 'organization', ellipsis: { showTitle: false }, hidden: isMobile,
              render: (v: string) => v ? <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip> : '-',
            },
            {
              title: '会员状态', dataIndex: 'memberTier', width: 100,
              render: (tier: string) => {
                const info = tierMap[tier] || tierMap.free
                return <Tag color={info.color}>{info.text}</Tag>
              },
            },
            {
              title: '账号状态', dataIndex: 'isBlocked', width: 100,
              render: (v: boolean) => v ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>,
            },
            { title: '注册时间', dataIndex: 'createdAt', width: 170, hidden: isMobile,
              render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
            {
              title: '操作', width: 120, fixed: 'right' as const,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, u: UserRow) => (
                u.isBlocked ? (
                  <Button size="small" type="primary" icon={<CheckCircleOutlined />} loading={toggling === u.id} onClick={() => toggleSingle(u)}>启用</Button>
                ) : (
                  <Button size="small" danger icon={<StopOutlined />} loading={toggling === u.id} onClick={() => toggleSingle(u)}>禁用</Button>
                )
              ),
            },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
