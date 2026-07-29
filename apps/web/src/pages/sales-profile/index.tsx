import { useEffect, useState } from 'react'
import {
  Card, Typography, Form, Input, Button, Upload, message, Space, Divider,
  Tag, Result, Spin, Checkbox, Tooltip, Row, Col, Switch, Alert, Modal,
} from 'antd'
import {
  UploadOutlined, CopyOutlined, EyeOutlined, LinkOutlined,
  RocketOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useAuth } from '../../contexts/AuthContext'
import { nodeApi } from '../../api/client'

const { Title, Text } = Typography

interface SalesProduct {
  code: string
  name: string
  slogan: string
  description: string
  targetUsers: string
  features: string[]
  actionType: string
  ctaLabel: string
}

interface Profile {
  id: string
  salesCode: string
  realName: string
  companyName: string | null
  positionTitle: string | null
  avatar: string | null
  bio: string | null
  wechat: string | null
  phone: string | null
  qrcode: string | null
  contactVisible: boolean
  companyVisible: boolean
  isPublic: boolean
  displayProducts: Array<{ code: string; sort: number }>
  status: string
}

export default function SalesProfilePage() {
  const { isLoggedIn } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [products, setProducts] = useState<SalesProduct[]>([])
  const [form] = Form.useForm()

  // 一键发布：与销售工作台 tag 旁的"立即发布"按钮等价，避免销售必须翻到表单底部找 Switch
  const handlePublishNow = () => {
    if (!profile) return
    Modal.confirm({
      title: '确认发布推广页',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>发布后，访问者通过推广链接 <Text code>/s/{profile.salesCode}</Text> 可以看到您的资料和联系方式。</p>
          <p style={{ color: '#8c9bac', fontSize: 13 }}>
            资料尚未填完时也可发布，后续可继续编辑保存；如需下线，把表单底部「启用我的推广页」开关关掉即可。
          </p>
        </div>
      ),
      okText: '确认发布',
      okType: 'primary',
      cancelText: '取消',
      onOk: async () => {
        setPublishing(true)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const updated: any = await nodeApi.put('/api/app/sales/profile/me', { isPublic: true })
          setProfile(updated)
          form.setFieldsValue({ isPublic: true })
          message.success('推广页已发布')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '发布失败')
        }
        setPublishing(false)
      },
    })
  }

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [p, ps] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodeApi.get('/api/app/sales/profile/me') as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodeApi.get('/api/app/sales/products') as Promise<any>,
      ])
      setProfile(p)
      setProducts(ps.products || [])
      form.setFieldsValue({
        realName: p.realName,
        companyName: p.companyName || '',
        positionTitle: p.positionTitle || '',
        bio: p.bio || '',
        wechat: p.wechat || '',
        phone: p.phone || '',
        avatar: p.avatar || '',
        qrcode: p.qrcode || '',
        contactVisible: p.contactVisible !== false,
        companyVisible: p.companyVisible !== false,
        isPublic: p.isPublic !== false,
        // 后端返回 [{code, sort}]，Checkbox.Group 需要 string[] 的 code 列表
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        displayProducts: (p.displayProducts || []).map((x: any) => x.code),
      })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isLoggedIn) load()
  }, [isLoggedIn])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSave = async (values: any) => {
    setSaving(true)
    try {
      // displayProducts 校验：最多 4 个，重新分配 sort
      const pickedCodes: string[] = values.displayProducts || []
      if (pickedCodes.length > 4) {
        message.error('最多展示 4 个产品')
        setSaving(false)
        return
      }
      const displayProducts = pickedCodes.map((code: string, idx: number) => ({ code, sort: idx + 1 }))
      const body = {
        realName: values.realName,
        companyName: values.companyName || null,
        positionTitle: values.positionTitle || null,
        bio: values.bio || null,
        wechat: values.wechat || null,
        phone: values.phone || null,
        avatar: values.avatar || null,
        qrcode: values.qrcode || null,
        contactVisible: values.contactVisible !== false,
        companyVisible: values.companyVisible !== false,
        isPublic: values.isPublic !== false,
        displayProducts,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated: any = await nodeApi.put('/api/app/sales/profile/me', body)
      setProfile(updated)
      message.success('保存成功')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '保存失败')
    }
    setSaving(false)
  }

  const uploadProps = (field: 'avatar' | 'qrcode') => ({
    name: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    showUploadList: false,
    maxCount: 1,
    beforeUpload: (file: File) => {
      if (file.size > 2 * 1024 * 1024) {
        message.error('图片大小不能超过 2MB')
        return Upload.LIST_IGNORE
      }
      return true
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customRequest: async (opts: any) => {
      const formData = new FormData()
      formData.append('file', opts.file)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await nodeApi.post('/api/app/sales/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        form.setFieldValue(field, res.url)
        message.success('上传成功')
        opts.onSuccess?.(res)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        message.error(e?.response?.data?.error || '上传失败')
        opts.onError?.(e)
      }
    },
  })

  const landingUrl = profile ? `${window.location.origin}/s/${profile.salesCode}` : ''

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}><Spin size="large" /></div>
    )
  }

  if (error || !profile) {
    return (
      <div style={{ padding: 24 }}>
        <Result
          status="404"
          title="未开通销售推广主页"
          subTitle={error || '请联系管理员为您开通'}
        />
      </div>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <Title level={3}>我的推广主页</Title>

      {/* 未发布警示：仅在 status=ENABLED 且 isPublic=false 时显示，提供一键发布入口（避免销售翻表单底部找 Switch） */}
      {profile.status === 'ENABLED' && !profile.isPublic && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="您的推广页尚未发布"
          description="访问者打开您的推广链接会看到「该推广页尚未发布」。点右侧按钮可立即发布；如希望先把资料填完再发布，可继续编辑后保存（也会一并发布）。"
          action={
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={publishing}
              onClick={handlePublishNow}
            >
              立即发布
            </Button>
          }
        />
      )}

      {/* 专属链接 */}
      <Card style={{ marginBottom: 16 }} size="small">
        <Row gutter={[16, 8]} align="middle">
          <Col flex="auto">
            <Space>
              <LinkOutlined />
              <Text strong>我的专属链接：</Text>
              <Text copyable={{ text: landingUrl }} style={{ color: '#1677ff' }}>{landingUrl}</Text>
            </Space>
          </Col>
          <Col>
            <Space>
              <Button
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard.writeText(landingUrl)
                  message.success('已复制链接')
                }}
              >复制链接</Button>
              <Button
                type="primary"
                icon={<EyeOutlined />}
                onClick={() => window.open(landingUrl, '_blank')}
              >预览主页</Button>
            </Space>
          </Col>
        </Row>
        <Divider style={{ margin: '12px 0' }} />
        <Space size="small">
          <Text type="secondary">salesCode：</Text>
          <Tag color="blue">{profile.salesCode}</Tag>
          <Tag color={profile.status === 'ENABLED' ? 'green' : 'red'}>
            {profile.status === 'ENABLED' ? '已启用' : '已停用'}
          </Tag>
          {profile.status === 'DISABLED' && (
            <Text type="secondary">当前主页已停用，链接不对外可见。如需启用请联系管理员。</Text>
          )}
        </Space>
      </Card>

      {/* 编辑表单 */}
      <Card title="编辑资料">
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                label="销售姓名"
                name="realName"
                rules={[{ required: true, message: '请输入销售姓名' }, { max: 30 }]}
              >
                <Input placeholder="张三" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label={
                  <Space>
                    <span>公司 / 部门</span>
                    <Form.Item name="companyVisible" valuePropName="checked" noStyle>
                      <Switch size="small" checkedChildren="展示" unCheckedChildren="隐藏" />
                    </Form.Item>
                  </Space>
                }
                name="companyName"
                rules={[{ max: 60 }]}
                extra="右侧开关控制推广页是否展示公司名称"
              >
                <Input placeholder="通标中研 xx 办事处" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label={<span>职位 / 身份标签 <Text type="secondary">（展示在推广页头像下方，留空则用默认"标准智能平台顾问"）</Text></span>}
            name="positionTitle"
            rules={[{ max: 40 }]}
          >
            <Input placeholder="标准智能平台顾问" maxLength={40} />
          </Form.Item>

          <Form.Item label="个人介绍" name="bio" rules={[{ max: 300 }]}>
            <Input.TextArea rows={3} placeholder="为企业提供标准查询、标准比对、协同编写与标准知识服务方案..." maxLength={300} showCount />
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="微信号" name="wechat" rules={[{ max: 50 }]}>
                <Input placeholder="wx_abc123" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="联系手机号" name="phone" rules={[{ max: 20 }]}>
                <Input placeholder="可与登录手机号不同" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label={<span>公开联系方式 <Text type="secondary">（关闭后，推广页的联系弹窗不会展示手机号、微信号和二维码）</Text></span>}
            name="contactVisible"
            valuePropName="checked"
          >
            <Switch checkedChildren="公开" unCheckedChildren="隐藏" />
          </Form.Item>

          <Form.Item
            label={<span>启用我的推广页 <Text type="secondary">（关闭后推广链接将对外显示"未启用"，不可访问）</Text></span>}
            name="isPublic"
            valuePropName="checked"
          >
            <Switch checkedChildren="已启用" unCheckedChildren="未启用" />
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} sm={12}>
              {/* 头像：只保留 Upload 按钮 + 缩略图预览，删除手输 Input 防止脏数据
                  (如 C:\fakepath\xxx.jpg 被当作 URL 直接入库)。
                  实际 URL 通过 uploadProps('avatar').customRequest →
                  form.setFieldValue 写入 form 状态，由下方 hidden Form.Item 保持
                  与表单 schema 的绑定（rules 校验仍生效）。*/}
              <Form.Item
                label="头像"
                extra="推荐 1:1 正方形 400×400，仅支持 jpg/png/webp，≤ 2MB"
              >
                <Upload {...uploadProps('avatar')}>
                  <Button icon={<UploadOutlined />}>上传头像</Button>
                </Upload>
              </Form.Item>
              <Form.Item name="avatar" rules={[{ max: 300 }]} hidden>
                <Input />
              </Form.Item>
              <Form.Item shouldUpdate={(p, c) => p.avatar !== c.avatar} noStyle>
                {({ getFieldValue }) => {
                  const v = getFieldValue('avatar')
                  return v ? (
                    <img src={v} alt="avatar" style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', marginTop: -12 }} />
                  ) : null
                }}
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              {/* 微信二维码：同上，删除手输 Input 防脏数据 */}
              <Form.Item label="微信二维码">
                <Upload {...uploadProps('qrcode')}>
                  <Button icon={<UploadOutlined />}>上传二维码</Button>
                </Upload>
              </Form.Item>
              <Form.Item name="qrcode" rules={[{ max: 300 }]} hidden>
                <Input />
              </Form.Item>
              <Form.Item shouldUpdate={(p, c) => p.qrcode !== c.qrcode} noStyle>
                {({ getFieldValue }) => {
                  const v = getFieldValue('qrcode')
                  return v ? (
                    <img src={v} alt="qrcode" style={{ width: 120, height: 120, objectFit: 'cover', marginTop: -12, border: '1px solid #e7edf7', borderRadius: 8 }} />
                  ) : null
                }}
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label={<span>展示产品 <Tooltip title="最多 4 个，顺序按勾选顺序决定；落地页上会按此顺序展示"><Text type="secondary">（最多 4 个）</Text></Tooltip></span>}
            name="displayProducts"
          >
            <Checkbox.Group style={{ width: '100%' }}>
              <Row gutter={[12, 12]}>
                {products.map(p => (
                  <Col xs={24} sm={12} key={p.code}>
                    <Checkbox value={p.code}>
                      <Text strong>{p.name}</Text>
                      <div style={{ color: '#8c9bac', fontSize: 12 }}>{p.slogan}</div>
                    </Checkbox>
                  </Col>
                ))}
              </Row>
            </Checkbox.Group>
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
              <Button onClick={() => load()}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
