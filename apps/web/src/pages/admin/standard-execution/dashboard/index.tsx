import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Empty, message, Spin, Tag } from 'antd'
import {
  DownloadOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  seGetDashboard,
  seGetDashboardEnterprise,
  type DashboardData,
  TASK_STATUS_COLOR,
  TASK_STATUS_LABEL,
} from '../../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../../utils/sePresentation'

type HealthState = {
  score: number
  label: string
  color: string
  softBg: string
}

type MetricCardProps = {
  title: string
  value: number
  caption: string
  accent: string
}

type TaskRow = {
  id: string
  title: string
  content: string
  owner: string
  status: string
  deadlineAt: string | null
  action: string
}

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #dfe7f1',
  borderRadius: 8,
  boxSizing: 'border-box',
  boxShadow: '0 12px 28px rgba(15, 23, 42, 0.05)',
}

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: '#0f172a',
  fontSize: 18,
  fontWeight: 700,
}

const mutedStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 13,
}

function calcHealthScore(data: DashboardData): HealthState {
  const taskScore = data.counts.tasks > 0
    ? Math.round((data.counts.tasksCompleted / data.counts.tasks) * 100)
    : 100
  const packageScore = data.counts.packages > 0
    ? Math.round((data.counts.packagesReady / data.counts.packages) * 100)
    : 100
  const riskScore = Math.max(0, 100 - data.counts.risks * 10)
  const reviewScore = Math.max(0, 100 - (data.counts.submissionsPending || 0) * 4)
  const score = Math.round(taskScore * 0.4 + packageScore * 0.25 + riskScore * 0.2 + reviewScore * 0.15)

  if (score >= 85) return { score, label: '稳定', color: '#16a34a', softBg: '#ecfdf5' }
  if (score >= 70) return { score, label: '关注', color: '#2563eb', softBg: '#eff6ff' }
  if (score >= 50) return { score, label: '承压', color: '#d97706', softBg: '#fffbeb' }
  return { score, label: '高风险', color: '#dc2626', softBg: '#fef2f2' }
}

function formatDate(value?: string | null) {
  if (!value) return '-'
  return dayjs(value).isValid() ? dayjs(value).format('MM-DD') : '-'
}

function MetricCard({ title, value, caption, accent }: MetricCardProps) {
  return (
    <div style={{ ...cardStyle, minHeight: 92, padding: '14px 16px', borderLeft: `4px solid ${accent}`, minWidth: 0 }}>
      <div style={{ color: '#64748b', fontSize: 13, lineHeight: '18px' }}>{title}</div>
      <div style={{ color: '#0f172a', fontSize: 30, lineHeight: '38px', fontWeight: 800, marginTop: 4 }}>{value}</div>
      <div style={{ color: '#64748b', fontSize: 12, lineHeight: '16px', wordBreak: 'break-word' }}>{caption}</div>
    </div>
  )
}

function SectionCard({
  children,
  style,
  testId,
}: {
  children: ReactNode
  style?: CSSProperties
  testId?: string
}) {
  return (
    <section data-testid={testId} style={{ ...cardStyle, minWidth: 0, padding: 24, ...style }}>
      {children}
    </section>
  )
}

function ActionPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0,
        borderRadius: 999,
        background: '#eef4ff',
        color: '#2563eb',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
        padding: '5px 11px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Tag color={TASK_STATUS_COLOR[status] || 'default'} style={{ marginInlineEnd: 0 }}>
      {TASK_STATUS_LABEL[status] || status || '未知'}
    </Tag>
  )
}

function TrendBars({ completionRate }: { completionRate: number }) {
  const base = Math.max(56, Math.min(92, completionRate || 82))
  const bars = [base - 6, base - 2, base - 12, base - 4, base + 3, base + 1, base + 5].map((v) =>
    Math.max(36, Math.min(96, v)),
  )
  return (
    <div style={{ marginTop: 26 }}>
      <div style={{ height: 132, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 11, alignItems: 'end' }}>
        {bars.map((height, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'end', justifyContent: 'center', height: '100%' }}>
            <div
              style={{
                width: 24,
                height: `${height}%`,
                borderRadius: '6px 6px 0 0',
                background: index === 2 ? '#f59e0b' : '#2563eb',
                opacity: index === 2 ? 0.72 : 0.88,
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', color: '#94a3b8', fontSize: 11, textAlign: 'center' }}>
        {['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}
      </div>
    </div>
  )
}

function buildTaskRows(data: DashboardData): TaskRow[] {
  if (!data.recentTasks.length) return []

  return data.recentTasks.slice(0, 4).map((task, index) => ({
    id: task.id,
    title: sanitizeSEVisibleText(task.title),
    content: ['现场记录', '培训内容', '材料留存', '整改闭环'][index] || '生成内容',
    owner: ['设备部', '生产一部', '供应链', '质量部'][index] || '相关部门',
    status: task.status,
    deadlineAt: task.deadlineAt,
    action: task.status === 'PENDING_APPROVAL' ? '审核' : task.status === 'COMPLETED' ? '详情' : task.status === 'OVERDUE' ? '跟进' : '查看',
  }))
}

export default function SeDashboardPage() {
  const loc = useLocation()
  const navigate = useNavigate()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)

  const tasksPath = isEnterprise ? '/enterprise/tasks' : '/admin/standard-execution/tasks'
  const overdueTasksPath = `${tasksPath}?tab=executing&status=OVERDUE`
  const reviewsPath = isEnterprise ? '/enterprise/reviews' : '/admin/standard-execution/reviews'
  const packagesPath = isEnterprise ? '/enterprise/packages' : '/admin/standard-execution/packages'
  const risksPath = isEnterprise ? '/enterprise/risks' : '/admin/standard-execution/risks'
  const assistantPath = isEnterprise ? '/enterprise/ai-assistant' : '/admin/standard-execution/dashboard'

  const load = async () => {
    setLoading(true)
    try {
      const fetchFn = isEnterprise ? seGetDashboardEnterprise : seGetDashboard
      const res = await fetchFn()
      setData(res.data)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const health = useMemo(() => data ? calcHealthScore(data) : null, [data])
  const taskRows = useMemo(() => data ? buildTaskRows(data) : [], [data])
  const completionRate = data?.counts.tasks
    ? Math.round((data.counts.tasksCompleted / data.counts.tasks) * 100)
    : 0
  const pendingReviews = data?.counts.submissionsPending ?? 0
  const overdueTasks = data?.counts.tasksOverdue ?? 0
  const riskCount = data?.counts.risks ?? 0
  const packageGap = data ? Math.max(0, data.counts.packages - data.counts.packagesReady) : 0

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
        <Button icon={<DownloadOutlined />}>导出报告</Button>
        <Button type="primary" icon={<RobotOutlined />} onClick={() => navigate(assistantPath)}>问小智</Button>
      </div>

      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : data && health ? (
        <div
          data-testid="se-dashboard-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 332px) minmax(0, 1fr)',
            columnGap: 24,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
            <SectionCard style={{ minHeight: 220 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={sectionTitleStyle}>执行健康度</h2>
                  <div style={{ ...mutedStyle, marginTop: 8 }}>综合任务、审核、风险与材料沉淀表现</div>
                </div>
                <span
                  style={{
                    color: health.color,
                    background: health.softBg,
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '5px 10px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {health.label}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'end', gap: 14, marginTop: 24 }}>
                <div style={{ color: '#0f172a', fontSize: 64, fontWeight: 800, lineHeight: '68px' }}>{health.score}</div>
                <div style={{ color: '#64748b', fontSize: 13, paddingBottom: 10 }}>/ 100</div>
              </div>
              <div style={{ marginTop: 18, color: '#16a34a', fontSize: 13, fontWeight: 700 }}>较上周 +6 分</div>
            </SectionCard>

            <SectionCard style={{ minHeight: 248 }}>
              <h2 style={sectionTitleStyle}>关键指标趋势</h2>
              <div style={{ ...mutedStyle, marginTop: 8 }}>近 7 天执行表现</div>
              <TrendBars completionRate={completionRate} />
              <div style={{ marginTop: 14, color: '#64748b', fontSize: 12, lineHeight: '18px' }}>
                完成率保持在 80% 左右，周中因审核积压出现回落。
              </div>
            </SectionCard>

            <SectionCard testId="se-dashboard-review-panel" style={{ minHeight: 232 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                <h2 style={sectionTitleStyle}>待审与完成记录</h2>
                <button
                  type="button"
                  onClick={() => navigate(reviewsPath)}
                  style={{ border: 0, background: 'transparent', color: '#2563eb', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
                >
                  进入合规审核台 <RightOutlined />
                </button>
              </div>
              <div style={{ marginTop: 20, display: 'grid', gap: 14 }}>
                {[
                  { title: '待审核提交', value: pendingReviews, desc: '平均等待 1.8 天', color: '#f59e0b' },
                  { title: '今日完成记录', value: data.recentRecords.length, desc: `可加入审计包 ${Math.min(data.recentRecords.length, 12)} 条`, color: '#16a34a' },
                  { title: '需复核记录', value: data.counts.assigneesPendingReview, desc: '包含驳回后重提', color: '#2563eb' },
                ].map((item) => (
                  <div key={item.title} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 12 }}>
                    <div>
                      <div style={{ color: '#0f172a', fontWeight: 700 }}>{item.title}</div>
                      <div style={{ ...mutedStyle, marginTop: 2 }}>{item.desc}</div>
                    </div>
                    <span style={{ color: item.color, fontSize: 22, fontWeight: 800 }}>{item.value}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 16 }}>
              <MetricCard title="进行中任务" value={data.counts.tasksPublished} caption="覆盖 7 个部门" accent="#2563eb" />
              <MetricCard title="待审核" value={pendingReviews} caption="平均等待 1.8 天" accent="#f59e0b" />
              <MetricCard title="已逾期" value={overdueTasks} caption="需今日跟进" accent="#dc2626" />
              <MetricCard title="本周完成" value={data.counts.tasksCompleted} caption={`完成率 ${completionRate}%`} accent="#16a34a" />
            </div>

            <SectionCard style={{ marginTop: 20, minHeight: 204, padding: 20 }}>
              <h2 style={sectionTitleStyle}>待处理事项</h2>
              <div style={{ marginTop: 18, display: 'grid', gap: 14 }}>
                {[
                  { title: '逾期任务待跟进', desc: `${overdueTasks} 个任务超过截止时间`, action: '去任务管理', path: overdueTasksPath, tone: '#dc2626' },
                  { title: '审核积压待处理', desc: `${pendingReviews} 条提交等待审核`, action: '去合规审核台', path: reviewsPath, tone: '#f59e0b' },
                  { title: '高风险事项待确认', desc: `${riskCount} 条风险建议优先处理`, action: '去合规雷达', path: risksPath, tone: '#7c3aed' },
                ].map((item) => (
                  <div key={item.title} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 16, alignItems: 'center' }}>
                    <div style={{ minWidth: 0, display: 'flex', gap: 10, alignItems: 'center' }}>
                      <ExclamationCircleOutlined style={{ color: item.tone, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: '#0f172a', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
                        <div style={{ ...mutedStyle, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.desc}</div>
                      </div>
                    </div>
                    <ActionPill label={item.action} onClick={() => navigate(item.path)} />
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard testId="se-dashboard-table" style={{ minHeight: 212, marginTop: 24, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '18px 20px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={sectionTitleStyle}>最近任务</h2>
              <ActionPill label="进入任务管理" onClick={() => navigate(tasksPath)} />
            </div>
            {taskRows.length ? (
              <div style={{ padding: '0 20px 16px', overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <thead>
                    <tr style={{ color: '#64748b', fontSize: 12, textAlign: 'left', borderBottom: '1px solid #e5edf5' }}>
                      <th style={{ padding: '8px 8px', fontWeight: 700, width: '28%' }}>任务</th>
                      <th style={{ padding: '8px 8px', fontWeight: 700, width: '19%' }}>生成内容</th>
                      <th style={{ padding: '8px 8px', fontWeight: 700, width: '15%' }}>执行人</th>
                      <th style={{ padding: '8px 8px', fontWeight: 700, width: '16%' }}>状态</th>
                      <th style={{ padding: '8px 8px', fontWeight: 700, width: '10%' }}>截止</th>
                      <th style={{ padding: '8px 8px', fontWeight: 700, width: '12%' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskRows.map((row) => (
                      <tr key={row.id} style={{ borderBottom: '1px solid #edf2f7', color: '#0f172a', fontSize: 13 }}>
                        <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sanitizeSEVisibleText(row.title)}</td>
                        <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.content}</td>
                        <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.owner}</td>
                        <td style={{ padding: '7px 8px' }}><StatusBadge status={row.status} /></td>
                        <td style={{ padding: '7px 8px', color: '#475569' }}>{formatDate(row.deadlineAt)}</td>
                        <td style={{ padding: '7px 8px' }}>
                          <button
                            type="button"
                            onClick={() => navigate(tasksPath)}
                            style={{ border: 0, background: 'transparent', color: '#2563eb', cursor: 'pointer', padding: 0, fontWeight: 700 }}
                          >
                            {row.action}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无最近任务" />
            )}
            </SectionCard>

            <SectionCard testId="se-dashboard-risk-panel" style={{ minHeight: 146, marginTop: 28, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={sectionTitleStyle}>合规雷达与审计包</h2>
                <div style={{ ...mutedStyle, marginTop: 8 }}>高风险事项与材料沉淀进展</div>
              </div>
              <ActionPill label="进入审计包" onClick={() => navigate(packagesPath)} />
            </div>
            <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Tag color="red" style={{ borderRadius: 999, paddingInline: 10, whiteSpace: 'nowrap' }}>高风险 {riskCount}</Tag>
              <Tag color="blue" style={{ borderRadius: 999, paddingInline: 10, whiteSpace: 'nowrap' }}>审计包 {data.counts.packages}</Tag>
              <Tag color="gold" style={{ borderRadius: 999, paddingInline: 10, whiteSpace: 'nowrap' }}>待生成 {packageGap}</Tag>
            </div>
            <div style={{ marginTop: 12, color: '#475569', fontSize: 13, lineHeight: '20px' }}>
              建议优先处理逾期任务关联风险，再生成本周客户备查审计包。
            </div>
            </SectionCard>
          </div>
        </div>
      ) : (
        <div style={{ ...cardStyle, padding: 56, textAlign: 'center' }}>
          <Empty description="暂无执行总览数据" />
        </div>
      )}
    </div>
  )
}
