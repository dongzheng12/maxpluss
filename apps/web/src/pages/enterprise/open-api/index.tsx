import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Table, Tag, Typography, message } from 'antd'
import { KeyOutlined, LinkOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  ENTERPRISE_API_SCOPE_LABEL,
  ENTERPRISE_WEBHOOK_EVENT_LABEL,
  seCreateEnterpriseApiKey,
  seCreateEnterpriseWebhook,
  seDisableEnterpriseWebhook,
  seListEnterpriseApiKeys,
  seListEnterpriseWebhooks,
  seRevokeEnterpriseApiKey,
  type EnterpriseApiKey,
  type EnterpriseApiScope,
  type EnterpriseWebhook,
  type EnterpriseWebhookEvent,
} from '../../../api/standardExecution'

const { Text, Paragraph } = Typography

const scopeOptions = (Object.keys(ENTERPRISE_API_SCOPE_LABEL) as EnterpriseApiScope[]).map((value) => ({
  label: ENTERPRISE_API_SCOPE_LABEL[value],
  value,
}))

const eventOptions = (Object.keys(ENTERPRISE_WEBHOOK_EVENT_LABEL) as EnterpriseWebhookEvent[]).map((value) => ({
  label: ENTERPRISE_WEBHOOK_EVENT_LABEL[value],
  value,
}))

function timeText(value?: string | null) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
}

export default function EnterpriseOpenApiPage() {
  const [keys, setKeys] = useState<EnterpriseApiKey[]>([])
  const [webhooks, setWebhooks] = useState<EnterpriseWebhook[]>([])
  const [loading, setLoading] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [webhookOpen, setWebhookOpen] = useState(false)
  const [keyForm] = Form.useForm()
  const [webhookForm] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const [keyRes, webhookRes] = await Promise.all([
        seListEnterpriseApiKeys(),
        seListEnterpriseWebhooks(),
      ])
      setKeys(keyRes.data)
      setWebhooks(webhookRes.data)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '加载开放 API 设置失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreateKey = async () => {
    try {
      const values = await keyForm.validateFields()
      const res = await seCreateEnterpriseApiKey({
        name: values.name,
        scopes: values.scopes,
        expiresAt: values.expiresAt || null,
      })
      setKeyOpen(false)
      keyForm.resetFields()
      await load()
      Modal.info({
        title: 'API Key 已创建',
        width: 680,
        content: (
          <div>
            <Paragraph>请现在保存，关闭后不会再次显示。</Paragraph>
            <Text code copyable style={{ wordBreak: 'break-all' }}>{res.plainKey}</Text>
          </div>
        ),
      })
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const handleCreateWebhook = async () => {
    try {
      const values = await webhookForm.validateFields()
      const res = await seCreateEnterpriseWebhook({ url: values.url, events: values.events })
      setWebhookOpen(false)
      webhookForm.resetFields()
      await load()
      Modal.info({
        title: 'Webhook 已创建',
        width: 680,
        content: (
          <div>
            <Paragraph>签名密钥仅本次展示，用于校验 X-BXZ-Signature。</Paragraph>
            <Text code copyable style={{ wordBreak: 'break-all' }}>{res.secret}</Text>
          </div>
        ),
      })
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const revokeKey = (row: EnterpriseApiKey) => {
    Modal.confirm({
      title: `吊销 API Key「${row.name}」？`,
      content: '吊销后外部系统将立即无法继续使用该 Key。',
      okButtonProps: { danger: true },
      onOk: async () => {
        await seRevokeEnterpriseApiKey(row.id)
        message.success('已吊销')
        load()
      },
    })
  }

  const disableWebhook = (row: EnterpriseWebhook) => {
    Modal.confirm({
      title: '停用 Webhook？',
      content: row.url,
      okButtonProps: { danger: true },
      onOk: async () => {
        await seDisableEnterpriseWebhook(row.id)
        message.success('已停用')
        load()
      },
    })
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Alert
        type="info"
        showIcon
        message="开放 API 用于外部 ERP/MES/LIMS 系统推送执行数据、读取任务和接收合规事件通知。"
      />

      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <Space>
            <KeyOutlined />
            <strong>API Key</strong>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { keyForm.resetFields(); keyForm.setFieldsValue({ scopes: ['records:write'] }); setKeyOpen(true) }}>
              创建 Key
            </Button>
          </Space>
        </div>
        <Table<EnterpriseApiKey>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={keys}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name', ellipsis: true },
            {
              title: '权限',
              dataIndex: 'scopes',
              render: (scopes: EnterpriseApiScope[]) => <Space size={4} wrap>{scopes.map((scope) => <Tag key={scope}>{ENTERPRISE_API_SCOPE_LABEL[scope]}</Tag>)}</Space>,
            },
            { title: '最近使用', dataIndex: 'lastUsedAt', width: 150, render: timeText },
            { title: '过期时间', dataIndex: 'expiresAt', width: 150, render: timeText },
            { title: '状态', dataIndex: 'isActive', width: 86, render: (active: boolean) => active ? <Tag color="green">启用</Tag> : <Tag>已吊销</Tag> },
            {
              title: '操作',
              width: 90,
              render: (_: unknown, row) => row.isActive ? <Button size="small" danger type="link" onClick={() => revokeKey(row)}>吊销</Button> : '-',
            },
          ]}
        />
      </section>

      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <Space>
            <LinkOutlined />
            <strong>Webhook</strong>
          </Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { webhookForm.resetFields(); webhookForm.setFieldsValue({ events: ['record.created'] }); setWebhookOpen(true) }}>
            创建 Webhook
          </Button>
        </div>
        <Table<EnterpriseWebhook>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={webhooks}
          pagination={false}
          columns={[
            { title: 'URL', dataIndex: 'url', ellipsis: true },
            {
              title: '事件',
              dataIndex: 'events',
              render: (events: EnterpriseWebhookEvent[]) => <Space size={4} wrap>{events.map((event) => <Tag key={event}>{ENTERPRISE_WEBHOOK_EVENT_LABEL[event]}</Tag>)}</Space>,
            },
            { title: '最近触发', dataIndex: 'lastTriggeredAt', width: 150, render: timeText },
            { title: '状态', dataIndex: 'isActive', width: 86, render: (active: boolean) => active ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag> },
            {
              title: '操作',
              width: 90,
              render: (_: unknown, row) => row.isActive ? <Button size="small" danger type="link" onClick={() => disableWebhook(row)}>停用</Button> : '-',
            },
          ]}
        />
      </section>

      <Modal title="创建 API Key" open={keyOpen} onCancel={() => setKeyOpen(false)} onOk={handleCreateKey} okText="创建">
        <Form form={keyForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={80} placeholder="如：MES 生产线推送" />
          </Form.Item>
          <Form.Item name="scopes" label="权限" rules={[{ required: true, message: '请选择权限' }]}>
            <Checkbox.Group options={scopeOptions} />
          </Form.Item>
          <Form.Item name="expiresAt" label="过期时间">
            <Input placeholder="可选，ISO 时间，例如 2026-12-31T23:59:59.000Z" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="创建 Webhook" open={webhookOpen} onCancel={() => setWebhookOpen(false)} onOk={handleCreateWebhook} okText="创建">
        <Form form={webhookForm} layout="vertical">
          <Form.Item name="url" label="Endpoint URL" rules={[{ required: true, message: '请输入 URL' }]}>
            <Input maxLength={500} placeholder="https://example.com/bxz-webhook" />
          </Form.Item>
          <Form.Item name="events" label="事件" rules={[{ required: true, message: '请选择事件' }]}>
            <Checkbox.Group options={eventOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
