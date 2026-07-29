import { useEffect, useMemo, useState } from 'react'
import { Alert, DatePicker, Form, Modal, Select, Space, Switch, Tag, Typography, message } from 'antd'
import { InputNumber, Radio } from 'antd'
import dayjs from 'dayjs'
import {
  TASK_TYPE_LABEL,
  seCommitTaskGeneration,
  seCommitTaskGenerationEnterprise,
  type EnterpriseMember,
} from '../../../api/standardExecution'
import type { WorkbenchScope } from './aiAdapter'
import {
  batchToCommitBody,
  buildCommitBatches,
  type DispatchConfig,
} from './commit'
import { deadlineLabel, type WorkbenchModel } from './model'

const { Text } = Typography

interface DispatchModalProps {
  open: boolean
  scope: WorkbenchScope
  model: WorkbenchModel
  selectedIds: string[]
  /** 每卡已 stamp 的审核人/截止（批量调审核人/调截止结果）；弹窗内统一值可再覆盖 */
  dispatchByCardId: Record<string, DispatchConfig>
  members: EnterpriseMember[]
  onCancel: () => void
  onDispatched: (summary: { requirements: number; tasks: number; batches: number }) => void
}

export default function DispatchModal({
  open,
  scope,
  model,
  selectedIds,
  dispatchByCardId,
  members,
  onCancel,
  onDispatched,
}: DispatchModalProps) {
  const [reviewerId, setReviewerId] = useState<string | undefined>(undefined)
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [overrideDeadline, setOverrideDeadline] = useState(false)
  const [deadlineMode, setDeadlineMode] = useState<'AFTER_APPROVAL_DAYS' | 'FIXED'>('AFTER_APPROVAL_DAYS')
  const [days, setDays] = useState<number>(30)
  const [fixedAt, setFixedAt] = useState<dayjs.Dayjs | null>(dayjs().add(30, 'day').hour(18).minute(0).second(0))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setReviewerId(undefined)
      setAssigneeIds([])
      setOverrideDeadline(false)
    }
  }, [open])

  const memberOptions = members.map((m) => ({
    value: m.id,
    label: `${m.phone}${m.nickName ? ` ${m.nickName}` : ''}`,
  }))

  // 计算生效 dispatch：每卡取已 stamp 值（或卡自身建议），再被弹窗统一值覆盖
  const effective = useMemo<Record<string, DispatchConfig>>(() => {
    const map: Record<string, DispatchConfig> = {}
    for (const id of selectedIds) {
      const card = model.cards.find((c) => c.id === id)
      if (!card) continue
      const seed: DispatchConfig = dispatchByCardId[id] ?? {
        reviewerId: null,
        deadlineMode: card.deadlineSuggestion.mode,
        deadlineDaysAfterApproval: card.deadlineSuggestion.daysAfterApproval,
        deadlineAt: card.deadlineSuggestion.fixedAt,
      }
      const next: DispatchConfig = { ...seed }
      if (reviewerId) next.reviewerId = reviewerId
      if (overrideDeadline) {
        next.deadlineMode = deadlineMode
        next.deadlineDaysAfterApproval = deadlineMode === 'AFTER_APPROVAL_DAYS' ? days : null
        next.deadlineAt = deadlineMode === 'FIXED' ? (fixedAt ? fixedAt.toISOString() : null) : null
      }
      map[id] = next
    }
    return map
  }, [selectedIds, model.cards, dispatchByCardId, reviewerId, overrideDeadline, deadlineMode, days, fixedAt])

  const { batches, warnings } = useMemo(
    () => buildCommitBatches(model, selectedIds, effective, { assigneeIds }),
    [model, selectedIds, effective, assigneeIds],
  )

  const reviewerName = (id: string | null) => memberOptions.find((m) => m.value === id)?.label || id || '（未设）'
  const blocking = assigneeIds.length === 0 || batches.length === 0

  const handleDispatch = async () => {
    if (blocking) {
      message.warning(assigneeIds.length === 0 ? '请选择执行人' : '没有可派发的任务卡')
      return
    }
    setSubmitting(true)
    const commitFn = scope === 'enterprise' ? seCommitTaskGenerationEnterprise : seCommitTaskGeneration
    let requirements = 0
    let tasks = 0
    try {
      // 按分组顺序逐次 commit（一次 commit 只能一组审核人/截止）
      for (const batch of batches) {
        const res = await commitFn(batchToCommitBody(batch))
        requirements += res.data.summary.requirements
        tasks += res.data.summary.tasks
      }
      onDispatched({ requirements, tasks, batches: batches.length })
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || `派发失败（已成功 ${tasks} 个任务，请勿重复派发已成功部分）`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={`批量派发（已选 ${selectedIds.length} 张卡）`}
      open={open}
      onOk={handleDispatch}
      onCancel={onCancel}
      okText="确认派发"
      cancelText="取消"
      okButtonProps={{ disabled: blocking, loading: submitting }}
      width={680}
      destroyOnClose
    >
      <Form layout="vertical">
        <Form.Item label="审核人（留空则用各卡已设审核人）">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="统一指定审核人"
            options={memberOptions}
            value={reviewerId}
            onChange={(v) => setReviewerId(v || undefined)}
          />
        </Form.Item>
        <Form.Item label="执行人（必选，可多选）" required>
          <Select
            mode="multiple"
            showSearch
            optionFilterProp="label"
            placeholder="选择执行人"
            options={memberOptions}
            value={assigneeIds}
            onChange={setAssigneeIds}
          />
        </Form.Item>
        <Form.Item label={<Space>统一截止 <Switch size="small" checked={overrideDeadline} onChange={setOverrideDeadline} /></Space>}>
          {overrideDeadline ? (
            <Space>
              <Radio.Group value={deadlineMode} onChange={(e) => setDeadlineMode(e.target.value)}>
                <Radio value="AFTER_APPROVAL_DAYS">审核后 N 天</Radio>
                <Radio value="FIXED">固定日期</Radio>
              </Radio.Group>
              {deadlineMode === 'AFTER_APPROVAL_DAYS' ? (
                <InputNumber min={1} max={3650} value={days} onChange={(v) => setDays(v || 30)} addonAfter="天" />
              ) : (
                <DatePicker showTime value={fixedAt} onChange={setFixedAt} />
              )}
            </Space>
          ) : (
            <Text type="secondary">不覆盖，沿用各卡建议/已设截止</Text>
          )}
        </Form.Item>
      </Form>

      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="派发提示"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        />
      )}

      <div>
        <Text strong>将生成 {batches.length} 次提交：</Text>
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          {batches.map((b, i) => (
            <div key={i} style={{ border: '1px solid #eef2f7', borderRadius: 8, padding: 10 }}>
              <Space wrap size={6}>
                <Tag color="blue">审核人：{reviewerName(b.reviewerId)}</Tag>
                <Tag>
                  截止：
                  {deadlineLabel(b.deadlineMode, b.deadlineDaysAfterApproval, b.deadlineAt ? dayjs(b.deadlineAt).format('YYYY-MM-DD HH:mm') : null)}
                </Tag>
                <Tag color="geekblue">{b.cardIds.length} 张卡</Tag>
                <Tag color="purple">{b.drafts.length} 条要求</Tag>
              </Space>
              <div style={{ marginTop: 6 }}>
                {b.drafts.flatMap((d) => d.taskDrafts || []).map((t) => (
                  <Tag key={t.taskDraftId} bordered={false} style={{ marginBottom: 4 }}>
                    {TASK_TYPE_LABEL[t.taskType || ''] || t.taskType}：{t.title}
                  </Tag>
                ))}
              </div>
            </div>
          ))}
        </Space>
      </div>
    </Modal>
  )
}
