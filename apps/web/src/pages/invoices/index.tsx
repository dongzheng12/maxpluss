import { useState, useEffect } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Card, Table, Tag, Typography, Button, Modal, Form, Input, Radio, message, Space } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { listInvoices, createInvoice } from '../../api/app'
import { useSearchParams } from 'react-router-dom'

const { Title } = Typography


export default function InvoicesPage() {
  const isMobile = useIsMobile()
  const [params] = useSearchParams()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const orderNo = params.get('orderNo') || ''

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await listInvoices()
      setItems(res?.items || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (orderNo) {
      setOpen(true)
      form.setFieldValue('orderNo', orderNo)
    }
  }, [orderNo])

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      await createInvoice(values)
      message.success('发票申请已提交')
      setOpen(false)
      form.resetFields()
      load()
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
        <Title level={4} style={{ margin: 0 }}>发票管理</Title>
        <Space>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => setOpen(true)}>申请发票</Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </Space>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="invoiceNo"
          dataSource={items}
          loading={loading}
          columns={[
            { title: '发票号', dataIndex: 'invoiceNo', width: 180, hidden: isMobile },
            { title: '订单号', dataIndex: 'orderNo', width: 180, hidden: isMobile },
            { title: '抬头', dataIndex: 'title' },
            { title: '类型', dataIndex: 'type', width: 100, hidden: isMobile, render: (v: string) => v === 'SPECIAL' ? '专票' : '普票' },
            { title: '金额', dataIndex: 'amount', width: 100, render: (v: number) => `¥${(v / 100).toFixed(2)}` },
            { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => (
              <Tag color={s === 'ISSUED' ? 'green' : s === 'REJECTED' ? 'red' : 'orange'}>{
                s === 'ISSUED' ? '已开具' : s === 'REJECTED' ? '已驳回' : '待开具'
              }</Tag>
            )},
            { title: '申请时间', dataIndex: 'createdAt', width: 180, hidden: isMobile, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>

      <Modal title="申请发票" open={open} onCancel={() => setOpen(false)} onOk={handleSubmit} confirmLoading={submitting} okText="提交申请">
        <Form form={form} layout="vertical" initialValues={{ type: 'NORMAL', titleType: 'COMPANY' }}>
          <Form.Item name="orderNo" label="订单号" rules={[{ required: true }]}>
            <Input placeholder="请输入已支付的订单号" />
          </Form.Item>
          <Form.Item name="type" label="发票类型">
            <Radio.Group>
              <Radio value="NORMAL">增值税普通发票</Radio>
              <Radio value="SPECIAL">增值税专用发票</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="titleType" label="抬头类型">
            <Radio.Group>
              <Radio value="PERSONAL">个人</Radio>
              <Radio value="COMPANY">单位</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="title" label="发票抬头" rules={[{ required: true }]}>
            <Input placeholder="公司名称或个人姓名" />
          </Form.Item>
          <Form.Item name="taxNo" label="税号">
            <Input placeholder="纳税人识别号（单位必填）" />
          </Form.Item>
          <Form.Item name="email" label="接收邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input placeholder="发票发送邮箱" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
