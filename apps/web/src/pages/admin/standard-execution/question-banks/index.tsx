/**
 * 题库管理页
 * 路径：/admin/standard-execution/question-banks
 * 企业路径：/enterprise/standard-execution/question-banks
 */
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  Table, Button, Space, Input, Typography, Tag, Drawer, Form, Select,
  message, Modal, Divider, InputNumber, Checkbox,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, MinusCircleOutlined, RobotOutlined } from '@ant-design/icons'
import {
  seListQuestionBanks,
  seGetQuestionBank,
  seCreateQuestionBank,
  seUpdateQuestionBank,
  seDeleteQuestionBank,
  seListQuestionBanksEnterprise,
  seGetQuestionBankEnterprise,
  seCreateQuestionBankEnterprise,
  seUpdateQuestionBankEnterprise,
  seDeleteQuestionBankEnterprise,
  seAiGenerateQuestions,
  type QuestionBank,
  type QuizQuestion,
} from '../../../../api/standardExecution'

const { Title, Text } = Typography

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
const tableShellStyle: CSSProperties = {
  width: 640,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
}
function genId() {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

const EMPTY_QUESTION: QuizQuestion = {
  id: genId(),
  type: 'single',
  text: '',
  opts: ['', ''],
  answer: [],
  score: 20,
  exp: '',
}

// 判断题启发式：DB 不单独存判断题类型，按「正确/错误」两选项识别（仅展示用）
const isJudgeQuestion = (q: QuizQuestion) => q.opts.length === 2 && q.opts[0] === '正确' && q.opts[1] === '错误'

const relatedBasisCount = (bank: QuestionBank) => (
  new Set((bank.questions || []).map((q) => q.relatedRequirementId).filter(Boolean)).size
)

export default function QuestionBanksPage() {
  const loc = useLocation()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const apiList = isEnterprise ? seListQuestionBanksEnterprise : seListQuestionBanks
  const apiGet = isEnterprise ? seGetQuestionBankEnterprise : seGetQuestionBank
  const apiCreate = isEnterprise ? seCreateQuestionBankEnterprise : seCreateQuestionBank
  const apiUpdate = isEnterprise ? seUpdateQuestionBankEnterprise : seUpdateQuestionBank
  const apiDelete = isEnterprise ? seDeleteQuestionBankEnterprise : seDeleteQuestionBank

  const [items, setItems] = useState<QuestionBank[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editRow, setEditRow] = useState<QuestionBank | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewRow, setPreviewRow] = useState<QuestionBank | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  // local question list in drawer (managed outside antd Form.List for simplicity)
  const [questions, setQuestions] = useState<QuizQuestion[]>([{ ...EMPTY_QUESTION, id: genId() }])

  // P1-9 AI 生成题目
  const [aiOpen, setAiOpen] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiCount, setAiCount] = useState(5)
  const [aiType, setAiType] = useState<'SINGLE' | 'MULTI' | 'TRUEFALSE'>('SINGLE')
  const [aiDiff, setAiDiff] = useState<'BASIC' | 'MEDIUM' | 'HARD'>('BASIC')
  const [aiPreview, setAiPreview] = useState<QuizQuestion[] | null>(null)
  const [aiSelectedIds, setAiSelectedIds] = useState<string[]>([])
  const [aiRequirementId, setAiRequirementId] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const handleAiGenerate = async () => {
    if (!aiRequirementId && !aiText.trim()) { message.warning('请输入出题内容（标准文档或生成内容）'); return }
    setAiLoading(true)
    try {
      const res = await seAiGenerateQuestions(
        aiRequirementId
          ? { requirementId: aiRequirementId, count: aiCount, questionType: aiType, difficulty: aiDiff }
          : { requirementText: aiText.trim(), count: aiCount, questionType: aiType, difficulty: aiDiff },
      )
      setAiPreview(res.data.questions)
      setAiSelectedIds(res.data.questions.map((q) => q.id)) // 默认全选，用户可逐题勾掉
      if (!res.data.questions.length) message.info('AI 未生成有效题目，请调整内容后重试')
    } catch (e: unknown) {
      message.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'AI 生成失败')
    } finally { setAiLoading(false) }
  }
  const handleAiApply = () => {
    if (!aiPreview?.length) return
    const picked = aiPreview.filter((q) => aiSelectedIds.includes(q.id))
    if (!picked.length) { message.warning('请至少勾选一道题再加入'); return }
    setQuestions((prev) => {
      // 若当前只有 1 道空白初始题，直接用 AI 题目替换，否则追加
      const base = prev.length === 1 && !prev[0].text.trim() ? [] : prev
      return [...base, ...picked.map((q) => ({ ...q, id: genId() }))]
    })
    if (!drawerOpen) {
      setEditRow(null)
      form.setFieldsValue({ title: '', description: '' })
      setDrawerOpen(true)
    }
    message.success(`已加入 ${picked.length} 道 AI 生成题目`)
    setAiOpen(false)
    setAiPreview(null)
  }

  const openAiCreate = () => {
    openCreate()
    setAiPreview(null)
    setAiRequirementId(null)
    setAiText('')
    setAiOpen(true)
  }

  const load = async () => {
    setLoading(true)
    try {
      const res = await apiList({ keyword: keyword || undefined, page, pageSize: 20 })
      setItems(res.data ?? [])
      setTotal(res.total ?? 0)
    } catch { message.error('加载失败') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [page, keyword]) // eslint-disable-line

  // 从生成内容详情跳转进来：自动开新建抽屉 + AI 弹窗，基于该内容出题
  useEffect(() => {
    const reqId = searchParams.get('requirementId')
    if (reqId) {
      openCreate()
      setAiRequirementId(reqId)
      setAiText(searchParams.get('requirementTitle') || '')
      setAiPreview(null)
      setAiOpen(true)
      setSearchParams({}, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => {
    setEditRow(null)
    form.setFieldsValue({ title: '', description: '' })
    setQuestions([{ ...EMPTY_QUESTION, id: genId() }])
    setDrawerOpen(true)
  }

  const openEdit = async (row: QuestionBank) => {
    try {
      const bank = await apiGet(row.id)
      setEditRow(bank)
      form.setFieldsValue({ title: bank.title, description: bank.description ?? '' })
      setQuestions(bank.questions.length ? bank.questions : [{ ...EMPTY_QUESTION, id: genId() }])
      setDrawerOpen(true)
    } catch { message.error('加载题库详情失败') }
  }

  const openPreview = async (row: QuestionBank) => {
    try {
      const bank = await apiGet(row.id)
      setPreviewRow(bank)
      setPreviewOpen(true)
    } catch { message.error('加载题库预览失败') }
  }

  const handleDelete = (row: QuestionBank) => {
    Modal.confirm({
      title: `删除题库「${row.title}」？`,
      content: '若有进行中任务已关联此题库，删除将被拒绝。',
      okType: 'danger',
      okText: '删除',
      onOk: async () => {
        try {
          await apiDelete(row.id)
          message.success('已删除')
          load()
        } catch (e: unknown) {
          message.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || '删除失败')
        }
      },
    })
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    if (questions.length === 0) { message.warning('至少添加 1 道题目'); return }
    for (const q of questions) {
      if (!q.text.trim()) { message.warning('题目内容不能为空'); return }
      if (q.opts.some((o) => !o.trim())) { message.warning('选项不能为空'); return }
      if (q.answer.length === 0) { message.warning('请设置正确答案'); return }
    }
    setSaving(true)
    try {
      const payload = { title: values.title, description: values.description || null, questions }
      if (editRow) {
        await apiUpdate(editRow.id, payload)
        message.success('已更新')
      } else {
        await apiCreate(payload)
        message.success('已创建')
      }
      setDrawerOpen(false)
      load()
    } catch (e: unknown) {
      message.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || '保存失败')
    } finally { setSaving(false) }
  }

  // ── 题目编辑辅助函数 ──────────────────────────────────────────────────────
  const updateQ = (idx: number, patch: Partial<QuizQuestion>) => {
    setQuestions((prev) => prev.map((q, i) => i === idx ? { ...q, ...patch } : q))
  }
  const addOpt = (idx: number) => {
    setQuestions((prev) => prev.map((q, i) => i === idx ? { ...q, opts: [...q.opts, ''] } : q))
  }
  const removeOpt = (qIdx: number, oIdx: number) => {
    setQuestions((prev) => prev.map((q, i) => {
      if (i !== qIdx) return q
      const opts = q.opts.filter((_, oi) => oi !== oIdx)
      const answer = q.answer.filter((a) => a !== oIdx).map((a) => a > oIdx ? a - 1 : a)
      return { ...q, opts, answer }
    }))
  }
  const toggleAnswer = (qIdx: number, oIdx: number) => {
    setQuestions((prev) => prev.map((q, i) => {
      if (i !== qIdx) return q
      if (q.type === 'single') return { ...q, answer: [oIdx] }
      const has = q.answer.includes(oIdx)
      return { ...q, answer: has ? q.answer.filter((a) => a !== oIdx) : [...q.answer, oIdx].sort((a, b) => a - b) }
    }))
  }
  const addQuestion = () => {
    setQuestions((prev) => [...prev, { ...EMPTY_QUESTION, id: genId() }])
  }
  const removeQuestion = (idx: number) => {
    setQuestions((prev) => prev.filter((_, i) => i !== idx))
  }

  const metrics = useMemo(() => {
    const questionTotal = items.reduce((sum, item) => sum + (item.questionCount ?? item.questions?.length ?? 0), 0)
    const linkedTasks = items.reduce((sum, item) => sum + (item.taskCount ?? 0), 0)
    const linkedBasis = items.reduce((sum, item) => sum + relatedBasisCount(item), 0)
    return [
      { label: '题库', value: total, hint: '当前企业题库', color: '#2563eb' },
      { label: '题目', value: questionTotal, hint: '可用于学习确认', color: '#16a34a' },
      { label: '关联生成内容', value: linkedBasis, hint: '来自标准文档', color: '#7c3aed' },
      { label: '关联任务', value: linkedTasks, hint: '已被任务使用', color: '#d97706' },
    ]
  }, [items, total])

  const columns = [
    {
      title: '题库名称',
      dataIndex: 'title',
      key: 'title',
      render: (v: string, row: QuestionBank) => (
        <div>
          <Text strong>{v}</Text>
          {row.description && <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{row.description}</div>}
        </div>
      ),
    },
    { title: '关联生成内容', key: 'basis', width: 120, render: (_: unknown, row: QuestionBank) => <Tag color={relatedBasisCount(row) ? 'purple' : 'default'}>{relatedBasisCount(row) || '未关联'}</Tag> },
    { title: '题目数', dataIndex: 'questionCount', key: 'questionCount', width: 90, render: (v: number, row: QuestionBank) => <Tag>{v ?? row.questions?.length ?? 0} 题</Tag> },
    { title: '关联任务', dataIndex: 'taskCount', key: 'taskCount', width: 90, render: (v: number) => <Tag color={v > 0 ? 'blue' : 'default'}>{v || 0} 个</Tag> },
    { title: '状态', key: 'status', width: 100, render: (_: unknown, row: QuestionBank) => <Tag color={(row.taskCount ?? 0) > 0 ? 'green' : 'default'}>{(row.taskCount ?? 0) > 0 ? '使用中' : '未使用'}</Tag> },
    {
      title: '操作', key: 'action', width: 190,
      render: (_: unknown, row: QuestionBank) => (
        <Space>
          <Button size="small" onClick={() => openPreview(row)}>预览</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)} />
        </Space>
      ),
    },
  ]

  const enterpriseColumns = [
    {
      title: '题库名称',
      dataIndex: 'title',
      width: 145,
      ellipsis: true,
      render: (v: string) => <span style={{ color: '#0f172a', fontSize: 12, fontWeight: 500 }}>{v}</span>,
    },
    {
      title: '关联生成内容',
      width: 145,
      ellipsis: true,
      render: (_: unknown, row: QuestionBank) => (
        <span style={{ color: '#475569', fontSize: 12 }}>
          {relatedBasisCount(row) ? `${relatedBasisCount(row)} 项生成内容` : '未关联'}
        </span>
      ),
    },
    {
      title: '题目数',
      dataIndex: 'questionCount',
      width: 70,
      render: (v: number, row: QuestionBank) => <span style={{ color: '#475569', fontSize: 12 }}>{v ?? row.questions?.length ?? 0}</span>,
    },
    { title: '通过分', width: 70, render: () => <span style={{ color: '#475569', fontSize: 12 }}>80</span> },
    {
      title: '状态',
      width: 80,
      render: (_: unknown, row: QuestionBank) => (
        <span style={{ color: '#475569', fontSize: 12 }}>{(row.questionCount ?? row.questions?.length ?? 0) > 0 ? '启用' : '草稿'}</span>
      ),
    },
    {
      title: '操作',
      width: 152,
      render: (_: unknown, row: QuestionBank) => (
        <Space size={0} split={<span style={{ color: '#cbd5e1' }}>/</span>}>
          <Button size="small" type="link" onClick={() => openEdit(row)}>编辑</Button>
          <Button size="small" type="link" onClick={() => openPreview(row)}>预览</Button>
          <Button size="small" type="link" danger onClick={() => handleDelete(row)}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <div style={isEnterprise ? enterprisePageStyle : { padding: 24 }}>
      {isEnterprise && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 22 }}>
          {metrics.map((item) => (
            <div key={item.label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, borderLeft: `4px solid ${item.color}`, padding: '14px 16px', minHeight: 92 }}>
              <div style={{ color: '#64748b', fontSize: 12 }}>{item.label}</div>
              <div style={{ color: '#0f172a', fontSize: 26, fontWeight: 800, lineHeight: 1.2 }}>{item.value}</div>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>{item.hint}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: isEnterprise ? 24 : 14 }}>
        {!isEnterprise && <Title level={4} style={{ margin: 0 }}>题库管理</Title>}
        <Space align="end" wrap style={{ width: isEnterprise ? '100%' : undefined }}>
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>搜索题库</div>}
            <Input.Search
              placeholder={isEnterprise ? '题库名称 / 生成内容' : '搜索题库名称'}
              allowClear
              style={{ width: isEnterprise ? 240 : 220 }}
              onSearch={(v) => { setKeyword(v); setPage(1) }}
            />
          </div>
          {isEnterprise && <div style={{ flex: 1, minWidth: 360 }} />}
          <Button icon={<RobotOutlined />} onClick={openAiCreate}>AI 生成题目</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建题库</Button>
        </Space>
      </div>

      {isEnterprise ? (
        <div style={{ ...tableShellStyle, width: '100%' }}>
            <Table
              rowKey="id"
              size="small"
              columns={enterpriseColumns}
              dataSource={items}
              loading={loading}
              locale={{ emptyText: '暂无题库，可使用 AI 生成题目或新建题库。' }}
              pagination={{ current: page, pageSize: 20, total, onChange: setPage, showTotal: (t) => `共 ${t} 个` }}
            />
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
            {metrics.map((item) => (
              <div key={item.label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, borderLeft: `4px solid ${item.color}`, padding: '12px 14px' }}>
                <div style={{ color: '#64748b', fontSize: 12 }}>{item.label}</div>
                <div style={{ color: '#0f172a', fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{item.value}</div>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>{item.hint}</div>
              </div>
            ))}
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
            <Table
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={items}
              loading={loading}
              locale={{ emptyText: '暂无题库，可先使用 AI 生成题目或新建题库；已有题库可在列表中预览。' }}
              pagination={{ current: page, pageSize: 20, total, onChange: setPage, showTotal: (t) => `共 ${t} 个` }}
            />
          </div>
        </>
      )}

      <Drawer
        title={editRow ? '编辑题库' : '新建题库'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={700}
        extra={<Button type="primary" loading={saving} onClick={handleSave}>保存</Button>}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="题库名称" rules={[{ required: true, message: '必填' }]}>
            <Input maxLength={200} placeholder="如：Q2 操作规范培训考核题库" />
          </Form.Item>
          <Form.Item name="description" label="说明（选填）">
            <Input.TextArea maxLength={1000} rows={2} />
          </Form.Item>
        </Form>

        <Divider>题目列表（{questions.length} 题，共 {questions.reduce((s, q) => s + q.score, 0)} 分）</Divider>

        {questions.map((q, qi) => (
          <div key={q.id} style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: 16, marginBottom: 16, background: '#fafafa' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>第 {qi + 1} 题</Text>
              <Space>
                <Select
                  size="small"
                  value={q.type}
                  onChange={(v) => updateQ(qi, { type: v, answer: [] })}
                  options={[{ value: 'single', label: '单选题' }, { value: 'multi', label: '多选题' }]}
                  style={{ width: 90 }}
                />
                <span style={{ fontSize: 12, color: '#888' }}>分值</span>
                <InputNumber size="small" min={1} max={100} value={q.score} onChange={(v) => updateQ(qi, { score: v ?? 10 })} style={{ width: 60 }} />
                {questions.length > 1 && (
                  <Button size="small" danger icon={<MinusCircleOutlined />} onClick={() => removeQuestion(qi)} />
                )}
              </Space>
            </div>

            <Input.TextArea
              rows={2}
              placeholder="题目内容"
              value={q.text}
              onChange={(e) => updateQ(qi, { text: e.target.value })}
              style={{ marginBottom: 8 }}
            />

            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
              选项（点击字母设为正确答案；{q.type === 'single' ? '单选' : '多选'}）
            </div>
            {q.opts.map((opt, oi) => {
              const label = String.fromCharCode(65 + oi)
              const isCorrect = q.answer.includes(oi)
              return (
                <div key={oi} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <Button
                    size="small"
                    type={isCorrect ? 'primary' : 'default'}
                    style={{ minWidth: 28, flexShrink: 0 }}
                    onClick={() => toggleAnswer(qi, oi)}
                  >{label}</Button>
                  <Input
                    size="small"
                    value={opt}
                    onChange={(e) => {
                      const opts = [...q.opts]; opts[oi] = e.target.value
                      updateQ(qi, { opts })
                    }}
                    placeholder={`选项 ${label}`}
                  />
                  {q.opts.length > 2 && (
                    <MinusCircleOutlined style={{ color: '#999', cursor: 'pointer' }} onClick={() => removeOpt(qi, oi)} />
                  )}
                </div>
              )
            })}
            {q.opts.length < 8 && (
              <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addOpt(qi)} style={{ marginBottom: 8 }}>
                添加选项
              </Button>
            )}

            <Input
              size="small"
              placeholder="解析说明（选填，答完题后展示）"
              value={q.exp ?? ''}
              onChange={(e) => updateQ(qi, { exp: e.target.value })}
              style={{ marginTop: 4 }}
            />
          </div>
        ))}

        <Space direction="vertical" style={{ width: '100%' }}>
          <Button type="dashed" block icon={<PlusOutlined />} onClick={addQuestion}>
            添加题目
          </Button>
          <Button type="dashed" block icon={<RobotOutlined />} onClick={() => { setAiPreview(null); setAiRequirementId(null); setAiText(''); setAiOpen(true) }} style={{ borderColor: '#722ed1', color: '#722ed1' }}>
            AI 生成题目
          </Button>
        </Space>
      </Drawer>

      <Drawer
        title={previewRow ? `题库预览：${previewRow.title}` : '题库预览'}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={680}
      >
        {previewRow && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Space wrap>
              <Tag>{previewRow.questionCount ?? previewRow.questions?.length ?? 0} 题</Tag>
              <Tag color={relatedBasisCount(previewRow) ? 'purple' : 'default'}>关联生成内容 {relatedBasisCount(previewRow) || 0}</Tag>
              <Tag color={(previewRow.taskCount ?? 0) > 0 ? 'blue' : 'default'}>关联任务 {previewRow.taskCount ?? 0}</Tag>
            </Space>
            {previewRow.description && <Text type="secondary">{previewRow.description}</Text>}
            {(previewRow.questions || []).length ? (
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                {previewRow.questions.map((q, index) => (
                  <div key={q.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#fff' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                      <Text strong>{index + 1}. {q.text}</Text>
                      <Tag>{isJudgeQuestion(q) ? '判断题' : q.type === 'multi' ? '多选题' : '单选题'}</Tag>
                    </div>
                    {q.opts.map((opt, optIndex) => (
                      <div key={optIndex} style={{ color: q.answer.includes(optIndex) ? '#16a34a' : '#475569', fontSize: 13, padding: '2px 0' }}>
                        {String.fromCharCode(65 + optIndex)}. {opt}{q.answer.includes(optIndex) ? ' / 正确答案' : ''}
                      </div>
                    ))}
                    {q.exp && <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>解析：{q.exp}</div>}
                  </div>
                ))}
              </Space>
            ) : (
              <Text type="secondary">暂无题目</Text>
            )}
          </Space>
        )}
      </Drawer>

      <Modal
        title="AI 生成题目"
        open={aiOpen}
        onCancel={() => setAiOpen(false)}
        width={640}
        footer={null}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea rows={4} value={aiText} onChange={(e) => setAiText(e.target.value)} placeholder="粘贴标准文档或生成内容作为出题内容…" maxLength={5000} showCount />
          <Space wrap>
            <span style={{ fontSize: 13 }}>题量</span>
            <InputNumber min={1} max={20} value={aiCount} onChange={(v) => setAiCount(v ?? 5)} style={{ width: 70 }} />
            <Select value={aiType} onChange={setAiType} style={{ width: 110 }} options={[{ value: 'SINGLE', label: '单选题' }, { value: 'MULTI', label: '多选题' }, { value: 'TRUEFALSE', label: '判断题' }]} />
            <Select value={aiDiff} onChange={setAiDiff} style={{ width: 100 }} options={[{ value: 'BASIC', label: '基础' }, { value: 'MEDIUM', label: '中等' }, { value: 'HARD', label: '较难' }]} />
            <Button type="primary" loading={aiLoading} onClick={handleAiGenerate}>生成</Button>
          </Space>
          {aiPreview && (
            <>
              <Divider style={{ margin: '8px 0' }}>预览（{aiPreview.length} 题，已选 {aiSelectedIds.length}）· 勾选后加入题库</Divider>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {aiPreview.map((q, i) => {
                  const checked = aiSelectedIds.includes(q.id)
                  return (
                    <div key={q.id} style={{ border: '1px solid #eee', borderRadius: 6, padding: 10, marginBottom: 8, background: checked ? '#fff' : '#f5f5f5' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                        <Checkbox
                          checked={checked}
                          onChange={(e) => setAiSelectedIds((prev) => e.target.checked ? [...prev, q.id] : prev.filter((x) => x !== q.id))}
                        />
                        <span style={{ fontWeight: 500, flex: 1 }}>{i + 1}. {q.text}</span>
                        <Tag color={isJudgeQuestion(q) ? 'gold' : q.type === 'multi' ? 'blue' : 'default'}>
                          {isJudgeQuestion(q) ? '判断题' : q.type === 'multi' ? '多选题' : '单选题'}
                        </Tag>
                      </div>
                      {q.opts.map((o, oi) => (
                        <div key={oi} style={{ color: q.answer.includes(oi) ? '#52c41a' : '#666', fontSize: 13, paddingLeft: 24 }}>
                          {String.fromCharCode(65 + oi)}. {o}{q.answer.includes(oi) ? ' ✓' : ''}
                        </div>
                      ))}
                      {q.exp && <div style={{ color: '#999', fontSize: 12, marginTop: 4, paddingLeft: 24 }}>解析：{q.exp}</div>}
                    </div>
                  )
                })}
              </div>
              <Button type="primary" block disabled={!aiSelectedIds.length} onClick={handleAiApply}>加入题库（{aiSelectedIds.length} 题）</Button>
              <Text type="secondary" style={{ fontSize: 12 }}>AI 生成内容仅供参考，加入后请人工复核题目与答案。</Text>
            </>
          )}
        </Space>
      </Modal>
    </div>
  )
}
