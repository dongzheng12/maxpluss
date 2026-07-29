import { useState, useEffect } from 'react'
import { Card, Tabs, Empty, Tag, Spin, Typography, Button, Result } from 'antd'
import { TagOutlined, LoginOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { getMyCoupons, type MyCoupon } from '../../api/app'

const { Text } = Typography

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'AVAILABLE', label: '可用' },
  { key: 'USED', label: '已使用' },
  { key: 'EXPIRED', label: '已过期' },
  { key: 'REVOKED', label: '已撤销' },
]

const SCOPE_LABEL: Record<string, string> = {
  ALL: '全场通用',
  MEMBERSHIP: '会员套餐',
  MEMBERSHIP_PERSONAL: '个人会员',
  MEMBERSHIP_PRO: '专业会员',
  STANDARD: '标准全库比对',
}

function formatDiscount(c: MyCoupon['coupon']): string {
  if (c.discountType === 'FIXED') return `¥${(c.discountValue / 100).toFixed(0)}`
  return `${c.discountValue}%`
}

function CouponCard({ uc }: { uc: MyCoupon }) {
  const isAvailable = uc.status === 'AVAILABLE'
  // eslint-disable-next-line react-hooks/purity
  const expired = new Date(uc.expiresAt).getTime() < Date.now()
  // eslint-disable-next-line react-hooks/purity
  const daysLeft = Math.ceil((new Date(uc.expiresAt).getTime() - Date.now()) / 86400_000)

  return (
    <Card
      style={{
        marginBottom: 12,
        opacity: isAvailable ? 1 : 0.6,
        background: isAvailable
          ? 'linear-gradient(90deg, #fff7e6 0%, #fff 35%)'
          : '#fafafa',
        border: isAvailable ? '1px solid #ffd591' : '1px solid #f0f0f0',
      }}
      bodyStyle={{ padding: 16 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ minWidth: 110, textAlign: 'center', borderRight: '1px dashed #d9d9d9', paddingRight: 12 }}>
          <div style={{ fontSize: 28, color: isAvailable ? '#fa8c16' : '#bfbfbf', fontWeight: 700, lineHeight: 1.1 }}>
            {formatDiscount(uc.coupon)}
          </div>
          <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
            {uc.coupon.minAmount > 0 ? `满 ¥${(uc.coupon.minAmount / 100).toFixed(0)} 可用` : '无门槛'}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Text strong style={{ fontSize: 15 }}>{uc.coupon.name}</Text>
            <Tag color={SCOPE_LABEL[uc.coupon.applicableScope] ? 'orange' : 'default'} style={{ fontSize: 11 }}>
              {SCOPE_LABEL[uc.coupon.applicableScope] || uc.coupon.applicableScope}
            </Tag>
          </div>
          {uc.coupon.description && (
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{uc.coupon.description}</div>
          )}
          <div style={{ fontSize: 12, color: expired ? '#ff4d4f' : '#999' }}>
            有效期至 {new Date(uc.expiresAt).toLocaleDateString()}
            {isAvailable && !expired && daysLeft <= 7 && (
              <Tag color="red" style={{ marginLeft: 8, fontSize: 11 }}>剩余 {daysLeft} 天</Tag>
            )}
          </div>
          {uc.status === 'USED' && uc.usedAt && (
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              已用于订单 {uc.usedOrderNo}（{new Date(uc.usedAt).toLocaleString()}）
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

export default function MyCouponsPage() {
  const { user } = useAuth()
  const nav = useNavigate()
  const [tab, setTab] = useState('AVAILABLE')
  const [items, setItems] = useState<MyCoupon[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    getMyCoupons(tab)
      .then(res => setItems(res.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [tab, user])

  if (!user) {
    return (
      <Result
        status="warning"
        title="请先登录后查看优惠券"
        extra={<Button type="primary" icon={<LoginOutlined />} onClick={() => nav('/login')}>登录</Button>}
      />
    )
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <Card
        title={<><TagOutlined /> 我的优惠券</>}
        bodyStyle={{ paddingTop: 0 }}
      >
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={STATUS_TABS.map(t => ({ key: t.key, label: t.label }))}
        />
        <Spin spinning={loading}>
          {items.length === 0 && !loading ? (
            <Empty description={tab === 'AVAILABLE' ? '暂无可用优惠券' : '无记录'} style={{ padding: '24px 0' }}>
              {tab === 'AVAILABLE' && (
                <Button type="primary" onClick={() => nav('/membership')}>去会员中心</Button>
              )}
            </Empty>
          ) : (
            items.map(uc => <CouponCard key={uc.id} uc={uc} />)
          )}
        </Spin>
      </Card>
    </div>
  )
}
