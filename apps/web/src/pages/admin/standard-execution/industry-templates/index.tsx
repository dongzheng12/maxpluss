import { useEffect, useState } from 'react'
import { Button, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd'
import { PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  INDUSTRY_TEMPLATE_CATEGORY_LABEL,
  INDUSTRY_TEMPLATE_STATUS_COLOR,
  INDUSTRY_TEMPLATE_STATUS_LABEL,
  seCreateIndustryTemplate,
  seCreateIndustryTemplateFromRequirements,
  seGetIndustryTemplate,
  seListIndustryTemplates,
  seOfflineIndustryTemplate,
  sePublishIndustryTemplate,
  seUpdateIndustryTemplate,
  type IndustryTemplate,
  type IndustryTemplateCategory,
  type IndustryTemplateInput,
  type IndustryTemplateItem,
  type IndustryTemplateStatus,
} from '../../../../api/standardExecution'

const { Title, Text } = Typography
const { TextArea } = Input

const CATEGORY_OPTIONS = Object.entries(INDUSTRY_TEMPLATE_CATEGORY_LABEL).map(([value, label]) => ({ value, label }))
const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  ...Object.entries(INDUSTRY_TEMPLATE_STATUS_LABEL).map(([value, label]) => ({ value, label })),
]

function parseItemsText(text: string): IndustryTemplateInput['items'] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|').map((part) => part.trim())
      if (parts.length >= 3) {
        return { clauseNo: parts[0] || null, title: parts[1], requirementText: parts.slice(2).join('|') }
      }
      if (parts.length === 2) {
        return { title: parts[0], requirementText: parts[1] }
      }
      return { title: line, requirementText: line }
    })
}

function stringifyItems(items: IndustryTemplateItem[] = []) {
  return items
    .map((item) => [item.clauseNo || '', item.title, item.requirementText].join('|'))
    .join('\n')
}

export default function SeIndustryTemplatesPage() {
  const [items, setItems] = useState<IndustryTemplate[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [industryCategory, setIndustryCategory] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [editOpen, setEditOpen] = useState(false)
  const [editRow, setEditRow] = useState<IndustryTemplate | null>(null)
  const [detailRow, setDetailRow] = useState<IndustryTemplate | null>(null)
  const [fromOpen, setFromOpen] = useState(false)
  const [form] = Form.useForm()
  const [fromForm] = Form.useForm()
  const pageSize = 20

  const load = async () => {
    setLoading(true)
    try {
      const res = await seListIndustryTemplates({
        keyword: keyword || undefined,
        industryCategory: industryCategory || undefined,
        status: status || undefined,
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

  useEffect(() => { load() }, [page, industryCategory, status])

  const openCreate = () => {
    setEditRow(null)
    form.resetFields()
    form.setFieldsValue({ industryCategory: 'GENERAL', itemsText: '' })
    setEditOpen(true)
  }

  const openEdit = async (row: IndustryTemplate) => {
    try {
      const res = await seGetIndustryTemplate(row.id)
      setEditRow(res.data)
      form.setFieldsValue({
        ...res.data,
        itemsText: stringifyItems(res.data.items),
      })
      setEditOpen(true)
    } catch {
      message.error('加载模板失败')
    }
  }

  const openDetail = async (row: IndustryTemplate) => {
    try {
      const res = await seGetIndustryTemplate(row.id)
      setDetailRow(res.data)
    } catch {
      message.error('加载模板失败')
    }
  }

  const submitEdit = async () => {
    try {
      const values = await form.validateFields()
      const parsedItems = parseItemsText(values.itemsText || '')
      if (parsedItems.length === 0) {
        message.warning('请至少录入 1 条控制点')
        return
      }
      const payload: IndustryTemplateInput = {
        industryCategory: values.industryCategory,
        title: values.title,
        sourceNo: values.sourceNo || null,
        version: values.version || null,
        description: values.description || null,
        items: parsedItems,
      }
      if (editRow) {
        await seUpdateIndustryTemplate(editRow.id, payload)
        message.success('已更新')
      } else {
        await seCreateIndustryTemplate(payload)
        message.success('已创建')
      }
      setEditOpen(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const submitFromRequirements = async () => {
    try {
      const values = await fromForm.validateFields()
      await seCreateIndustryTemplateFromRequirements({
        enterpriseId: values.enterpriseId || 'DEFAULT',
        requirementIds: values.requirementIds,
        industryCategory: values.industryCategory,
        title: values.title,
        sourceNo: values.sourceNo || null,
        version: values.version || null,
        description: values.description || null,
      })
      message.success('已保存为模板')
      setFromOpen(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '保存失败')
    }
  }

  const transition = async (row: IndustryTemplate, action: 'publish' | 'offline') => {
    try {
      if (action === 'publish') await sePublishIndustryTemplate(row.id)
      else await seOfflineIndustryTemplate(row.id)
      message.success(action === 'publish' ? '已发布' : '已下线')
      load()
    } catch {
      message.error('操作失败')
    }
  }

  return (
    <div>
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 16 }} wrap>
        <div>
          <Title level={4} style={{ margin: 0 }}>行业模板库</Title>
          <Text type="secondary">沉淀可复用的行业控制点模板，发布后企业可导入。</Text>
        </div>
        <Space wrap>
          <Input.Search placeholder="搜索模板/编号" value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={() => { setPage(1); load() }} allowClear style={{ width: 210 }} />
          <Select options={[{ value: '', label: '全部行业' }, ...CATEGORY_OPTIONS]} value={industryCategory} onChange={(v) => { setIndustryCategory(v); setPage(1) }} style={{ width: 150 }} />
          <Select options={STATUS_OPTIONS} value={status} onChange={(v) => { setStatus(v); setPage(1) }} style={{ width: 120 }} />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          <Button icon={<SaveOutlined />} onClick={() => { fromForm.resetFields(); fromForm.setFieldsValue({ enterpriseId: 'DEFAULT', industryCategory: 'GENERAL' }); setFromOpen(true) }}>保存为模板</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建模板</Button>
        </Space>
      </Space>

      <Table<IndustryTemplate>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
        columns={[
          { title: '模板名称', dataIndex: 'title', ellipsis: true },
          { title: '行业', dataIndex: 'industryCategory', width: 110, render: (v: IndustryTemplateCategory) => <Tag>{INDUSTRY_TEMPLATE_CATEGORY_LABEL[v]}</Tag> },
          { title: '标准编号', dataIndex: 'sourceNo', width: 150, render: (v: string | null) => v || '-' },
          { title: '版本', dataIndex: 'version', width: 90, render: (v: string | null) => v || '-' },
          { title: '控制点', dataIndex: 'controlPointCount', width: 90 },
          { title: '状态', dataIndex: 'status', width: 100, render: (v: IndustryTemplateStatus) => <Tag color={INDUSTRY_TEMPLATE_STATUS_COLOR[v]}>{INDUSTRY_TEMPLATE_STATUS_LABEL[v]}</Tag> },
          { title: '更新时间', dataIndex: 'updatedAt', width: 145, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
          {
            title: '操作', width: 230,
            render: (_: unknown, row) => (
              <Space split={<span style={{ color: '#e2e8f0' }}>|</span>} wrap>
                <Button size="small" type="link" onClick={() => openDetail(row)}>预览</Button>
                <Button size="small" type="link" onClick={() => openEdit(row)}>编辑</Button>
                {row.status !== 'PUBLISHED' && <Button size="small" type="link" onClick={() => transition(row, 'publish')}>发布</Button>}
                {row.status === 'PUBLISHED' && (
                  <Popconfirm title="确认下线该模板？" onConfirm={() => transition(row, 'offline')}>
                    <Button size="small" type="link" danger>下线</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editRow ? '编辑行业模板' : '新建行业模板'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={submitEdit}
        okText="保存"
        width={760}
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="title" label="模板名称" rules={[{ required: true, message: '必填' }]}><Input maxLength={200} /></Form.Item>
            <Form.Item name="industryCategory" label="行业分类" rules={[{ required: true, message: '必填' }]}><Select options={CATEGORY_OPTIONS} /></Form.Item>
            <Form.Item name="sourceNo" label="标准编号"><Input maxLength={120} /></Form.Item>
            <Form.Item name="version" label="版本"><Input maxLength={80} /></Form.Item>
          </div>
          <Form.Item name="description" label="说明"><TextArea rows={2} maxLength={2000} /></Form.Item>
          <Form.Item name="itemsText" label="控制点条目" rules={[{ required: true, message: '必填' }]}>
            <TextArea rows={10} placeholder="条款号|标题|要求正文，每行一条" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="从企业控制点保存为模板"
        open={fromOpen}
        onCancel={() => setFromOpen(false)}
        onOk={submitFromRequirements}
        okText="保存"
        width={680}
      >
        <Form form={fromForm} layout="vertical">
          <Form.Item name="enterpriseId" label="企业 ID" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
          <Form.Item name="requirementIds" label="控制点 IDs" rules={[{ required: true, message: '必填' }]}>
            <Select mode="tags" tokenSeparators={[',', '，', '\n']} placeholder="粘贴或输入 requirementId 后回车" />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="title" label="模板名称" rules={[{ required: true, message: '必填' }]}><Input maxLength={200} /></Form.Item>
            <Form.Item name="industryCategory" label="行业分类" rules={[{ required: true, message: '必填' }]}><Select options={CATEGORY_OPTIONS} /></Form.Item>
            <Form.Item name="sourceNo" label="标准编号"><Input maxLength={120} /></Form.Item>
            <Form.Item name="version" label="版本"><Input maxLength={80} /></Form.Item>
          </div>
          <Form.Item name="description" label="说明"><TextArea rows={2} maxLength={2000} /></Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detailRow?.title || '模板预览'}
        open={!!detailRow}
        width={720}
        onClose={() => setDetailRow(null)}
      >
        {detailRow && (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              <Tag>{INDUSTRY_TEMPLATE_CATEGORY_LABEL[detailRow.industryCategory]}</Tag>
              <Tag color={INDUSTRY_TEMPLATE_STATUS_COLOR[detailRow.status]}>{INDUSTRY_TEMPLATE_STATUS_LABEL[detailRow.status]}</Tag>
              {detailRow.sourceNo && <Tag>{detailRow.sourceNo}</Tag>}
              {detailRow.version && <Tag>{detailRow.version}</Tag>}
            </Space>
            {detailRow.description && <div style={{ color: '#475569', marginBottom: 16 }}>{detailRow.description}</div>}
            <Table<IndustryTemplateItem>
              size="small"
              rowKey="id"
              dataSource={detailRow.items || []}
              pagination={false}
              columns={[
                { title: '条款号', dataIndex: 'clauseNo', width: 100, render: (v: string | null) => v || '-' },
                { title: '标题', dataIndex: 'title', width: 180 },
                { title: '要求正文', dataIndex: 'requirementText' },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  )
}
