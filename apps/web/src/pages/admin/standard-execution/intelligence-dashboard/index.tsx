import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Alert, Button, Empty, Progress, Segmented, Spin, Table, Tag, message } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  seExportIntelligenceDashboard,
  seExportIntelligenceDashboardEnterprise,
  seGetIntelligenceDashboard,
  seGetIntelligenceDashboardEnterprise,
  type IntelligenceDashboardData,
  type IntelligenceRangeDays,
} from '../../../../api/standardExecution'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  boxShadow: '0 10px 22px rgba(15, 23, 42, 0.04)',
}

const mutedStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 13,
}

const chartBoxStyle: CSSProperties = {
  width: '100%',
  height: 260,
  minWidth: 0,
}

type MetricCardProps = {
  title: string
  value: ReactNode
  caption: string
  accent: string
}

type ExecutorRow = IntelligenceDashboardData['people']['topExecutors'][number]
type DepartmentRow = IntelligenceDashboardData['department']['rows'][number]
type ReviewEfficiencyRow = IntelligenceDashboardData['people']['reviewEfficiency'][number]

function MetricCard({ title, value, caption, accent }: MetricCardProps) {
  return (
    <section style={{ ...cardStyle, padding: 16, borderLeft: `4px solid ${accent}`, minHeight: 108 }}>
      <div style={{ ...mutedStyle, lineHeight: '18px' }}>{title}</div>
      <div style={{ color: '#0f172a', fontSize: 30, lineHeight: '40px', fontWeight: 800, marginTop: 4 }}>{value}</div>
      <div style={{ color: '#64748b', fontSize: 12, lineHeight: '18px' }}>{caption}</div>
    </section>
  )
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ ...cardStyle, padding: 20, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: '#0f172a', fontSize: 17, fontWeight: 700 }}>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  )
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function percentText(value: number) {
  return `${value || 0}%`
}

const coverageColors = ['#2563eb', '#f97316']

export default function SeIntelligenceDashboardPage() {
  const loc = useLocation()
  const nav = useNavigate()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [range, setRange] = useState<IntelligenceRangeDays>(90)
  const [data, setData] = useState<IntelligenceDashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const fn = isEnterprise ? seGetIntelligenceDashboardEnterprise : seGetIntelligenceDashboard
      const res = await fn(range)
      setData(res.data)
    } catch {
      message.error('加载数据看板失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [range, isEnterprise])

  const coveragePieData = useMemo(() => {
    if (!data) return []
    return [
      { name: '已覆盖', value: data.overview.coveredRequirements },
      { name: '未覆盖', value: data.overview.uncoveredRequirements },
    ]
  }, [data])

  const handleExport = async () => {
    setExporting(true)
    try {
      const fn = isEnterprise ? seExportIntelligenceDashboardEnterprise : seExportIntelligenceDashboard
      const blob = await fn(range)
      downloadBlob(blob, `执行数据看板-${range}天-${dayjs().format('YYYYMMDD')}.xlsx`)
    } catch {
      message.error('导出失败')
    } finally {
      setExporting(false)
    }
  }

  const departmentColumns = [
    { title: '部门', dataIndex: 'departmentId', width: 160 },
    { title: '控制点', dataIndex: 'controlPointCount', width: 90 },
    { title: '已覆盖', dataIndex: 'coveredCount', width: 90 },
    {
      title: '覆盖率',
      dataIndex: 'coverageRate',
      width: 180,
      render: (value: number) => <Progress percent={value} size="small" />,
    },
    {
      title: '逾期任务',
      dataIndex: 'overdueTaskCount',
      width: 100,
      render: (value: number) => value > 0 ? <Tag color="red">{value}</Tag> : <Tag color="green">0</Tag>,
    },
  ]

  const executorColumns = [
    { title: '人员', dataIndex: 'name', ellipsis: true },
    { title: '任务数', dataIndex: 'totalTasks', width: 82 },
    { title: '已完成', dataIndex: 'completedTasks', width: 82 },
    {
      title: '完成率',
      dataIndex: 'completionRate',
      width: 150,
      render: (value: number) => <Progress percent={value} size="small" />,
    },
  ]

  const reviewColumns = [
    { title: '审核人', dataIndex: 'name', ellipsis: true },
    { title: '审核数', dataIndex: 'reviewedCount', width: 82 },
    { title: '通过率', dataIndex: 'passRate', width: 90, render: (value: number) => percentText(value) },
    { title: '平均响应', dataIndex: 'avgReviewHours', width: 100, render: (value: number) => `${value} 小时` },
  ]

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Segmented
          value={range}
          onChange={(value) => setRange(value as IntelligenceRangeDays)}
          options={[
            { label: '近 30 天', value: 30 },
            { label: '近 90 天', value: 90 },
            { label: '近 365 天', value: 365 },
          ]}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          <Button icon={<DownloadOutlined />} onClick={handleExport} loading={exporting}>导出 Excel</Button>
        </div>
      </div>

      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : data ? (
        <div style={{ display: 'grid', gap: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <MetricCard title="控制点覆盖率" value={percentText(data.overview.coverageRate)} caption={`${data.overview.coveredRequirements}/${data.overview.totalRequirements} 已覆盖`} accent="#2563eb" />
            <MetricCard title="任务完成率" value={percentText(data.overview.taskCompletionRate)} caption={`${data.overview.tasksCompleted}/${data.overview.tasksTotal} 已完成`} accent="#16a34a" />
            <MetricCard title="审核通过率" value={percentText(data.overview.reviewPassRate)} caption={`${data.overview.reviewsApproved}/${data.overview.reviewsTotal} 已通过`} accent="#7c3aed" />
            <MetricCard title="逾期任务数" value={data.overview.overdueTasks} caption="当前需跟进任务" accent="#dc2626" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
            <Section title="覆盖结构">
              <div style={chartBoxStyle}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie dataKey="value" data={coveragePieData} innerRadius={60} outerRadius={86} paddingAngle={4}>
                      {coveragePieData.map((entry, index) => <Cell key={entry.name} fill={coverageColors[index % coverageColors.length]} />)}
                    </Pie>
                    <RechartsTooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Section>

            <Section title="任务完成率趋势" extra={<Tag>{data.range.startDate} 至 {data.range.endDate}</Tag>}>
              <div style={chartBoxStyle}>
                <ResponsiveContainer>
                  <AreaChart data={data.trends.taskCompletion}>
                    <defs>
                      <linearGradient id="taskRate" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.26} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} width={42} />
                    <RechartsTooltip formatter={(value) => [`${value}`, '数值']} />
                    <Area type="monotone" dataKey="rate" name="完成率" stroke="#2563eb" fill="url(#taskRate)" />
                    <Line type="monotone" dataKey="completed" name="已完成" stroke="#16a34a" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Section>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
            <Section title="审核通过率趋势">
              <div style={chartBoxStyle}>
                <ResponsiveContainer>
                  <LineChart data={data.trends.reviewPass}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} width={42} />
                    <RechartsTooltip />
                    <Legend />
                    <Line type="monotone" dataKey="rate" name="通过率" stroke="#7c3aed" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="approved" name="通过数" stroke="#16a34a" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Section>

            <Section title="逾期任务趋势">
              <div style={chartBoxStyle}>
                <ResponsiveContainer>
                  <BarChart data={data.trends.overdue}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} width={42} />
                    <RechartsTooltip />
                    <Bar dataKey="overdue" name="逾期任务" fill="#dc2626" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Section>
          </div>

          {data.department.visible && (
            <Section title="部门覆盖率排行">
              <Table<DepartmentRow>
                size="small"
                rowKey="departmentId"
                pagination={false}
                dataSource={data.department.rows}
                columns={departmentColumns}
              />
            </Section>
          )}

          {data.people.visible ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
              <Section title="执行完成率 TOP 10">
                <Table<ExecutorRow> size="small" rowKey="userId" pagination={false} dataSource={data.people.topExecutors} columns={executorColumns} />
              </Section>
              <Section title="执行完成率后 10">
                <Table<ExecutorRow> size="small" rowKey="userId" pagination={false} dataSource={data.people.bottomExecutors} columns={executorColumns} />
              </Section>
              <Section title="审核效率">
                <Table<ReviewEfficiencyRow> size="small" rowKey="userId" pagination={false} dataSource={data.people.reviewEfficiency} columns={reviewColumns} />
              </Section>
            </div>
          ) : (
            <Alert type="info" showIcon message="人员维度仅企业 ADMIN / MANAGER 可见" />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="link" onClick={() => nav(isEnterprise ? '/enterprise/risks' : '/admin/standard-execution/risks')}>
              查看合规雷达
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ ...cardStyle, padding: 64 }}>
          <Empty description="暂无数据看板数据" />
        </div>
      )}
    </div>
  )
}
