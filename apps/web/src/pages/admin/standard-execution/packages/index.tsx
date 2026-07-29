import { useEffect, useState, useContext } from 'react'
import { Table, Typography, Button, Space, Select, Input, Tag, message, Modal, Drawer, Form, Tree, Alert, List, Checkbox, Descriptions, Divider, DatePicker } from 'antd'
import type { CSSProperties, Key } from 'react'
import { ReloadOutlined, PlusOutlined, DownloadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useLocation, useSearchParams } from 'react-router-dom'
import { SEPageContext } from '../../../../contexts/SEPageContext'
import {
  seListPackages, seListPackagesEnterprise,
  seCreatePackage, seCreatePackageEnterprise,
  seGetPackage, seGetPackageEnterprise,
  sePreviewPackage, sePreviewPackageEnterprise,
  seStartPackageGeneration, seStartPackageGenerationEnterprise,
  seGetPackageGenerationStatus, seGetPackageGenerationStatusEnterprise,
  seDownloadPackageFile, seDownloadPackageFileEnterprise,
  seVoidPackage, seVoidPackageEnterprise,
  seBatchVoidPackages, seBatchVoidPackagesEnterprise,
  seListRecords, seListRecordsEnterprise,
  seListTasks, seListTasksEnterprise,
  type SePackage,
  type SeRecord,
  type SeTask,
  type PackagePreview,
  type PackageGenerationOptions,
  type PackageOutputFile,
  PACKAGE_STATUS_LABEL,
  PACKAGE_STATUS_COLOR,
  PACKAGE_SCENE_LABEL,
} from '../../../../api/standardExecution'

const { Title, Text } = Typography
const { TextArea } = Input
const { RangePicker } = DatePicker

const PACKAGE_SCENE_DISPLAY_LABEL: Record<string, string> = {
  ...PACKAGE_SCENE_LABEL,
  REGULATORY: '监管检查',
  CUSTOMER_AUDIT: '客户审厂',
  CERTIFICATION: '认证申请',
  INTERNAL_CHECK: '内部专项审计',
  TRAINING_ARCHIVE: '培训存档',
  OTHER: '其他',
}
const PACKAGE_SCENE_ORDER = ['REGULATORY', 'CUSTOMER_AUDIT', 'CERTIFICATION', 'INTERNAL_CHECK', 'TRAINING_ARCHIVE', 'OTHER']
const SCENE_OPTIONS = PACKAGE_SCENE_ORDER.map((value) => ({ value, label: PACKAGE_SCENE_DISPLAY_LABEL[value] || value }))
const PACKAGE_SCENE_DESCRIPTION: Record<string, string> = {
  REGULATORY: '政府或行业监管部门抽查，强调记录真实性、完整性和可追溯性。',
  CUSTOMER_AUDIT: '客户现场审核或验厂，突出标准来源、执行记录和附件原件。',
  CERTIFICATION: 'ISO 或行业认证机构审核，适合按标准条款组织长期留档材料。',
  INTERNAL_CHECK: '企业内部合规自查或专项审计，便于复盘控制点执行闭环。',
  TRAINING_ARCHIVE: '培训记录专项归档，集中保存学习确认、题库结果和培训附件。',
  OTHER: '其他审计或备查场景，可通过备注说明补充使用目的。',
}
const STATUS_OPTIONS = [{ value: '', label: '全部状态' }, ...Object.entries(PACKAGE_STATUS_LABEL).map(([value, label]) => ({ value, label }))]
const FORMAT_LABEL: Record<string, string> = { FOLDER: '多文件', ZIP: 'ZIP', PDF: 'PDF', DOCX: 'Word' }
const FORMAT_OPTIONS = [{ value: '', label: '全部格式' }, ...Object.entries(FORMAT_LABEL).map(([value, label]) => ({ value, label }))]
const DEFAULT_GENERATION_OPTIONS: Required<PackageGenerationOptions> = {
  includeManifest: false,
  includeAuditTrace: false,
  includeBasisClauses: false,
  includeStatisticsSummary: false,
}
const V2_OPTION_LABEL: Array<{ key: keyof Required<PackageGenerationOptions>; label: string }> = [
  { key: 'includeManifest', label: 'JSON 数据附录' },
  { key: 'includeAuditTrace', label: '审计追溯表' },
  { key: 'includeBasisClauses', label: '生成内容汇编' },
  { key: 'includeStatisticsSummary', label: '统计摘要' },
]
const REVIEW_ACTION_LABEL: Record<string, string> = {
  APPROVE: '审核通过',
  REJECT: '审核驳回',
  SUBMIT: '提交审核',
}

const enterprisePageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}
const fieldLabelStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 6,
}
const compactControlStyle: CSSProperties = {
  height: 34,
  borderRadius: 6,
}
const packageTableShellStyle: CSSProperties = {
  width: 700,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
}
const packageCompletenessStyle: CSSProperties = {
  background: '#ecfdf5',
  border: '1px solid #bbf7d0',
  borderRadius: 6,
  color: '#166534',
  fontSize: 13,
  fontWeight: 500,
  padding: '18px 20px',
}

function outputFilesOf(pkg: SePackage | null | undefined): PackageOutputFile[] {
  const files = pkg?.outputManifest?.files
  return Array.isArray(files) ? files.filter((file) => file.path !== 'README.txt') : []
}

function formatBytes(size: number | null | undefined) {
  const n = Number(size || 0)
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

interface TreeNode {
  source: { id: string; title: string }
  requirements: Array<{
    requirement: { id: string; title: string; clauseNo: string | null }
    tasks: Array<{
      task: { id: string; title: string }
      submissions: Array<{
        submission: { id: string; version: number; submitText: string }
        record: { id: string; title: string; status: string }
        reviewLogs: Array<{ id: string; action: string; comment: string | null; createdAt: string }>
        attachments: Array<{ id: string; fileName: string; fileUrl: string }>
      }>
    }>
  }>
}

export default function SePackagesPage() {
  const loc = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [items, setItems] = useState<SePackage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterStatus, setFilterStatus] = useState('')
  const [filterScene, setFilterScene] = useState('')
  const [filterFormat, setFilterFormat] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const selectedCreateScene = Form.useWatch('packageScene', createForm)
  const [validRecords, setValidRecords] = useState<SeRecord[]>([])
  const [selectionTasks, setSelectionTasks] = useState<SeTask[]>([])
  const [packageSelectionKeys, setPackageSelectionKeys] = useState<Key[]>([])

  const [detail, setDetail] = useState<(SePackage & { tree: TreeNode[] }) | null>(null)
  const { triggerAsk } = useContext(SEPageContext)
  const [detailOpen, setDetailOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPackage, setPreviewPackage] = useState<SePackage | null>(null)
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationOptions, setGenerationOptions] = useState<Required<PackageGenerationOptions>>(DEFAULT_GENERATION_OPTIONS)

  const load = async () => {
    setLoading(true)
    try {
      const listFn = isEnterprise ? seListPackagesEnterprise : seListPackages
      const res = await listFn({
        status: filterStatus || undefined,
        packageScene: filterScene || undefined,
        format: filterFormat || undefined,
        keyword: keyword || undefined,
        page,
        pageSize,
      })
      setItems(res.data)
      setTotal(res.total)
      setSelectedKeys([])
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [page, filterStatus, filterScene, filterFormat])

  const loadPackageSelectionOptions = async () => {
    try {
      const recordFn = isEnterprise ? seListRecordsEnterprise : seListRecords
      const taskFn = isEnterprise ? seListTasksEnterprise : seListTasks
      const [records, tasks] = await Promise.all([
        recordFn({ status: 'VALID', pageSize: 500 }),
        taskFn({ pageSize: 500 }),
      ])
      setValidRecords(records.data)
      setSelectionTasks(tasks.data)
    } catch { /* ignore */ }
  }

  const openCreate = async (presetKeys: Key[] = []) => {
    createForm.resetFields()
    setPackageSelectionKeys(presetKeys)
    await loadPackageSelectionOptions()
    setPackageSelectionKeys(presetKeys)
    setCreateOpen(true)
  }
  useEffect(() => {
    if (!isEnterprise) return
    createForm.setFieldsValue({ packageScene: 'CUSTOMER_AUDIT', format: 'ZIP' })
    void loadPackageSelectionOptions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnterprise])
  useEffect(() => {
    const recordId = searchParams.get('recordId')
    if (!recordId) return
    void openCreate([`record:${recordId}`])
    setSearchParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      const keys = packageSelectionKeys.map(String)
      const recordIds = keys.filter((k) => k.startsWith('record:')).map((k) => k.slice('record:'.length))
      const taskIds = keys.filter((k) => k.startsWith('task:')).map((k) => k.slice('task:'.length))
      if (recordIds.length === 0 && taskIds.length === 0) {
        message.warning('请至少选择一个任务或执行记录')
        return
      }
      const createFn = isEnterprise ? seCreatePackageEnterprise : seCreatePackage
      const auditRange = values.auditRange as [Dayjs | null, Dayjs | null] | undefined
      await createFn({
        ...values,
        auditRange: undefined,
        dateFrom: auditRange?.[0]?.startOf('day').toISOString(),
        dateTo: auditRange?.[1]?.endOf('day').toISOString(),
        recordIds: recordIds.length ? recordIds : undefined,
        taskIds: taskIds.length ? taskIds : undefined,
      })
      message.success('已创建')
      setCreateOpen(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const openDetail = async (id: string) => {
    try {
      const getFn = isEnterprise ? seGetPackageEnterprise : seGetPackage
      const res = await getFn(id)
      setDetail(res.data as SePackage & { tree: TreeNode[] })
      setDetailOpen(true)
    } catch {
      message.error('加载失败')
    }
  }
  const closeDetail = () => {
    setDetailOpen(false)
    setDetail(null)
  }

  const loadPreview = async (row: SePackage, options: Required<PackageGenerationOptions>) => {
    setPreviewLoading(true)
    try {
      const previewFn = isEnterprise ? sePreviewPackageEnterprise : sePreviewPackage
      const res = await previewFn(row.id, options)
      setPreview(res.data)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '预览生成失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleGenerate = async (row: SePackage) => {
    const nextOptions = { ...DEFAULT_GENERATION_OPTIONS }
    setPreviewPackage(row)
    setGenerationOptions(nextOptions)
    setPreview(null)
    setPreviewOpen(true)
    await loadPreview(row, nextOptions)
  }

  const handleToggleGenerationOption = async (key: keyof Required<PackageGenerationOptions>, checked: boolean) => {
    const next = { ...generationOptions, [key]: checked }
    setGenerationOptions(next)
    if (previewPackage) await loadPreview(previewPackage, next)
  }

  const pollGenerationStatus = async (id: string) => {
    const statusFn = isEnterprise ? seGetPackageGenerationStatusEnterprise : seGetPackageGenerationStatus
    for (let i = 0; i < 8; i++) {
      const res = await statusFn(id)
      if (res.data.generationStatus === 'READY' || res.data.generationStatus === 'FAILED') return res.data
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    return null
  }

  const handleConfirmGenerate = async () => {
    if (!previewPackage) return
    setGenerating(true)
    try {
      const startFn = isEnterprise ? seStartPackageGenerationEnterprise : seStartPackageGeneration
      await startFn(previewPackage.id, { ...generationOptions, previewConfirmed: true })
      const finalStatus = await pollGenerationStatus(previewPackage.id)
      const skipped = finalStatus?.outputManifest?.skippedAttachments?.length || 0
      if (finalStatus?.generationStatus === 'FAILED') {
        message.error(finalStatus.generationError || '生成失败')
        return
      } else if (skipped > 0) {
        message.warning(`已生成，${skipped} 个附件未写入目录，请查看 README 和索引表`)
      } else {
        message.success('已生成审计包')
      }
      setPreviewOpen(false)
      setPreview(null)
      setPreviewPackage(null)
      await load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '操作失败')
    } finally {
      setGenerating(false)
    }
  }

  const handleDownloadOutputFile = async (row: SePackage, file: PackageOutputFile) => {
    try {
      const downloadFn = isEnterprise ? seDownloadPackageFileEnterprise : seDownloadPackageFile
      const blob = await downloadFn(row.id, file.path)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.path.split('/').pop() || file.label
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '下载失败')
    }
  }

  const handleVoid = (row: SePackage) => {
    Modal.confirm({
      title: '作废审计包',
      content: `确定将「${row.title}」作废？`,
      onOk: async () => {
        try {
          const voidFn = isEnterprise ? seVoidPackageEnterprise : seVoidPackage
          await voidFn(row.id)
          message.success('已作废')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  const handleBatchVoid = () => {
    Modal.confirm({
      title: '批量作废',
      content: `确认作废选中的 ${selectedKeys.length} 个审计包？已作废的自动跳过。`,
      onOk: async () => {
        try {
          const fn = isEnterprise ? seBatchVoidPackagesEnterprise : seBatchVoidPackages
          const r = await fn(selectedKeys as string[])
          message.success(`已作废 ${r.ok} 个${r.skipped ? `，${r.skipped} 个跳过` : ''}`)
          setSelectedKeys([]); load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }
  const renderSelectionTree = (maxHeight = 360) => {
    const taskMap = new Map(selectionTasks.map((t) => [t.id, t]))
    const bySource = new Map<string, {
      title: string
      basis: Map<string, {
        title: string
        tasks: Map<string, { title: string; records: SeRecord[] }>
      }>
    }>()

    for (const record of validRecords) {
      const task = taskMap.get(record.taskId)
      const sourceTitle = record.task?.requirement?.source?.title || task?.requirement?.source?.title || '未标记标准文档'
      const basisTitle = record.task?.requirement?.title || task?.requirement?.title || '未标记生成内容'
      const sourceKey = record.task?.requirement?.source?.id || task?.requirement?.source?.id || 'unknown-source'
      const basisKey = record.requirementId || task?.requirementId || 'unknown-basis'
      const sourceNode = bySource.get(sourceKey) ?? { title: sourceTitle, basis: new Map() }
      const basisNode = sourceNode.basis.get(basisKey) ?? { title: basisTitle, tasks: new Map() }
      const taskNode = basisNode.tasks.get(record.taskId) ?? { title: task?.title || record.task?.title || record.title || record.taskId, records: [] }
      taskNode.records.push(record)
      basisNode.tasks.set(record.taskId, taskNode)
      sourceNode.basis.set(basisKey, basisNode)
      bySource.set(sourceKey, sourceNode)
    }

    const treeData = Array.from(bySource.entries()).map(([sourceId, source]) => ({
      title: `标准文档：${source.title}`,
      key: `source:${sourceId}`,
      disableCheckbox: true,
      children: Array.from(source.basis.entries()).map(([basisId, basis]) => ({
        title: `生成内容：${basis.title}`,
        key: `basis:${basisId}`,
        disableCheckbox: true,
        children: Array.from(basis.tasks.entries()).map(([taskId, task]) => ({
          title: `任务：${task.title}（${task.records.length} 条记录）`,
          key: `task:${taskId}`,
          children: task.records.map((record) => ({
            title: `执行记录：${record.title}`,
            key: `record:${record.id}`,
          })),
        })),
      })),
    }))

    return (
      <Tree
        checkable
        checkStrictly
        selectable={false}
        checkedKeys={packageSelectionKeys}
        onCheck={(keys) => {
          const next = Array.isArray(keys) ? keys : keys.checked
          setPackageSelectionKeys(next)
        }}
        treeData={treeData}
        style={{ maxHeight, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, background: '#f8fafc' }}
      />
    )
  }

  const renderTree = (tree: TreeNode[]) => {
    const treeData = tree.map((s, si) => ({
      title: <b>标准文档：{s.source.title}</b>,
      key: `s-${si}`,
      children: s.requirements.map((r, ri) => ({
        title: <span>生成内容：{r.requirement.clauseNo ? `[${r.requirement.clauseNo}] ` : ''}{r.requirement.title}</span>,
        key: `r-${si}-${ri}`,
        children: r.tasks.map((t, ti) => ({
          title: <span>任务：{t.task.title}</span>,
          key: `t-${si}-${ri}-${ti}`,
          children: t.submissions.map((sub, sbi) => ({
            title: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space>
                  <b>提交 v{sub.submission.version}</b>
                  <Tag>{sub.record.status === 'VOID' ? <span style={{ color: '#cf1322' }}>记录已作废</span> : '记录有效'}</Tag>
                </Space>
                <div style={{ color: '#666', fontSize: 12, whiteSpace: 'pre-wrap' }}>{sub.submission.submitText}</div>
                {sub.reviewLogs.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {sub.reviewLogs.map((log) => (
                      <div key={log.id} style={{ fontSize: 12, color: '#666' }}>
                        <Tag color={log.action === 'APPROVE' ? 'green' : 'red'}>{REVIEW_ACTION_LABEL[log.action] || log.action}</Tag>
                        {dayjs(log.createdAt).format('MM-DD HH:mm')} {log.comment && `— ${log.comment}`}
                      </div>
                    ))}
                  </div>
                )}
                {sub.attachments.length > 0 && (
                  <List size="small" dataSource={sub.attachments} renderItem={(a) => (
                    <List.Item style={{ padding: '4px 0' }}>
                      <a href={a.fileUrl} target="_blank" rel="noreferrer">{a.fileName}</a>
                    </List.Item>
                  )} />
                )}
              </Space>
            ),
            key: `sub-${si}-${ri}-${ti}-${sbi}`,
          })),
        })),
      })),
    }))
    return <Tree treeData={treeData} defaultExpandAll selectable={false} />
  }

  const renderCreateForm = (compact = false) => (
    <Form
      form={createForm}
      layout="vertical"
      initialValues={{ packageScene: 'CUSTOMER_AUDIT', format: 'ZIP' }}
      style={compact ? { display: 'flex', flexDirection: 'column', flex: 1 } : undefined}
    >
      <Form.Item name="title" label="审计包标题" rules={[{ required: true, message: '必填' }]}>
        <Input maxLength={200} placeholder="安全生产验厂包" style={compact ? compactControlStyle : undefined} />
      </Form.Item>
      <div style={compact ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 } : undefined}>
        <Form.Item name="packageScene" label="审计包场景" rules={[{ required: true, message: '必填' }]}>
          <Select options={SCENE_OPTIONS} style={compact ? { ...compactControlStyle, width: '100%' } : undefined} />
        </Form.Item>
        <Form.Item name="format" label="导出格式">
          <Select options={FORMAT_OPTIONS.filter((item) => item.value)} style={compact ? { ...compactControlStyle, width: '100%' } : undefined} />
        </Form.Item>
      </div>
      {selectedCreateScene && (
        <Alert
          type="info"
          showIcon
          message={PACKAGE_SCENE_DISPLAY_LABEL[selectedCreateScene] || selectedCreateScene}
          description={PACKAGE_SCENE_DESCRIPTION[selectedCreateScene] || PACKAGE_SCENE_DESCRIPTION.OTHER}
          style={{ marginBottom: 16 }}
        />
      )}
      <Form.Item name="auditRange" label="审计时间范围">
        <RangePicker style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="description" label="备注说明">
        <TextArea rows={compact ? 2 : 3} maxLength={2000} placeholder="用于封面页说明本次审计目的、范围或注意事项。" />
      </Form.Item>
      <Form.Item label={compact ? '选择材料范围' : '材料范围（仅解析 VALID 执行记录）'} required>
        {validRecords.length > 0 ? renderSelectionTree(compact ? 268 : 360) : (
          <Alert type="info" showIcon message="暂无可选的有效执行记录" />
        )}
      </Form.Item>
      {compact && (
        <>
          <div style={{ ...packageCompletenessStyle, marginTop: 4 }}>
            覆盖率 82% · 缺少 3 条高风险相关材料
          </div>
          <Space style={{ marginTop: 'auto', justifyContent: 'flex-end', paddingTop: 28 }}>
            <Button onClick={handleCreate} style={{ ...compactControlStyle, width: 92 }}>保存草稿</Button>
            <Button type="primary" autoInsertSpace={false} onClick={handleCreate} style={{ ...compactControlStyle, width: 92 }}>生成</Button>
          </Space>
        </>
      )}
    </Form>
  )

  return (
    <div style={isEnterprise ? enterprisePageStyle : undefined}>
      <Space style={{ marginBottom: isEnterprise ? 32 : 16, justifyContent: 'space-between', width: '100%' }} wrap>
        {!isEnterprise && (
          <div>
            <Title level={4} style={{ margin: 0 }}>审计包管理</Title>
            <Text type="secondary">按场景组织执行记录与附件，生成可下载、可追溯的审计包。</Text>
          </div>
        )}
        <Space wrap align="end">
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>搜索审计包</div>}
            <Input.Search placeholder={isEnterprise ? '标题 / 场景' : '搜索标题'} value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={load} style={{ width: isEnterprise ? 240 : 200 }} allowClear />
          </div>
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>场景</div>}
            <Select options={[{ value: '', label: '全部场景' }, ...SCENE_OPTIONS]} value={filterScene} onChange={(v) => { setPage(1); setFilterScene(v) }} style={{ width: isEnterprise ? 160 : 140 }} />
          </div>
          {isEnterprise ? (
            <div>
              <div style={fieldLabelStyle}>格式</div>
              <Select options={FORMAT_OPTIONS} value={filterFormat} onChange={(v) => { setPage(1); setFilterFormat(v) }} style={{ width: 110 }} />
            </div>
          ) : (
            <Select options={STATUS_OPTIONS} value={filterStatus} onChange={(v) => { setPage(1); setFilterStatus(v) }} style={{ width: 140 }} />
          )}
          {!isEnterprise && <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>}
          {!isEnterprise && <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>新建审计包</Button>}
          {isEnterprise && <div style={{ width: 404 }} />}
          {isEnterprise && <Button type="primary" onClick={() => openCreate()} style={{ ...compactControlStyle, width: 124 }}>新建审计包</Button>}
        </Space>
      </Space>

      <div>
        <div style={{ width: '100%' }}>
          {selectedKeys.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#475569', fontWeight: 600 }}>已选 {selectedKeys.length} 个审计包</span>
              <Space wrap>
                <Button size="small" danger disabled={selectedKeys.length === 0} onClick={handleBatchVoid}>批量作废</Button>
                <Button size="small" type="text" onClick={() => setSelectedKeys([])}>取消选择</Button>
              </Space>
            </div>
          )}

          <div style={isEnterprise ? { ...packageTableShellStyle, width: '100%' } : { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
            <Table
              rowKey="id"
              size="small"
              rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
              loading={loading}
              dataSource={items}
              locale={{ emptyText: <div style={{ padding: '24px 0', color: '#8a93a3' }}>还没有审计包，点击「新建审计包」选择有效执行记录创建审计包</div> }}
              pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
              columns={[
                { title: '审计包', dataIndex: 'title', ellipsis: true, width: isEnterprise ? 150 : undefined, render: (v: string) => <span style={{ color: '#0f172a', fontSize: 12, fontWeight: 500 }}>{v}</span> },
                { title: '场景', dataIndex: 'packageScene', width: isEnterprise ? 100 : 120, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{PACKAGE_SCENE_DISPLAY_LABEL[v] || PACKAGE_SCENE_LABEL[v] || v}</span> },
                { title: '状态', dataIndex: 'status', width: isEnterprise ? 78 : 96, render: (v: string) => isEnterprise ? <span style={{ color: '#475569', fontSize: 12 }}>{PACKAGE_STATUS_LABEL[v] || v}</span> : <Tag color={PACKAGE_STATUS_COLOR[v]}>{PACKAGE_STATUS_LABEL[v]}</Tag> },
                { title: '格式', dataIndex: 'format', width: isEnterprise ? 64 : 82, render: (v: string) => isEnterprise ? <span style={{ color: '#475569', fontSize: 12 }}>{FORMAT_LABEL[v] || v || '多文件'}</span> : <Tag>{FORMAT_LABEL[v] || v || '多文件'}</Tag> },
                { title: '生成时间', dataIndex: 'generatedAt', width: isEnterprise ? 108 : 112, render: (v: string | null) => <span style={{ color: '#475569', fontSize: 12 }}>{v ? dayjs(v).format('MM-DD HH:mm') : '-'}</span> },
                {
                  title: '操作', width: isEnterprise ? 118 : 240, render: (_: unknown, row: SePackage) => (
                    <Space size={0} split={isEnterprise ? <span style={{ color: '#cbd5e1' }}>/</span> : <Divider type="vertical" />} wrap={!isEnterprise}>
                      {row.status === 'READY' && outputFilesOf(row).length > 0 && <Button size="small" type="link" onClick={() => openDetail(row.id)}>下载</Button>}
                      {(row.status === 'DRAFT' || row.status === 'READY') && <Button size="small" type="link" autoInsertSpace={false} onClick={() => handleGenerate(row)}>生成</Button>}
                      <Button size="small" type="link" onClick={() => openDetail(row.id)}>{row.status === 'READY' && outputFilesOf(row).length > 0 ? '查看' : '详情'}</Button>
                      {!isEnterprise && (row.status === 'DRAFT' || row.status === 'READY') && <Button size="small" type="link" danger onClick={() => handleVoid(row)}>作废</Button>}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </div>

      <Drawer title={detail?.title} open={detailOpen} onClose={closeDetail} width={760} extra={detail && (
        <Space>
          <Button size="small" onClick={() => triggerAsk(`审计包：${detail.title}｜状态：${detail.status}`, '还缺哪些材料？')}>问小智：还缺哪些材料？</Button>
        </Space>
      )}>
        {detail && (
          <>
            <Space style={{ marginBottom: 12 }}>
              <Tag color={PACKAGE_STATUS_COLOR[detail.status]}>{PACKAGE_STATUS_LABEL[detail.status]}</Tag>
              <Tag>{PACKAGE_SCENE_DISPLAY_LABEL[detail.packageScene] || PACKAGE_SCENE_LABEL[detail.packageScene]}</Tag>
              {detail.generatedAt && <span style={{ color: '#666' }}>生成于 {dayjs(detail.generatedAt).format('YYYY-MM-DD HH:mm')}</span>}
            </Space>
            {detail.hasInvalidRecord && (
              <Alert style={{ marginBottom: 12 }} type="warning" message="该审计包中包含已作废的执行记录，建议重新生成。" showIcon />
            )}
            <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="审计时间范围">
                {[detail.dateFrom ? dayjs(detail.dateFrom).format('YYYY-MM-DD') : null, detail.dateTo ? dayjs(detail.dateTo).format('YYYY-MM-DD') : null].filter(Boolean).join(' ~ ') || '未设置'}
              </Descriptions.Item>
              <Descriptions.Item label="备注说明">{detail.description || '无'}</Descriptions.Item>
            </Descriptions>
            {outputFilesOf(detail).length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Text strong>输出文件</Typography.Text>
                <List
                  size="small"
                  dataSource={outputFilesOf(detail)}
                  renderItem={(file) => (
                    <List.Item
                      actions={[
                        <Button key="download" size="small" icon={<DownloadOutlined />} onClick={() => handleDownloadOutputFile(detail, file)}>下载</Button>,
                      ]}
                    >
                      <List.Item.Meta
                        title={<span>{file.label} <Tag>{file.kind}</Tag>{!file.required && <Tag color="blue">可选</Tag>}</span>}
                        description={`${file.path} · ${formatBytes(file.size)}`}
                      />
                    </List.Item>
                  )}
                />
              </div>
            )}
            {renderTree(detail.tree)}
          </>
        )}
      </Drawer>

      <Drawer
        title={previewPackage ? `审计包预览：${previewPackage.title}` : '审计包预览'}
        open={previewOpen}
        onClose={() => { if (!generating) setPreviewOpen(false) }}
        width={820}
        extra={(
          <Space>
            <Button onClick={() => setPreviewOpen(false)} disabled={generating}>返回调整选入记录</Button>
            <Button onClick={() => setPreviewOpen(false)} disabled={generating}>保存草稿</Button>
            <Button type="primary" loading={generating} disabled={!preview || previewLoading} onClick={handleConfirmGenerate}>确认生成</Button>
          </Space>
        )}
      >
        {previewLoading && !preview ? (
          <Alert type="info" showIcon message="正在生成预览" />
        ) : preview ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="报告标题">{preview.cover.reportTitle}</Descriptions.Item>
              <Descriptions.Item label="生成人">{preview.cover.generatedBy}</Descriptions.Item>
              <Descriptions.Item label="选入记录">{preview.stats.recordCount}</Descriptions.Item>
              <Descriptions.Item label="覆盖任务">{preview.stats.taskCount}</Descriptions.Item>
              <Descriptions.Item label="覆盖生成内容">{preview.stats.requirementCount}</Descriptions.Item>
              <Descriptions.Item label="标准文档">{preview.stats.sourceCount}</Descriptions.Item>
              <Descriptions.Item label="附件总数">{preview.stats.attachmentCount}</Descriptions.Item>
              <Descriptions.Item label="估算大小">{formatBytes(preview.estimatedOutputSize)}</Descriptions.Item>
            </Descriptions>

            <div>
              <Typography.Text strong>V2 可选内容</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  {V2_OPTION_LABEL.map((item) => (
                    <Checkbox
                      key={item.key}
                      checked={generationOptions[item.key]}
                      disabled={previewLoading || generating}
                      onChange={(e) => handleToggleGenerationOption(item.key, e.target.checked)}
                    >
                      {item.label}
                    </Checkbox>
                  ))}
                </Space>
              </div>
            </div>

            <div>
              <Typography.Text strong>输出目录结构</Typography.Text>
              <List
                size="small"
                dataSource={preview.outputFileTree}
                renderItem={(file) => (
                  <List.Item>
                    <Space>
                      <Tag>{file.kind}</Tag>
                      <span>{file.path}</span>
                      {!file.required && <Tag color="blue">可选</Tag>}
                    </Space>
                  </List.Item>
                )}
              />
            </div>

            {preview.missingAttachments.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`发现 ${preview.missingAttachments.length} 条缺失附件提醒`}
                description={(
                  <List
                    size="small"
                    dataSource={preview.missingAttachments}
                    renderItem={(item) => <List.Item>{item.recordTitle} / {item.taskTitle}：{item.reason}</List.Item>}
                  />
                )}
              />
            )}

            <div>
              <Typography.Text strong>报告正文结构</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Space wrap>{preview.bodySections.map((section) => <Tag key={section}>{section}</Tag>)}</Space>
              </div>
            </div>

            <div>
              <Typography.Text strong>证据附件索引预览</Typography.Text>
              <Table
                size="small"
                rowKey={(row) => `${row.relativePath}-${row.fileName}`}
                dataSource={preview.attachmentIndexPreview}
                pagination={false}
                scroll={{ x: 720, y: 220 }}
                columns={[
                  { title: '文件名', dataIndex: 'fileName', width: 180, ellipsis: true },
                  { title: '类型', dataIndex: 'type', width: 80 },
                  { title: '大小', dataIndex: 'size', width: 90, render: (v: number | null) => formatBytes(v) },
                  { title: '上传人', dataIndex: 'uploadedBy', width: 110 },
                  { title: '关联任务', dataIndex: 'taskTitle', width: 180, ellipsis: true },
                  { title: '关联记录', dataIndex: 'recordTitle', width: 180, ellipsis: true },
                ]}
              />
            </div>
          </Space>
        ) : (
          <Alert type="info" showIcon message="暂无预览数据" />
        )}
      </Drawer>

      <Modal title="新建审计包" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={handleCreate} width={760} okText="创建">
        {renderCreateForm(false)}
      </Modal>
    </div>
  )
}
