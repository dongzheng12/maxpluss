/**
 * 后台详情页 — 会议通知 + 会后整理 + 确认文件交付 + 归档
 *
 * 按 status 渲染不同模块：
 *   MEETING_SCHEDULED：通知模块（行级专家通知）+ 人工进入会后整理
 *   VOTING：会后录入 UI（每位专家 + 汇总 + 结论 + 关闭整理）
 *   VOTED：生成 Word 确认文件
 *   SIGNING：确认文件交付（线下整理后上传最终交付 PDF；平台内自动合成后续版本开放）
 *   COMPLETED：最终交付文件 + 文件信息 + 交付留痕
 */
import { useEffect, useState } from 'react'
import {
  Card, Button, Space, Typography, message, Alert, Input, Select, Tag, Upload,
  Modal, Empty, Divider, Form, Row, Col, Radio, Collapse, Tooltip, Checkbox,
} from 'antd'
import {
  CopyOutlined, DownloadOutlined, UploadOutlined, FileDoneOutlined,
  CheckCircleFilled, MailOutlined,
} from '@ant-design/icons'
import {
  adminGetExpertVoteNotificationTexts,
  adminMarkExpertNotified,
  adminStartVoting, adminPutVotingResults, adminCloseVoting,
  adminGenerateExpertVoteResultDoc, adminDownloadExpertVoteResultDoc,
  adminUploadFinalDeliverableUrl,
  adminFinalDeliverableUrl,
  adminGetExpertVoteSignLogs,
} from '../../../api/admin'
import { nodeApi } from '../../../api/client'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const CONCLUSION_OPTIONS = [
  { label: '通过', value: 'PASS' },
  { label: '不通过', value: 'REJECT' },
  { label: '修改后通过', value: 'PASS_WITH_MOD' },
  { label: '建议补充材料后再次评审', value: 'NEED_SUPPLEMENT' },
]

const SIGN_LOG_ACTION_LABEL: Record<string, string> = {
  EXPERT_ASSIGN: '指派评审专家',
  EXPERT_CHANGE: '调整评审专家',
  MEETING_CHANGE: '调整会议安排',
  START_VOTING: '发起专家投票',
  VOTING_RESULTS_UPDATED: '更新投票结果',
  CLOSE_VOTING: '关闭投票',
  GENERATE_PDF: '生成确认件',
  GENERATE_FINAL_DELIVERABLE: '生成最终交付文件',
  UPLOAD_FINAL_DELIVERABLE: '上传最终交付文件',
  UPLOAD_SIGNATURE_MATERIAL: '上传签字材料',
}

function formatDateTime(value?: string | Date | null) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function operatorLabel(operatorId?: string | null) {
  return operatorId ? '管理员' : '系统管理员'
}

interface ExpertItem {
  id?: string
  expertName: string
  expertOrg?: string | null
  expertTitle?: string | null
  expertField?: string | null
  expertPhone?: string | null
  notifiedAt?: string | null
}

interface VoteRow {
  assignmentId: string
  expertName: string
  voteResult: string
  reviewOpinion: string
  modificationSuggestion?: string
  riskWarning?: string
}

interface Props {
  no: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  experts: ExpertItem[]
  reload: () => void
}

export default function ExpertVotePostMeetingSection({ no, data, experts, reload }: Props) {
  const status: string = data.status

  // ────────── 会议通知模块（MEETING_SCHEDULED 后展示）──────────
  const [notifTexts, setNotifTexts] = useState<{ expert_invite?: string; meeting_confirm?: string; vote_remind?: string }>({})
  const [markingMap, setMarkingMap] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!no) return
    if (!['MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].includes(status)) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminGetExpertVoteNotificationTexts(no).then((r: any) => {
      setNotifTexts(r?.texts || {})
    }).catch(() => {})
  }, [no, status])

  const copyText = (txt: string, label: string) => {
    if (!txt) return
    navigator.clipboard.writeText(txt).then(() => message.success(`${label} 已复制`))
  }

  // 选中状态（批量操作用）
  const [selectedExpertIds, setSelectedExpertIds] = useState<Set<string>>(new Set())
  const toggleSelect = (aid: string) => {
    setSelectedExpertIds((prev) => {
      const next = new Set(prev)
      if (next.has(aid)) next.delete(aid); else next.add(aid)
      return next
    })
  }

  // 复制全部专家通知文本
  const handleCopyAllExperts = () => {
    const txt = notifTexts.meeting_confirm || ''
    if (!txt) return message.warning('通知文本未加载')
    navigator.clipboard.writeText(txt).then(() => message.success('全部专家通知文本已复制'))
  }

  // 标记选中已通知
  const handleMarkSelected = async () => {
    const targets = experts.filter((e) => e.id && selectedExpertIds.has(e.id) && !e.notifiedAt)
    if (targets.length === 0) return message.info('请先选中尚未通知的专家')
    setMarkingMap((m) => ({ ...m, _bulk: true }))
    try {
      for (const e of targets) {
        await adminMarkExpertNotified(no, e.id!)
      }
      message.success(`已标记选中 ${targets.length} 位专家已通知`)
      setSelectedExpertIds(new Set())
      reload()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '部分标记失败')
    }
    setMarkingMap((m) => ({ ...m, _bulk: false }))
  }

  // 标记全部已通知
  const handleMarkAllExperts = () => {
    const targets = experts.filter((e) => e.id && !e.notifiedAt)
    if (targets.length === 0) return message.info('全部专家已标记')
    Modal.confirm({
      title: `标记全部 ${targets.length} 位专家已通知？`,
      okText: '全部标记',
      cancelText: '取消',
      onOk: async () => {
        try {
          for (const e of targets) {
            await adminMarkExpertNotified(no, e.id!)
          }
          message.success(`已标记 ${targets.length} 位专家已通知`)
          reload()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '部分标记失败')
        }
      },
    })
  }

  // 专家名单完整性提示（commit 7 streamline）
  const expertCountTarget = data.expertCount || 0
  const expertListIncomplete = experts.length < expertCountTarget

  // ────────── 进入会后整理（MEETING_SCHEDULED，管理员人工触发）──────────
  const [startingVoting, setStartingVoting] = useState(false)

  const handleStartVoting = () => {
    Modal.confirm({
      title: '进入会后结果整理？',
      content: '请确认会议已经结束且需要开始整理。点击后状态将由"会议已定"变为"会后结果整理中"，可在本页录入专家意见和投票结果。',
      okText: '进入整理',
      cancelText: '取消',
      onOk: async () => {
        setStartingVoting(true)
        try {
          await adminStartVoting(no)
          message.success('已进入会后结果整理')
          reload()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '操作失败')
        }
        setStartingVoting(false)
      },
    })
  }

  // ────────── 会后录入（VOTING）──────────
  const [voteRows, setVoteRows] = useState<VoteRow[]>([])
  const [conclusion, setConclusion] = useState<string>('')
  const [conclusionRemark, setConclusionRemark] = useState<string>('')
  const [savingVotes, setSavingVotes] = useState(false)
  const [closingVoting, setClosingVoting] = useState(false)

  useEffect(() => {
    if (status !== 'VOTING' && status !== 'VOTED') return
    // 拉详情时 ExpertAssignment 列表已在 experts；这里加载已有 records
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeApi.get(`/api/admin/expert-votes/${no}`).then((r: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recs: any[] = r?.votes || []  // ExpertVoteRecord，后端 include votes 返回
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recsByAid = new Map<string, any>(recs.map((rec) => [rec.assignmentId, rec]))
      setVoteRows(experts.map((e) => {
        const rec = recsByAid.get(e.id || '')
        return {
          assignmentId: e.id || '',
          expertName: e.expertName,
          voteResult: rec?.voteResult || '',
          reviewOpinion: rec?.reviewOpinion || '',
          modificationSuggestion: rec?.modificationSuggestion || '',
          riskWarning: rec?.riskWarning || '',
        }
      }))
      setConclusion(r?.conclusion || '')
      setConclusionRemark(r?.conclusionRemark || '')
    }).catch(() => {
      setVoteRows(experts.map((e) => ({
        assignmentId: e.id || '',
        expertName: e.expertName,
        voteResult: '',
        reviewOpinion: '',
      })))
    })
  }, [status, no, experts])

  const summary = (() => {
    const counts = { PASS: 0, REJECT: 0, PASS_WITH_MOD: 0, ABSTAIN: 0 }
    for (const r of voteRows) if (counts[r.voteResult as keyof typeof counts] !== undefined) {
      counts[r.voteResult as keyof typeof counts]++
    }
    return counts
  })()

  const handleSaveVotes = async () => {
    const votes = voteRows
      .filter((r) => r.voteResult && r.reviewOpinion?.trim())
      .map((r) => ({
        assignmentId: r.assignmentId,
        voteResult: r.voteResult,
        reviewOpinion: r.reviewOpinion.trim(),
        modificationSuggestion: r.modificationSuggestion?.trim() || undefined,
        riskWarning: r.riskWarning?.trim() || undefined,
      }))
    setSavingVotes(true)
    try {
      await adminPutVotingResults(no, {
        conclusion: conclusion || undefined,
        conclusionRemark: conclusionRemark.trim() || undefined,
        votes,
      })
      message.success('投票结果草稿已保存')
      reload()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '保存失败')
    }
    setSavingVotes(false)
  }

  const handleCloseVoting = () => {
    const missing = voteRows.filter((r) => !r.voteResult || !r.reviewOpinion?.trim()).map((r) => r.expertName)
    if (missing.length) return message.warning(`以下专家尚未完整录入：${missing.join('、')}`)
    if (!conclusion) return message.warning('请选择最终结论')
    Modal.confirm({
      title: '关闭会后结果整理？',
      content: '关闭后状态将变为"整理已完成"，进入确认文件生成阶段。该动作不可撤销。',
      okText: '关闭整理',
      cancelText: '取消',
      onOk: async () => {
        setClosingVoting(true)
        try {
          await handleSaveVotes()
          await adminCloseVoting(no)
          message.success('整理已关闭，进入确认文件生成')
          reload()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '关闭失败')
        }
        setClosingVoting(false)
      },
    })
  }

  // VOTING 阶段一键完成：保存草稿 → close-voting → generate-result-doc（两步合一）
  const handleFinishAndGenerate = () => {
    const missing = voteRows.filter((r) => !r.voteResult || !r.reviewOpinion?.trim()).map((r) => r.expertName)
    if (missing.length) return message.warning(`以下专家尚未完整录入：${missing.join('、')}`)
    if (!conclusion) return message.warning('请选择最终结论')
    Modal.confirm({
      title: '生成 Word 确认文件？',
      content: '将先关闭结果整理，再基于已录入数据生成《专家评审意见与投票结果确认单》Word 文件，状态进入"确认文件处理中"。该动作不可撤销。',
      okText: '生成确认文件',
      cancelText: '取消',
      onOk: async () => {
        setClosingVoting(true)
        try {
          await handleSaveVotes()
          await adminCloseVoting(no)
          await adminGenerateExpertVoteResultDoc(no)
          message.success('Word 确认文件已生成，进入确认文件处理阶段')
          reload()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '生成失败')
        }
        setClosingVoting(false)
      },
    })
  }

  // ────────── 生成 / 上传文件（VOTED / SIGNING / COMPLETED）──────────
  const [generating, setGenerating] = useState(false)        // 生成 Word 确认文件（VOTED → SIGNING）
  const [downloadingResultDoc, setDownloadingResultDoc] = useState(false)

  const handleGenerate = () => {
    Modal.confirm({
      title: '生成 Word 确认文件？',
      content: '将基于已录入的专家意见和投票结果生成《专家评审意见与投票结果确认单》（.docx），状态变为"确认文件处理中"。',
      okText: '立即生成',
      cancelText: '取消',
      onOk: async () => {
        setGenerating(true)
        try {
          await adminGenerateExpertVoteResultDoc(no)
          message.success('Word 确认文件已生成')
          reload()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '生成失败')
        }
        setGenerating(false)
      },
    })
  }

  const handleDownloadResultDoc = async () => {
    setDownloadingResultDoc(true)
    try {
      const resp = await adminDownloadExpertVoteResultDoc(no)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = resp instanceof Blob ? resp : new Blob([resp as any])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${no}_专家评审意见与投票结果确认单.docx`
      a.click()
      URL.revokeObjectURL(url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Word 确认文件下载失败，请稍后重试')
    } finally {
      setDownloadingResultDoc(false)
    }
  }

  // 交付留痕（COMPLETED 折叠区）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [signLogs, setSignLogs] = useState<any[]>([])
  useEffect(() => {
    if (status !== 'COMPLETED') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminGetExpertVoteSignLogs(no).then((r: any) => setSignLogs(r?.items || [])).catch(() => {})
  }, [status, no])

  const uploadHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('bxz_token')
    const h: Record<string, string> = {}
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  const flowInfo: Record<string, { label: string; next: string }> = {
    MEETING_SCHEDULED: { label: '会议已定', next: '管理员确认会议结束后，手动进入会后结果整理' },
    VOTING: { label: '会后结果整理中', next: '录入专家意见和投票结果后，手动关闭整理或生成 Word 确认文件' },
    VOTED: { label: '整理已完成', next: '管理员手动生成 Word 确认文件' },
    SIGNING: { label: '确认文件处理中', next: '下载 Word 确认文件，线下整理后上传最终 PDF' },
    COMPLETED: { label: '已完成', next: '流程终态，用户可下载最终交付文件' },
  }
  const currentFlow = flowInfo[status]

  return (
    <>
      {/* 会议通知模块（MEETING_SCHEDULED 起） */}
      {['MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].includes(status) && (
        <Card
          title={<Text strong style={{ fontSize: 16 }}>会议通知</Text>}
          style={{ marginBottom: 24, borderTop: '3px solid #faad14' }}
        >
          <Row justify="space-between" align="middle" gutter={[12, 12]}>
            <Col>
              <Space wrap>
                <Tag color="success">申请人已通知</Tag>
                <Text type="secondary">
                  专家通知：{experts.filter((e) => e.notifiedAt).length} / {experts.length || 0} 位已标记
                </Text>
              </Space>
            </Col>
            {expertListIncomplete && (
              <Col>
                <Tag color="warning">专家名单未完善</Tag>
              </Col>
            )}
          </Row>
          <Collapse style={{ marginTop: 12 }} ghost>
            <Collapse.Panel key="notifications" header={<Text type="secondary">展开通知文本与专家通知操作</Text>}>
          {/* 申请人通知 */}
          <Card
            size="small"
            style={{ background: '#EFF6FF', borderColor: '#BFDBFE', marginBottom: 16 }}
          >
            <Row justify="space-between" align="middle">
              <Col>
                <Space>
                  <CheckCircleFilled style={{ color: '#10B981' }} />
                  <Text strong>申请人通知</Text>
                  <Tag color="success">已发送</Tag>
                  {data.meetingArrangedAt && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      最近发送：{new Date(data.meetingArrangedAt).toLocaleString('zh-CN')}
                    </Text>
                  )}
                </Space>
              </Col>
              <Col>
                <Tooltip title="敬请期待">
                  <Button size="small" icon={<MailOutlined />} disabled>重新发送</Button>
                </Tooltip>
              </Col>
            </Row>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              确认会议安排时已自动通过站内消息通知申请人，链接到会议详情页（不含密码）。
            </Paragraph>
          </Card>

          {/* 专家通知（批量操作） */}
          <div>
            {expertListIncomplete && (
              <Alert
                type="warning"
                showIcon
                message={`专家名单未完善（${experts.length} / ${expertCountTarget} 位），建议完善后再发送通知`}
                style={{ marginBottom: 12 }}
              />
            )}

            <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
              <Col>
                <Text strong>专家通知</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  线下通过微信 / 邮件发送，勾选后批量标记已通知
                  {selectedExpertIds.size > 0 && (
                    <Text strong style={{ marginLeft: 8, color: '#1677ff' }}>
                      已选择 {selectedExpertIds.size} 位
                    </Text>
                  )}
                </Text>
              </Col>
              <Col>
                <Space>
                  <Button size="small" icon={<CopyOutlined />} onClick={handleCopyAllExperts}>
                    复制全部专家通知文本
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    disabled={selectedExpertIds.size === 0}
                    loading={!!markingMap._bulk}
                    onClick={handleMarkSelected}
                  >
                    标记选中已通知
                  </Button>
                  <Button size="small" onClick={handleMarkAllExperts}>
                    标记全部已通知
                  </Button>
                </Space>
              </Col>
            </Row>

            {experts.length === 0 ? (
              <Empty description="尚未录入专家" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                {experts.map((e) => {
                  const checked = e.id ? selectedExpertIds.has(e.id) : false
                  const notified = !!e.notifiedAt
                  return (
                    <div
                      key={e.id || e.expertName}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        border: '1px solid #f0f0f0',
                        borderRadius: 6,
                        background: checked ? '#EFF6FF' : '#fff',
                      }}
                    >
                      <Space size={12} align="center" wrap style={{ flex: 1 }}>
                        <Checkbox
                          checked={checked}
                          disabled={notified || !e.id}
                          onChange={() => e.id && toggleSelect(e.id)}
                        />
                        <Text strong>{e.expertName}</Text>
                        {e.expertOrg && <Text type="secondary">·{e.expertOrg}</Text>}
                        {e.expertTitle && <Tag>{e.expertTitle}</Tag>}
                        {e.expertField && <Text type="secondary">{e.expertField}</Text>}
                        {e.expertPhone && (
                          <Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.expertPhone}</Text>
                        )}
                        {notified ? (
                          <Tag color="success" icon={<CheckCircleFilled />}>
                            已通知{e.notifiedAt && ` · ${new Date(e.notifiedAt).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)}`}
                          </Tag>
                        ) : (
                          <Tag>未通知</Tag>
                        )}
                      </Space>
                      <Button
                        type="link"
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => copyText(notifTexts.meeting_confirm || '', `${e.expertName} 通知`)}
                      >
                        复制文本
                      </Button>
                    </div>
                  )
                })}
              </Space>
            )}

            {/* 通知文本预览（折叠） */}
            <Collapse style={{ marginTop: 16 }} ghost>
              <Collapse.Panel key="texts" header={<Text type="secondary">查看通知文本（专家邀请 / 会议确认 / 会后提醒）</Text>}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  {[
                    { key: 'expert_invite', label: '专家邀请文本' },
                    { key: 'meeting_confirm', label: '会议确认文本' },
                    { key: 'vote_remind', label: '会后提醒文本' },
                  ].map((it) => (
                    <div key={it.key} style={{ background: '#fafafa', padding: 12, borderRadius: 6 }}>
                      <Space style={{ marginBottom: 8 }}>
                        <Text strong>{it.label}</Text>
                        <Button size="small" icon={<CopyOutlined />}
                          onClick={() =>
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            copyText((notifTexts as any)[it.key] || '', it.label)
                          }>
                          复制
                        </Button>
                      </Space>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', fontSize: 13 }}>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {(notifTexts as any)[it.key] || '（加载中…）'}
                      </pre>
                    </div>
                  ))}
                </Space>
              </Collapse.Panel>
            </Collapse>
          </div>
            </Collapse.Panel>
          </Collapse>
        </Card>
      )}

      {/* 状态推进与流程说明（默认折叠；会议时间不驱动状态） */}
      {currentFlow && (
        <Collapse style={{ marginBottom: 24 }}>
          <Collapse.Panel key="flow" header={<Text strong>状态推进与流程说明</Text>}>
          <Alert
            type="info"
            showIcon
            message="会议时间仅用于记录，不会自动推进状态。"
            description={
              <Space direction="vertical" size={4}>
                <span>当前状态：{currentFlow.label}</span>
                <span>下一步：{currentFlow.next}</span>
              </Space>
            }
            action={status === 'MEETING_SCHEDULED' ? (
              <Button
                type="primary"
                loading={startingVoting}
                onClick={handleStartVoting}
              >
                进入会后结果整理
              </Button>
            ) : undefined}
          />
          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            所有状态推进都必须由后台管理员明确点击触发，并由后端写入操作记录；页面加载和会议时间到点不会改变真实状态。
          </Paragraph>
          </Collapse.Panel>
        </Collapse>
      )}

      {/* 会后录入（VOTING / VOTED） */}
      {(status === 'VOTING' || status === 'VOTED') && (
        <>
          {/* 投票汇总卡（蓝色背景，前置）*/}
          <Card
            size="small"
            style={{ background: '#EFF6FF', borderColor: '#BFDBFE', marginBottom: 16 }}
          >
            <Row justify="space-between" align="middle">
              <Col>
                <Text strong style={{ fontSize: 16 }}>投票汇总</Text>
              </Col>
              <Col>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  已录入 {voteRows.filter((r) => r.voteResult && r.reviewOpinion?.trim()).length} / {voteRows.length} 位专家
                </Text>
              </Col>
            </Row>
            <Space size={24} style={{ marginTop: 8 }} wrap>
              <span><Text type="secondary">通过：</Text><Text strong style={{ color: '#10B981' }}>{summary.PASS}</Text> 票</span>
              <span><Text type="secondary">不通过：</Text><Text strong style={{ color: '#EF4444' }}>{summary.REJECT}</Text> 票</span>
              <span><Text type="secondary">修改后通过：</Text><Text strong style={{ color: '#F59E0B' }}>{summary.PASS_WITH_MOD}</Text> 票</span>
              <span><Text type="secondary">弃权：</Text><Text strong>{summary.ABSTAIN}</Text> 票</span>
            </Space>
          </Card>

          <Card
            title={<Text strong style={{ fontSize: 16 }}>专家投票结果</Text>}
            style={{ marginBottom: 24, borderTop: '3px solid #1677ff' }}
            extra={
              status === 'VOTING' ? (
                <Space>
                  <Button loading={savingVotes} onClick={handleSaveVotes}>保存结果草稿</Button>
                  <Button onClick={handleCloseVoting}>仅关闭整理</Button>
                  <Button
                    type="primary"
                    icon={<FileDoneOutlined />}
                    loading={closingVoting}
                    onClick={handleFinishAndGenerate}
                  >
                    生成 Word 确认文件
                  </Button>
                </Space>
              ) : null
            }
          >
            {voteRows.length === 0 ? (
              <Empty description="暂无专家可录入" />
            ) : (
              <>
                <Collapse defaultActiveKey={voteRows.map((r) => r.assignmentId)} expandIconPosition="end">
                  {voteRows.map((row, idx) => {
                    const recorded = row.voteResult && row.reviewOpinion?.trim()
                    const labelByValue: Record<string, { label: string; color: string }> = {
                      PASS:          { label: '通过',       color: 'success' },
                      REJECT:        { label: '不通过',     color: 'error' },
                      PASS_WITH_MOD: { label: '修改后通过', color: 'warning' },
                      ABSTAIN:       { label: '弃权',       color: 'default' },
                    }
                    return (
                      <Collapse.Panel
                        key={row.assignmentId || `idx-${idx}`}
                        header={
                          <Space>
                            <Text strong>{row.expertName}</Text>
                            {recorded ? (
                              <Tag color={labelByValue[row.voteResult]?.color || 'default'}>
                                已录入：{labelByValue[row.voteResult]?.label || row.voteResult}
                              </Tag>
                            ) : (
                              <Tag>待录入</Tag>
                            )}
                          </Space>
                        }
                      >
                        <Form layout="vertical" disabled={status !== 'VOTING'}>
                          <Form.Item label="投票结果" required>
                            <Radio.Group
                              value={row.voteResult || undefined}
                              onChange={(e) => {
                                const next = [...voteRows]
                                next[idx] = { ...row, voteResult: e.target.value }
                                setVoteRows(next)
                              }}
                            >
                              <Radio.Button
                                value="PASS"
                                style={row.voteResult === 'PASS'
                                  ? { background: '#D1FAE5', borderColor: '#10B981', color: '#065F46', fontWeight: 600 }
                                  : {}}
                              >
                                通过
                              </Radio.Button>
                              <Radio.Button
                                value="REJECT"
                                style={row.voteResult === 'REJECT'
                                  ? { background: '#FEE2E2', borderColor: '#EF4444', color: '#991B1B', fontWeight: 600 }
                                  : {}}
                              >
                                不通过
                              </Radio.Button>
                              <Radio.Button
                                value="PASS_WITH_MOD"
                                style={row.voteResult === 'PASS_WITH_MOD'
                                  ? { background: '#FEF3C7', borderColor: '#F59E0B', color: '#92400E', fontWeight: 600 }
                                  : {}}
                              >
                                修改后通过
                              </Radio.Button>
                              <Radio.Button value="ABSTAIN">弃权</Radio.Button>
                            </Radio.Group>
                          </Form.Item>

                          <Form.Item label="专家意见" required>
                            <TextArea
                              rows={3} maxLength={5000}
                              placeholder="请输入专家对项目的整体评审意见..."
                              value={row.reviewOpinion}
                              onChange={(e) => {
                                const next = [...voteRows]; next[idx] = { ...row, reviewOpinion: e.target.value }; setVoteRows(next)
                              }}
                            />
                          </Form.Item>

                          {(row.voteResult === 'PASS_WITH_MOD' || row.voteResult === 'REJECT') && (
                            <Form.Item label="修改建议">
                              <TextArea
                                rows={2} maxLength={5000}
                                placeholder="请输入需要修改的具体建议..."
                                value={row.modificationSuggestion}
                                onChange={(e) => {
                                  const next = [...voteRows]; next[idx] = { ...row, modificationSuggestion: e.target.value }; setVoteRows(next)
                                }}
                              />
                            </Form.Item>
                          )}

                          <Form.Item label="风险提示（选填）">
                            <TextArea
                              rows={2} maxLength={5000}
                              placeholder="如有潜在风险，请在此说明..."
                              value={row.riskWarning}
                              onChange={(e) => {
                                const next = [...voteRows]; next[idx] = { ...row, riskWarning: e.target.value }; setVoteRows(next)
                              }}
                            />
                          </Form.Item>
                        </Form>
                      </Collapse.Panel>
                    )
                  })}
                </Collapse>

                <Divider />

                <Form layout="vertical" disabled={status !== 'VOTING'}>
                  <Form.Item label="最终结论" required>
                    <Select
                      value={conclusion || undefined}
                      options={CONCLUSION_OPTIONS}
                      onChange={(v) => setConclusion(v)}
                      placeholder="请选择"
                    />
                  </Form.Item>
                  <Form.Item label="结论说明（选填）" style={{ marginBottom: 0 }}>
                    <TextArea rows={3} maxLength={5000} value={conclusionRemark}
                      placeholder="请输入综合所有专家意见后的最终结论说明..."
                      onChange={(e) => setConclusionRemark(e.target.value)} />
                  </Form.Item>
                </Form>
              </>
            )}
          </Card>
        </>
      )}

      {/* 生成 Word 确认文件（VOTED） */}
      {status === 'VOTED' && (
        <Card
          title={<Text strong style={{ fontSize: 16 }}>生成 Word 确认文件</Text>}
          style={{ marginBottom: 24, borderTop: '3px solid #1677ff' }}
        >
          <Paragraph type="secondary">
            基于已录入的专家意见和投票结果生成《专家评审意见与投票结果确认单》Word 文件，
            状态将变为"确认文件处理中"。生成后请下载 Word 确认文件，线下整理后上传最终 PDF：
          </Paragraph>
          <Button type="primary" icon={<FileDoneOutlined />} loading={generating} onClick={handleGenerate}>
            生成 Word 确认文件
          </Button>
        </Card>
      )}

      {/* 确认文件处理中（SIGNING）—— 线下整理后上传最终交付文件 */}
      {status === 'SIGNING' && (
        <Card
          title={<Text strong style={{ fontSize: 16 }}>确认文件交付</Text>}
          style={{ marginBottom: 24, borderTop: '3px solid #1677ff' }}
        >
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            请下载 Word 确认文件后，线下完成修改、排版、专家签字、转 PDF，再上传最终交付 PDF。
            上传后状态将变为「已完成」，用户可下载最终交付文件。
          </Paragraph>
          <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
            专家签字材料请线下合并后，由管理员通过下方「上传最终 PDF」完成交付。平台内自动合成功能后续版本开放。
          </Paragraph>

          <Space wrap style={{ marginBottom: 16 }}>
            <Button
              icon={<DownloadOutlined />}
              loading={downloadingResultDoc}
              onClick={handleDownloadResultDoc}
            >
              下载 Word 确认文件
            </Button>
            <Upload
              accept=".pdf,.docx,.doc"
              showUploadList={false}
              action={adminUploadFinalDeliverableUrl(no)}
              headers={uploadHeaders()}
              onChange={(info) => {
                if (info.file.status === 'done') {
                  message.success('最终交付 PDF 已上传，状态已变为已完成')
                  reload()
                } else if (info.file.status === 'error') {
                  message.error(info.file.response?.error || '上传失败')
                }
              }}
            >
              <Button type="primary" icon={<UploadOutlined />} size="large">
                上传最终交付 PDF
              </Button>
            </Upload>
          </Space>

          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 16 }}
            message="操作不可撤销。完成交付后状态将变为「已完成」，用户即可在前台下载最终交付文件。"
          />
        </Card>
      )}

      {/* 归档（COMPLETED）*/}
      {status === 'COMPLETED' && (
        <>
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled />}
            message="服务已完成"
            description={
              <Space direction="vertical" size={2}>
                {data.deliveredAt && (
                  <span>完成时间：{formatDateTime(data.deliveredAt)}</span>
                )}
                <span>
                  投票结果：
                  {summary.PASS > 0 && `通过 ${summary.PASS} 票`}
                  {summary.PASS_WITH_MOD > 0 && ` · 修改后通过 ${summary.PASS_WITH_MOD} 票`}
                  {summary.REJECT > 0 && ` · 不通过 ${summary.REJECT} 票`}
                  {summary.ABSTAIN > 0 && ` · 弃权 ${summary.ABSTAIN} 票`}
                </span>
                <span>最终交付文件已生成并交付给用户</span>
              </Space>
            }
            style={{ marginBottom: 16 }}
          />

          <Card
            title={<Text strong style={{ fontSize: 16 }}>最终交付文件</Text>}
            style={{ marginBottom: 24, borderTop: '3px solid #52c41a' }}
          >
            <Card size="small" style={{ background: '#F9FAFB', marginBottom: 16 }}>
              <Row justify="space-between" align="middle" gutter={[16, 12]}>
                <Col>
                  <Space>
                    <FileDoneOutlined style={{ fontSize: 32, color: '#10B981' }} />
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>
                        {data.requestNo}_专家评审最终交付文件
                        {(data.finalDeliverablePath || data.signedPdfPath || '').endsWith('.pdf') ? '.pdf' : '.docx'}
                      </div>
                      <Space wrap size={8} style={{ marginTop: 4 }}>
                        <Tag color={data.deliveryMode === 'PLATFORM_GENERATED' ? 'purple' : 'blue'}>
                          {data.deliveryMode === 'PLATFORM_GENERATED'
                            ? '平台内生成'
                            : data.deliveryMode === 'OFFLINE_UPLOAD'
                            ? '线下整理后上传'
                            : '最终交付'}
                        </Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          交付时间：{formatDateTime(data.deliveredAt)}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          上传人：{operatorLabel(data.deliveredBy || data.signedBy)}
                        </Text>
                      </Space>
                    </div>
                  </Space>
                </Col>
                <Space>
                  <Button
                    type="primary"
                    icon={<DownloadOutlined />}
                    href={adminFinalDeliverableUrl(no)}
                    target="_blank"
                  >
                    下载最终交付文件
                  </Button>
                </Space>
              </Row>
            </Card>

            <Card size="small" title="文件信息">
              <Row gutter={[16, 8]}>
                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>交付方式</Text>
                  <div>
                    {data.deliveryMode === 'PLATFORM_GENERATED'
                      ? <Tag color="purple">平台内生成</Tag>
                      : data.deliveryMode === 'OFFLINE_UPLOAD'
                      ? <Tag color="blue">线下整理后上传</Tag>
                      : '-'}
                  </div>
                </Col>
                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>交付时间</Text>
                  <div>{formatDateTime(data.deliveredAt)}</div>
                </Col>
                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>上传人</Text>
                  <div>{operatorLabel(data.deliveredBy || data.signedBy)}</div>
                </Col>
              </Row>
            </Card>

            <Collapse style={{ marginTop: 16 }} ghost>
              <Collapse.Panel key="tech" header={<Text strong>技术校验信息</Text>}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text type="secondary">文件 hash（SHA-256）</Text>
                  <Text code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {data.finalDeliverableHash || data.signedPdfHash || '-'}
                  </Text>
                  {(data.finalDeliverableHash || data.signedPdfHash) && (
                    <Button
                      icon={<CopyOutlined />}
                      onClick={() => copyText(data.finalDeliverableHash || data.signedPdfHash, '文件 hash')}
                    >
                      复制 hash
                    </Button>
                  )}
                </Space>
              </Collapse.Panel>
            </Collapse>

            {/* 交付留痕折叠 */}
            <Collapse style={{ marginTop: 16 }} ghost>
              <Collapse.Panel key="logs" header={<Text strong>交付留痕（{signLogs.length}）</Text>}>
                {signLogs.length === 0 ? (
                  <Empty description="暂无留痕日志" />
                ) : (
                  <div>
                    {signLogs.map((log) => (
                      <div
                        key={log.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '8px 0',
                          borderBottom: '1px solid #f0f0f0',
                          fontSize: 13,
                        }}
                      >
                        <Space>
                          <Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {formatDateTime(log.createdAt)}
                          </Text>
                          <Tag>{SIGN_LOG_ACTION_LABEL[log.action] || log.action || '留痕记录'}</Tag>
                        </Space>
                        <Text type="secondary" style={{ fontSize: 12 }}>{operatorLabel(log.operatorId)}</Text>
                      </div>
                    ))}
                  </div>
                )}
              </Collapse.Panel>
            </Collapse>
          </Card>
        </>
      )}
    </>
  )
}
