import { useState, useEffect, useCallback } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Card, Table, Button, Modal, Form, Input, Typography, message, Popconfirm, Space, Tag } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, NotificationOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'

const { Title, Text } = Typography
const { TextArea } = Input


export default function AdminAnnouncementsPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editing, setEditing] = useState<any>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/announcements')
      setData(res.items || [])
    } catch { message.error('加载失败') }
    setLoading(false)
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openEdit = (row: any) => {
    setEditing(row)
    form.setFieldsValue({ title: row.title, content: row.content || '' })
    setModalOpen(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSave = async (values: any) => {
    setSaving(true)
    try {
      if (editing) {
        await nodeApi.put(`/api/admin/announcements/${editing.id}`, values)
        message.success('修改成功')
      } else {
        await nodeApi.post('/api/admin/announcements', values)
        message.success('发布成功')
      }
      setModalOpen(false)
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    try {
      await nodeApi.delete(`/api/admin/announcements/${id}`)
      message.success('已删除')
      load()
    } catch { message.error('删除失败') }
  }

  const columns = [
    {
      title: '标题', dataIndex: 'title', ellipsis: true,
      render: (t: string) => (
        <Space>
          <Tag color="blue" style={{ fontSize: 11 }}>公告</Tag>
          <Text>{t}</Text>
        </Space>
      ),
    },
    {
      title: '内容摘要', dataIndex: 'content', ellipsis: true, width: 300, hidden: isMobile,
      render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 13 }}>{v}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: '发布日期', dataIndex: 'date', width: 120, hidden: isMobile,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: '操作', width: 120, fixed: 'right' as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
          <Popconfirm title="确定删除该公告？" onConfirm={() => handleDelete(row.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ].filter(c => !('hidden' in c && (c as any).hidden))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}><NotificationOutlined /> 内容管理 · 公告</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>发布公告</Button>
      </div>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '暂无公告，点击右上角发布' }}
        />
      </Card>

      <Modal
        title={editing ? '编辑公告' : '发布公告'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText={editing ? '保存修改' : '发布'}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={handleSave} style={{ marginTop: 16 }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入公告标题' }, { max: 100 }]}>
            <Input placeholder="公告标题" maxLength={100} showCount />
          </Form.Item>
          <Form.Item name="content" label="内容（选填）">
            <TextArea rows={4} placeholder="公告详细内容" maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
