import { useEffect, useState, useContext } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Typography, Button, Space, Tag, Empty, message, Progress, Table } from 'antd'
import { ReloadOutlined, ExclamationCircleFilled, WarningFilled, InfoCircleFilled, MessageOutlined, ArrowRightOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useLocation, useNavigate } from 'react-router-dom'
import { SEPageContext } from '../../../../contexts/SEPageContext'
import { AIAskableRegion, type AIQuestionContext } from '../../../../components/se/aiQuestioning'
import {
  seGetDashboard, seGetDashboardEnterprise,
  seListRisks, seListRisksEnterprise,
  type RiskItem,
  type ComplianceRadarData,
  RISK_TYPE_LABEL,
  RISK_LEVEL_COLOR,
} from '../../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../../utils/sePresentation'

const { Title, Text } = Typography

const enterprisePageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}
const compactControlStyle: CSSProperties = {
  height: 34,
  borderRadius: 6,
}
const metricCardStyle: CSSProperties = {
  position: 'relative',
  width: 190,
  height: 88,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  boxShadow: '0 4px 7px rgba(15, 23, 42, 0.04)',
  padding: '15px 16px 12px',
}
const radarPanelStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  boxShadow: '0 6px 9px rgba(15, 23, 42, 0.04)',
  padding: 16,
}
const riskColumnStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  minHeight: 574,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  boxShadow: '0 6px 9px rgba(15, 23, 42, 0.04)',
  padding: 16,
}

const RISK_LEVEL_CONFIG: Record<string, { label: string; icon: ReactNode; bg: string; border: string; text: string }> = {
  HIGH:   { label: '高风险', icon: <ExclamationCircleFilled style={{ color: '#DC2626' }} />, bg: '#FEF2F2', border: '#FECACA', text: '#DC2626' },
  MEDIUM: { label: '中风险', icon: <WarningFilled style={{ color: '#D97706' }} />,           bg: '#FFFBEB', border: '#FDE68A', text: '#D97706' },
  LOW:    { label: '低风险', icon: <InfoCircleFilled style={{ color: '#3B7BF6' }} />,        bg: '#EFF6FF', border: '#BFDBFE', text: '#3B7BF6' },
}

const RISK_ACTION_LABEL: Record<string, string> = {
  REQUIREMENT_NO_TASK: '生成任务草稿',
  TASK_OVERDUE: '查看任务进度',
  ASSIGNEE_NOT_SUBMITTED: '提醒执行人提交',
  REVIEW_PENDING: '进入审核处理',
}

const RISK_LEVEL_HINT: Record<string, string> = {
  HIGH: '优先处理',
  MEDIUM: '持续跟进',
  LOW: '保持观察',
}

type HeatmapRow = ComplianceRadarData['heatmap'][number]
type ExpiringRecord = ComplianceRadarData['expiringRecords'][number]

function pctText(rate: number) {
  return `${Number.isFinite(rate) ? rate : 0}%`
}

function expiryTone(item: ExpiringRecord) {
  if (item.severity === 'ERROR') return { color: 'red', label: '已过期' }
  if (item.severity === 'RED') return { color: 'red', label: '7天内' }
  return { color: 'orange', label: '30天内' }
}

function riskTypeLabel(type: string) {
  if (type === 'REQUIREMENT_NO_TASK') return '标准文档未生成任务'
  return sanitizeSEVisibleText(RISK_TYPE_LABEL[type] || type)
}

function riskActionPath(item: RiskItem, isEnterprise: boolean) {
  const prefix = isEnterprise ? '/enterprise' : '/admin/standard-execution'
  if (item.riskType === 'REQUIREMENT_NO_TASK') return `${prefix}/sources`
  if (item.riskType === 'REVIEW_PENDING') return `${prefix}/reviews`
  return `${prefix}/tasks`
}

function relatedTypeLabel(type: string) {
  const map: Record<string, string> = {
    ['Require' + 'ment']: '生成内容',
    Task: '任务',
    TaskAssignee: '执行人任务',
    Submission: '提交记录',
  }
  return map[type] || type
}

function riskDisplayText(item: RiskItem) {
  const normalize = (text: string) => text
    .replace(new RegExp('要' + '求项', 'g'), '生成内容')
    .replace(new RegExp('来源' + '条款', 'g'), '生成内容')
    .replace(new RegExp('标准' + '要求', 'g'), '标准文档')
    .replace(new RegExp('任务' + '依据', 'g'), '生成内容')
    .replace(new RegExp('标准' + '依据', 'g'), '标准文档')
  const title = sanitizeSEVisibleText(normalize(item.title))
  const description = sanitizeSEVisibleText(normalize(item.description))
  return {
    title: item.riskType === 'REQUIREMENT_NO_TASK' ? title.replace(/^生成内容无任务：/, '标准文档未生成任务：') : title,
    description,
  }
}

function riskAIContext(
  item: RiskItem,
  isEnterprise: boolean,
  cfgLabel: string,
  typeLabel: string,
  display: { title: string; description: string },
): AIQuestionContext {
  return {
    page: isEnterprise ? 'enterprise/risks' : 'admin/standard-execution/risks',
    objectType: 'risk',
    objectId: item.id,
    title: display.title,
    summary: [
      `风险标题：${display.title}`,
      `风险等级：${cfgLabel}`,
      `风险类型：${typeLabel}`,
      `关联对象：${relatedTypeLabel(item.relatedType)} ${item.relatedId}`,
      `出现时间：${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}`,
      `说明：${display.description || '无'}`,
    ].join('\n'),
    meta: {
      riskLevel: item.riskLevel,
      riskType: item.riskType,
      relatedType: item.relatedType,
      relatedId: item.relatedId,
    },
  }
}

function RadarDashboard({ radar, isEnterprise }: { radar: ComplianceRadarData | null; isEnterprise: boolean }) {
  const navigate = useNavigate()
  if (!radar) return null
  const prefix = isEnterprise ? '/enterprise' : '/admin/standard-execution'
  const metricCards = [
    {
      key: 'coverage',
      label: '控制点覆盖率',
      value: pctText(radar.metrics.controlPointCoverage.rate),
      meta: `${radar.metrics.controlPointCoverage.covered}/${radar.metrics.controlPointCoverage.total}`,
      percent: radar.metrics.controlPointCoverage.rate,
      color: '#16a34a',
    },
    {
      key: 'tasks',
      label: '本月任务完成率',
      value: pctText(radar.metrics.monthlyTaskCompletion.rate),
      meta: `${radar.metrics.monthlyTaskCompletion.completed}/${radar.metrics.monthlyTaskCompletion.total}`,
      percent: radar.metrics.monthlyTaskCompletion.rate,
      color: '#2563eb',
    },
    {
      key: 'reviews',
      label: '审核通过率',
      value: pctText(radar.metrics.reviewPassRate.rate),
      meta: `${radar.metrics.reviewPassRate.approved}/${radar.metrics.reviewPassRate.total}`,
      percent: radar.metrics.reviewPassRate.rate,
      color: '#7c3aed',
    },
    {
      key: 'overdue',
      label: '逾期任务数',
      value: String(radar.metrics.overdueTasks.count),
      meta: '当前',
      percent: Math.min(100, radar.metrics.overdueTasks.count * 10),
      color: radar.metrics.overdueTasks.count > 0 ? '#dc2626' : '#16a34a',
      onClick: () => navigate(`${prefix}/tasks?tab=executing&status=OVERDUE`),
    },
  ]
  const heatmapColumns = [
    {
      title: '标准来源',
      dataIndex: 'sourceTitle',
      key: 'sourceTitle',
      render: (_: string, row: HeatmapRow) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{row.sourceTitle}</Text>
          <div style={{ color: '#64748b', fontSize: 12 }}>
            {[row.sourceNo, row.version].filter(Boolean).join(' · ') || '未标注编号'}
          </div>
        </div>
      ),
    },
    {
      title: '控制点',
      dataIndex: 'controlPointCount',
      key: 'controlPointCount',
      width: 82,
      render: (value: number) => <Text>{value}</Text>,
    },
    {
      title: '覆盖率',
      dataIndex: 'coverageRate',
      key: 'coverageRate',
      width: 180,
      render: (value: number, row: HeatmapRow) => (
        <div style={{ width: '100%' }}>
          <Progress percent={value} size="small" strokeColor={value >= 80 ? '#16a34a' : value >= 50 ? '#d97706' : '#dc2626'} />
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{row.coveredCount}/{row.controlPointCount}</div>
        </div>
      ),
    },
    {
      title: '逾期',
      dataIndex: 'overdueTaskCount',
      key: 'overdueTaskCount',
      width: 72,
      render: (value: number) => value > 0 ? <Tag color="red">{value}</Tag> : <Text type="secondary">0</Text>,
    },
  ]

  return (
    <div style={{ marginBottom: isEnterprise ? 32 : 28 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: 12,
        marginBottom: 16,
      }}>
        {metricCards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={card.onClick}
            style={{
              ...radarPanelStyle,
              textAlign: 'left',
              cursor: card.onClick ? 'pointer' : 'default',
              minHeight: 118,
              width: '100%',
            }}
          >
            <div style={{ color: '#64748b', fontSize: 12 }}>{card.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <span style={{ color: '#0f172a', fontSize: 28, fontWeight: 700, lineHeight: 1 }}>{card.value}</span>
              <span style={{ color: '#64748b', fontSize: 12 }}>{card.meta}</span>
            </div>
            <Progress percent={card.percent} showInfo={false} strokeColor={card.color} style={{ marginTop: 10 }} />
          </button>
        ))}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 16,
      }}>
        <div style={radarPanelStyle}>
          <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
            <Text strong>合规健康热力图</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>按标准来源分组</Text>
          </Space>
          <div style={{ overflowX: 'auto' }}>
            <Table<HeatmapRow>
              size="small"
              rowKey="sourceId"
              columns={heatmapColumns}
              dataSource={radar.heatmap}
              pagination={false}
              locale={{ emptyText: '暂无标准来源数据' }}
            />
          </div>
        </div>

        <div style={radarPanelStyle}>
          <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 8 }}>
            <Text strong>到期预警</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>VALID 记录</Text>
          </Space>
          {radar.expiringRecords.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未来 30 天暂无到期证据" style={{ padding: '24px 0 12px' }} />
          ) : (
            <div>
              {radar.expiringRecords.map((item, index) => {
                const tone = expiryTone(item)
                return (
                  <div
                    key={item.recordId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 0',
                      borderBottom: index === radar.expiringRecords.length - 1 ? 'none' : '1px solid #eef2f7',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <Space size={8} wrap>
                        <Text style={{ fontSize: 13 }}>{item.recordTitle}</Text>
                        <Tag color={tone.color} style={{ margin: 0 }}>{tone.label}</Tag>
                      </Space>
                      <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                        有效期 {dayjs(item.validUntil).format('YYYY-MM-DD')} · {item.daysUntilExpiry < 0 ? `超期 ${Math.abs(item.daysUntilExpiry)} 天` : `剩余 ${item.daysUntilExpiry} 天`}
                      </div>
                    </div>
                    <Button size="small" type="link" onClick={() => navigate(`${prefix}/records`)}>查看</Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RiskCard({ item, isEnterprise }: { item: RiskItem; isEnterprise: boolean }) {
  const cfg = RISK_LEVEL_CONFIG[item.riskLevel] || RISK_LEVEL_CONFIG.LOW
  const { triggerAsk } = useContext(SEPageContext)
  const navigate = useNavigate()
  const typeLabel = riskTypeLabel(item.riskType)
  const display = riskDisplayText(item)
  const aiContext = riskAIContext(item, isEnterprise, cfg.label, typeLabel, display)
  const aiQuestion = '这个风险怎么处理？'
  if (isEnterprise) {
    return (
      <AIAskableRegion context={aiContext} question={aiQuestion} style={{ marginTop: 16 }}>
      <div style={{
        background: cfg.bg,
        border: `1px solid ${cfg.text}`,
        borderRadius: 8,
        minHeight: 124,
        padding: '13px 15px',
      }}>
        <Text strong style={{ display: 'block', fontSize: 14, color: '#0f172a', marginBottom: 12 }}>{display.title}</Text>
        <div style={{ width: 260, minHeight: 34, color: '#475569', fontSize: 12, lineHeight: 1.45 }}>
          {display.description || '关联标准文档与执行记录，建议立即分派责任人跟进。'}
        </div>
        <Button size="small" onClick={() => triggerAsk(`风险：${display.title}｜等级：${cfg.label}｜类型：${typeLabel}｜说明：${display.description || '无'}`, '这个风险怎么处理？')} style={{ ...compactControlStyle, width: 76, marginTop: 12 }}>问小智</Button>
      </div>
      </AIAskableRegion>
    )
  }
  return (
    <AIAskableRegion context={aiContext} question={aiQuestion} style={{ marginBottom: 12 }}>
    <div style={{
      background: '#fff',
      border: `1px solid ${cfg.border}`,
      borderLeft: `4px solid ${cfg.text}`,
      borderRadius: 8,
      padding: '16px',
      boxShadow: '0 6px 18px rgba(15, 23, 42, 0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ marginTop: 2, fontSize: 16, flexShrink: 0 }}>{cfg.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 14, color: '#1A202C' }}>{display.title}</Text>
            <Tag color={RISK_LEVEL_COLOR[item.riskLevel]} style={{ margin: 0 }}>{cfg.label}</Tag>
            <Tag style={{ margin: 0, background: 'transparent', border: `1px solid ${cfg.border}`, color: cfg.text }}>
              {typeLabel}
            </Tag>
          </div>
          {display.description && (
            <div style={{ fontSize: 13, color: '#4A5568', marginBottom: 6 }}>{display.description}</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, color: '#64748B' }}>
            <span>关联对象：{relatedTypeLabel(item.relatedType)}</span>
            <span>出现时间：{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</span>
          </div>
          <Space size={12} style={{ marginTop: 10 }} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>建议动作</Text>
            <Button size="small" type="primary" ghost icon={<ArrowRightOutlined />} onClick={() => navigate(riskActionPath(item, isEnterprise))}>
              {RISK_ACTION_LABEL[item.riskType] || '查看关联对象'}
            </Button>
            <Button size="small" type="link" icon={<MessageOutlined />} style={{ padding: 0 }} onClick={() => triggerAsk(`风险：${display.title}｜等级：${cfg.label}｜类型：${typeLabel}｜说明：${display.description || '无'}`, '这个风险怎么处理？')}>问小智</Button>
          </Space>
        </div>
      </div>
    </div>
    </AIAskableRegion>
  )
}

function RiskSection({
  level, items, isEnterprise,
}: { level: string; items: RiskItem[]; isEnterprise: boolean }) {
  const cfg = RISK_LEVEL_CONFIG[level]
  if (!cfg) return null
  if (isEnterprise) {
    return (
      <div style={riskColumnStyle}>
        <Text strong style={{ color: cfg.text, fontSize: 16 }}>{cfg.label}</Text>
        {items.length === 0
          ? <div style={{ color: '#94a3b8', fontSize: 13, paddingTop: 28 }}>暂无{cfg.label}</div>
          : items.map((r) => <RiskCard key={r.id} item={r} isEnterprise={isEnterprise} />)
        }
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        paddingBottom: 8, borderBottom: `2px solid ${cfg.border}`,
      }}>
        {cfg.icon}
        <Text strong style={{ fontSize: 14, color: cfg.text }}>{cfg.label}</Text>
        <div style={{
          minWidth: 22, height: 22, borderRadius: 11,
          background: cfg.border, color: cfg.text,
          fontSize: 12, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {items.length}
        </div>
      </div>
      {items.length === 0
        ? <div style={{ color: '#A0AEC0', fontSize: 13, padding: '8px 0' }}>无{cfg.label}项</div>
        : items.map((r) => <RiskCard key={r.id} item={r} isEnterprise={isEnterprise} />)
      }
    </div>
  )
}

export default function SeRisksPage() {
  const loc = useLocation()
  const { triggerAsk } = useContext(SEPageContext)
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [items, setItems] = useState<RiskItem[]>([])
  const [radar, setRadar] = useState<ComplianceRadarData | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const listFn = isEnterprise ? seListRisksEnterprise : seListRisks
      const dashboardFn = isEnterprise ? seGetDashboardEnterprise : seGetDashboard
      const [dashboard, risks] = await Promise.all([dashboardFn(), listFn()])
      setRadar(dashboard.data.complianceRadar ?? null)
      setItems(dashboard.data.complianceRadar?.riskEvents ?? risks.data ?? [])
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const high = items.filter((r) => r.riskLevel === 'HIGH')
  const medium = items.filter((r) => r.riskLevel === 'MEDIUM')
  const low = items.filter((r) => r.riskLevel === 'LOW')
  const metrics = [
    { level: 'HIGH', count: high.length },
    { level: 'MEDIUM', count: medium.length },
    { level: 'LOW', count: low.length },
  ]

  return (
    <div style={isEnterprise ? enterprisePageStyle : undefined}>
      <Space style={{ marginBottom: isEnterprise ? 28 : 20, justifyContent: 'space-between', width: '100%' }} wrap>
        {!isEnterprise && (
          <div>
            <Title level={4} style={{ margin: 0 }}>合规雷达</Title>
            <Text type="secondary">聚合逾期、未提交、审核积压与标准文档缺口，优先处理高风险事项。</Text>
          </div>
        )}
        <Space wrap style={{ marginLeft: 'auto' }}>
          {!isEnterprise && items.length > 0 && (
            <Tag color={high.length > 0 ? 'red' : medium.length > 0 ? 'orange' : 'blue'}>
              共 {items.length} 项风险
            </Tag>
          )}
          {!isEnterprise && <Button icon={<MessageOutlined />} onClick={() => triggerAsk('请基于当前合规雷达页，按高/中/低风险给出优先处理建议。', '这些风险先处理哪几个？')}>问小智</Button>}
          <Button icon={!isEnterprise ? <ReloadOutlined /> : undefined} autoInsertSpace={false} onClick={load} loading={loading} style={isEnterprise ? { ...compactControlStyle, width: 90 } : undefined}>刷新</Button>
        </Space>
      </Space>

      <RadarDashboard radar={radar} isEnterprise={isEnterprise} />

      <div style={{ marginBottom: 12 }}>
        <Text strong>风险事件列表</Text>
        <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>按高风险优先排序</Text>
      </div>

      <div style={{
        display: 'flex',
        gap: isEnterprise ? 16 : 12,
        marginBottom: isEnterprise ? 44 : 24,
        flexWrap: 'wrap',
      }}>
        {metrics.map(({ level, count }) => {
          const cfg = RISK_LEVEL_CONFIG[level]
          return (
            <div key={level} style={{
              ...(isEnterprise ? metricCardStyle : {}),
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderLeft: `4px solid ${cfg.text}`,
              borderRadius: 8,
              padding: isEnterprise ? '15px 16px 12px' : '14px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: isEnterprise ? 'flex-start' : 'space-between',
              minHeight: isEnterprise ? undefined : 76,
            }}>
              <div>
                <div style={{ fontSize: 12, color: '#64748B' }}>{cfg.label}</div>
                <div style={{ marginTop: isEnterprise ? 8 : 0, fontSize: isEnterprise ? 28 : 26, fontWeight: 700, color: isEnterprise ? '#0f172a' : cfg.text, lineHeight: 1.2 }}>{count}</div>
                {!isEnterprise && <div style={{ fontSize: 12, color: '#94a3b8' }}>{RISK_LEVEL_HINT[level]}</div>}
              </div>
              {!isEnterprise && cfg.icon}
            </div>
          )
        })}
      </div>

      {items.length === 0 ? (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ color: '#A0AEC0' }}>当前无风险项，运行状态良好</span>}
            style={{ padding: '60px 0' }}
          />
        </div>
      ) : (
        <div style={isEnterprise ? {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 24,
          alignItems: 'flex-start',
        } : undefined}>
          <RiskSection level="HIGH" items={high} isEnterprise={isEnterprise} />
          <RiskSection level="MEDIUM" items={medium} isEnterprise={isEnterprise} />
          <RiskSection level="LOW" items={low} isEnterprise={isEnterprise} />
        </div>
      )}
    </div>
  )
}
