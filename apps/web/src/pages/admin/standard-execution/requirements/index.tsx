import { useEffect, useState, useContext } from 'react'
import { Table, Typography, Button, Space, Select, Input, Tag, message, Drawer, Form, Modal, DatePicker, Popconfirm, Tabs, Alert, Divider } from 'antd'
import { ReloadOutlined, PlusOutlined, ThunderboltOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { SEPageContext } from '../../../../contexts/SEPageContext'
import dayjs from 'dayjs'
import {
  seListRequirements,
  seListRequirementsEnterprise,
  seCreateRequirement,
  seCreateRequirementEnterprise,
  seUpdateRequirement,
  seUpdateRequirementEnterprise,
  seActivateRequirement,
  seActivateRequirementEnterprise,
  seDisableRequirement,
  seDisableRequirementEnterprise,
  seArchiveRequirement,
  seArchiveRequirementEnterprise,
  seListSources,
  seListSourcesEnterprise,
  seAutoGenerate,
  seAutoGenerateEnterprise,
  seListEnterpriseMembers,
  seBatchCreateTasksFromRequirements,
  seBatchCreateTasksFromRequirementsEnterprise,
  seBatchActivateRequirements, seBatchActivateRequirementsEnterprise,
  seBatchDisableRequirements, seBatchDisableRequirementsEnterprise,
  seBatchDeleteRequirements, seBatchDeleteRequirementsEnterprise,
  seListIndustryTemplatesEnterprise,
  seGetIndustryTemplateEnterprise,
  seImportIndustryTemplateEnterprise,
  type Requirement,
  type Source,
  type EnterpriseMember,
  type IndustryTemplate,
  type IndustryTemplateItem,
  INDUSTRY_TEMPLATE_CATEGORY_LABEL,
  REQUIREMENT_STATUS_LABEL,
  REQUIREMENT_STATUS_COLOR,
  PARSE_MODE_LABEL,
  TASK_TYPE_LABEL,
  STANDARD_TASK_TYPE_VALUES,
  seListTasks,
  seListTasksEnterprise,
  TASK_STATUS_LABEL,
  TASK_STATUS_COLOR,
  type SeTask,
} from '../../../../api/standardExecution'
import { SE_WORKBENCH_LEGACY } from '../../../../config/featureFlags'

const { Title } = Typography
const { TextArea } = Input

// 来源条款 Tab：待处理(REVIEW_PENDING+DRAFT，默认) / 已处理(ACTIVE+DISABLED+ARCHIVED)
const REQ_TABS = [
  { key: 'todo', label: '待处理' },
  { key: 'done', label: '已处理' },
] as const
type ReqTabKey = (typeof REQ_TABS)[number]['key']
const REQ_TAB_BACKEND_STATUS: Record<ReqTabKey, string> = {
  todo: 'REVIEW_PENDING,DRAFT',        // 待处理 = 待审核 + 兼容历史草稿
  done: 'ACTIVE,DISABLED,ARCHIVED',    // 已处理 = 可派发(已创建) / 已停用 / 已删除
}
// 细分状态下拉（跟随当前 Tab）
const REQ_TAB_STATUS_OPTIONS: Record<ReqTabKey, { value: string; label: string }[]> = {
  todo: [{ value: '', label: '全部' }, { value: 'REVIEW_PENDING', label: '待审核' }, { value: 'DRAFT', label: '历史草稿' }],
  done: [{ value: '', label: '全部' }, { value: 'ACTIVE', label: '可派发' }, { value: 'DISABLED', label: '已停用' }, { value: 'ARCHIVED', label: '已删除' }],
}
const PARSE_MODE_OPTIONS = Object.entries(PARSE_MODE_LABEL).map(([value, label]) => ({ value, label }))
const TASK_TYPE_OPTIONS = STANDARD_TASK_TYPE_VALUES.map((value) => ({ value, label: TASK_TYPE_LABEL[value] }))
const PARSE_AUDIT_META: Record<string, { label: string; color: string }> = {
  OCR_AI: { label: 'AI', color: 'green' },
  RULE: { label: 'RULE', color: 'gold' },
  AI_STUB: { label: 'STUB', color: 'default' },
}
// P1-7: 列表行附带的关联任务统计字段（后端 attachRequirementTaskStats 注入）
type ReqWithTasks = Requirement & { taskCount?: number; latestTaskStatus?: string | null }
type RequirementHealth = NonNullable<Requirement['health']>

const HEALTH_META: Record<RequirementHealth['status'], { label: string; color?: string }> = {
  COVERED: { label: '已覆盖', color: 'green' },
  EXPIRING: { label: '即将到期', color: 'orange' },
  UNCOVERED: { label: '未覆盖', color: 'red' },
  NO_TASK: { label: '无任务', color: 'default' },
  NA: { label: '-', color: undefined },
}

function renderHealthTag(health?: RequirementHealth) {
  if (!health || health.status === 'NA') return <span style={{ color: '#bbb' }}>—</span>
  const meta = HEALTH_META[health.status]
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function RequirementHealthPanel({ row }: { row: Requirement }) {
  const health = row.health
  if (!health) return null
  const meta = HEALTH_META[health.status]
  return (
    <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span style={{ fontWeight: 600, color: '#0f172a' }}>合规状态</span>
        {health.status === 'NA' ? <span style={{ color: '#94a3b8' }}>—</span> : <Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</Tag>}
      </div>
      <div style={{ color: '#475569', fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>{health.description}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 12 }}>最近有效记录</div>
          <div style={{ color: '#334155', fontSize: 13 }}>{health.latestValidRecordDate ? dayjs(health.latestValidRecordDate).format('YYYY-MM-DD') : '—'}</div>
        </div>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 12 }}>有效期</div>
          <div style={{ color: '#334155', fontSize: 13 }}>{health.validUntil ? dayjs(health.validUntil).format('YYYY-MM-DD') : '—'}</div>
        </div>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 12 }}>关联任务</div>
          <div style={{ color: '#334155', fontSize: 13 }}>{health.taskCount}</div>
        </div>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 12 }}>有效证据</div>
          <div style={{ color: '#334155', fontSize: 13 }}>{health.validRecordCount}</div>
        </div>
      </div>
    </div>
  )
}

export default function SeRequirementsPage() {
  const nav = useNavigate()
  const loc = useLocation()
  const [searchParams] = useSearchParams()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const scopedSourceId = searchParams.get('sourceId') || ''
  const { triggerAsk } = useContext(SEPageContext)
  const [items, setItems] = useState<Requirement[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [members, setMembers] = useState<EnterpriseMember[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [sourceKeyword, setSourceKeyword] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [activeTab, setActiveTab] = useState<ReqTabKey>('todo')
  const [keyword, setKeyword] = useState('')

  const [editOpen, setEditOpen] = useState(false)
  const [editRow, setEditRow] = useState<Requirement | null>(null)
  const [reviewMode, setReviewMode] = useState(false)
  const [form] = Form.useForm()

  const [genOpen, setGenOpen] = useState(false)
  const [genForm] = Form.useForm()
  const [genLoading, setGenLoading] = useState(false)
  const [selectedRequirementIds, setSelectedRequirementIds] = useState<string[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchForm] = Form.useForm()
  const [batchLoading, setBatchLoading] = useState(false)
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false)
  const [tasksDrawerRequirement, setTasksDrawerRequirement] = useState<Requirement | null>(null)
  const [tasksDrawerItems, setTasksDrawerItems] = useState<SeTask[]>([])
  const [tasksDrawerLoading, setTasksDrawerLoading] = useState(false)
  const [templateImportOpen, setTemplateImportOpen] = useState(false)
  const [templateImportLoading, setTemplateImportLoading] = useState(false)
  const [industryTemplates, setIndustryTemplates] = useState<IndustryTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>()
  const [selectedTemplateDetail, setSelectedTemplateDetail] = useState<IndustryTemplate | null>(null)
  const [selectedTemplateItemIds, setSelectedTemplateItemIds] = useState<string[]>([])

  const loadSources = async () => {
    try {
      const fetchFn = isEnterprise ? seListSourcesEnterprise : seListSources
      const res = await fetchFn({ pageSize: 500, status: 'ACTIVE' })
      setSources(res.data)
    } catch { /* ignore */ }
  }

  const loadMembers = async () => {
    try {
      const res = await seListEnterpriseMembers()
      setMembers(res.data)
    } catch { /* ignore */ }
  }

  const load = async () => {
    setLoading(true)
    try {
      const fetchFn = isEnterprise ? seListRequirementsEnterprise : seListRequirements
      // 下拉为「全部」时用 Tab 默认范围（逗号分隔多值），选了具体值则用具体值
      const backendStatus = filterStatus || REQ_TAB_BACKEND_STATUS[activeTab]
      const res = await fetchFn({
        sourceKeyword: sourceKeyword || undefined,
        sourceId: scopedSourceId || undefined,
        status: backendStatus || undefined,
        keyword: keyword || undefined,
        page,
        pageSize,
      })
      setItems(res.data)
      setTotal(res.total)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadSources(); loadMembers() }, [])
  useEffect(() => { load() }, [page, sourceKeyword, filterStatus, activeTab, scopedSourceId])

  const openTasksDrawer = async (row: Requirement) => {
    setTasksDrawerRequirement(row)
    setTasksDrawerItems([])
    setTasksDrawerOpen(true)
    setTasksDrawerLoading(true)
    try {
      const fn = isEnterprise ? seListTasksEnterprise : seListTasks
      const res = await fn({ requirementId: row.id, pageSize: 100 })
      setTasksDrawerItems(res.data)
    } catch {
      message.error('加载关联任务失败')
    } finally {
      setTasksDrawerLoading(false)
    }
  }

  const openCreate = () => {
    setEditRow(null)
    setReviewMode(false)
    form.resetFields()
    setEditOpen(true)
  }
  const openEdit = (row: Requirement) => {
    setEditRow(row)
    setReviewMode(false)
    form.setFieldsValue(row)
    setEditOpen(true)
  }
  const openReview = (row: Requirement) => {
    setEditRow(row)
    setReviewMode(true)
    form.setFieldsValue(row)
    setEditOpen(true)
  }
  const handleSave = async (activateAfterSave = false) => {
    try {
      const values = await form.validateFields()
      if (editRow) {
        const updateFn = isEnterprise ? seUpdateRequirementEnterprise : seUpdateRequirement
        await updateFn(editRow.id, values)
        if (activateAfterSave) {
          await (isEnterprise ? seActivateRequirementEnterprise : seActivateRequirement)(editRow.id)
          message.success('已审核并启用')
        } else {
          message.success('已更新')
        }
      } else {
        const createFn = isEnterprise ? seCreateRequirementEnterprise : seCreateRequirement
        await createFn(values)
        message.success('已创建（待审核）')
      }
      setEditOpen(false)
      setReviewMode(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const handleTransition = (row: Requirement, action: 'activate' | 'disable' | 'archive') => {
    const labels = { activate: '启用', disable: '停用', archive: '删除' }
    Modal.confirm({
      title: `${labels[action]}来源条款`,
      content: `确认对「${row.title}」执行${labels[action]}操作？`,
      onOk: async () => {
        try {
          if (action === 'activate') {
            await (isEnterprise ? seActivateRequirementEnterprise : seActivateRequirement)(row.id)
          } else if (action === 'disable') {
            await (isEnterprise ? seDisableRequirementEnterprise : seDisableRequirement)(row.id)
          } else {
            await (isEnterprise ? seArchiveRequirementEnterprise : seArchiveRequirement)(row.id)
          }
          message.success('已操作')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  const goCreateTask = (row: Requirement) => {
    const base = isEnterprise ? '/enterprise/tasks' : '/admin/standard-execution/tasks'
    nav(`${base}?requirementId=${row.id}`)
  }

  const openBatchCreateTasks = () => {
    if (selectedRequirementIds.length === 0) {
      message.warning('请先选择「已启用」来源条款')
      return
    }
    const selectedRows = items.filter((item) => selectedRequirementIds.includes(item.id))
    const sourceIds = Array.from(new Set(selectedRows.map((item) => item.sourceId).filter(Boolean)))
    const enterpriseBase = SE_WORKBENCH_LEGACY ? '/enterprise/task-generation' : '/enterprise/workbench'
    const base = isEnterprise ? enterpriseBase : '/admin/standard-execution/task-generation'
    if (sourceIds.length === 1) {
      nav(`${base}?sourceId=${sourceIds[0]}`)
      return
    }
    message.info('已进入任务生成工作台，请先选择标准来源')
    nav(base)
  }

  const openTemplateImport = async () => {
    setTemplateImportOpen(true)
    setTemplateImportLoading(true)
    setSelectedTemplateId(undefined)
    setSelectedTemplateDetail(null)
    setSelectedTemplateItemIds([])
    try {
      const res = await seListIndustryTemplatesEnterprise({ pageSize: 100 })
      setIndustryTemplates(res.data)
    } catch {
      message.error('加载行业模板失败')
    } finally {
      setTemplateImportLoading(false)
    }
  }

  const chooseIndustryTemplate = async (templateId: string) => {
    setSelectedTemplateId(templateId)
    setTemplateImportLoading(true)
    try {
      const res = await seGetIndustryTemplateEnterprise(templateId)
      setSelectedTemplateDetail(res.data)
      setSelectedTemplateItemIds((res.data.items || []).map((item) => item.id))
    } catch {
      message.error('加载模板详情失败')
    } finally {
      setTemplateImportLoading(false)
    }
  }

  const handleImportTemplate = async () => {
    if (!selectedTemplateId || selectedTemplateItemIds.length === 0) {
      message.warning('请选择模板和控制点')
      return
    }
    setTemplateImportLoading(true)
    try {
      const res = await seImportIndustryTemplateEnterprise(selectedTemplateId, { itemIds: selectedTemplateItemIds })
      message.success(`已导入 ${res.imported} 个控制点`)
      setTemplateImportOpen(false)
      setActiveTab('todo')
      setFilterStatus('DRAFT')
      setPage(1)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '导入失败')
    } finally {
      setTemplateImportLoading(false)
    }
  }

  const handleBatchCreateTasks = async () => {
    try {
      const values = await batchForm.validateFields()
      setBatchLoading(true)
      const createFn = isEnterprise
        ? seBatchCreateTasksFromRequirementsEnterprise
        : seBatchCreateTasksFromRequirements
      const res = await createFn({
        ...values,
        requirementIds: selectedRequirementIds,
        deadlineAt: values.deadlineAt.toISOString(),
      })
      message.success(`已生成 ${res.createdCount} 个任务草稿`)
      setBatchOpen(false)
      setSelectedRequirementIds([])
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    } finally {
      setBatchLoading(false)
    }
  }

  const handleAutoGenerate = async () => {
    try {
      const values = await genForm.validateFields()
      setGenLoading(true)
      const res = await (isEnterprise ? seAutoGenerateEnterprise : seAutoGenerate)(values)
      const d = res.data
      const degradeHint = d.degraded ? `（已降级 RULE，原因：${d.degradedReason}）` : ''
      const statHint = `AI ${d.aiCount ?? 0} / RULE ${d.ruleCount ?? 0} / 降级 ${d.degradedCount ?? 0}`
      message.success(`解析完成：实际模式 ${d.parseMode}${degradeHint}，新建 ${d.createdCount} 条待审核来源条款（${statHint}）`)
      setGenOpen(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    } finally {
      setGenLoading(false)
    }
  }

  const handleBatchDelete = async () => {
    try {
      const fn = isEnterprise ? seBatchDeleteRequirementsEnterprise : seBatchDeleteRequirements
      const r = await fn(selectedRequirementIds)
      const summary = `已删除 ${r.deleted + r.archived} 项${r.skipped ? `，跳过 ${r.skipped} 项` : ''}`
      message.success(summary)
      if (r.archived > 0 || r.skipped > 0) {
        Modal.info({
          title: '删除结果',
          content: (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <div>{summary}</div>
              {r.details.filter((item) => item.action !== 'deleted').slice(0, 10).map((item) => (
                <div key={item.id} style={{ padding: 8, background: '#f8fafc', borderRadius: 6 }}>
                  <Tag color={item.action === 'archived' ? 'orange' : 'default'}>
                    {item.action === 'archived' ? '已删除' : '已跳过'}
                  </Tag>
                  <span style={{ color: '#475569' }}>{item.id}</span>
                  {item.action === 'archived' && (
                    <div style={{ color: '#8a93a3', fontSize: 12, marginTop: 4 }}>
                      已有关联历史，保留数据并转为已删除状态：
                      任务 {item.associations.tasks}、
                      填写项 {item.associations.taskItems}、
                      记录 {item.associations.records}、
                      审计包 {item.associations.packageItems}
                    </div>
                  )}
                  {item.action === 'skipped' && (
                    <div style={{ color: '#8a93a3', fontSize: 12, marginTop: 4 }}>未找到该来源条款，已跳过。</div>
                  )}
                </div>
              ))}
              {r.details.filter((item) => item.action !== 'deleted').length > 10 && (
                <div style={{ color: '#8a93a3', fontSize: 12 }}>仅展示前 10 条明细。</div>
              )}
            </Space>
          ),
        })
      }
      setSelectedRequirementIds([])
      load()
    } catch (e) {
      message.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || '删除失败')
    }
  }

  return (
    <div>
      <Tabs
        activeKey={activeTab}
        onChange={(k) => { setActiveTab(k as ReqTabKey); setFilterStatus(''); setSelectedRequirementIds([]); setPage(1) }}
        items={REQ_TABS.map((t) => ({ key: t.key, label: t.label }))}
        style={{ marginBottom: 12 }}
      />
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Title level={4} style={{ margin: 0 }}>解析结果</Title>
        <Space wrap>
          <Input.Search placeholder="搜索标题/条款号" value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={load} style={{ width: 200 }} allowClear />
          <Input
            placeholder="搜索来源名称"
            allowClear
            value={sourceKeyword}
            onChange={(e) => { setSourceKeyword(e.target.value); setPage(1) }}
            style={{ width: 200 }}
            prefix={<SearchOutlined />}
          />
          <Select options={REQ_TAB_STATUS_OPTIONS[activeTab]} value={filterStatus} onChange={(v) => { setPage(1); setFilterStatus(v) }} style={{ width: 140 }} />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          {isEnterprise && <Button onClick={openTemplateImport}>从行业模板导入</Button>}
          <Button icon={<ThunderboltOutlined />} onClick={() => { genForm.resetFields(); genForm.setFieldsValue({ sourceId: scopedSourceId || undefined, parseMode: 'RULE' }); setGenOpen(true) }}>解析来源条款</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建</Button>
        </Space>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="从标准来源解析来源条款并生成任务草稿；已有任务依据的派发请进入任务生成工作台复核后提交。"
      />

      {selectedRequirementIds.length > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: '#475569', fontWeight: 600 }}>已选 {selectedRequirementIds.length} 项</span>
          <Space wrap>
            <Button size="small" type="primary" onClick={openBatchCreateTasks}>批量生成任务草稿</Button>
            <Button size="small" onClick={async () => {
              try {
                const fn = isEnterprise ? seBatchActivateRequirementsEnterprise : seBatchActivateRequirements
                const r = await fn(selectedRequirementIds)
                message.success(`已启用 ${r.updated} 项`); setSelectedRequirementIds([]); load()
              } catch (e) { message.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || '操作失败') }
            }}>批量启用</Button>
            <Button size="small" onClick={async () => {
              try {
                const fn = isEnterprise ? seBatchDisableRequirementsEnterprise : seBatchDisableRequirements
                const r = await fn(selectedRequirementIds)
                message.success(`已停用 ${r.updated} 项`); setSelectedRequirementIds([]); load()
              } catch (e) { message.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || '操作失败') }
            }}>批量停用</Button>
            <Popconfirm
              title={`确定处理选中的 ${selectedRequirementIds.length} 个来源条款？`}
              description="无历史关联的来源条款会删除；已有任务、记录或审计包历史的来源条款会保留历史并转为已删除状态。"
              onConfirm={handleBatchDelete}
              okText="删除"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger>批量删除</Button>
            </Popconfirm>
            <Button size="small" type="text" onClick={() => setSelectedRequirementIds([])}>取消选择</Button>
          </Space>
        </div>
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        rowSelection={{
          selectedRowKeys: selectedRequirementIds,
          onChange: (keys) => setSelectedRequirementIds(keys.map(String)),
          getCheckboxProps: (row) => ({ disabled: row.status === 'ARCHIVED' }),
        }}
        locale={{ emptyText: <div style={{ padding: '24px 0', color: '#8a93a3' }}>还没有解析结果，请先在「标准来源」页面进行解析或手动新建</div> }}
        pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
        columns={[
          { title: '条款号', dataIndex: 'clauseNo', width: 90, render: (v: string) => v || '-' },
          {
            title: '标题',
            dataIndex: 'title',
            ellipsis: true,
            render: (v: string, row: Requirement) => (
              <Space size={6} wrap>
                <span>{v}</span>
                {row.requiresReview && <Tag color="orange">需复核</Tag>}
              </Space>
            ),
          },
          {
            title: '标准来源', dataIndex: 'sourceId', width: 160, ellipsis: true,
            render: (_v: string, row: Requirement) => {
              const src = sources.find((s) => s.id === row.sourceId)
              return src ? src.title : '-'
            },
          },
          {
            title: '生成方式', dataIndex: 'generateMode', width: 90,
            render: (v: string) => {
              const labelMap: Record<string, string> = { MANUAL: '手动录入', RULE: '规则解析', AI: 'AI解析', AI_STUB: '测试' }
              return <Tag>{labelMap[v] || v}</Tag>
            },
          },
          {
            title: '解析', width: 90,
            render: (_: unknown, row: Requirement) => {
              const mode = row.parseMode || undefined
              if (!mode) return <Tag color="default">未标记</Tag>
              const meta = PARSE_AUDIT_META[mode]
              if (!meta) return <span style={{ color: '#bbb' }}>—</span>
              return (
                <Tag color={row.degradedReason ? 'orange' : meta.color} title={row.degradedReason || undefined}>
                  {meta.label}{row.degradedReason ? ' 降级' : ''}
                </Tag>
              )
            },
          },
          {
            title: '状态', dataIndex: 'status', width: 90,
            render: (v: string) => <Tag color={REQUIREMENT_STATUS_COLOR[v]}>{REQUIREMENT_STATUS_LABEL[v]}</Tag>,
          },
          {
            title: '合规状态', dataIndex: 'health', width: 110,
            render: (_: unknown, row: Requirement) => renderHealthTag(row.health),
          },
          {
            title: '关联任务', width: 130,
            render: (_: unknown, row: Requirement) => {
              const r = row as ReqWithTasks
              if (!r.taskCount) return <span style={{ color: '#bbb' }}>—</span>
              return (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => openTasksDrawer(row)} style={{ padding: 0 }}>
                    {r.taskCount} 个
                  </Button>
                  {r.latestTaskStatus && <Tag color={r.latestTaskStatus === 'CANCELLED' ? 'default' : TASK_STATUS_COLOR[r.latestTaskStatus]}>{r.latestTaskStatus === 'CANCELLED' ? '已关闭' : TASK_STATUS_LABEL[r.latestTaskStatus]}</Tag>}
                </Space>
              )
            },
          },
          { title: '创建时间', dataIndex: 'createdAt', width: 130, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
          {
            title: '操作', width: 280, render: (_: unknown, row: Requirement) => {
              const actions: React.ReactNode[] = []
              if (row.status !== 'ARCHIVED') actions.push(<Button key="edit" size="small" type="link" onClick={() => openEdit(row)}>编辑</Button>)
              if (row.status === 'REVIEW_PENDING') actions.push(<Button key="review" size="small" type="link" onClick={() => openReview(row)}>审核</Button>)
              if (row.status === 'DISABLED') actions.push(<Button key="activate" size="small" type="link" onClick={() => handleTransition(row, 'activate')}>启用</Button>)
              if (row.status === 'ACTIVE') actions.push(<Button key="disable" size="small" type="link" onClick={() => handleTransition(row, 'disable')}>停用</Button>)
              if (row.status === 'ACTIVE') actions.push(<Button key="createTask" size="small" type="link" onClick={() => goCreateTask(row)}>生成任务草稿</Button>)
              if (row.status === 'ACTIVE' || row.status === 'DISABLED') actions.push(<Button key="archive" size="small" type="link" danger onClick={() => handleTransition(row, 'archive')}>删除</Button>)
              return <Space wrap split={<Divider type="vertical" />}>{actions}</Space>
            },
          },
        ]}
      />

      <Drawer
        title="关联任务"
        open={tasksDrawerOpen}
        width={640}
        onClose={() => setTasksDrawerOpen(false)}
      >
        {tasksDrawerRequirement && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>{tasksDrawerRequirement.title}</div>
            <div style={{ color: '#8a93a3', fontSize: 12 }}>
              {tasksDrawerRequirement.clauseNo ? `[${tasksDrawerRequirement.clauseNo}] ` : ''}
              {tasksDrawerRequirement.source?.title || sources.find((s) => s.id === tasksDrawerRequirement.sourceId)?.title || '标准来源未标记'}
            </div>
          </div>
        )}
        <Table<SeTask>
          size="small"
          rowKey="id"
          loading={tasksDrawerLoading}
          dataSource={tasksDrawerItems}
          pagination={false}
          locale={{ emptyText: '该来源条款暂无关联任务' }}
          columns={[
            { title: '任务标题', dataIndex: 'title', ellipsis: true },
            { title: '类型', dataIndex: 'taskType', width: 110, render: (v: string) => v ? <Tag>{TASK_TYPE_LABEL[v] || v}</Tag> : '-' },
            { title: '状态', dataIndex: 'status', width: 120, render: (v: string, r: SeTask) => <Space><Tag color={r.isOverdue ? 'red' : TASK_STATUS_COLOR[v]}>{v === 'CANCELLED' ? '已关闭' : TASK_STATUS_LABEL[v]}</Tag>{r.isOverdue && <Tag color="red">逾期</Tag>}</Space> },
            { title: '截止', dataIndex: 'deadlineAt', width: 130, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
          ]}
        />
      </Drawer>

      <Drawer
        title={reviewMode ? '审核来源条款' : editRow ? '编辑来源条款' : '新建来源条款'}
        open={editOpen}
        width={560}
        onClose={() => { setEditOpen(false); setReviewMode(false) }}
        extra={editRow && (
          <Space>
            <Button size="small" type="primary" onClick={() => nav(`${isEnterprise ? '/enterprise/question-banks' : '/admin/standard-execution/question-banks'}?requirementId=${editRow.id}&requirementTitle=${encodeURIComponent(editRow.title)}`)}>为此依据出题</Button>
            <Button size="small" onClick={() => triggerAsk(`任务依据：${editRow.title}｜依据原文：${editRow.requirementText}`, '这条依据怎么执行？')}>问小智</Button>
          </Space>
        )}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setEditOpen(false); setReviewMode(false) }}>取消</Button>
            {reviewMode && <Button onClick={() => handleSave(false)}>仅保存</Button>}
            <Button type="primary" onClick={() => handleSave(reviewMode)}>{reviewMode ? '保存并启用' : '保存'}</Button>
          </Space>
        }
      >
        {editRow && <RequirementHealthPanel row={editRow} />}
        <Form form={form} layout="vertical">
          {!editRow && (
            <Form.Item name="sourceId" label="所属标准来源" rules={[{ required: true, message: '必填' }]}>
              <Select options={sources.map((s) => ({ value: s.id, label: s.title }))} showSearch optionFilterProp="label" />
            </Form.Item>
          )}
          <Form.Item name="clauseNo" label="条款号"><Input maxLength={50} /></Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '必填' }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="requirementText" label="要求正文" rules={[{ required: true, message: '必填' }]}><TextArea rows={5} maxLength={10000} showCount /></Form.Item>
          <Form.Item name="recommendedTaskType" label="推荐任务类型">
            <Select options={TASK_TYPE_OPTIONS} allowClear />
          </Form.Item>
          <Form.Item name="executionDescription" label="执行描述"><TextArea rows={3} maxLength={2000} showCount /></Form.Item>
          <Form.Item name="submitRequirement" label="提交要求"><TextArea rows={3} maxLength={1000} showCount /></Form.Item>
          <Form.Item name="requiredMaterials" label="需提交材料">
            <Select mode="tags" tokenSeparators={[',', '，', '\n']} placeholder="输入材料名称后回车" />
          </Form.Item>
          <Form.Item name="applicableDeptIds" label="适用部门">
            <Select mode="tags" tokenSeparators={[',', '，', '\n']} placeholder="输入部门标识后回车" />
          </Form.Item>
          <Form.Item name="archiveTags" label="标签">
            <Select mode="tags" tokenSeparators={[',', '，', '\n']} placeholder="输入标签后回车" />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal title="解析来源条款" open={genOpen} onCancel={() => setGenOpen(false)} onOk={handleAutoGenerate} confirmLoading={genLoading} okText="开始解析">
        <Form form={genForm} layout="vertical">
          <Form.Item name="sourceId" label="标准来源（须先有原文）" rules={[{ required: true, message: '必填' }]}>
            <Select options={sources.filter((s) => s.rawText).map((s) => ({ value: s.id, label: s.title }))} showSearch optionFilterProp="label" placeholder="仅显示已录入原文的来源" />
          </Form.Item>
          <Form.Item name="parseMode" label="解析模式" rules={[{ required: true, message: '必填' }]}>
            <Select options={PARSE_MODE_OPTIONS} />
          </Form.Item>
          <Form.Item name="dryRun" valuePropName="checked" label=" "><Input.Group><label><input type="checkbox" onChange={(e) => genForm.setFieldValue('dryRun', e.target.checked)} /> 仅预览（不写库）</label></Input.Group></Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`批量生成任务草稿（${selectedRequirementIds.length} 项）`}
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={handleBatchCreateTasks}
        confirmLoading={batchLoading}
        okText="生成任务草稿"
        width={620}
      >
        <Form form={batchForm} layout="vertical">
          <Form.Item name="titlePrefix" label="任务标题前缀">
            <Input maxLength={80} placeholder="选填，如：5月内审执行" />
          </Form.Item>
          <Form.Item name="taskType" label="任务类型" extra="留空则自动使用任务依据推荐类型">
            <Select options={TASK_TYPE_OPTIONS} allowClear placeholder="留空则自动使用任务依据推荐类型" />
          </Form.Item>
          <Form.Item name="submitRequirement" label="提交要求" rules={[{ required: true, message: '必填' }]}>
            <TextArea rows={3} maxLength={1000} />
          </Form.Item>
          <Form.Item name="deadlineAt" label="截止时间" rules={[{ required: true, message: '必填' }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reviewerId" label="审核人" rules={[{ required: true, message: '必填' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="搜索手机号或昵称"
              options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))}
            />
          </Form.Item>
          <Form.Item name="assigneeIds" label="执行人" rules={[{ required: true, message: '必填' }]}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="搜索手机号或昵称，可多选"
              options={members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ' ' + m.nickName : ''}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="从行业模板导入"
        open={templateImportOpen}
        onCancel={() => setTemplateImportOpen(false)}
        onOk={handleImportTemplate}
        confirmLoading={templateImportLoading}
        okText="导入"
        width={780}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Select
            style={{ width: '100%' }}
            placeholder="选择已发布模板"
            value={selectedTemplateId}
            loading={templateImportLoading}
            onChange={chooseIndustryTemplate}
            options={industryTemplates.map((tpl) => ({
              value: tpl.id,
              label: `${tpl.title}${tpl.sourceNo ? ` · ${tpl.sourceNo}` : ''} · ${INDUSTRY_TEMPLATE_CATEGORY_LABEL[tpl.industryCategory]}`,
            }))}
          />
          {selectedTemplateDetail && (
            <div>
              <Space style={{ marginBottom: 8 }} wrap>
                <Tag>{INDUSTRY_TEMPLATE_CATEGORY_LABEL[selectedTemplateDetail.industryCategory]}</Tag>
                {selectedTemplateDetail.sourceNo && <Tag>{selectedTemplateDetail.sourceNo}</Tag>}
                {selectedTemplateDetail.version && <Tag>{selectedTemplateDetail.version}</Tag>}
                <Tag>控制点 {selectedTemplateDetail.items?.length || 0}</Tag>
              </Space>
              <Table<IndustryTemplateItem>
                size="small"
                rowKey="id"
                dataSource={selectedTemplateDetail.items || []}
                pagination={false}
                rowSelection={{
                  selectedRowKeys: selectedTemplateItemIds,
                  onChange: (keys) => setSelectedTemplateItemIds(keys.map(String)),
                }}
                columns={[
                  { title: '条款号', dataIndex: 'clauseNo', width: 90, render: (v: string | null) => v || '-' },
                  { title: '标题', dataIndex: 'title', width: 180 },
                  { title: '要求正文', dataIndex: 'requirementText', ellipsis: true },
                ]}
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
