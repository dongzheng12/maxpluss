import { useState, useEffect } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Card, Form, Input, Select, Button, Typography, Space, Table, Tag, Modal, message, Tabs } from 'antd'
import { PhoneOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { createBooking, listBookings } from '../../api/app'
import { useAccess } from '../../hooks/useAccess'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

const SERVICE_TYPES = [
  { label: '团体标准', value: '团体标准', desc: '协助完成团体标准立项申请全流程，包括项目论证、专家评审等环节' },
  { label: '企业标准', value: '企业标准', desc: '提供企业标准起草、审查、发布等全流程专业服务' },
  { label: '不确定', value: '不确定', desc: '不确定需求类型，由顾问帮助您分析和推荐' },
]


export default function BookingPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [activeTab, setActiveTab] = useState('book')
  const { requireLogin } = useAccess()

  const loadRecords = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await listBookings()
      setItems(res?.items || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { loadRecords() }, [])

  const handleSubmit = async () => {
    if (!requireLogin()) return
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      await createBooking(values)
      message.success('预约申请已提交，工作人员将尽快与您联系')
      setOpen(false)
      form.resetFields()
      loadRecords()
      setActiveTab('records')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.response?.data?.error) message.error(e.response.data.error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}><PhoneOutlined /> 标准服务预约</Title>
          <Text type="secondary">预约专业标准化服务，涵盖标准立项、编写、审查、培训等环节</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          预约服务
        </Button>
      </Space>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {
          key: 'book',
          label: '服务介绍',
          children: (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {SERVICE_TYPES.map((svc) => (
                <Card key={svc.value} hoverable onClick={() => { form.setFieldValue('demandType', svc.value); setOpen(true) }}>
                  <Card.Meta
                    title={<Tag color="blue">{svc.label}</Tag>}
                    description={
                      <div>
                        <Paragraph style={{ marginBottom: 8 }}>{svc.desc}</Paragraph>
                        <Button type="link" size="small" style={{ padding: 0 }}>立即预约 →</Button>
                      </div>
                    }
                  />
                </Card>
              ))}
            </Space>
          ),
        },
        {
          key: 'records',
          label: '我的预约',
          children: (
            <Card>
              <Button icon={<ReloadOutlined />} onClick={loadRecords} style={{ marginBottom: 16 }}>刷新</Button>
              <Table scroll={{ x: "max-content" }}
                rowKey={(r, i) => r.bookingNo || r.id || `${i}`}
                dataSource={items}
                loading={loading}
                columns={[
                  { title: '预约号', dataIndex: 'bookingNo', width: 180, hidden: isMobile },
                  { title: '需求类型', dataIndex: 'demandType', width: 120 },
                  { title: '联系人', dataIndex: 'name', width: 100, hidden: isMobile },
                  { title: '联系电话', dataIndex: 'phone', width: 130, hidden: isMobile },
                  { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => (
                    <Tag color={s === '已完成' ? 'green' : s === '已取消' ? 'red' : s === '已联系' ? 'blue' : 'orange'}>
                      {s || '待联系'}
                    </Tag>
                  )},
                  { title: '预约时间', dataIndex: 'createdAt', width: 180, hidden: isMobile, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
                ].filter(c => !('hidden' in c && c.hidden))}
              />
            </Card>
          ),
        },
      ]} />

      <Modal title="预约标准服务" open={open} onCancel={() => setOpen(false)} onOk={handleSubmit} confirmLoading={submitting} okText="提交预约" width={520}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="联系人" rules={[{ required: true, message: '请输入联系人姓名' }]}>
            <Input placeholder="您的姓名" />
          </Form.Item>
          <Form.Item name="phone" label="联系电话" rules={[{ required: true, message: '请输入联系电话' }]}>
            <Input placeholder="手机号码（11位）" maxLength={11} />
          </Form.Item>
          <Form.Item name="organization" label="单位名称" rules={[{ required: true, message: '请输入单位名称' }]}>
            <Input placeholder="所在单位" />
          </Form.Item>
          <Form.Item name="demandType" label="服务类型">
            <Select placeholder="请选择" options={SERVICE_TYPES} />
          </Form.Item>
          <Form.Item name="demandDesc" label="需求描述">
            <TextArea rows={3} placeholder="请简要描述您的标准化服务需求（200字以内）" maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
