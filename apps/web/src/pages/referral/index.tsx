/**
 * PC Web 邀请好友页
 *
 * 展示：小程序码（来自 wxacode.getUnlimited 缓存）+ 邀请码 + PC 分享链接
 * PC 端分享链接走 /register?ref=<userId> 格式；新用户在注册成功时调
 * POST /api/app/referral/track，完成归因 + 邀请人 +7 天注册奖励
 */
import { useEffect, useState } from 'react'
import {
  Card, Typography, Button, Space, Input, message, Spin, Result, Statistic, Row, Col,
} from 'antd'
import {
  CopyOutlined, LinkOutlined, HeartOutlined, GiftOutlined, TeamOutlined,
} from '@ant-design/icons'
import { useAuth } from '../../contexts/AuthContext'
import { getReferralCode, type ReferralCodeInfo } from '../../api/app'
// useAuth 保留给未登录态检查；shareUrl 已改用 code，不再依赖 user.id

const { Title, Text, Paragraph } = Typography

export default function ReferralPage() {
  const { isLoggedIn } = useAuth()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ReferralCodeInfo | null>(null)
  const [err, setErr] = useState<string>('')

  const load = async () => {
    setLoading(true)
    setErr('')
    try {
      const d = await getReferralCode()
      setData(d)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setErr(e?.response?.data?.error || '邀请码加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isLoggedIn) load()
  }, [isLoggedIn])

  if (!isLoggedIn) {
    return (
      <Card>
        <Result
          icon={<HeartOutlined style={{ color: '#ff4d4f' }} />}
          title="请先登录"
          extra={<Button type="primary" href="/login">去登录</Button>}
        />
      </Card>
    )
  }

  // 分享链接用 8 位短码，而非 userId（更好看、防暴露）
  const shareUrl = data?.code
    ? `${window.location.origin}/register?ref=${encodeURIComponent(data.code)}`
    : ''
  const shareText = data?.code
    ? `我最近在用标准小智，能做标准信息查询、AI 比对和大纲生成。用我的邀请码 ${data.code} 注册，咱俩各得 7 天会员体验：${shareUrl}`
    : ''

  const copy = async (val: string, label: string) => {
    // 优先 navigator.clipboard（需 HTTPS 或 localhost），HTTP/IP 环境降级到 execCommand
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(val)
        message.success(`${label}已复制`)
        return
      }
    } catch { /* 继续走 fallback */ }
    // execCommand fallback
    try {
      const ta = document.createElement('textarea')
      ta.value = val
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) {
        message.success(`${label}已复制`)
      } else {
        message.error('复制失败，请手动选中复制')
      }
    } catch {
      message.error('复制失败，请手动选中复制')
    }
  }

  return (
    <div>
      {/* Hero */}
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #fff1e6 0%, #ffd6a5 100%)', border: 'none' }}>
        <Space direction="vertical" size={4}>
          <Title level={3} style={{ margin: 0, color: '#7a4200' }}>
            <GiftOutlined style={{ marginRight: 8 }} />
            邀请好友 · 赚会员时长
          </Title>
          <Text style={{ fontSize: 14, color: '#8c5a1a' }}>好友注册送你 7 天，好友付费再送 30 天</Text>
        </Space>
      </Card>

      {loading && <Card><div style={{ textAlign: 'center', padding: 48 }}><Spin /></div></Card>}

      {!loading && err && (
        <Card>
          <Result status="error" title={err} extra={<Button onClick={load}>重试</Button>} />
        </Card>
      )}

      {!loading && data && (
        <Row gutter={[16, 16]}>
          {/* 左：小程序码 */}
          <Col xs={24} md={10}>
            <Card title="小程序邀请码" styles={{ body: { textAlign: 'center', padding: '32px 24px' } }}>
              <img
                src={data.qrcodeBase64}
                alt="邀请小程序码"
                style={{ width: 240, height: 240, borderRadius: 8, background: '#f5f5f5' }}
              />
              <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
                好友微信扫码进入小程序后，登录即完成邀请
              </Paragraph>
            </Card>
          </Col>

          {/* 右：邀请码 + 分享链接 + 数据 */}
          <Col xs={24} md={14}>
            <Card title="我的邀请码" style={{ marginBottom: 16 }}>
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>邀请码（可口头分享）</Text>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <Input
                      value={data.code}
                      readOnly
                      size="large"
                      style={{ fontSize: 22, fontWeight: 600, letterSpacing: 2, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
                    />
                    <Button size="large" icon={<CopyOutlined />} onClick={() => copy(data.code, '邀请码')}>复制</Button>
                  </div>
                </div>

                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>PC 注册专属链接</Text>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <Input
                      value={shareUrl}
                      readOnly
                      prefix={<LinkOutlined style={{ color: '#bfbfbf' }} />}
                    />
                    <Button icon={<CopyOutlined />} onClick={() => copy(shareUrl, '链接')}>复制</Button>
                  </div>
                </div>

                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>一段话分享（复制发给好友）</Text>
                  <Input.TextArea
                    value={shareText}
                    readOnly
                    rows={3}
                    style={{ marginTop: 6 }}
                  />
                  <div style={{ marginTop: 8, textAlign: 'right' }}>
                    <Button type="primary" icon={<CopyOutlined />} onClick={() => copy(shareText, '分享文案')}>
                      复制分享文案
                    </Button>
                  </div>
                </div>
              </Space>
            </Card>

            <Card>
              <Statistic
                title="已成功邀请（好友首次付费口径）"
                value={data.totalInvited}
                suffix="人"
                prefix={<TeamOutlined />}
              />
            </Card>
          </Col>

          {/* 规则说明 */}
          <Col span={24}>
            <Card title="奖励规则">
              <ul style={{ margin: 0, paddingLeft: 20, color: '#595959', lineHeight: 1.9 }}>
                <li>好友通过你的邀请链接 / 小程序码完成注册并登录 → <Text strong>双方各得 +7 天会员体验</Text></li>
                <li>好友在此基础上完成首次付费 → 你再获得 <Text strong>+30 天会员体验</Text>（被邀请人无额外奖励）</li>
                <li>同一好友只归属首位邀请人，不可覆盖</li>
                <li>奖励自动延长到你会员的到期时间，无需手动领取；如当前没有会员，将自动开通一份体验期</li>
              </ul>
            </Card>
          </Col>
        </Row>
      )}
    </div>
  )
}
