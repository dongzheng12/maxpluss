/* eslint-disable react-refresh/only-export-components */
/**
 * 后台 — 专家评审投票管理列表页
 */
import { useEffect, useState, useMemo } from 'react'
import {
  Card, Table, Tag, Typography, Space, Button, Input, Select, Tabs, Tooltip,
  Row, Col, Statistic, message, Dropdown,
} from 'antd'
import {
  ReloadOutlined, DownloadOutlined, FilterOutlined,
  FileTextOutlined, UserOutlined, DollarOutlined, CalendarOutlined,
} from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { adminListExpertVotes } from '../../../api/admin'
import {
  ADMIN_EXPERT_VOTE_STATUS_LABEL,
  getAdminDisplayStatus,
} from '../../../utils/expertVoteUi'

const { Title, Text } = Typography

// 后台中文状态文案（用于 Tag / 下拉 / 描述）。
const ADMIN_STATUS_LABEL = ADMIN_EXPERT_VOTE_STATUS_LABEL

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'DRAFT', label: ADMIN_STATUS_LABEL.DRAFT },
  { value: 'PAYING', label: ADMIN_STATUS_LABEL.PAYING },
  { value: 'EXPERT_ARRANGING', label: ADMIN_STATUS_LABEL.EXPERT_ARRANGING },
  { value: 'MEETING_SCHEDULED', label: ADMIN_STATUS_LABEL.MEETING_SCHEDULED },
  { value: 'VOTING', label: ADMIN_STATUS_LABEL.VOTING },
  { value: 'VOTED', label: ADMIN_STATUS_LABEL.VOTED },
  { value: 'SIGNING', label: ADMIN_STATUS_LABEL.SIGNING },
  { value: 'COMPLETED', label: ADMIN_STATUS_LABEL.COMPLETED },
  { value: 'CANCELLED', label: ADMIN_STATUS_LABEL.CANCELLED },
  { value: 'REFUNDED', label: ADMIN_STATUS_LABEL.REFUNDED },
]

const TABS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'all', label: '全部', statuses: [] },
  { key: 'pending', label: '待处理', statuses: ['EXPERT_ARRANGING', 'MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING'] },
  { key: 'arranging', label: '待安排', statuses: ['EXPERT_ARRANGING'] },
  { key: 'meeting', label: '会议已定', statuses: ['MEETING_SCHEDULED'] },
  { key: 'voting', label: '待整理', statuses: ['VOTING', 'VOTED'] },
  { key: 'signing', label: '待交付', statuses: ['SIGNING'] },
  { key: 'completed', label: '已完成', statuses: ['COMPLETED'] },
]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// 当前是不是本月（用于"本月完成"统计）
function isThisMonth(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

type ActionConfig = {
  primary: { label: string; tooltip: string }
  more?: Array<{ key: string; label: string }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getActionConfig(row: any): ActionConfig {
  const s = row?.status
  if (s === 'DRAFT') return { primary: { label: '草稿', tooltip: '查看草稿详情' } }
  if (s === 'PAYING') {
    return { primary: { label: '订单', tooltip: '查看支付订单' }, more: [{ key: 'detail', label: '详情' }] }
  }
  if (s === 'EXPERT_ARRANGING') {
    return {
      primary: { label: '安排', tooltip: '安排专家与会议' },
      more: [
        { key: 'detail', label: '详情' },
        { key: 'files', label: '材料' },
      ],
    }
  }
  if (s === 'MEETING_SCHEDULED') {
    return {
      primary: { label: '进入整理', tooltip: '人工确认会议结束后进入会后结果整理' },
      more: [
        { key: 'meeting', label: '会议' },
        { key: 'notify', label: '通知' },
        { key: 'detail', label: '详情' },
      ],
    }
  }
  if (s === 'VOTING') {
    return { primary: { label: '录入', tooltip: '录入评审结果' }, more: [{ key: 'detail', label: '详情' }] }
  }
  if (s === 'VOTED') {
    return { primary: { label: '生成 Word', tooltip: '生成 Word 确认文件' }, more: [{ key: 'detail', label: '详情' }] }
  }
  if (s === 'SIGNING') {
    return {
      primary: { label: '上传', tooltip: '上传最终交付文件' },
      more: [
        { key: 'download', label: '下载' },
        { key: 'detail', label: '详情' },
      ],
    }
  }
  if (s === 'COMPLETED') {
    return { primary: { label: '下载', tooltip: '下载最终交付文件' }, more: [{ key: 'archive', label: '归档' }] }
  }
  if (s === 'CANCELLED' || s === 'REFUNDED') {
    return { primary: { label: '归档', tooltip: '查看归档记录' } }
  }
  return { primary: { label: '详情', tooltip: '查看详情' } }
}

export default function AdminExpertVotesPage() {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [tabKey, setTabKey] = useState<string>('all')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await adminListExpertVotes({
        status: status || undefined,
        q: q || undefined,
        page,
        pageSize,
      })
      setItems(res?.items || [])
      setTotal(res?.total || 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败，请稍后重试')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() /* eslint-disable-next-line */ }, [status, page, pageSize])

  // Tab 客户端过滤
  const filteredItems = useMemo(() => {
    const tab = TABS.find((t) => t.key === tabKey)
    if (!tab || tab.statuses.length === 0) return items
    return items.filter((it) => tab.statuses.includes(it.status))
  }, [items, tabKey])

  // 客户端聚合统计（仅基于当前 list 数据，不全量准确）
  const stats = useMemo(() => {
    const pending = items.filter((it) => ['EXPERT_ARRANGING', 'MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING'].includes(it.status)).length
    const completedThisMonth = items.filter(
      (it) => it.status === 'COMPLETED' && isThisMonth(it.deliveredAt || it.signedAt || it.updatedAt),
    ).length
    return { pending, completedThisMonth }
  }, [items])

  return (
    <div>
      {/* 顶部 */}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }} gutter={[16, 16]}>
        <Col>
          <Title level={4} style={{ margin: 0 }}>专家评审投票管理</Title>
          <Text type="secondary">管理和处理专家评审投票申请</Text>
        </Col>
        <Col>
          <Space size={12}>
            <Card
              size="small"
              style={{ background: '#EFF6FF', borderColor: '#BFDBFE', minWidth: 140 }}
            >
              <Statistic
                title={<span style={{ fontSize: 12, color: '#1D4ED8' }}>当前列表待处理</span>}
                value={stats.pending}
                valueStyle={{ color: '#1D4ED8', fontSize: 24, fontWeight: 700 }}
              />
            </Card>
            <Card
              size="small"
              style={{ background: '#ECFDF5', borderColor: '#A7F3D0', minWidth: 140 }}
            >
              <Statistic
                title={<span style={{ fontSize: 12, color: '#059669' }}>当前列表本月完成</span>}
                value={stats.completedThisMonth}
                valueStyle={{ color: '#059669', fontSize: 24, fontWeight: 700 }}
              />
            </Card>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          </Space>
        </Col>
      </Row>

      <Card>
        <Tabs
          activeKey={tabKey}
          onChange={(k) => { setTabKey(k); setStatus('') }}
          items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        />

        <Space wrap style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Input.Search
              placeholder="搜索申请编号 / 项目名称 / 申请人 / 联系电话"
              allowClear
              style={{ width: 360 }}
              onSearch={() => { setPage(1); load() }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Select
              value={status}
              style={{ width: 160 }}
              onChange={(v) => { setPage(1); setStatus(v); setTabKey('all') }}
              options={STATUS_OPTIONS}
            />
          </Space>
          <Space>
            <Tooltip title="敬请期待">
              <Button icon={<FilterOutlined />} disabled>更多筛选</Button>
            </Tooltip>
            <Tooltip title="敬请期待">
              <Button icon={<DownloadOutlined />} disabled>导出</Button>
            </Tooltip>
          </Space>
        </Space>

        <Table
          rowKey="requestNo"
          dataSource={filteredItems}
          loading={loading}
          scroll={{ x: 1200 }}
          rowClassName={(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            row: any
          ) => {
            if (row.status !== 'EXPERT_ARRANGING') return ''
            const start = row.paidAt || row.submittedAt || row.createdAt
            if (!start) return ''
            const elapsed = Date.now() - new Date(start).getTime()
            return elapsed >= DAY_MS ? 'expert-vote-row-overdue' : ''
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (n, range) => `显示 ${range[0]}-${range[1]} 条记录，共 ${n} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          columns={[
            {
              title: <><FileTextOutlined /> 申请信息</>,
              key: 'reqInfo',
              width: 280,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => (
                <Link to={`/admin/expert-votes/${row.requestNo}`} style={{ display: 'block' }}>
                  <div style={{ fontSize: 12, color: '#2563EB', marginBottom: 2, fontFamily: 'monospace' }}>
                    {row.requestNo}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#2563EB' }}>{row.projectName}</div>
                </Link>
              ),
            },
            {
              title: <><UserOutlined /> 申请人 / 单位</>,
              key: 'applicant',
              width: 200,
              hidden: isMobile,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{row.applicant?.name || '-'}</div>
                  <div
                    style={{ fontSize: 12, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={row.applicant?.organization || ''}
                  >
                    {row.applicant?.organization || row.applicant?.phone || '-'}
                  </div>
                </div>
              ),
            },
            {
              title: <><DollarOutlined /> 专家 / 金额</>,
              key: 'expertAmount',
              width: 140,
              hidden: isMobile,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => (
                <div>
                  <div style={{ fontSize: 14 }}>{row.expertCount} 位专家</div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#10B981' }}>
                    {typeof row.totalAmount === 'number' ? `¥${(row.totalAmount / 100).toLocaleString()}` : '-'}
                  </div>
                </div>
              ),
            },
            {
              title: '状态',
              key: 'status',
              width: 220,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => {
                const { label, color } = getAdminDisplayStatus(row)
                const tags = [<Tag color={color} key="status">{label}</Tag>]

                if (row.status === 'EXPERT_ARRANGING') {
                  const start = row.paidAt || row.submittedAt || row.createdAt
                  if (start && Date.now() - new Date(start).getTime() >= DAY_MS) {
                    tags.push(<Tag color="red" key="overdue">超24h</Tag>)
                  }
                }

                return <Space size={4} wrap>{tags}</Space>
              },
            },
            {
              title: <><CalendarOutlined /> 时间</>,
              key: 'times',
              width: 180,
              hidden: isMobile,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => {
                const submitted = row.submittedAt || row.createdAt
                const updated = row.updatedAt || row.deliveredAt || row.signedAt
                return (
                  <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.7 }}>
                    <div>申请：{submitted ? new Date(submitted).toLocaleString('zh-CN', { hour12: false }) : '-'}</div>
                    {updated && updated !== submitted && (
                      <div>更新：{new Date(updated).toLocaleString('zh-CN', { hour12: false })}</div>
                    )}
                  </div>
                )
              },
            },
            {
              title: '操作',
              key: 'actions',
              width: 160,
              fixed: 'right' as const,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => {
                const detailUrl = `/admin/expert-votes/${row.requestNo}`
                const cfg = getActionConfig(row)
                const moreItems = (cfg.more || []).map((m) => ({
                  key: m.key,
                  label: m.label,
                  onClick: () => navigate(detailUrl),
                }))
                return (
                  <Space size={4}>
                    <Tooltip title={cfg.primary.tooltip}>
                      <Button size="small" type="primary" onClick={() => navigate(detailUrl)}>
                        {cfg.primary.label}
                      </Button>
                    </Tooltip>
                    {moreItems.length > 0 && (
                      <Dropdown menu={{ items: moreItems }}>
                        <Button size="small">更多</Button>
                      </Dropdown>
                    )}
                  </Space>
                )
              },
            },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ].filter((c: any) => !('hidden' in c && c.hidden))}
        />
      </Card>

      <style>{`
        .expert-vote-row-overdue td {
          background: #fff5f5 !important;
        }
        .expert-vote-row-overdue:hover td {
          background: #ffecec !important;
        }
      `}</style>
    </div>
  )
}
