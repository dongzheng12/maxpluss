/**
 * PC Web 用户端 — 专家投票列表
 *
 * 无数据时展示正式服务介绍页（亮点 / 适用场景 / 流程 / 价格说明 + CTA），
 * 而不是空 Empty。
 */
import { useEffect, useMemo, useState } from 'react'
import { Card, Button, Space, Tag, Typography, Spin, message, Row, Col, Popconfirm, Tabs } from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined,
  TeamOutlined, RocketOutlined, SafetyOutlined,
  FileTextOutlined, DollarOutlined, CalendarOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import { listExpertVotes, deleteExpertVoteDraft, type ExpertVoteRequestRow } from '../../api/app'
import { useAccess } from '../../hooks/useAccess'
import { getExpertVoteStatusColor, getExpertVoteStatusLabel } from '../../utils/expertVoteUi'

const { Title, Text, Paragraph } = Typography

function ServiceLanding({ onStart }: { onStart: () => void }) {
  const SCENARIOS = [
    '团体标准审查', '企业标准评审', '技术规范评审', '项目论证',
    '成果评价', '技术咨询', '标准文本争议点判断', '企业内部技术方案评议',
  ]
  const STEPS = [
    { num: '1', text: '提交申请' },
    { num: '2', text: '支付费用' },
    { num: '3', text: '组织专家' },
    { num: '4', text: '线上会议' },
    { num: '5', text: '结果确认' },
    { num: '6', text: '文件交付' },
  ]
  return (
    <div>
      {/* 顶部主视觉区 */}
      <div
        style={{
          background: 'linear-gradient(135deg, #EFF6FF 0%, #DBEAFE 100%)',
          padding: '60px 40px',
          borderRadius: 12,
          textAlign: 'center',
          marginBottom: 48,
        }}
      >
        <Title level={1} style={{ fontSize: 32, fontWeight: 700, marginBottom: 16 }}>
          专家评审投票
        </Title>
        <Paragraph
          style={{ fontSize: 18, color: '#374151', lineHeight: 1.6, marginBottom: 24, maxWidth: 800, marginLeft: 'auto', marginRight: 'auto' }}
        >
          多领域专家智库支持，协助企业快速组织标准评审、项目论证、成果评价与技术咨询。
        </Paragraph>
        <Paragraph
          style={{ fontSize: 14, color: '#6B7280', lineHeight: 1.6, marginBottom: 32, maxWidth: 800, marginLeft: 'auto', marginRight: 'auto' }}
        >
          平台可根据项目领域、标准类型和专业关键词，协助匹配标准化、行业技术、检测认证、法规合规、高校科研、企业实践等方向专家，完成线上评审、投票与结果确认文件交付。
        </Paragraph>
        <Button type="primary" size="large" onClick={onStart}
          style={{ padding: '14px 32px', height: 'auto', fontSize: 16, fontWeight: 600, borderRadius: 8 }}>
          立即发起申请
        </Button>
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            按专家数量计费，提交申请后生成订单，支付完成后进入专家组织流程。
          </Text>
        </div>
      </div>

      {/* 信任背书数据区 */}
      <Row gutter={24} style={{ marginBottom: 48 }}>
        <Col xs={24} md={8}>
          <Card style={{ textAlign: 'center', height: '100%' }} bodyStyle={{ padding: 24 }}>
            <RocketOutlined style={{ fontSize: 40, color: '#2563EB', marginBottom: 16 }} />
            <Title level={4} style={{ fontSize: 16, marginBottom: 12 }}>多领域专家支持</Title>
            <Text type="secondary" style={{ fontSize: 14, lineHeight: 1.6 }}>
              覆盖标准化、行业技术、检测认证、法规合规、高校科研、企业实践等方向
            </Text>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card style={{ textAlign: 'center', height: '100%' }} bodyStyle={{ padding: 24 }}>
            <TeamOutlined style={{ fontSize: 40, color: '#2563EB', marginBottom: 16 }} />
            <Title level={4} style={{ fontSize: 16, marginBottom: 12 }}>灵活专家组合</Title>
            <Text type="secondary" style={{ fontSize: 14, lineHeight: 1.6 }}>
              支持 3 / 5 / 7 / 9 位专家组合，按项目复杂度选择
            </Text>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card style={{ textAlign: 'center', height: '100%' }} bodyStyle={{ padding: 24 }}>
            <SafetyOutlined style={{ fontSize: 40, color: '#2563EB', marginBottom: 16 }} />
            <Title level={4} style={{ fontSize: 16, marginBottom: 12 }}>全流程交付</Title>
            <Text type="secondary" style={{ fontSize: 14, lineHeight: 1.6 }}>
              从申请、支付、专家组织、腾讯会议到结果确认文件交付形成闭环
            </Text>
          </Card>
        </Col>
      </Row>

      {/* 服务亮点 */}
      <Row gutter={24} style={{ marginBottom: 48 }}>
        {[
          { num: '01', title: '专家组织', desc: '根据项目类型、所属行业和专业关键词，协助组织匹配方向的专家参与评审。' },
          { num: '02', title: '线上评审', desc: '通过腾讯会议开展线上评审，支持专家围绕材料进行讨论、判断与投票。' },
          { num: '03', title: '文件交付', desc: '会后形成专家意见与投票结果确认文件，完成线下确认后交付最终文件。' },
        ].map((it) => (
          <Col xs={24} md={8} key={it.num}>
            <Card
              style={{ background: '#EFF6FF', borderColor: '#BFDBFE', height: '100%' }}
              bodyStyle={{ padding: 24 }}
            >
              <div style={{ fontSize: 24, fontWeight: 700, color: '#2563EB', marginBottom: 12 }}>{it.num}</div>
              <Title level={4} style={{ fontSize: 18, marginBottom: 12 }}>{it.title}</Title>
              <Text style={{ fontSize: 14, color: '#374151', lineHeight: 1.6 }}>{it.desc}</Text>
            </Card>
          </Col>
        ))}
      </Row>

      {/* 适用场景 */}
      <div style={{ marginBottom: 48 }}>
        <Title level={3} style={{ fontSize: 18, marginBottom: 24 }}>适用场景</Title>
        <Space size={[12, 12]} wrap>
          {SCENARIOS.map((s) => (
            <Tag
              key={s}
              style={{ padding: '8px 16px', fontSize: 14, borderRadius: 16, border: '1px solid #D1D5DB', background: '#F3F4F6' }}
            >
              {s}
            </Tag>
          ))}
        </Space>
      </div>

      {/* 服务流程 6 步 */}
      <div style={{ marginBottom: 60 }}>
        <Title level={3} style={{ fontSize: 18, marginBottom: 32, textAlign: 'center' }}>服务流程</Title>
        <Row justify="center" gutter={[8, 16]} style={{ marginBottom: 24 }}>
          {STEPS.map((step, i) => (
            <Col key={step.num} flex="0 0 auto">
              <Space size={8} align="center">
                <div style={{ textAlign: 'center' }}>
                  <div
                    style={{
                      width: 60, height: 60, borderRadius: '50%',
                      background: '#EFF6FF', border: '2px solid #2563EB',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 20, fontWeight: 700, color: '#2563EB',
                      margin: '0 auto 8px',
                    }}
                  >
                    {step.num}
                  </div>
                  <Text style={{ fontSize: 14 }}>{step.text}</Text>
                </div>
                {i < STEPS.length - 1 && (
                  <ArrowRightOutlined style={{ fontSize: 20, color: '#9CA3AF', marginTop: -28 }} />
                )}
              </Space>
            </Col>
          ))}
        </Row>
        <Paragraph
          style={{ fontSize: 14, color: '#6B7280', textAlign: 'center', maxWidth: 700, margin: '0 auto', lineHeight: 1.6 }}
        >
          支付完成后，平台业务人员将根据申请材料和专家需求组织专家，并回填会议安排。会议结束后，整理专家意见与投票结果，形成最终交付文件。
        </Paragraph>
      </div>

      {/* 底部 CTA */}
      <div
        style={{
          background: 'linear-gradient(135deg, #EFF6FF 0%, #DBEAFE 100%)',
          padding: 40, borderRadius: 12, textAlign: 'center',
        }}
      >
        <Button type="primary" size="large" onClick={onStart}
          style={{ padding: '14px 40px', height: 'auto', fontSize: 16, fontWeight: 600, borderRadius: 8 }}>
          立即发起专家评审投票申请
        </Button>
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            提交前可查看预计金额，最终费用以订单确认为准。
          </Text>
        </div>
      </div>
    </div>
  )
}

// 用户端状态分组（按使用频率聚合，与后台不一一对应）
const USER_TABS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'all', label: '全部', statuses: [] },
  { key: 'ongoing', label: '进行中', statuses: ['PAYING', 'EXPERT_ARRANGING', 'MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING'] },
  { key: 'pending', label: '待处理', statuses: ['DRAFT', 'PAYING'] },
  { key: 'completed', label: '已完成', statuses: ['COMPLETED'] },
  { key: 'closed', label: '已关闭', statuses: ['CANCELLED', 'REFUNDED'] },
]

export default function ExpertVoteListPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<ExpertVoteRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [tabKey, setTabKey] = useState('all')
  const { requireLogin } = useAccess()

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await listExpertVotes()
      setItems(res?.items || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      // 未登录时列表接口 401，前端展示介绍页即可，不要弹错
      const code = e?.response?.status
      if (code !== 401) message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const goNew = () => {
    if (!requireLogin()) return
    navigate('/expert-vote/new')
  }

  // Tab 客户端聚合
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length }
    for (const t of USER_TABS) {
      if (t.statuses.length === 0) continue
      counts[t.key] = items.filter((it) => t.statuses.includes(it.status)).length
    }
    return counts
  }, [items])

  const filteredItems = useMemo(() => {
    const tab = USER_TABS.find((t) => t.key === tabKey)
    if (!tab || tab.statuses.length === 0) return items
    return items.filter((it) => tab.statuses.includes(it.status))
  }, [items, tabKey])

  // 状态化主链接（严格按状态机 × 操作项矩阵）
  // 仅 MEETING_SCHEDULED 把"查看会议"作为主操作；
  // VOTING / VOTED / SIGNING 不再以"查看会议"作为主链接，统一为"查看进度"。
  const primaryAction = (it: ExpertVoteRequestRow): { label: string; to: string } | null => {
    const s = it.status
    if (s === 'DRAFT') return { label: '继续填写 →', to: `/expert-vote/new?no=${it.requestNo}` }
    if (s === 'PAYING') return { label: '去支付 →', to: `/expert-vote/${it.requestNo}?action=pay` }
    if (s === 'EXPERT_ARRANGING') return { label: '查看申请进度 →', to: `/expert-vote/${it.requestNo}` }
    if (s === 'MEETING_SCHEDULED') return { label: '查看会议 →', to: `/expert-vote/${it.requestNo}/meeting` }
    if (s === 'VOTING' || s === 'VOTED' || s === 'SIGNING')
      return { label: '查看进度 →', to: `/expert-vote/${it.requestNo}` }
    if (s === 'COMPLETED') return { label: '下载最终交付文件 →', to: `/expert-vote/${it.requestNo}` }
    return { label: '查看申请记录 →', to: `/expert-vote/${it.requestNo}` }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Title level={4} style={{ margin: 0 }}>我的申请</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={goNew}>发起新申请</Button>
        </Space>
      </Space>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
      ) : items.length === 0 ? (
        <ServiceLanding onStart={goNew} />
      ) : (
        <>
          <Tabs
            activeKey={tabKey}
            onChange={setTabKey}
            items={USER_TABS.map((t) => ({
              key: t.key,
              label: `${t.label}${t.key === 'all' ? `（${tabCounts.all}）` : tabCounts[t.key] != null ? `（${tabCounts[t.key]}）` : ''}`,
            }))}
          />

          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {filteredItems.length === 0 ? (
              <Card><Text type="secondary" style={{ textAlign: 'center', display: 'block', padding: 40 }}>该分类下暂无申请</Text></Card>
            ) : (
              filteredItems.map((it) => {
                const action = primaryAction(it)
                const showDelete = it.status === 'DRAFT'
                return (
                  <Card key={it.requestNo} hoverable bodyStyle={{ padding: 20 }}>
                    {/* 顶部：项目名 + 状态 Tag */}
                    <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
                      <Col flex="1 1 auto">
                        <Link to={`/expert-vote/${it.requestNo}`}>
                          <Typography.Text strong style={{ fontSize: 16, color: '#1677ff' }}>
                            {it.projectName}
                          </Typography.Text>
                        </Link>
                      </Col>
                      <Col flex="0 0 auto">
                        <Tag
                          color={getExpertVoteStatusColor(it.status)}
                          style={{ borderRadius: 9999, padding: '2px 12px' }}
                        >
                          {getExpertVoteStatusLabel(it.status)}
                        </Tag>
                      </Col>
                    </Row>

                    {/* 信息行 */}
                    <Row gutter={[16, 8]} style={{ paddingTop: 4 }}>
                      <Col xs={12} sm={6}>
                        <Space size={4}>
                          <FileTextOutlined style={{ color: '#9CA3AF' }} />
                          <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
                            {it.requestNo}
                          </Text>
                        </Space>
                      </Col>
                      <Col xs={12} sm={6}>
                        <Space size={4}>
                          <TeamOutlined style={{ color: '#9CA3AF' }} />
                          <Text style={{ fontSize: 14 }}>{it.expertCount} 位专家</Text>
                        </Space>
                      </Col>
                      <Col xs={12} sm={6}>
                        <Space size={4}>
                          <DollarOutlined style={{ color: '#9CA3AF' }} />
                          <Text style={{ fontSize: 14, color: '#10B981', fontWeight: 500 }}>
                            {typeof it.totalAmount === 'number' ? `¥${(it.totalAmount / 100).toLocaleString()}` : '-'}
                          </Text>
                        </Space>
                      </Col>
                      <Col xs={12} sm={6}>
                        <Space size={4}>
                          <CalendarOutlined style={{ color: '#9CA3AF' }} />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {new Date(it.createdAt).toLocaleDateString('zh-CN')}
                          </Text>
                        </Space>
                      </Col>
                    </Row>

                    {/* 底部：更新时间 + 主链接 */}
                    <Row
                      justify="space-between"
                      align="middle"
                      style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #E5E7EB' }}
                    >
                      <Col>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {/* 会议已定及之后的状态显示实际会议时间；其余显示期望日期 */}
                          {['MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].includes(it.status)
                            ? it.meetingStartAt
                              ? <>会议时间：{new Date(it.meetingStartAt).toLocaleString('zh-CN')} · </>
                              : null
                            : it.desiredDate
                              ? <>期望会议：{new Date(it.desiredDate).toLocaleDateString('zh-CN')} · </>
                              : null
                          }
                          提交：{new Date(it.createdAt).toLocaleString('zh-CN')}
                        </Text>
                      </Col>
                      <Col>
                        <Space size={16}>
                          {showDelete && (
                            <Popconfirm
                              title="删除草稿？"
                              description="删除后无法恢复，已上传材料一并清除。"
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={async () => {
                                try {
                                  await deleteExpertVoteDraft(it.requestNo)
                                  message.success('草稿已删除')
                                  load()
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                } catch (e: any) {
                                  message.error(e?.response?.data?.error || '删除失败')
                                }
                              }}
                            >
                              <Button type="link" danger size="small" icon={<DeleteOutlined />} style={{ padding: 0 }}>
                                删除草稿
                              </Button>
                            </Popconfirm>
                          )}
                          {action && (
                            <Link to={action.to}>
                              <Button type="link" style={{ padding: 0 }}>
                                {action.label}
                              </Button>
                            </Link>
                          )}
                        </Space>
                      </Col>
                    </Row>
                  </Card>
                )
              })
            )}
          </Space>
        </>
      )}
    </div>
  )
}
