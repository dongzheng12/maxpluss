/**
 * PC Web 用户端 — 专家投票申请表（4 步流程）
 *
 * Steps：
 *   1. 项目信息
 *   2. 专家与会议
 *   3. 材料上传
 *   4. 确认并支付
 *
 * - 删除 targetName 字段（提交时自动 = projectName）
 * - 删除"具体专业关键词" expertKeywords 字段（提交时自动 = keywords）
 * - 价格走 GET /api/app/expert-votes/pricing
 * - sticky 底部操作栏，page 内部预留 padding-bottom
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Card, Form, Input, InputNumber, Select, DatePicker, Button, Space, Switch, Upload,
  Typography, message, Spin, Divider, Alert, Tag, Steps, Descriptions, Row, Col,
} from 'antd'
import { PlusOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { nodeApi } from '../../api/client'
import {
  createExpertVoteDraft, updateExpertVoteDraft, getExpertVote,
  submitExpertVote, deleteExpertVoteAttachment, getExpertVotePricing,
  type ExpertVotePricing,
} from '../../api/app'
import { useAccess } from '../../hooks/useAccess'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

const PROJECT_TYPES = ['标准评审', '专家投票', '项目论证', '成果评价', '技术咨询', '其他']
const STANDARD_TYPES = ['国家标准', '行业标准', '地方标准', '团体标准', '企业标准', '技术规范', '其他']
const STANDARD_STATUSES = ['立项前', '已立项', '起草中', '征求意见后', '送审稿', '报批前', '已发布', '复审中']
const INDUSTRIES = ['机械', '能源', '核工业', '化工', '电子信息', '食品', '医疗', '建材', '其他']
const EXPERT_CATEGORIES = [
  '标准化专家', '行业技术专家', '检测认证专家', '法规合规专家',
  '高校科研专家', '企业实践专家', '质量管理专家', '安全专家', '环保/绿色低碳专家',
]
const TITLE_REQS = ['不限', '高工', '正高', '教授', '研究员', '其他']
const ORG_BG_REQS = ['不限', '高校', '科研院所', '检测认证机构', '行业协会', '企业', '其他']

const normalizeExpertCount = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

const isValidExpertCount = (value: unknown) => {
  const count = normalizeExpertCount(value)
  return count !== null && count >= 3 && count % 2 === 1
}

const STEP_FIELDS: Record<number, string[]> = {
  0: ['contactName', 'contactPhone',
      'projectName', 'projectType', 'standardType', 'standardStatus', 'industries',
      'keywords', 'draftingOrgs', 'participatingOrgs', 'backgroundDesc', 'disputePoints',
      'confidentialLevel', 'confidentialRemark'],
  1: ['expertSourceType', 'expertCategories', 'titleRequirements', 'orgBackgroundRequirements',
      'expertCount', 'extraExpertNote', 'userSpecifiedExperts',
      'desiredDate', 'desiredSlot', 'acceptReschedule', 'backupTimeNote'],
  2: ['materialRemark'],
  3: [],
}

interface AttachmentRow {
  id?: string
  uid: string
  name: string
  size: number
  category: 'MAIN' | 'EXTRA'
  status: 'done' | 'pending'
  rawFile?: File
}

export default function ExpertVoteNewPage() {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const editNo = search.get('no') || ''
  const { requireLogin } = useAccess()

  const [form] = Form.useForm()
  const [loading, setLoading] = useState(!!editNo)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState(0)
  const [no, setNo] = useState<string>(editNo)
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  const [pricing, setPricing] = useState<ExpertVotePricing | null>(null)
  const [pricingError, setPricingError] = useState(false)
  // 专家数量：预设 or 自定义
  const [expertCountMode, setExpertCountMode] = useState<'preset' | 'custom'>('preset')

  // 用 form watch 触发金额实时刷新
  const expertCount = Form.useWatch('expertCount', form)

  const minDesiredDate = useMemo(() => {
    const days = pricing?.minLeadDays || 14
    return dayjs().startOf('day').add(days, 'day')
  }, [pricing])

  useEffect(() => {
    if (!requireLogin()) return
    // 拉价格
    getExpertVotePricing().then((p) => {
      setPricing(p)
      if (p.error) setPricingError(true)
    }).catch(() => setPricingError(true))

    if (editNo) {
      // eslint-disable-next-line react-hooks/immutability
      loadDraft()
    } else {
      form.setFieldsValue({
        confidentialLevel: 'NONE',
        expertSourceType: 'PLATFORM',
        titleRequirements: ['不限'],
        orgBackgroundRequirements: ['不限'],
        expertCount: 5,
        acceptReschedule: true,
        desiredSlot: 'ANY',
      })
    }
    // eslint-disable-next-line
  }, [editNo])

  const loadDraft = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await getExpertVote(editNo)
      if (d.status !== 'DRAFT') {
        message.warning('该申请已提交，无法编辑')
        navigate(`/expert-vote/${editNo}`, { replace: true })
        return
      }
      setNo(editNo)
      form.setFieldsValue({
        projectName: d.projectName,
        projectType: d.projectType,
        standardType: d.standardType,
        standardStatus: d.standardStatus,
        industries: d.industries || [],
        keywords: d.keywords,
        draftingOrgs: d.draftingOrgs,
        participatingOrgs: d.participatingOrgs,
        backgroundDesc: d.backgroundDesc,
        disputePoints: d.disputePoints,
        confidentialLevel: d.confidentialLevel || 'NONE',
        confidentialRemark: d.confidentialRemark,
        expertSourceType: d.expertSourceType || 'PLATFORM',
        expertCategories: d.expertCategories || [],
        titleRequirements: d.titleRequirements?.length ? d.titleRequirements : ['不限'],
        orgBackgroundRequirements: d.orgBackgroundRequirements?.length ? d.orgBackgroundRequirements : ['不限'],
        expertCount: d.expertCount || 5,
        contactName: d.contactName || '',
        contactPhone: d.contactPhone || '',
        extraExpertNote: d.extraExpertNote,
        userSpecifiedExperts: d.userSpecifiedExperts,
        desiredDate: d.desiredDate ? dayjs(d.desiredDate) : null,
        desiredSlot: d.desiredSlot || 'ANY',
        acceptReschedule: d.acceptReschedule !== false,
        backupTimeNote: d.backupTimeNote,
        materialRemark: d.materialRemark,
      })
      // 回填专家数量模式
      if (d.expertCount && ![3, 5, 7, 9].includes(d.expertCount)) {
        setExpertCountMode('custom')
      }
      setAttachments(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (d.attachments || []).map((a: any): AttachmentRow => ({
          id: a.id, uid: a.id, name: a.originalName, size: a.size,
          category: a.category === 'EXTRA' ? 'EXTRA' : 'MAIN', status: 'done',
        })),
      )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载草稿失败')
    }
    setLoading(false)
  }

  // ⚠️ 字段必须与 services/api/src/services/expertVote.ts REQUIRED_FIELDS_ON_SUBMIT 保持一致
  // 必填字段：contactName / contactPhone / projectName / targetName / projectType /
  //           standardType / standardStatus / backgroundDesc / expertSourceType /
  //           expertCount / desiredDate / desiredSlot
  // 漏发任一字段 → submit 时后端 assertDraftSubmittable 抛"缺少必填项"，UI 上是 400
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildPayload = (values: any) => {
    const projectName = values.projectName?.trim() || ''
    const keywords = values.keywords?.trim() || undefined
    return {
      contactName: values.contactName?.trim() || undefined,
      contactPhone: values.contactPhone?.trim() || undefined,
      projectName,
      // 后端字段保留：targetName 兜底等于 projectName，避免 schema 改动
      targetName: projectName,
      projectType: values.projectType,
      standardType: values.standardType,
      standardStatus: values.standardStatus,
      industries: values.industries || [],
      keywords,
      draftingOrgs: values.draftingOrgs?.trim() || undefined,
      participatingOrgs: values.participatingOrgs?.trim() || undefined,
      backgroundDesc: values.backgroundDesc?.trim(),
      disputePoints: values.disputePoints?.trim() || undefined,
      confidentialLevel: values.confidentialLevel,
      confidentialRemark: values.confidentialRemark?.trim() || undefined,
      expertSourceType: values.expertSourceType,
      expertCategories: values.expertCategories || [],
      // 具体专业关键词废弃；后端 expertKeywords 用同一个 keywords 兜底
      expertKeywords: keywords,
      titleRequirements: values.titleRequirements?.length ? values.titleRequirements : ['不限'],
      orgBackgroundRequirements: values.orgBackgroundRequirements?.length ? values.orgBackgroundRequirements : ['不限'],
      expertCount: normalizeExpertCount(values.expertCount) ?? values.expertCount,
      extraExpertNote: values.extraExpertNote?.trim() || undefined,
      userSpecifiedExperts: values.userSpecifiedExperts?.trim() || undefined,
      desiredDate: values.desiredDate ? (values.desiredDate as Dayjs).toISOString() : undefined,
      desiredSlot: values.desiredSlot,
      acceptReschedule: values.acceptReschedule !== false,
      backupTimeNote: values.backupTimeNote?.trim() || undefined,
      materialRemark: values.materialRemark?.trim() || undefined,
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsertDraft = async (values: any): Promise<string> => {
    const payload = buildPayload(values)
    if (no) {
      await updateExpertVoteDraft(no, payload)
      return no
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created: any = await createExpertVoteDraft(payload)
    if (!created?.requestNo) throw new Error('创建草稿失败')
    setNo(created.requestNo)
    return created.requestNo
  }

  const uploadPending = async (targetNo: string): Promise<void> => {
    const pending = attachments.filter((a) => a.status === 'pending' && a.rawFile)
    for (const att of pending) {
      const fd = new FormData()
      fd.append('file', att.rawFile as File)
      fd.append('category', att.category)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await nodeApi.post(`/api/app/expert-votes/${targetNo}/attachments`, fd)
      setAttachments((prev) => prev.map((p) => p.uid === att.uid
        ? { ...p, id: r.id, uid: r.id, status: 'done' as const, rawFile: undefined }
        : p))
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const validateFull = (values: any): string | null => {
    if (!values.contactName?.trim()) return '请填写申请人姓名'
    if (!/^1[3-9]\d{9}$/.test(values.contactPhone || '')) return '请填写有效的申请人电话'
    if (!values.projectName?.trim()) return '请填写评审项目名称'
    if (!values.projectType) return '请选择项目类型'
    if (!values.standardType) return '请选择标准类型'
    if (!values.standardStatus) return '请选择标准状态'
    if (!values.industries?.length) return '请至少选择一个所属行业'
    if (!values.backgroundDesc?.trim()) return '请填写项目背景说明'
    if ((values.confidentialLevel === 'SENSITIVE' || values.confidentialLevel === 'STRICT')
        && !values.confidentialRemark?.trim()) return '涉密项目请填写保密要求说明'
    if (!values.expertCategories?.length) return '请至少选择一类专家类别'
    if (!isValidExpertCount(values.expertCount))
      return '专家数量必须为奇数且不少于 3 位'
    if (values.expertSourceType === 'USER_SPECIFIED' && !values.userSpecifiedExperts?.trim())
      return '请填写指定专家说明'
    if (!values.desiredDate) return '请选择期望会议日期'
    if ((values.desiredDate as Dayjs).isBefore(minDesiredDate)) {
      return `期望会议日期需提前 ${pricing?.minLeadDays || 14} 天以上`
    }
    if (!values.desiredSlot) return '请选择期望时间段'
    return null
  }

  const handleNext = async () => {
    try {
      // 单步必填校验：使用 antd validateFields(filed[])
      await form.validateFields(STEP_FIELDS[step])
      // 第 1 步加 confidentialRemark 条件校验
      if (step === 0) {
        const v = form.getFieldsValue()
        if ((v.confidentialLevel === 'SENSITIVE' || v.confidentialLevel === 'STRICT')
            && !v.confidentialRemark?.trim()) {
          return message.warning('涉密项目请填写保密要求说明')
        }
      }
      // 第 2 步：14 天校验
      if (step === 1) {
        const v = form.getFieldsValue()
        if (v.desiredDate && (v.desiredDate as Dayjs).isBefore(minDesiredDate)) {
          return message.warning(`期望会议日期需提前 ${pricing?.minLeadDays || 14} 天以上`)
        }
      }
      // 第 3 步：主要材料必填
      if (step === 2) {
        const mainCount = attachments.filter((a) => a.category === 'MAIN').length
        if (mainCount === 0) return message.warning('请至少上传一份主要材料')
      }
      setStep((s) => Math.min(3, s + 1))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    } catch (_e: any) {
      // antd 校验已弹错；这里不重复 toast
    }
  }

  const handlePrev = () => setStep((s) => Math.max(0, s - 1))

  const handleSaveDraft = async () => {
    try {
      const values = form.getFieldsValue(true)  // 不强制 validate，部分填写也可保存
      if (!values.projectName?.trim()) return message.warning('请至少填写评审项目名称后再保存')
      setSaving(true)
      const targetNo = await upsertDraft(values)
      await uploadPending(targetNo)
      message.success('草稿已保存')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || e?.message || '保存失败')
    }
    setSaving(false)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      const err = validateFull(values)
      if (err) return message.warning(err)
      const mainCount = attachments.filter((a) => a.category === 'MAIN').length
      if (mainCount === 0) return message.warning('请至少上传一份主要材料')
      setSubmitting(true)
      const targetNo = await upsertDraft(values)
      await uploadPending(targetNo)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await submitExpertVote(targetNo)
      message.success('提交成功，进入支付')
      navigate(`/expert-vote/${targetNo}?action=pay&orderNo=${r.order.orderNo}`, { replace: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.error || e?.message || '提交失败')
    }
    setSubmitting(false)
  }

  const handlePickFile = (file: File, category: 'MAIN' | 'EXTRA') => {
    const fileMax = (pricing?.fileMaxMb || 50) * 1024 * 1024
    if (file.size > fileMax) {
      message.warning(`${file.name} 超过单文件大小限制 ${pricing?.fileMaxMb || 50}MB`)
      return false
    }
    const uid = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setAttachments((prev) => [...prev, {
      uid, name: file.name, size: file.size, category, status: 'pending', rawFile: file,
    }])
    return false
  }

  const handleRemove = async (att: AttachmentRow) => {
    if (att.status === 'pending') {
      setAttachments((prev) => prev.filter((p) => p.uid !== att.uid))
      return
    }
    if (!no || !att.id) return
    try {
      await deleteExpertVoteAttachment(no, att.id)
      setAttachments((prev) => prev.filter((p) => p.uid !== att.uid))
      message.success('已删除')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '删除失败')
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>

  const mainAtts = attachments.filter((a) => a.category === 'MAIN')
  const extraAtts = attachments.filter((a) => a.category === 'EXTRA')
  const allValues = form.getFieldsValue(true)

  const estimateAmount = pricing && expertCount
    ? expertCount * pricing.unitPriceYuan
    : null

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', paddingBottom: 100 }}>
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/expert-vote')}>返回列表</Button>
        <Title level={4} style={{ margin: 0 }}>发起专家评审投票申请</Title>
      </Space>
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        请按步骤填写项目信息、专家需求和评审材料，提交后将按专家数量生成订单，平台将在支付后组织专家并确认会议安排。
      </Paragraph>

      <Card style={{ marginBottom: 16 }}>
        <Steps
          current={step}
          items={[
            { title: '项目信息' },
            { title: '专家与会议' },
            { title: '材料上传' },
            { title: '确认并支付' },
          ]}
        />
      </Card>

      <Form form={form} layout="vertical">
        {/* Step 1: 项目信息 */}
        <div style={{ display: step === 0 ? 'block' : 'none' }}>
          <Card title="申请人信息" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col xs={24} sm={12}>
                <Form.Item
                  label="申请人姓名"
                  name="contactName"
                  rules={[
                    { required: true, message: '请填写申请人姓名' },
                    { min: 2, max: 50, message: '姓名长度 2~50 字符' },
                  ]}
                >
                  <Input placeholder="请输入真实姓名" maxLength={50} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  label="申请人电话"
                  name="contactPhone"
                  rules={[
                    { required: true, message: '请填写申请人电话' },
                    { pattern: /^1[3-9]\d{9}$/, message: '请输入有效的中国大陆手机号' },
                  ]}
                >
                  <Input placeholder="请输入手机号" maxLength={11} />
                </Form.Item>
              </Col>
            </Row>
          </Card>
          <Card title="项目信息" style={{ marginBottom: 16 }}>
            <Form.Item label="评审项目名称" name="projectName" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="如《XXX 团体标准》专家审查会" maxLength={200} />
            </Form.Item>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item label="项目类型" name="projectType" rules={[{ required: true }]} style={{ flex: 1, marginRight: 8 }}>
                <Select options={PROJECT_TYPES.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
              <Form.Item label="标准类型" name="standardType" rules={[{ required: true }]} style={{ flex: 1, marginRight: 8 }}>
                <Select options={STANDARD_TYPES.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
              <Form.Item label="标准状态" name="standardStatus" rules={[{ required: true }]} style={{ flex: 1 }}>
                <Select options={STANDARD_STATUSES.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
            </Space.Compact>
            <Form.Item label="所属行业" name="industries" rules={[{ required: true, message: '至少选一个' }]}>
              <Select mode="multiple" options={INDUSTRIES.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item
              label="专业领域关键词"
              name="keywords"
              extra="用于说明本次评审涉及的细分技术方向，也将作为专家匹配参考。"
            >
              <Input placeholder="如泵、阀门、压力容器、光伏、储能、绿色低碳、智能制造等。" />
            </Form.Item>
            <Form.Item label="起草单位" name="draftingOrgs">
              <Input placeholder="多个用顿号分隔" />
            </Form.Item>
            <Form.Item label="参与单位" name="participatingOrgs">
              <TextArea rows={2} maxLength={2000} />
            </Form.Item>
            <Form.Item label="项目背景说明" name="backgroundDesc" rules={[{ required: true }]}>
              <TextArea rows={4} maxLength={5000} placeholder="为什么要组织专家评审 / 投票" />
            </Form.Item>
            <Form.Item label="主要争议点 / 需专家判断事项" name="disputePoints">
              <TextArea rows={3} maxLength={5000} />
            </Form.Item>
            <Form.Item label="是否涉密 / 敏感" name="confidentialLevel" rules={[{ required: true }]}>
              <Select options={[
                { label: '否', value: 'NONE' },
                { label: '一般敏感', value: 'SENSITIVE' },
                { label: '严格保密', value: 'STRICT' },
              ]} />
            </Form.Item>
            <Form.Item shouldUpdate noStyle>
              {() => {
                const v = form.getFieldValue('confidentialLevel')
                if (v === 'SENSITIVE' || v === 'STRICT') {
                  return (
                    <Form.Item label="保密要求说明" name="confidentialRemark" rules={[{ required: true }]}>
                      <TextArea rows={3} maxLength={2000} />
                    </Form.Item>
                  )
                }
                return null
              }}
            </Form.Item>
          </Card>
        </div>

        {/* Step 2: 专家与会议 */}
        <div style={{ display: step === 1 ? 'block' : 'none' }}>
          <Card title="专家需求" style={{ marginBottom: 16 }}>
            <Form.Item label="专家来源方式" name="expertSourceType" rules={[{ required: true }]}>
              <Select options={[
                { label: '平台匹配', value: 'PLATFORM' },
                { label: '用户指定', value: 'USER_SPECIFIED' },
              ]} />
            </Form.Item>
            <Form.Item label="专家类别" name="expertCategories" rules={[{ required: true }]}>
              <Select mode="multiple" options={EXPERT_CATEGORIES.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item label="职称要求" name="titleRequirements" style={{ flex: 1, marginRight: 8 }}>
                <Select mode="multiple" options={TITLE_REQS.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
              <Form.Item label="单位背景要求" name="orgBackgroundRequirements" style={{ flex: 1 }}>
                <Select mode="multiple" options={ORG_BG_REQS.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
            </Space.Compact>
            {/* 专家数量：预设 3/5/7/9 + 其他（自定义奇数） */}
            <Form.Item
              label="专家数量"
              required
            >
              <Space>
                <Select
                  style={{ width: 160 }}
                  value={expertCountMode === 'custom' ? 'custom' : normalizeExpertCount(expertCount) ?? undefined}
                  options={[
                    ...(pricing?.expertCountOptions || [3, 5, 7, 9]).map((v) => ({ label: `${v} 位`, value: v })),
                    { label: '其他（自定义）', value: 'custom' },
                  ]}
                  onChange={(v) => {
                    if (v === 'custom') {
                      setExpertCountMode('custom')
                      form.setFieldValue('expertCount', undefined)
                    } else {
                      setExpertCountMode('preset')
                      form.setFieldValue('expertCount', v)
                    }
                    void form.validateFields(['expertCount']).catch(() => undefined)
                  }}
                />
                {expertCountMode === 'custom' && (
                  <InputNumber
                    min={3}
                    step={2}
                    style={{ width: 120 }}
                    placeholder="输入奇数"
                    value={normalizeExpertCount(expertCount) ?? undefined}
                    onChange={(v) => {
                      form.setFieldValue('expertCount', normalizeExpertCount(v) ?? undefined)
                      void form.validateFields(['expertCount']).catch(() => undefined)
                    }}
                  />
                )}
                {expertCountMode === 'custom' && (
                  <Text type="secondary" style={{ fontSize: 12 }}>须为奇数，如 11、13…</Text>
                )}
              </Space>
              <Form.Item
                name="expertCount"
                noStyle
                rules={[
                  { required: true, message: '请选择或填写专家数量' },
                  {
                    validator: (_, v) => {
                      if (!v) return Promise.resolve()
                      if (!isValidExpertCount(v)) {
                        return Promise.reject(new Error('专家数量必须为奇数且不少于 3 位'))
                      }
                      return Promise.resolve()
                    },
                  },
                ]}
              >
                <InputNumber style={{ display: 'none' }} />
              </Form.Item>
            </Form.Item>
            <Form.Item label="其他专家要求" name="extraExpertNote">
              <TextArea rows={2} maxLength={2000} />
            </Form.Item>
            <Form.Item shouldUpdate noStyle>
              {() => form.getFieldValue('expertSourceType') === 'USER_SPECIFIED' ? (
                <Form.Item label="指定专家说明" name="userSpecifiedExperts" rules={[{ required: true }]}>
                  <TextArea rows={3} placeholder="姓名 / 单位 / 联系方式 / 指定原因" />
                </Form.Item>
              ) : null}
            </Form.Item>
          </Card>

          <Card title="期望会议时间" style={{ marginBottom: 16 }}>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                label="期望会议日期"
                name="desiredDate"
                rules={[{ required: true }]}
                style={{ flex: 1, marginRight: 8 }}
                extra={`专家组织和材料预审需要时间，最早可预约当前日期 ${pricing?.minLeadDays || 14} 天后的会议。`}
              >
                <DatePicker
                  style={{ width: '100%' }}
                  disabledDate={(d) => d.isBefore(minDesiredDate)}
                />
              </Form.Item>
              <Form.Item label="期望时间段" name="desiredSlot" rules={[{ required: true }]} style={{ flex: 1 }}>
                <Select options={[
                  { label: '上午', value: 'MORNING' },
                  { label: '下午', value: 'AFTERNOON' },
                  { label: '晚上', value: 'EVENING' },
                  { label: '全天均可', value: 'ANY' },
                ]} />
              </Form.Item>
            </Space.Compact>
            <Form.Item label="是否接受调剂" name="acceptReschedule" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="备用时间说明" name="backupTimeNote">
              <TextArea rows={2} maxLength={2000} />
            </Form.Item>
          </Card>
        </div>

        {/* Step 3: 材料 */}
        <div style={{ display: step === 2 ? 'block' : 'none' }}>
          <Card title="材料上传" style={{ marginBottom: 16 }}>
            <Paragraph type="secondary">
              请上传专家评审所需的标准草案、项目说明、技术文件或相关辅助材料。材料越完整，越有利于专家判断。
            </Paragraph>
            <div style={{ marginBottom: 16 }}>
              <Text strong>主要材料 <Text type="danger">*</Text></Text>
              <div style={{ marginTop: 8 }}>
                {mainAtts.map((att) => (
                  <Tag key={att.uid} closable onClose={() => handleRemove(att)} style={{ marginBottom: 8 }}>
                    {att.name} {att.status === 'pending' && '(待上传)'}
                  </Tag>
                ))}
              </div>
              <Upload beforeUpload={(f) => handlePickFile(f, 'MAIN')} showUploadList={false}>
                <Button icon={<PlusOutlined />}>选择主要材料</Button>
              </Upload>
            </div>
            <Divider />
            <div style={{ marginBottom: 16 }}>
              <Text strong>辅助材料</Text>
              <div style={{ marginTop: 8 }}>
                {extraAtts.map((att) => (
                  <Tag key={att.uid} closable onClose={() => handleRemove(att)} style={{ marginBottom: 8 }}>
                    {att.name} {att.status === 'pending' && '(待上传)'}
                  </Tag>
                ))}
              </div>
              <Upload beforeUpload={(f) => handlePickFile(f, 'EXTRA')} showUploadList={false}>
                <Button icon={<PlusOutlined />}>选择辅助材料</Button>
              </Upload>
            </div>
            <Form.Item label="材料说明" name="materialRemark">
              <TextArea rows={2} maxLength={2000} />
            </Form.Item>
            <Text type="secondary">
              单文件不超过 {pricing?.fileMaxMb || 50}MB，总文件不超过 {pricing?.totalMaxMb || 200}MB。
            </Text>
          </Card>
        </div>

        {/* Step 4: 确认并支付 */}
        <div style={{ display: step === 3 ? 'block' : 'none' }}>
          <Card title="申请信息确认" style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
              <Descriptions.Item label="评审项目名称" span={2}>{allValues.projectName || '-'}</Descriptions.Item>
              <Descriptions.Item label="项目类型">{allValues.projectType || '-'}</Descriptions.Item>
              <Descriptions.Item label="标准类型">{allValues.standardType || '-'}</Descriptions.Item>
              <Descriptions.Item label="标准状态">{allValues.standardStatus || '-'}</Descriptions.Item>
              <Descriptions.Item label="所属行业">
                {Array.isArray(allValues.industries) && allValues.industries.length ? allValues.industries.join('、') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="专业领域关键词" span={2}>{allValues.keywords || '-'}</Descriptions.Item>
              <Descriptions.Item label="专家数量">{allValues.expertCount} 位</Descriptions.Item>
              <Descriptions.Item label="专家类别">
                {Array.isArray(allValues.expertCategories) && allValues.expertCategories.length ? allValues.expertCategories.join('、') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="期望会议日期">
                {allValues.desiredDate ? (allValues.desiredDate as Dayjs).format('YYYY-MM-DD') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="期望时间段">
                {allValues.desiredSlot === 'MORNING' ? '上午'
                  : allValues.desiredSlot === 'AFTERNOON' ? '下午'
                  : allValues.desiredSlot === 'EVENING' ? '晚上' : '全天均可'}
              </Descriptions.Item>
              <Descriptions.Item label="材料数量" span={2}>
                主要 {mainAtts.length} 份 / 辅助 {extraAtts.length} 份
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="价格说明" style={{ marginBottom: 16 }}>
            {pricingError ? (
              <Alert type="info" message="价格以提交后订单确认为准。" style={{ marginBottom: 12 }} />
            ) : null}
            <Row gutter={16}>
              <Col xs={12} md={6}>
                <Text type="secondary">专家数量</Text>
                <div style={{ fontSize: 18, fontWeight: 500 }}>{allValues.expertCount || 0} 位</div>
              </Col>
              <Col xs={12} md={6}>
                <Text type="secondary">单专家服务费</Text>
                <div style={{ fontSize: 18, fontWeight: 500 }}>
                  {pricing ? `¥${pricing.unitPriceYuan.toLocaleString()} / 位` : '-'}
                </div>
              </Col>
              <Col xs={24} md={12}>
                <Text type="secondary">预计金额</Text>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#cf1322' }}>
                  {estimateAmount != null ? `¥${estimateAmount.toLocaleString()}` : '-'}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>最终金额以订单确认为准</Text>
              </Col>
            </Row>
          </Card>
        </div>
      </Form>

      {/* Sticky 底部操作栏 */}
      <div
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0,
          background: '#fff', borderTop: '1px solid #f0f0f0',
          padding: '12px 24px', zIndex: 9,
          display: 'flex', justifyContent: 'center',
        }}
      >
        <div style={{ maxWidth: 880, width: '100%', display: 'flex', justifyContent: 'space-between' }}>
          <div>
            {step > 0 && <Button onClick={handlePrev}>上一步</Button>}
          </div>
          <Space>
            <Button onClick={handleSaveDraft} loading={saving}>保存草稿</Button>
            {step < 3 && <Button type="primary" onClick={handleNext}>下一步</Button>}
            {step === 3 && (
              <Button type="primary" onClick={handleSubmit} loading={submitting}>提交并支付</Button>
            )}
          </Space>
        </div>
      </div>
    </div>
  )
}
