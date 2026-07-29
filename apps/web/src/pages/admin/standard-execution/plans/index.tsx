import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Table, Typography, Button, Space, Select, Tag, message,
  Dropdown, Form, Input, InputNumber, DatePicker, Modal, Radio, Progress,
} from 'antd'
import { MoreOutlined } from '@ant-design/icons'
import { useLocation } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  enterpriseMe,
  seListPlans,
  seGetPlan,
  seCreatePlan,
  seUpdatePlan,
  seCancelPlan,
  seBindPlanTasks,
  seUnbindPlanTask,
  seListSourcesEnterprise,
  seListTasksEnterprise,
  seListRequirementsEnterprise,
  seListEnterpriseMembers,
  seGeneratePlanTasks,
  seListComplianceCycleTemplates,
  seCreateComplianceCycleTemplate,
  seStartComplianceCycle,
  seListComplianceCycles,
  seGetComplianceCycle,
  seGenerateComplianceCycleReport,
  STANDARD_TASK_TYPE_VALUES,
  TASK_TYPE_LABEL,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_COLOR,
  TASK_STATUS_LABEL,
  TASK_STATUS_COLOR,
  COMPLIANCE_CYCLE_TYPE_LABEL,
  COMPLIANCE_CYCLE_STATUS_LABEL,
  type Plan,
  type SeTask,
  type Source,
  type Requirement,
  type EnterpriseMember,
  type ComplianceCycleTemplate,
  type ComplianceCycle,
  type ComplianceCycleDetailResp,
  type ComplianceCycleType,
} from '../../../../api/standardExecution'
import { filterSEOption } from '../../../../utils/sePresentation'

const { Text } = Typography

const pageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #cbd5e1',
  borderRadius: 8,
  boxShadow: '0 10px 15px rgba(15, 23, 42, 0.1)',
}

const fieldLabelStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 6,
}

const compactControlStyle: CSSProperties = {
  height: 38,
  borderRadius: 6,
}

const PLAN_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'ACTIVE', label: '进行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
]

const PLAN_STATUS_EDIT_OPTIONS = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'ACTIVE', label: '进行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
]
const PLAN_FREQUENCY_OPTIONS = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'quarterly', label: '每季度' },
  { value: 'yearly', label: '每年' },
]

const CYCLE_TYPE_OPTIONS = Object.entries(COMPLIANCE_CYCLE_TYPE_LABEL).map(([value, label]) => ({ value, label }))
const CYCLE_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  ...Object.entries(COMPLIANCE_CYCLE_STATUS_LABEL).map(([value, label]) => ({ value, label })),
]

const CAN_WRITE_ROLES = ['ADMIN', 'MANAGER', 'REVIEWER']

function formatPlanDate(value?: string | null, withTime = false) {
  if (!value) return '-'
  const parsed = dayjs(value)
  if (!parsed.isValid()) return '-'
  return parsed.format(withTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD')
}

function StatusPill({ status }: { status: string }) {
  return (
    <Tag color={PLAN_STATUS_COLOR[status] || 'default'} style={{ marginInlineEnd: 0, borderRadius: 13, padding: '2px 10px' }}>
      {PLAN_STATUS_LABEL[status] || status}
    </Tag>
  )
}

function InlineAction({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0,
        background: 'transparent',
        color: danger ? '#dc2626' : '#2563eb',
        cursor: 'pointer',
        fontSize: 12,
        padding: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

export default function SePlansPage() {
  const loc = useLocation()
  // 本页恒在 /enterprise 下，isEnterprise 始终 true（遵循约定保留此写法）
  const _isEnterprise = loc.pathname.startsWith('/enterprise')
  void _isEnterprise

  // ─── 权限 ────────────────────────────────────────────
  const [canWrite, setCanWrite] = useState(false)
  useEffect(() => {
    enterpriseMe()
      .then((me) => {
        const role = me.enterpriseRole || ''
        setCanWrite(CAN_WRITE_ROLES.includes(role) || !!me.isAdminBypass)
      })
      .catch(() => {})
  }, [])

  // ─── 列表 ────────────────────────────────────────────
  const [items, setItems] = useState<Plan[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterStatus, setFilterStatus] = useState('')
  const [filterSourceId, setFilterSourceId] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const res = await seListPlans({
        status: filterStatus || undefined,
        page,
        pageSize,
      })
      setItems(res.data ?? [])
      setTotal(res.total ?? 0)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page, filterStatus])

  // ─── 新建 Modal ──────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [activeSources, setActiveSources] = useState<Source[]>([])

  const loadActiveSources = async () => {
    try {
      const res = await seListSourcesEnterprise({ status: 'ACTIVE', pageSize: 200 })
      setActiveSources(res.data ?? [])
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadActiveSources()
  }, [])

  const sourceLabelMap = useMemo(() => {
    const map = new Map<string, string>()
    activeSources.forEach((source) => {
      map.set(source.id, [source.sourceNo, source.title].filter(Boolean).join(' ') || source.title)
    })
    return map
  }, [activeSources])

  const getSourceLabel = (plan: Plan) =>
    sourceLabelMap.get(plan.sourceId) || (plan.sourceId ? `文档 ${plan.sourceId.slice(0, 8)}` : '-')

  const displayItems = useMemo(
    () => filterSourceId ? items.filter((item) => item.sourceId === filterSourceId) : items,
    [filterSourceId, items],
  )

  const openCreate = () => {
    loadActiveSources()
    createForm.resetFields()
    seListEnterpriseMembers().then((res) => setMembers(res.data ?? [])).catch(() => {})
    createForm.setFieldsValue({ roundNumber: 1, defaultDeadlineMode: 'AFTER_APPROVAL_DAYS', defaultDeadlineDaysAfterApproval: 7 })
    setCreateOpen(true)
  }

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      const body: Parameters<typeof seCreatePlan>[0] = {
        sourceId: values.sourceId,
        title: values.title,
        roundNumber: values.roundNumber ?? 1,
        frequency: values.frequency || null,
        defaultReviewerId: values.defaultReviewerId || null,
        defaultAssigneeIds: values.defaultAssigneeIds || [],
        defaultTaskType: values.defaultTaskType || null,
        defaultDeadlineMode: values.defaultDeadlineMode || 'AFTER_APPROVAL_DAYS',
        defaultDeadlineDaysAfterApproval: values.defaultDeadlineDaysAfterApproval ?? 7,
      }
      if (values.scheduledAt) {
        body.scheduledAt = (values.scheduledAt as dayjs.Dayjs).toISOString()
      }
      if (values.startAt) body.startAt = (values.startAt as dayjs.Dayjs).toISOString()
      if (values.endAt) body.endAt = (values.endAt as dayjs.Dayjs).toISOString()
      if (values.nextRunAt) body.nextRunAt = (values.nextRunAt as dayjs.Dayjs).toISOString()
      await seCreatePlan(body)
      message.success('已创建')
      setCreateOpen(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  // ─── 详情 / 编辑 ─────────────────────────────────────
  const [detailPlan, setDetailPlan] = useState<Plan | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editForm] = Form.useForm()

  // 绑定任务 Modal
  const [bindOpen, setBindOpen] = useState(false)
  const [allTasks, setAllTasks] = useState<SeTask[]>([])
  const [bindSelectedKeys, setBindSelectedKeys] = useState<string[]>([])
  const [bindLoading, setBindLoading] = useState(false)

  // 发起本轮执行 Modal
  const [genOpen, setGenOpen] = useState(false)
  const [genForm] = Form.useForm()
  const [genReqs, setGenReqs] = useState<Requirement[]>([])
  const [members, setMembers] = useState<EnterpriseMember[]>([])
  const [genLoading, setGenLoading] = useState(false)
  const [cycleTemplates, setCycleTemplates] = useState<ComplianceCycleTemplate[]>([])
  const [cycles, setCycles] = useState<ComplianceCycle[]>([])
  const [cycleDetail, setCycleDetail] = useState<ComplianceCycleDetailResp | null>(null)
  const [cycleLoading, setCycleLoading] = useState(false)
  const [cycleStatus, setCycleStatus] = useState('')
  const [cycleTemplateOpen, setCycleTemplateOpen] = useState(false)
  const [cycleTemplateForm] = Form.useForm()
  const [cycleTemplateRequirements, setCycleTemplateRequirements] = useState<Requirement[]>([])
  const [startCycleOpen, setStartCycleOpen] = useState(false)
  const [startCycleTemplate, setStartCycleTemplate] = useState<ComplianceCycleTemplate | null>(null)
  const [startCycleForm] = Form.useForm()
  const [cycleActionLoading, setCycleActionLoading] = useState(false)
  // 列表批量
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [batchLoading, setBatchLoading] = useState(false)

  const loadCycleTemplates = async () => {
    try {
      const res = await seListComplianceCycleTemplates({ status: 'ACTIVE', pageSize: 100 })
      setCycleTemplates(res.data ?? [])
    } catch {
      message.error('加载周期模板失败')
    }
  }

  const loadCycles = async () => {
    setCycleLoading(true)
    try {
      const res = await seListComplianceCycles({ status: cycleStatus || undefined, pageSize: 100 })
      setCycles(res.data ?? [])
      const first = res.data?.[0]
      if (first) {
        const detail = await seGetComplianceCycle(first.id)
        setCycleDetail(detail)
      } else {
        setCycleDetail(null)
      }
    } catch {
      message.error('加载合规周期失败')
    } finally {
      setCycleLoading(false)
    }
  }

  useEffect(() => {
    loadCycleTemplates()
  }, [])

  useEffect(() => {
    loadCycles()
  }, [cycleStatus])

  const openCycleTemplate = async () => {
    setCycleTemplateOpen(true)
    cycleTemplateForm.resetFields()
    cycleTemplateForm.setFieldsValue({
      cycleType: 'QUARTERLY',
      taskStatus: 'DRAFT',
      deadlineMode: 'AFTER_APPROVAL_DAYS',
      deadlineDaysAfterApproval: 7,
    })
    try {
      const [reqRes, memberRes] = await Promise.all([
        seListRequirementsEnterprise({ status: 'ACTIVE', pageSize: 500 }),
        seListEnterpriseMembers(),
      ])
      setCycleTemplateRequirements(reqRes.data ?? [])
      setMembers(memberRes.data ?? [])
    } catch {
      message.error('加载控制点/成员失败')
    }
  }

  const handleCreateCycleTemplate = async () => {
    try {
      const values = await cycleTemplateForm.validateFields()
      setCycleActionLoading(true)
      await seCreateComplianceCycleTemplate({
        title: values.title,
        cycleType: values.cycleType,
        requirementIds: values.requirementIds,
        taskConfig: {
          reviewerId: values.reviewerId || null,
          assigneeIds: values.assigneeIds || [],
          taskType: values.taskType || null,
          taskStatus: values.taskStatus || 'DRAFT',
          deadlineMode: values.deadlineMode || 'AFTER_APPROVAL_DAYS',
          deadlineDaysAfterApproval: values.deadlineDaysAfterApproval ?? 7,
        },
      })
      message.success('已创建周期模板')
      setCycleTemplateOpen(false)
      loadCycleTemplates()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    } finally {
      setCycleActionLoading(false)
    }
  }

  const openStartCycle = async (template: ComplianceCycleTemplate) => {
    setStartCycleTemplate(template)
    setStartCycleOpen(true)
    const config = template.taskConfig || {}
    startCycleForm.resetFields()
    startCycleForm.setFieldsValue({
      title: `${template.title} ${dayjs().format('YYYY-MM')}`,
      startDate: dayjs().startOf('day'),
      endDate: dayjs().add(template.cycleType === 'ANNUAL' ? 1 : template.cycleType === 'QUARTERLY' ? 3 : 1, 'month').subtract(1, 'day').endOf('day'),
      reviewerId: config.reviewerId || undefined,
      assigneeIds: config.assigneeIds || [],
      taskType: config.taskType || undefined,
      taskStatus: config.taskStatus || 'DRAFT',
      deadlineMode: config.deadlineMode || 'AFTER_APPROVAL_DAYS',
      deadlineDaysAfterApproval: config.deadlineDaysAfterApproval ?? 7,
    })
    seListEnterpriseMembers().then((res) => setMembers(res.data ?? [])).catch(() => {})
  }

  const handleStartCycle = async () => {
    if (!startCycleTemplate) return
    try {
      const values = await startCycleForm.validateFields()
      setCycleActionLoading(true)
      const res = await seStartComplianceCycle(startCycleTemplate.id, {
        title: values.title,
        startDate: (values.startDate as dayjs.Dayjs).toISOString(),
        endDate: (values.endDate as dayjs.Dayjs).toISOString(),
        reviewerId: values.reviewerId,
        assigneeIds: values.assigneeIds || [],
        taskType: values.taskType || null,
        taskStatus: values.taskStatus || 'DRAFT',
        deadlineMode: values.deadlineMode || 'AFTER_APPROVAL_DAYS',
        deadlineDaysAfterApproval: values.deadlineDaysAfterApproval ?? 7,
      })
      message.success(`已启动周期，生成 ${res.createdTasks} 个任务 / ${res.createdItems} 个控制点项`)
      setStartCycleOpen(false)
      loadCycles()
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '启动周期失败')
    } finally {
      setCycleActionLoading(false)
    }
  }

  const openCycleDetail = async (cycle: ComplianceCycle) => {
    setCycleLoading(true)
    try {
      const detail = await seGetComplianceCycle(cycle.id)
      setCycleDetail(detail)
    } catch {
      message.error('加载周期概览失败')
    } finally {
      setCycleLoading(false)
    }
  }

  const handleGenerateCycleReport = async () => {
    if (!cycleDetail?.data) return
    setCycleActionLoading(true)
    try {
      const res = await seGenerateComplianceCycleReport(cycleDetail.data.id)
      message.success('周期报告已生成')
      setCycleDetail({ ...cycleDetail, data: res.data })
      if (res.fileUrl) window.open(res.fileUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '生成报告失败')
    } finally {
      setCycleActionLoading(false)
    }
  }

  const loadDetail = async (id: string) => {
    setDetailLoading(true)
    try {
      const res = await seGetPlan(id)
      setDetailPlan(res.data)
    } catch {
      message.error('加载详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const openDetail = (plan: Plan) => {
    setEditMode(false)
    setDetailPlan(plan)
    loadDetail(plan.id)
  }

  const openEdit = (plan: Plan) => {
    openDetail(plan)
    seListEnterpriseMembers().then((res) => setMembers(res.data ?? [])).catch(() => {})
    editForm.setFieldsValue({
      title: plan.title,
      roundNumber: plan.roundNumber,
      status: plan.status,
      scheduledAt: plan.scheduledAt ? dayjs(plan.scheduledAt) : null,
      frequency: plan.frequency || undefined,
      startAt: plan.startAt ? dayjs(plan.startAt) : null,
      endAt: plan.endAt ? dayjs(plan.endAt) : null,
      nextRunAt: plan.nextRunAt ? dayjs(plan.nextRunAt) : null,
      defaultReviewerId: plan.defaultReviewerId || undefined,
      defaultAssigneeIds: plan.defaultAssigneeIds || [],
      defaultTaskType: plan.defaultTaskType || undefined,
      defaultDeadlineMode: plan.defaultDeadlineMode || 'AFTER_APPROVAL_DAYS',
      defaultDeadlineDaysAfterApproval: plan.defaultDeadlineDaysAfterApproval ?? 7,
    })
    setEditMode(true)
  }

  useEffect(() => {
    const first = displayItems[0]
    if (!first) {
      setDetailPlan(null)
      return
    }
    if (!detailPlan || !displayItems.some((item) => item.id === detailPlan.id)) {
      setEditMode(false)
      setDetailPlan(first)
      loadDetail(first.id)
    }
  }, [displayItems])

  const handleEditSave = async () => {
    if (!detailPlan) return
    try {
      const values = await editForm.validateFields()
      const body: Parameters<typeof seUpdatePlan>[1] = {
        title: values.title,
        roundNumber: values.roundNumber,
        status: values.status,
        scheduledAt: values.scheduledAt ? (values.scheduledAt as dayjs.Dayjs).toISOString() : null,
        frequency: values.frequency || null,
        startAt: values.startAt ? (values.startAt as dayjs.Dayjs).toISOString() : null,
        endAt: values.endAt ? (values.endAt as dayjs.Dayjs).toISOString() : null,
        nextRunAt: values.nextRunAt ? (values.nextRunAt as dayjs.Dayjs).toISOString() : null,
        defaultReviewerId: values.defaultReviewerId || null,
        defaultAssigneeIds: values.defaultAssigneeIds || [],
        defaultTaskType: values.defaultTaskType || null,
        defaultDeadlineMode: values.defaultDeadlineMode || 'AFTER_APPROVAL_DAYS',
        defaultDeadlineDaysAfterApproval: values.defaultDeadlineDaysAfterApproval ?? 7,
      }
      await seUpdatePlan(detailPlan.id, body)
      message.success('已更新')
      setEditMode(false)
      loadDetail(detailPlan.id)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const handleUnbind = async (taskId: string) => {
    if (!detailPlan) return
    try {
      await seUnbindPlanTask(detailPlan.id, taskId)
      message.success('已解绑')
      loadDetail(detailPlan.id)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '操作失败')
    }
  }

  const openBind = async () => {
    if (!detailPlan) return
    setBindSelectedKeys([])
    setBindLoading(true)
    try {
      // 拉取全部任务（pageSize 200），前端过滤掉 CANCELLED
      const res = await seListTasksEnterprise({ pageSize: 200 })
      setAllTasks(res.data.filter((t) => t.status !== 'CANCELLED'))
    } catch {
      message.error('加载任务失败')
    } finally {
      setBindLoading(false)
    }
    setBindOpen(true)
  }

  const handleBindConfirm = async () => {
    if (!detailPlan || bindSelectedKeys.length === 0) {
      message.warning('请先选择要绑定的任务')
      return
    }
    try {
      const res = await seBindPlanTasks(detailPlan.id, bindSelectedKeys)
      message.success(`已绑定 ${res.bound} 个任务`)
      setBindOpen(false)
      loadDetail(detailPlan.id)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '操作失败')
    }
  }

  // ─── 发起本轮执行 ─────────────────────────────────────
  const openGenerate = async (planArg?: Plan) => {
    const targetPlan = planArg || detailPlan
    if (!targetPlan) return
    setDetailPlan(targetPlan)
    genForm.resetFields()
    genForm.setFieldsValue({
      taskType: targetPlan.defaultTaskType || 'INSPECTION_FILL',
      taskStatus: 'DRAFT',
      reviewerId: targetPlan.defaultReviewerId || undefined,
      assigneeIds: targetPlan.defaultAssigneeIds || [],
      deadlineAt: dayjs().add(targetPlan.defaultDeadlineDaysAfterApproval ?? 7, 'day').hour(18).minute(0).second(0),
    })
    try {
      const [reqRes, memRes] = await Promise.all([
        seListRequirementsEnterprise({ sourceId: targetPlan.sourceId, status: 'ACTIVE', pageSize: 500 }),
        seListEnterpriseMembers(),
      ])
      setGenReqs(reqRes.data)
      setMembers(memRes.data)
    } catch { message.error('加载生成内容/成员失败') }
    setGenOpen(true)
  }

  const handleGenerate = async () => {
    if (!detailPlan) return
    try {
      const values = await genForm.validateFields()
      if (genReqs.length === 0) {
        message.warning('该合规周期标准文档下暂无可生成任务的内容')
        return
      }
      setGenLoading(true)
      const res = await seGeneratePlanTasks(detailPlan.id, {
        requirementIds: genReqs.map((item) => item.id),
        taskType: values.taskType,
        taskStatus: values.taskStatus,
        reviewerId: values.reviewerId,
        assigneeIds: values.assigneeIds,
        deadlineAt: detailPlan.defaultDeadlineMode === 'AFTER_APPROVAL_DAYS'
          ? undefined
          : values.deadlineAt ? (values.deadlineAt as dayjs.Dayjs).toISOString() : undefined,
        deadlineMode: detailPlan.defaultDeadlineMode || 'FIXED',
        deadlineDaysAfterApproval: detailPlan.defaultDeadlineMode === 'AFTER_APPROVAL_DAYS'
          ? detailPlan.defaultDeadlineDaysAfterApproval ?? 7
          : null,
      })
      const taskLabel = res.taskStatus === 'PENDING_APPROVAL' ? '待审核任务' : '任务草稿'
      message.success(`已生成 ${res.createdTasks} 个${taskLabel} / ${res.createdItems} 个任务填写项${res.skippedExisting ? `，已跳过 ${res.skippedExisting} 条已生成内容` : ''}`)
      setGenOpen(false)
      loadDetail(detailPlan.id)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    } finally { setGenLoading(false) }
  }

  // ─── 批量取消 ─────────────────────────────────────────
  const handleBatchCancel = async () => {
    setBatchLoading(true)
    let ok = 0
    const ids = selectedKeys
    for (const id of ids) {
      try { await seCancelPlan(id); ok++ } catch { /* skip */ }
    }
    setBatchLoading(false)
    message.success(`已取消 ${ok} / 共 ${ids.length} 个`)
    setSelectedKeys([])
    load()
  }

  // ─── 取消计划 ─────────────────────────────────────────
  const handleCancel = (plan: Plan) => {
    Modal.confirm({
      title: '取消周期',
      content: `确认取消「${plan.title}」？`,
      okType: 'danger',
      onOk: async () => {
        try {
          await seCancelPlan(plan.id)
          message.success('已取消')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  const selectedPlan = detailPlan || displayItems[0] || null

  return (
    <div data-testid="enterprise-plans-page" style={pageStyle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', gap: 16, marginBottom: 18 }}>
        <section style={{ ...cardStyle, boxShadow: 'none', padding: 18 }}>
          <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }} align="center">
            <div>
              <div style={{ color: '#0f172a', fontSize: 16, fontWeight: 700 }}>周期模板</div>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>按控制点集合沉淀年度、季度、月度复查模板。</div>
            </div>
            {canWrite && <Button type="primary" onClick={openCycleTemplate}>新建模板</Button>}
          </Space>
          <Table<ComplianceCycleTemplate>
            size="small"
            rowKey="id"
            dataSource={cycleTemplates}
            pagination={false}
            scroll={{ x: 620 }}
            locale={{ emptyText: <div style={{ color: '#94a3b8', padding: '14px 0' }}>暂无周期模板</div> }}
            columns={[
              { title: '模板', dataIndex: 'title', ellipsis: true },
              { title: '类型', dataIndex: 'cycleType', width: 76, render: (v: ComplianceCycleType) => COMPLIANCE_CYCLE_TYPE_LABEL[v] },
              { title: '控制点', dataIndex: 'requirementIds', width: 72, render: (ids: string[]) => ids.length },
              {
                title: '操作',
                width: 90,
                render: (_: unknown, row) => canWrite ? <InlineAction label="启动" onClick={() => openStartCycle(row)} /> : null,
              },
            ]}
          />
        </section>

        <section style={{ ...cardStyle, boxShadow: 'none', padding: 18 }}>
          <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }} align="center">
            <div>
              <div style={{ color: '#0f172a', fontSize: 16, fontWeight: 700 }}>本周期概览</div>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>{cycleDetail?.data.title || '选择周期查看进度'}</div>
            </div>
            <Select
              size="small"
              options={CYCLE_STATUS_OPTIONS}
              value={cycleStatus}
              onChange={setCycleStatus}
              style={{ width: 104 }}
            />
          </Space>
          {cycleDetail ? (
            <>
              <Progress percent={cycleDetail.stats.progressPercent} size="small" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, margin: '12px 0' }}>
                <div style={{ background: '#f8fafc', borderRadius: 6, padding: 10 }}>
                  <div style={{ color: '#64748b', fontSize: 12 }}>已覆盖</div>
                  <div style={{ color: '#0f172a', fontWeight: 700 }}>{cycleDetail.stats.coveredRequirements}/{cycleDetail.stats.totalRequirements}</div>
                </div>
                <div style={{ background: '#f8fafc', borderRadius: 6, padding: 10 }}>
                  <div style={{ color: '#64748b', fontSize: 12 }}>任务</div>
                  <div style={{ color: '#0f172a', fontWeight: 700 }}>{cycleDetail.stats.completedTasks}/{cycleDetail.stats.totalTasks}</div>
                </div>
                <div style={{ background: '#f8fafc', borderRadius: 6, padding: 10 }}>
                  <div style={{ color: '#64748b', fontSize: 12 }}>逾期</div>
                  <div style={{ color: cycleDetail.stats.overdueTasks > 0 ? '#dc2626' : '#0f172a', fontWeight: 700 }}>{cycleDetail.stats.overdueTasks}</div>
                </div>
              </div>
              <Space style={{ marginBottom: 10 }}>
                <Tag>{COMPLIANCE_CYCLE_STATUS_LABEL[cycleDetail.data.status]}</Tag>
                <Tag>{formatPlanDate(cycleDetail.data.startDate)} ~ {formatPlanDate(cycleDetail.data.endDate)}</Tag>
              </Space>
              <Table<ComplianceCycle>
                size="small"
                rowKey="id"
                loading={cycleLoading}
                dataSource={cycles}
                pagination={false}
                onRow={(row) => ({
                  onClick: () => openCycleDetail(row),
                  style: { cursor: 'pointer', background: cycleDetail.data.id === row.id ? '#f8fbff' : undefined },
                })}
                columns={[
                  { title: '周期', dataIndex: 'title', ellipsis: true },
                  { title: '状态', dataIndex: 'status', width: 80, render: (v: ComplianceCycle['status']) => COMPLIANCE_CYCLE_STATUS_LABEL[v] },
                ]}
              />
              {canWrite && (
                <Button
                  block
                  style={{ marginTop: 12 }}
                  loading={cycleActionLoading}
                  onClick={handleGenerateCycleReport}
                >
                  生成周期合规报告
                </Button>
              )}
            </>
          ) : (
            <div style={{ color: '#94a3b8', padding: '36px 0', textAlign: 'center' }}>暂无已启动周期</div>
          )}
        </section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 720px) 356px', gap: 24, alignItems: 'start' }}>
        <section style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'block' }}>
                <div style={fieldLabelStyle}>标准文档</div>
                <Select
                  value={filterSourceId}
                  onChange={(value) => { setPage(1); setFilterSourceId(value) }}
                  style={{ width: 220 }}
                  popupMatchSelectWidth={260}
                  showSearch
                  optionFilterProp="label"
                  filterOption={filterSEOption}
                  options={[
                    { value: '', label: '全部' },
                    ...activeSources.map((source) => ({ value: source.id, label: sourceLabelMap.get(source.id) || source.title })),
                  ]}
                />
              </label>
              <label style={{ display: 'block' }}>
                <div style={fieldLabelStyle}>状态</div>
                <Select
                  options={PLAN_STATUS_OPTIONS}
                  value={filterStatus}
                  onChange={(value) => { setPage(1); setFilterStatus(value) }}
                  style={{ width: 140 }}
                />
              </label>
            </div>
            {canWrite && (
              <Button type="primary" style={{ ...compactControlStyle, width: 112 }} onClick={openCreate}>
                新建周期
              </Button>
            )}
          </div>

          {selectedKeys.length > 0 && (
            <Space
              style={{
                marginBottom: 12,
                padding: '8px 16px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: 6,
                width: '100%',
                justifyContent: 'space-between',
              }}
              wrap
            >
              <span style={{ color: '#2563eb', fontWeight: 600 }}>已选 {selectedKeys.length} 个合规周期</span>
              <Space size={8}>
                <Button size="small" danger loading={batchLoading} onClick={handleBatchCancel}>批量取消</Button>
                <Button size="small" onClick={() => setSelectedKeys([])}>取消选择</Button>
              </Space>
            </Space>
          )}

          <div style={{ ...cardStyle, borderColor: '#e2e8f0', boxShadow: 'none', overflow: 'hidden' }}>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={displayItems}
              rowSelection={canWrite ? {
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys as string[]),
                getCheckboxProps: (row: Plan) => ({ disabled: row.status === 'CANCELLED' }),
              } : undefined}
              pagination={{
                current: page,
                total: filterSourceId ? displayItems.length : total,
                pageSize,
                onChange: setPage,
                showSizeChanger: false,
              }}
              onRow={(row) => ({
                onClick: () => openDetail(row),
                style: {
                  cursor: 'pointer',
                  background: selectedPlan?.id === row.id ? '#f8fbff' : undefined,
                },
              })}
              locale={{ emptyText: <div style={{ padding: '24px 0', color: '#8a93a3' }}>还没有合规周期，可通过右上「新建周期」创建。</div> }}
              scroll={{ x: 720 }}
              columns={[
                { title: '周期名称', dataIndex: 'title', width: 172, ellipsis: true },
                {
                  title: '标准文档',
                  dataIndex: 'sourceId',
                  width: 122,
                  ellipsis: true,
                  render: (_: string, row: Plan) => getSourceLabel(row),
                },
                {
                  title: '轮次',
                  dataIndex: 'roundNumber',
                  width: 72,
                  render: (value: number) => `第 ${value || 1} 轮`,
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 82,
                  render: (value: string) => <StatusPill status={value} />,
                },
                {
                  title: '任务数',
                  width: 62,
                  render: (_: unknown, row: Plan) => row.tasks?.length ?? (selectedPlan?.id === row.id ? detailPlan?.tasks?.length ?? 0 : 0),
                },
                {
                  title: '操作',
                  width: 160,
                  render: (_: unknown, row: Plan) => (
                    <Space size={10} onClick={(event) => event.stopPropagation()}>
                      <InlineAction label="详情" onClick={() => openDetail(row)} />
                      {canWrite && row.status !== 'CANCELLED' && (
                        <InlineAction
                          label={row.status === 'DRAFT' ? '编辑' : '发起执行'}
                          onClick={() => {
                            if (row.status === 'DRAFT') openEdit(row)
                            else openGenerate(row)
                          }}
                        />
                      )}
                      {canWrite && row.status !== 'CANCELLED' && (
                        <Dropdown
                          trigger={['click']}
                          menu={{
                            items: [{ key: 'cancel', danger: true, label: '取消周期' }],
                            onClick: ({ key }) => {
                              if (key === 'cancel') handleCancel(row)
                            },
                          }}
                        >
                          <Button
                            size="small"
                            type="text"
                            icon={<MoreOutlined />}
                            onClick={(event) => event.stopPropagation()}
                            style={{ width: 24, height: 24 }}
                          />
                        </Dropdown>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        </section>

        <aside
          data-testid="execution-plan-detail-panel"
          style={{
            ...cardStyle,
            minHeight: 560,
            padding: 24,
            position: 'relative',
          }}
        >
          {selectedPlan ? (
            <>
              <div style={{ color: '#0f172a', fontSize: 18, fontWeight: 700, lineHeight: '24px', marginBottom: 16 }}>
                {selectedPlan.title}
              </div>
              <div style={{ marginBottom: 24 }}>
                <StatusPill status={selectedPlan.status} />
              </div>
              <div style={{ color: '#475569', fontSize: 13, lineHeight: '22px', marginBottom: 32 }}>
                <div>标准文档：{getSourceLabel(selectedPlan)}</div>
                <div>轮次：第 {selectedPlan.roundNumber || 1} 轮</div>
                <div>周期时间：{formatPlanDate(selectedPlan.scheduledAt, true)}</div>
                <div>已绑定任务：{detailPlan?.id === selectedPlan.id ? detailPlan.tasks?.length ?? 0 : selectedPlan.tasks?.length ?? 0} 个</div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <Text style={{ color: '#64748b', fontSize: 13, fontWeight: 600 }}>绑定任务</Text>
                {canWrite && detailPlan?.id === selectedPlan.id && (
                  <InlineAction label="绑定任务" onClick={openBind} />
                )}
              </div>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                <Table
                  size="small"
                  rowKey="id"
                  loading={detailLoading}
                  pagination={false}
                  dataSource={detailPlan?.id === selectedPlan.id ? detailPlan.tasks || [] : []}
                  locale={{ emptyText: <div style={{ padding: '18px 0', color: '#94a3b8' }}>暂无绑定任务</div> }}
                  columns={[
                    { title: '任务', dataIndex: 'title', ellipsis: true },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 86,
                      render: (value: string) => (
                        <Tag color={TASK_STATUS_COLOR[value] || 'default'} style={{ marginInlineEnd: 0 }}>
                          {TASK_STATUS_LABEL[value] || value}
                        </Tag>
                      ),
                    },
                    canWrite ? {
                      title: '操作',
                      width: 64,
                      render: (_: unknown, task: SeTask) => (
                        <InlineAction danger label="解绑" onClick={() => handleUnbind(task.id)} />
                      ),
                    } : {},
                  ].filter((column) => Object.keys(column).length > 0)}
                />
              </div>

              {canWrite && selectedPlan.status !== 'CANCELLED' && (
                <Space size={16} style={{ position: 'absolute', right: 24, bottom: 24 }}>
                  <InlineAction
                    label="编辑"
                    onClick={() => openEdit(selectedPlan)}
                  />
                  <Button type="primary" style={{ ...compactControlStyle, width: 112 }} onClick={() => openGenerate(selectedPlan)}>
                    发起本轮执行
                  </Button>
                </Space>
              )}
            </>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 13, lineHeight: '22px', paddingTop: 210, textAlign: 'center' }}>
              选择左侧合规周期后查看详情。
            </div>
          )}
        </aside>
      </div>

      <Modal
        title="新建周期模板"
        open={cycleTemplateOpen}
        onCancel={() => setCycleTemplateOpen(false)}
        onOk={handleCreateCycleTemplate}
        confirmLoading={cycleActionLoading}
        okText="保存模板"
        width={720}
        destroyOnHidden
      >
        <Form form={cycleTemplateForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12 }}>
            <Form.Item name="title" label="模板名称" rules={[{ required: true, message: '必填' }]}>
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="cycleType" label="周期类型" rules={[{ required: true, message: '必填' }]}>
              <Select options={CYCLE_TYPE_OPTIONS} />
            </Form.Item>
          </div>
          <Form.Item name="requirementIds" label="控制点集合" rules={[{ required: true, message: '至少选择 1 个控制点' }]}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              filterOption={filterSEOption}
              placeholder="选择本企业 ACTIVE 控制点"
              options={cycleTemplateRequirements.map((req) => ({
                value: req.id,
                label: `${req.clauseNo ? req.clauseNo + ' ' : ''}${req.title}`,
              }))}
            />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="taskType" label="默认任务类型">
              <Select allowClear options={STANDARD_TASK_TYPE_VALUES.map((v) => ({ value: v, label: TASK_TYPE_LABEL[v] }))} />
            </Form.Item>
            <Form.Item name="taskStatus" label="生成状态">
              <Select options={[
                { value: 'DRAFT', label: '任务草稿' },
                { value: 'PENDING_APPROVAL', label: '直接提交审核' },
              ]} />
            </Form.Item>
            <Form.Item name="reviewerId" label="默认审核人" rules={[{ required: true, message: '启动周期需要审核人' }]}>
              <Select showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
            </Form.Item>
            <Form.Item name="assigneeIds" label="默认执行人" rules={[{ required: true, message: '至少选择 1 个执行人' }]}>
              <Select mode="multiple" showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
            </Form.Item>
            <Form.Item name="deadlineMode" label="默认截止方式">
              <Select options={[
                { value: 'FIXED', label: '周期结束日' },
                { value: 'AFTER_APPROVAL_DAYS', label: '审核通过后 N 天内完成' },
              ]} />
            </Form.Item>
            <Form.Item name="deadlineDaysAfterApproval" label="审核通过后完成天数">
              <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <Modal
        title={startCycleTemplate ? `启动周期：${startCycleTemplate.title}` : '启动周期'}
        open={startCycleOpen}
        onCancel={() => setStartCycleOpen(false)}
        onOk={handleStartCycle}
        confirmLoading={cycleActionLoading}
        okText="启动并生成任务"
        width={680}
        destroyOnHidden
      >
        <Form form={startCycleForm} layout="vertical">
          <Form.Item name="title" label="周期名称" rules={[{ required: true, message: '必填' }]}>
            <Input maxLength={200} />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="startDate" label="开始日期" rules={[{ required: true, message: '必填' }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="endDate" label="结束日期" rules={[{ required: true, message: '必填' }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="reviewerId" label="审核人" rules={[{ required: true, message: '必填' }]}>
              <Select showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
            </Form.Item>
            <Form.Item name="assigneeIds" label="执行人" rules={[{ required: true, message: '至少选择 1 个执行人' }]}>
              <Select mode="multiple" showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
            </Form.Item>
            <Form.Item name="taskType" label="任务类型">
              <Select allowClear options={STANDARD_TASK_TYPE_VALUES.map((v) => ({ value: v, label: TASK_TYPE_LABEL[v] }))} />
            </Form.Item>
            <Form.Item name="taskStatus" label="生成状态">
              <Select options={[
                { value: 'DRAFT', label: '任务草稿' },
                { value: 'PENDING_APPROVAL', label: '直接提交审核' },
              ]} />
            </Form.Item>
            <Form.Item name="deadlineMode" label="截止方式">
              <Select options={[
                { value: 'FIXED', label: '周期结束日' },
                { value: 'AFTER_APPROVAL_DAYS', label: '审核通过后 N 天内完成' },
              ]} />
            </Form.Item>
            <Form.Item name="deadlineDaysAfterApproval" label="审核通过后完成天数">
              <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      {/* 新建 Modal */}
      <Modal
        title="新建周期"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        okText="创建"
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="sourceId" label="标准文档" rules={[{ required: true, message: '必填' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              filterOption={filterSEOption}
              placeholder="选择已启用文档"
              options={activeSources.map((s) => ({
                value: s.id,
                label: `${s.sourceNo ? s.sourceNo + ' ' : ''}${s.title}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="title" label="周期名称" rules={[{ required: true, message: '必填' }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="roundNumber" label="轮次" initialValue={1}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="scheduledAt" label="周期时间（可选）">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="frequency" label="周期频率">
            <Select allowClear options={PLAN_FREQUENCY_OPTIONS} placeholder="不设置则仅手动触发" />
          </Form.Item>
          <Form.Item name="startAt" label="周期开始时间">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="endAt" label="周期结束时间">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="nextRunAt" label="下次周期运行时间">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="defaultTaskType" label="默认任务类型">
            <Select allowClear options={STANDARD_TASK_TYPE_VALUES.map((v) => ({ value: v, label: TASK_TYPE_LABEL[v] }))} />
          </Form.Item>
          <Form.Item name="defaultReviewerId" label="默认审核人">
            <Select allowClear showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
          </Form.Item>
          <Form.Item name="defaultAssigneeIds" label="默认执行人">
            <Select mode="multiple" showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
          </Form.Item>
          <Form.Item name="defaultDeadlineMode" label="默认截止方式">
            <Select options={[
              { value: 'FIXED', label: '使用弹窗固定截止时间' },
              { value: 'AFTER_APPROVAL_DAYS', label: '审核通过后 N 天内完成' },
            ]} />
          </Form.Item>
          <Form.Item name="defaultDeadlineDaysAfterApproval" label="默认审核通过后完成天数">
            <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑 Modal */}
      <Modal
        title="编辑周期"
        open={editMode}
        onCancel={() => setEditMode(false)}
        onOk={handleEditSave}
        okText="保存"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="title" label="周期名称" rules={[{ required: true, message: '必填' }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="roundNumber" label="轮次">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="scheduledAt" label="周期时间">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="frequency" label="周期频率">
            <Select allowClear options={PLAN_FREQUENCY_OPTIONS} />
          </Form.Item>
          <Form.Item name="startAt" label="周期开始时间">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="endAt" label="周期结束时间">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="nextRunAt" label="下次周期运行时间">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="defaultTaskType" label="默认任务类型">
            <Select allowClear options={STANDARD_TASK_TYPE_VALUES.map((v) => ({ value: v, label: TASK_TYPE_LABEL[v] }))} />
          </Form.Item>
          <Form.Item name="defaultReviewerId" label="默认审核人">
            <Select allowClear showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
          </Form.Item>
          <Form.Item name="defaultAssigneeIds" label="默认执行人">
            <Select mode="multiple" showSearch optionFilterProp="label" filterOption={filterSEOption} options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
          </Form.Item>
          <Form.Item name="defaultDeadlineMode" label="默认截止方式">
            <Select options={[
              { value: 'FIXED', label: '使用弹窗固定截止时间' },
              { value: 'AFTER_APPROVAL_DAYS', label: '审核通过后 N 天内完成' },
            ]} />
          </Form.Item>
          <Form.Item name="defaultDeadlineDaysAfterApproval" label="默认审核通过后完成天数">
            <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={PLAN_STATUS_EDIT_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 绑定任务 Modal */}
      <Modal
        title="选择要绑定的任务"
        open={bindOpen}
        onCancel={() => setBindOpen(false)}
        onOk={handleBindConfirm}
        okText="确认绑定"
        width={680}
        loading={bindLoading}
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={allTasks}
          loading={bindLoading}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          rowSelection={{
            selectedRowKeys: bindSelectedKeys,
            onChange: (keys) => setBindSelectedKeys(keys as string[]),
          }}
          columns={[
            { title: '任务标题', dataIndex: 'title', ellipsis: true },
            {
              title: '状态', dataIndex: 'status', width: 90,
              render: (v: string) => (
                <Tag color={TASK_STATUS_COLOR[v] || 'default'}>
                  {TASK_STATUS_LABEL[v] || v}
                </Tag>
              ),
            },
          ]}
        />
      </Modal>

      {/* 发起本轮执行 Modal */}
      <Modal
        title="发起本轮执行"
        open={genOpen}
        onCancel={() => setGenOpen(false)}
        onOk={handleGenerate}
        confirmLoading={genLoading}
        okText="生成任务草稿"
        width={640}
        destroyOnHidden
      >
        <Form form={genForm} layout="vertical">
          <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, marginBottom: 16, color: '#64748b' }}>
            本轮将基于该合规周期标准文档下的 {genReqs.length} 条已启用生成内容创建执行任务。
          </div>
          <Form.Item name="taskType" label="任务类型" rules={[{ required: true, message: '必填' }]}>
            <Select options={STANDARD_TASK_TYPE_VALUES.map((v) => ({ value: v, label: TASK_TYPE_LABEL[v] }))} />
          </Form.Item>
	          <Form.Item name="taskStatus" label="生成方式" rules={[{ required: true, message: '必填' }]}>
	            <Radio.Group>
	              <Radio.Button value="DRAFT">保存任务草稿</Radio.Button>
	              <Radio.Button value="PENDING_APPROVAL">提交任务审核</Radio.Button>
	            </Radio.Group>
	          </Form.Item>
          <Form.Item name="reviewerId" label="审核人" rules={[{ required: true, message: '必填' }]}>
            <Select showSearch optionFilterProp="label" placeholder="搜索手机号/昵称"
              filterOption={filterSEOption}
              options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
          </Form.Item>
          <Form.Item name="assigneeIds" label="执行人（每人各生成一个独立任务）" rules={[{ required: true, message: '必填' }]}>
            <Select mode="multiple" showSearch optionFilterProp="label" placeholder="搜索手机号/昵称，可多选"
              filterOption={filterSEOption}
              options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))} />
          </Form.Item>
          <Form.Item name="deadlineAt" label="截止时间（可选）">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
