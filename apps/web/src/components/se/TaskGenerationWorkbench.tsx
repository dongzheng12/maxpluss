import { useEffect, useMemo, useReducer, useState } from 'react'
import type { Key } from 'react'
import {
  Alert,
  Button,
  DatePicker,
  Divider,
  Empty,
  Input,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  CheckCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useNavigate } from 'react-router-dom'
import {
  PARSE_MODE_LABEL,
  STANDARD_TASK_TYPE_VALUES,
  TASK_TYPE_LABEL,
  seCommitTaskGeneration,
  seCommitTaskGenerationEnterprise,
  seListEnterpriseMembers,
  seListSources,
  seListSourcesEnterprise,
  sePreviewTaskGeneration,
  sePreviewTaskGenerationEnterprise,
  type EnterpriseMember,
  type Source,
  type TaskGenerationCommitResp,
  type TaskGenerationDraft,
  type TaskGenerationPreviewResp,
} from '../../api/standardExecution'
import {
  buildTaskGenerationPreviewErrorAlert,
  type TaskGenerationPreviewErrorAlert,
} from './taskGenerationPreviewError'

const { Text, Title } = Typography
const { TextArea } = Input

type Scope = 'admin' | 'enterprise'
type ParseMode = 'OCR_AI' | 'RULE' | 'AI_STUB'
type TaskCommitStatus = 'DRAFT' | 'PENDING_APPROVAL'

interface TaskGenerationWorkbenchProps {
  scope: Scope
  initialSourceId?: string
}

interface WorkbenchState {
  step: number
  sourceId: string
  rawText: string
  parseMode: ParseMode
  preview: TaskGenerationPreviewResp | null
  drafts: TaskGenerationDraft[]
  titlePrefix: string
  taskType: string | null
  submitRequirement: string
  deadlineAt: Dayjs | null
  reviewerId: string
  assigneeIds: string[]
  result: TaskGenerationCommitResp | null
  previewLoading: boolean
  commitLoading: boolean
  dirty: boolean
}

type DraftPatch = Partial<Omit<TaskGenerationDraft, 'taskDrafts'>> & {
  taskDrafts?: TaskGenerationDraft['taskDrafts']
}
type TaskDraftPatch = NonNullable<TaskGenerationDraft['taskDrafts']>[number]

type Action =
  | { type: 'setField'; field: keyof WorkbenchState; value: WorkbenchState[keyof WorkbenchState]; dirty?: boolean }
  | { type: 'setPreviewLoading'; value: boolean }
  | { type: 'setCommitLoading'; value: boolean }
  | { type: 'previewSuccess'; preview: TaskGenerationPreviewResp; drafts: TaskGenerationDraft[] }
  | { type: 'patchDraft'; index: number; patch: DraftPatch }
  | { type: 'patchTaskDraft'; draftIndex: number; taskIndex: number; patch: Partial<TaskDraftPatch> }
  | { type: 'addTaskDraft'; draftIndex: number }
  | { type: 'removeTaskDraft'; draftIndex: number; taskIndex: number }
  | { type: 'removeDrafts'; keys: string[] }
  | { type: 'commitSuccess'; result: TaskGenerationCommitResp }
  | { type: 'reset'; sourceId?: string }

const DEFAULT_SUBMIT_REQUIREMENT = '请按任务要求完成执行，并提交必要的记录、说明或证明材料。'
const STEP_ITEMS = [
  { title: '选择来源' },
  { title: '预览执行要求' },
  { title: '配置任务' },
  { title: '完成' },
]
const PARSE_MODE_OPTIONS = (Object.keys(PARSE_MODE_LABEL) as ParseMode[]).map((value) => ({
  value,
  label: PARSE_MODE_LABEL[value],
}))
const TASK_TYPE_OPTIONS = STANDARD_TASK_TYPE_VALUES.map((value) => ({ value, label: TASK_TYPE_LABEL[value] }))

function initialState(sourceId = ''): WorkbenchState {
  return {
    step: 0,
    sourceId,
    rawText: '',
    parseMode: 'OCR_AI',
    preview: null,
    drafts: [],
    titlePrefix: '',
    taskType: null,
    submitRequirement: DEFAULT_SUBMIT_REQUIREMENT,
    deadlineAt: dayjs().add(7, 'day').hour(18).minute(0).second(0),
    reviewerId: '',
    assigneeIds: [],
    result: null,
    previewLoading: false,
    commitLoading: false,
    dirty: false,
  }
}

function ensureTaskDrafts(drafts: TaskGenerationDraft[]) {
  return drafts.map((draft, index) => {
    if (draft.taskDrafts?.length) return draft
    const id = draft.draftId || `draft-${index + 1}`
    return {
      ...draft,
      groupId: draft.groupId || id,
      taskDrafts: [{
        taskDraftId: `task-${id}`,
        groupId: draft.groupId || id,
        title: draft.title,
        taskType: draft.recommendedTaskType || null,
        submitRequirement: draft.submitRequirement || null,
      }],
    }
  })
}

function patchDraftList(
  drafts: TaskGenerationDraft[],
  index: number,
  patch: DraftPatch,
) {
  return drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft))
}

function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case 'setField':
      return { ...state, [action.field]: action.value, dirty: action.dirty ?? true }
    case 'setPreviewLoading':
      return { ...state, previewLoading: action.value }
    case 'setCommitLoading':
      return { ...state, commitLoading: action.value }
    case 'previewSuccess':
      return {
        ...state,
        preview: action.preview,
        drafts: action.drafts,
        step: 1,
        dirty: true,
      }
    case 'patchDraft':
      return { ...state, drafts: patchDraftList(state.drafts, action.index, action.patch), dirty: true }
    case 'patchTaskDraft':
      return {
        ...state,
        drafts: state.drafts.map((draft, draftIndex) => {
          if (draftIndex !== action.draftIndex) return draft
          const taskDrafts = draft.taskDrafts?.map((taskDraft, taskIndex) =>
            taskIndex === action.taskIndex ? { ...taskDraft, ...action.patch } : taskDraft,
          ) || []
          return { ...draft, taskDrafts }
        }),
        dirty: true,
      }
    case 'addTaskDraft':
      return {
        ...state,
        drafts: state.drafts.map((draft, draftIndex) => {
          if (draftIndex !== action.draftIndex) return draft
          const nextIndex = (draft.taskDrafts?.length || 0) + 1
          const groupId = `${draft.groupId || draft.draftId || `draft-${draftIndex + 1}`}-split-${nextIndex}`
          return {
            ...draft,
            taskDrafts: [
              ...(draft.taskDrafts || []),
              {
                taskDraftId: `task-${groupId}`,
                groupId,
                title: `${draft.title} ${nextIndex}`,
                taskType: draft.recommendedTaskType || null,
                submitRequirement: draft.submitRequirement || null,
              },
            ],
          }
        }),
        dirty: true,
      }
    case 'removeTaskDraft':
      return {
        ...state,
        drafts: state.drafts.map((draft, draftIndex) => {
          if (draftIndex !== action.draftIndex) return draft
          const taskDrafts = (draft.taskDrafts || []).filter((_item, taskIndex) => taskIndex !== action.taskIndex)
          return { ...draft, taskDrafts: taskDrafts.length ? taskDrafts : draft.taskDrafts }
        }),
        dirty: true,
      }
    case 'removeDrafts': {
      const removeKeys = new Set(action.keys)
      return {
        ...state,
        drafts: state.drafts.filter((draft, index) => !removeKeys.has(draft.draftId || `${draft.clauseNo || 'draft'}-${index}`)),
        dirty: true,
      }
    }
    case 'commitSuccess':
      return { ...state, result: action.result, step: 3, dirty: false }
    case 'reset':
      return initialState(action.sourceId)
    default:
      return state
  }
}

function normalizeDraftForSubmit(draft: TaskGenerationDraft): TaskGenerationDraft {
  return {
    ...draft,
    clauseNo: draft.clauseNo?.trim() || null,
    title: draft.title.trim(),
    requirementText: draft.requirementText.trim(),
    recommendedTaskType: draft.recommendedTaskType || null,
    executionDescription: draft.executionDescription?.trim() || null,
    submitRequirement: draft.submitRequirement?.trim() || null,
    requiredMaterials: draft.requiredMaterials?.filter(Boolean) || null,
    taskDrafts: draft.taskDrafts?.map((taskDraft) => ({
      ...taskDraft,
      groupId: taskDraft.groupId?.trim() || null,
      title: taskDraft.title?.trim() || null,
      description: taskDraft.description?.trim() || null,
      taskType: taskDraft.taskType || null,
      submitRequirement: taskDraft.submitRequirement?.trim() || null,
    })),
  }
}

function draftRowKey(row: TaskGenerationDraft, index?: number) {
  return row.draftId || `${row.clauseNo || 'draft'}-${index ?? 0}`
}

export default function TaskGenerationWorkbench({ scope, initialSourceId = '' }: TaskGenerationWorkbenchProps) {
  const [state, dispatch] = useReducer(reducer, initialState(initialSourceId))
  const [selectedDraftKeys, setSelectedDraftKeys] = useState<Key[]>([])
  const [previewErrorAlert, setPreviewErrorAlert] = useState<TaskGenerationPreviewErrorAlert | null>(null)
  const [sources, setSources] = useReducer((_state: Source[], next: Source[]) => next, [])
  const [members, setMembers] = useReducer((_state: EnterpriseMember[], next: EnterpriseMember[]) => next, [])
  const navigate = useNavigate()
  const isEnterprise = scope === 'enterprise'
  const taskPath = isEnterprise ? '/enterprise/tasks' : '/admin/standard-execution/tasks'

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === state.sourceId) || null,
    [sources, state.sourceId],
  )
  const memberOptions = members.map((member) => ({
    value: member.id,
    label: `${member.phone}${member.nickName ? ` ${member.nickName}` : ''}`,
  }))

  useEffect(() => {
    const fetchSources = isEnterprise ? seListSourcesEnterprise : seListSources
    fetchSources({ status: 'ACTIVE', pageSize: 500 })
      .then((res) => setSources(res.data))
      .catch(() => message.error('标准来源加载失败'))
    seListEnterpriseMembers()
      .then((res) => setMembers(res.data))
      .catch(() => message.error('成员列表加载失败'))
  }, [isEnterprise])

  useEffect(() => {
    if (!state.dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [state.dirty])

  const handlePreview = async () => {
    if (!state.sourceId && !state.rawText.trim()) {
      message.warning('请选择标准来源，或粘贴临时原文')
      return
    }
    dispatch({ type: 'setPreviewLoading', value: true })
    setPreviewErrorAlert(null)
    try {
      const previewFn = isEnterprise ? sePreviewTaskGenerationEnterprise : sePreviewTaskGeneration
      const res = await previewFn({
        sourceId: state.sourceId || undefined,
        rawText: state.rawText.trim() || undefined,
        parseMode: state.parseMode,
      })
      dispatch({ type: 'previewSuccess', preview: res.data, drafts: ensureTaskDrafts(res.data.drafts) })
      setPreviewErrorAlert(null)
      setSelectedDraftKeys([])
      if (res.data.drafts.length === 0) message.warning('未识别到可生成任务草稿的执行要求')
      else message.success(`已预览 ${res.data.drafts.length} 条执行要求草稿`)
    } catch (error) {
      setPreviewErrorAlert(buildTaskGenerationPreviewErrorAlert(error))
    } finally {
      dispatch({ type: 'setPreviewLoading', value: false })
    }
  }

  const handleCommit = async (taskStatus: TaskCommitStatus = 'DRAFT') => {
    if (!state.sourceId) {
      message.warning('提交前必须选择标准来源')
      return
    }
    if (state.drafts.length === 0) {
      message.warning('请先生成执行要求草稿')
      return
    }
    if (!state.deadlineAt || !state.reviewerId || state.assigneeIds.length === 0) {
      message.warning('请补齐截止时间、审核人和执行人')
      return
    }
    const invalidDraft = state.drafts.find((draft) => !draft.title.trim() || !draft.requirementText.trim())
    if (invalidDraft) {
      message.warning('执行要求标题和要求正文不能为空')
      return
    }
    dispatch({ type: 'setCommitLoading', value: true })
    try {
      const commitFn = isEnterprise ? seCommitTaskGenerationEnterprise : seCommitTaskGeneration
      const res = await commitFn({
        sourceId: state.sourceId,
        parseMode: state.parseMode,
        taskStatus,
        titlePrefix: state.titlePrefix.trim() || null,
        taskType: state.taskType || null,
        submitRequirement: state.submitRequirement.trim() || null,
        deadlineAt: state.deadlineAt.toISOString(),
        deadlineMode: 'FIXED',
        deadlineDaysAfterApproval: null,
        reviewerId: state.reviewerId,
        assigneeIds: state.assigneeIds,
        drafts: state.drafts.map(normalizeDraftForSubmit),
      })
      dispatch({ type: 'commitSuccess', result: res.data })
      message.success(`已生成 ${res.data.summary.requirements} 条执行要求、${res.data.summary.tasks} 个${taskStatus === 'PENDING_APPROVAL' ? '待审核任务' : '任务草稿'}`)
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      dispatch({ type: 'setCommitLoading', value: false })
    }
  }

  const handleReset = () => {
    if (state.dirty && !window.confirm('当前草稿尚未提交，确认清空并重新开始？')) return
    dispatch({ type: 'reset', sourceId: initialSourceId })
    setPreviewErrorAlert(null)
    setSelectedDraftKeys([])
  }

  const handleRemoveSelectedDrafts = () => {
    if (selectedDraftKeys.length === 0) return
    dispatch({ type: 'removeDrafts', keys: selectedDraftKeys.map(String) })
    setSelectedDraftKeys([])
  }

  const goCreatedTasks = () => {
    if (!state.result) return
    const params = new URLSearchParams({
      createdBatch: state.result.batchId,
      createdTaskIds: state.result.created.taskIds.join(','),
      createdTaskStatus: state.result.summary.taskStatus,
    })
    navigate(`${taskPath}?${params.toString()}`)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <div>
          <Title level={4} style={{ margin: 0 }}>任务生成工作台</Title>
          <Text type="secondary">从标准来源解析执行要求，再批量生成任务草稿。</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>重新开始</Button>
          {state.step < 2 && (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={state.previewLoading}
              onClick={handlePreview}
            >
              预览执行要求
            </Button>
          )}
        </Space>
      </Space>

      <Steps current={state.step} items={STEP_ITEMS} style={{ marginBottom: 20 }} />

      {state.preview?.degraded && (
        <Alert
          type={state.preview.degradedReason === 'REALTIME_RULE_LIMIT' ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            state.preview.degradedReason === 'REALTIME_RULE_LIMIT'
              ? `文档超出 AI 实时解析上限，已使用${PARSE_MODE_LABEL[state.preview.parseMode]}`
              : `解析已切换为 ${PARSE_MODE_LABEL[state.preview.parseMode]}${state.preview.degradedReason ? `：${state.preview.degradedReason}` : ''}`
          }
          description={
            state.preview.degradedReason === 'REALTIME_RULE_LIMIT'
              ? '这是当前大文档的正式解析策略；AI 大文档异步解析将随 T10 C1 另行上线。'
              : undefined
          }
        />
      )}

      {previewErrorAlert && (
        <Alert
          type={previewErrorAlert.kind === 'overload' ? 'warning' : 'error'}
          showIcon
          closable
          onClose={() => setPreviewErrorAlert(null)}
          style={{ marginBottom: 16 }}
          message={previewErrorAlert.message}
          description={previewErrorAlert.description}
          action={(
            <Button size="small" onClick={handlePreview} loading={state.previewLoading}>
              重试
            </Button>
          )}
        />
      )}

      {state.step === 0 && (
        <div style={{ maxWidth: 860 }}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div>
              <Text strong>标准来源</Text>
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择已启用且包含正文的标准来源"
                value={state.sourceId || undefined}
                options={sources.map((source) => ({
                  value: source.id,
                  label: `${source.title}${source.sourceNo ? ` · ${source.sourceNo}` : ''}`,
                  disabled: !source.rawText,
                }))}
                onChange={(value) => dispatch({ type: 'setField', field: 'sourceId', value: value || '' })}
              />
              {selectedSource && !selectedSource.rawText && (
                <Text type="danger" style={{ display: 'block', marginTop: 6 }}>该来源暂无正文，无法生成任务草稿。</Text>
              )}
            </div>
            <div>
              <Text strong>解析模式</Text>
              <Select
                style={{ width: 220, display: 'block', marginTop: 8 }}
                options={PARSE_MODE_OPTIONS}
                value={state.parseMode}
                onChange={(value) => dispatch({ type: 'setField', field: 'parseMode', value: value as ParseMode })}
              />
            </div>
            <div>
              <Text strong>临时原文</Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>仅用于预览；正式提交仍需选择标准来源。</Text>
              <TextArea
                rows={8}
                maxLength={500_000}
                showCount
                style={{ marginTop: 8 }}
                value={state.rawText}
                placeholder="可粘贴一段标准原文先试算，提交前请选择标准来源"
                onChange={(event) => dispatch({ type: 'setField', field: 'rawText', value: event.target.value })}
              />
            </div>
          </Space>
        </div>
      )}

      {state.step === 1 && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space wrap>
            <Tag color="blue">实际模式：{PARSE_MODE_LABEL[state.preview?.parseMode || state.parseMode]}</Tag>
            <Tag>拒绝项：{state.preview?.rejectedCount ?? 0}</Tag>
            {(state.preview?.warnings || []).map((warning) => <Tag color="orange" key={warning}>{warning}</Tag>)}
          </Space>
          {state.drafts.length === 0 ? (
            <Empty description="暂无草稿" />
          ) : (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {selectedDraftKeys.length > 0 && (
                <Space>
                  <Text type="secondary">已选 {selectedDraftKeys.length} 条草稿</Text>
                  <Button size="small" danger onClick={handleRemoveSelectedDrafts}>删除选中草稿</Button>
                </Space>
              )}
              <Table<TaskGenerationDraft>
                rowKey={draftRowKey}
                rowSelection={{ selectedRowKeys: selectedDraftKeys, onChange: setSelectedDraftKeys }}
                dataSource={state.drafts}
                pagination={false}
                size="middle"
                columns={[
                  { title: '条款号', dataIndex: 'clauseNo', width: 120, render: (value: string | null) => value || '-' },
                  { title: '标题', dataIndex: 'title', ellipsis: true },
                  {
                    title: '推荐类型',
                    dataIndex: 'recommendedTaskType',
                    width: 140,
                    render: (value: string | null) => value ? <Tag>{TASK_TYPE_LABEL[value] || value}</Tag> : '-',
                  },
                  { title: '要求正文', dataIndex: 'requirementText', ellipsis: true },
                  {
                    title: '操作',
                    width: 90,
                    render: (_: unknown, row: TaskGenerationDraft, index: number) => (
                      <Button
                        type="link"
                        danger
                        size="small"
                        onClick={() => dispatch({ type: 'removeDrafts', keys: [draftRowKey(row, index)] })}
                      >
                        删除
                      </Button>
                    ),
                  },
                ]}
              />
            </Space>
          )}
          <Space>
            <Button onClick={() => dispatch({ type: 'setField', field: 'step', value: 0, dirty: state.dirty })}>返回来源</Button>
            <Button type="primary" onClick={() => dispatch({ type: 'setField', field: 'step', value: 2, dirty: state.dirty })}>
              配置任务
            </Button>
          </Space>
        </Space>
      )}

      {state.step === 2 && (
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1fr)', gap: 16 }}>
            <div>
              <Text strong>任务参数</Text>
              <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 10 }}>
                <Input
                  maxLength={80}
                  placeholder="任务标题前缀（选填）"
                  value={state.titlePrefix}
                  onChange={(event) => dispatch({ type: 'setField', field: 'titlePrefix', value: event.target.value })}
                />
                <Select
                  allowClear
                  placeholder="默认任务类型（选填）"
                  options={TASK_TYPE_OPTIONS}
                  value={state.taskType || undefined}
                  onChange={(value) => dispatch({ type: 'setField', field: 'taskType', value: value || null })}
                />
                <TextArea
                  rows={3}
                  maxLength={1000}
                  value={state.submitRequirement}
                  onChange={(event) => dispatch({ type: 'setField', field: 'submitRequirement', value: event.target.value })}
                />
              </Space>
            </div>
            <div>
              <Text strong>指派信息</Text>
              <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 10 }}>
                <DatePicker
                  showTime
                  style={{ width: '100%' }}
                  value={state.deadlineAt}
                  onChange={(value) => dispatch({ type: 'setField', field: 'deadlineAt', value })}
                />
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="审核人"
                  options={memberOptions}
                  value={state.reviewerId || undefined}
                  onChange={(value) => dispatch({ type: 'setField', field: 'reviewerId', value: value || '' })}
                />
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  placeholder="执行人"
                  options={memberOptions}
                  value={state.assigneeIds}
                  onChange={(value) => dispatch({ type: 'setField', field: 'assigneeIds', value })}
                />
              </Space>
            </div>
          </div>

          <Divider style={{ margin: '6px 0' }} />

          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {state.drafts.map((draft, draftIndex) => (
              <div key={draft.draftId || draftIndex} style={{ border: '1px solid #eef2f7', borderRadius: 8, padding: 14 }}>
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                    <Text strong>{draftIndex + 1}. 执行要求草稿</Text>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => dispatch({ type: 'addTaskDraft', draftIndex })}
                    >
                      拆分任务
                    </Button>
                  </Space>
                  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 180px', gap: 10 }}>
                    <Input
                      maxLength={50}
                      placeholder="条款号"
                      value={draft.clauseNo || ''}
                      onChange={(event) => dispatch({ type: 'patchDraft', index: draftIndex, patch: { clauseNo: event.target.value } })}
                    />
                    <Input
                      maxLength={200}
                      placeholder="执行要求标题"
                      value={draft.title}
                      onChange={(event) => dispatch({ type: 'patchDraft', index: draftIndex, patch: { title: event.target.value } })}
                    />
                    <Select
                      allowClear
                      placeholder="推荐类型"
                      options={TASK_TYPE_OPTIONS}
                      value={draft.recommendedTaskType || undefined}
                      onChange={(value) => dispatch({ type: 'patchDraft', index: draftIndex, patch: { recommendedTaskType: value || null } })}
                    />
                  </div>
                  <TextArea
                    rows={3}
                    maxLength={10_000}
                    value={draft.requirementText}
                    onChange={(event) => dispatch({ type: 'patchDraft', index: draftIndex, patch: { requirementText: event.target.value } })}
                  />
                  <TextArea
                    rows={2}
                    maxLength={2000}
                    placeholder="执行描述"
                    value={draft.executionDescription || ''}
                    onChange={(event) => dispatch({ type: 'patchDraft', index: draftIndex, patch: { executionDescription: event.target.value } })}
                  />
                  <Select
                    mode="tags"
                    tokenSeparators={[',', '，', '\n']}
                    placeholder="需提交材料，输入后回车"
                    value={draft.requiredMaterials || []}
                    onChange={(value) => dispatch({ type: 'patchDraft', index: draftIndex, patch: { requiredMaterials: value } })}
                  />
                  <div style={{ background: '#f8fafc', borderRadius: 8, padding: 10 }}>
                    <Text type="secondary">任务草稿：相同 groupId 会合并为一个任务；多个 taskDrafts 会拆分为多个任务。</Text>
                    <Space direction="vertical" style={{ width: '100%', marginTop: 10 }} size={8}>
                      {(draft.taskDrafts || []).map((taskDraft, taskIndex) => (
                        <div key={taskDraft.taskDraftId || taskIndex} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 160px 120px', gap: 8 }}>
                          <Input
                            placeholder="groupId"
                            value={taskDraft.groupId || ''}
                            onChange={(event) => dispatch({ type: 'patchTaskDraft', draftIndex, taskIndex, patch: { groupId: event.target.value } })}
                          />
                          <Input
                            placeholder="任务标题"
                            value={taskDraft.title || ''}
                            onChange={(event) => dispatch({ type: 'patchTaskDraft', draftIndex, taskIndex, patch: { title: event.target.value } })}
                          />
                          <Select
                            allowClear
                            placeholder="任务类型"
                            options={TASK_TYPE_OPTIONS}
                            value={taskDraft.taskType || undefined}
                            onChange={(value) => dispatch({ type: 'patchTaskDraft', draftIndex, taskIndex, patch: { taskType: value || null } })}
                          />
                          <Button
                            danger
                            disabled={(draft.taskDrafts || []).length <= 1}
                            onClick={() => dispatch({ type: 'removeTaskDraft', draftIndex, taskIndex })}
                          >
                            移除
                          </Button>
                        </div>
                      ))}
                    </Space>
                  </div>
                </Space>
              </div>
            ))}
          </Space>

          <Space>
            <Button onClick={() => dispatch({ type: 'setField', field: 'step', value: 1, dirty: state.dirty })}>返回预览</Button>
            <Button icon={<SaveOutlined />} loading={state.commitLoading} onClick={() => handleCommit('DRAFT')}>保存任务草稿</Button>
            <Button type="primary" icon={<CheckCircleOutlined />} loading={state.commitLoading} onClick={() => handleCommit('PENDING_APPROVAL')}>提交任务审核</Button>
          </Space>
        </Space>
      )}

      {state.step === 3 && state.result && (
        <div style={{ maxWidth: 760 }}>
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message={`已生成 ${state.result.summary.requirements} 条执行要求、${state.result.summary.tasks} 个${state.result.summary.taskStatus === 'PENDING_APPROVAL' ? '待审核任务' : '任务草稿'}`}
            description={`批次号：${state.result.batchId}`}
            style={{ marginBottom: 16 }}
          />
          <Space>
            <Button type="primary" onClick={goCreatedTasks}>查看新任务</Button>
            <Button onClick={handleReset}>继续生成</Button>
          </Space>
        </div>
      )}
    </div>
  )
}
