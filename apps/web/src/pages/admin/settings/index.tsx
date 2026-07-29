import { useState, useEffect } from 'react'
import { Card, Form, Input, Switch, Button, Typography, message, Divider, Space, Tag } from 'antd'
import { SaveOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'

const { Title, Text } = Typography
const { TextArea } = Input

export default function AdminSettingsPage() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/settings')
      form.setFieldsValue({
        siteName: res.siteName || '标准小智',
        contactPhone: res.contactPhone || '',
        contactEmail: res.contactEmail || '',
        contactWechat: res.contactWechat || '',
        announcement: res.announcement || '',
        membershipEnabled: res.membershipEnabled !== 'false',
        compareEnabled: res.compareEnabled !== 'false',
        downloadEnabled: res.downloadEnabled !== 'false',
        maintenanceMode: res.maintenanceMode === 'true',
        maxCompareFileSize: res.maxCompareFileSize || '10',
        compareTimeout: res.compareTimeout || '300',
      })
    } catch {
      message.warning('系统设置加载失败，使用默认值')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const values = form.getFieldsValue()
      await nodeApi.post('/api/admin/settings', {
        siteName: values.siteName,
        contactPhone: values.contactPhone,
        contactEmail: values.contactEmail,
        contactWechat: values.contactWechat,
        announcement: values.announcement,
        membershipEnabled: String(values.membershipEnabled !== false),
        compareEnabled: String(values.compareEnabled !== false),
        downloadEnabled: String(values.downloadEnabled !== false),
        maintenanceMode: String(values.maintenanceMode === true),
        maxCompareFileSize: values.maxCompareFileSize,
        compareTimeout: values.compareTimeout,
      })
      message.success('设置已保存')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '保存失败')
    }
    setSaving(false)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Title level={4} style={{ margin: 0 }}>
          <SettingOutlined style={{ marginRight: 8 }} />
          系统设置
        </Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>重新加载</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>保存设置</Button>
        </Space>
      </Space>

      <Form form={form} layout="vertical" disabled={loading}>
        {/* 基本信息 */}
        <Card title="基本信息" style={{ marginBottom: 16 }}>
          <Form.Item label="平台名称" name="siteName">
            <Input placeholder="标准小智" maxLength={20} />
          </Form.Item>
          <Form.Item label="联系电话" name="contactPhone">
            <Input placeholder="客服电话" />
          </Form.Item>
          <Form.Item label="联系邮箱" name="contactEmail">
            <Input placeholder="客服邮箱" />
          </Form.Item>
          <Form.Item label="客服微信" name="contactWechat">
            <Input placeholder="客服微信号" />
          </Form.Item>
          <Form.Item label="系统公告" name="announcement" extra="会显示在首页和用户端，留空则不显示">
            <TextArea rows={3} placeholder="输入系统公告内容..." maxLength={500} showCount />
          </Form.Item>
        </Card>

        {/* 功能开关 */}
        <Card title="功能开关" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong>会员功能</Text>
                <br />
                <Text type="secondary">开启后用户可购买会员套餐</Text>
              </div>
              <Form.Item name="membershipEnabled" valuePropName="checked" noStyle>
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </div>
            <Divider style={{ margin: 0 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong>文档比对功能</Text>
                <br />
                <Text type="secondary">开启后用户可使用标准比对</Text>
              </div>
              <Form.Item name="compareEnabled" valuePropName="checked" noStyle>
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </div>
            <Divider style={{ margin: 0 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong>标准下载功能</Text>
                <br />
                <Text type="secondary">开启后用户可付费下载标准文件</Text>
              </div>
              <Form.Item name="downloadEnabled" valuePropName="checked" noStyle>
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </div>
            <Divider style={{ margin: 0 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong>维护模式</Text>
                <Tag color="red" style={{ marginLeft: 8 }}>谨慎</Tag>
                <br />
                <Text type="secondary">开启后前台显示维护提示，用户无法操作</Text>
              </div>
              <Form.Item name="maintenanceMode" valuePropName="checked" noStyle>
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </div>
          </Space>
        </Card>

        {/* 比对参数 */}
        <Card title="比对参数">
          <Form.Item label="最大上传文件大小（MB）" name="maxCompareFileSize">
            <Input type="number" min={1} max={100} style={{ width: 200 }} addonAfter="MB" />
          </Form.Item>
          <Form.Item label="比对超时时间（秒）" name="compareTimeout">
            <Input type="number" min={60} max={3600} style={{ width: 200 }} addonAfter="秒" />
          </Form.Item>
        </Card>
      </Form>
    </div>
  )
}
