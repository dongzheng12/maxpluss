import { useState, useEffect } from 'react'
import { Card, Row, Col, Typography, Button, Tag, List, message, Alert, Tooltip } from 'antd'
import { CheckOutlined, CrownOutlined, FireOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { listOrders, getMembershipPlans, getProfile } from '../../api/app'
import PaymentModal, { type PaymentRequest } from '../../components/PaymentModal'

const { Title, Text, Paragraph } = Typography

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePlanDisplay(plan: any) {
  if (plan?.id === 'personal') {
    return {
      ...plan,
      features: [
        '知识库检索与详情页不限次',
        '呼叫小智 / AI 编写辅助不限次',
        '一对一比对不限次',
        '全库相似度分析 10 次/年完整报告',
      ],
      note: '一对一比对为会员专属功能。',
    }
  }
  if (plan?.id === 'pro') {
    return {
      ...plan,
      features: [
        '包含个人会员全部权益',
        '呼叫小智 / AI 编写辅助不限次',
        '一对一比对不限次',
        '全库相似度分析不限次完整报告',
      ],
      note: '适合高频标准查询、AI 编写辅助和相似度分析场景。',
    }
  }
  return plan
}

export default function MembershipPage() {
  const { user, isLoggedIn } = useAuth()
  const nav = useNavigate()
  const [pendingOrderNo, setPendingOrderNo] = useState('')
  const [realTier, setRealTier] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [plans, setPlans] = useState<any[]>([])
  const currentTier = realTier ?? user?.memberTier ?? 'free'

  // 支付弹窗状态
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentReq, setPaymentReq] = useState<PaymentRequest | null>(null)

  // 等级排序：越大越高
  const tierRank: Record<string, number> = { free: 0, personal: 1, pro: 2, enterprise: 3 }
  const currentRank = tierRank[currentTier] ?? 0

  const fetchData = () => {
    const fetchPlans = getMembershipPlans().catch(() => null)
    const fetchOrders = isLoggedIn ? listOrders().catch(() => null) : Promise.resolve(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Promise.all([fetchPlans, fetchOrders]).then(([memberRes, orderRes]: any[]) => {
      // 方案数据
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apiPlans: any[] = memberRes?.plans || []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const normalized = apiPlans.map((p: any) => ({ ...normalizePlanDisplay(p), key: p.id }))
      // enterprise 拍末位（API price asc 会让 price=0 的 enterprise 排到最前）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      normalized.sort((a: any, b: any) => (a.key === 'enterprise' ? 1 : b.key === 'enterprise' ? -1 : 0))
      setPlans(normalized)

      // 真实会员等级
      const cm = memberRes?.currentMembership
      if (cm?.status === 'ACTIVE' && cm?.plan?.id) {
        setRealTier(cm.plan.id)
      } else {
        setRealTier('free')
      }
      // 未完成会员订单
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = orderRes?.items || []
      const active = items.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (o: any) => o.productType === 'MEMBERSHIP' &&
               ['PENDING', 'PAYING', 'PENDING_VERIFY'].includes(o.status)
      )
      setPendingOrderNo(active?.orderNo || '')
    })
  }

  useEffect(() => {
    fetchData()
  }, [isLoggedIn])

  // 点击购买 → 实时拉 profile 校验当前会员状态 → 通过才弹支付弹窗
  // 防止跨端状态不同步触发误创建订单（如 887240 那种）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBuy = async (plan: any) => {
    if (!isLoggedIn) {
      nav('/login')
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile: any = await getProfile()
      const cm = profile?.membership
      const currentPlan = cm?.status === 'ACTIVE' ? cm?.plan?.id : null
      if (currentPlan) {
        const tr: Record<string, number> = { personal: 1, pro: 2, enterprise: 3 }
        if ((tr[plan.key] || 0) <= (tr[currentPlan] || 0)) {
          const planLabel = plan.key === 'pro' ? '专业' : plan.key === 'personal' ? '个人' : '企业'
          message.info(`您已是${currentPlan === 'pro' ? '专业' : currentPlan === 'personal' ? '个人' : '企业'}会员，无需购买${planLabel}会员`)
          // 同时刷新本页 tier 状态，避免按钮继续显示「立即购买」
          fetchData()
          return
        }
      }
    } catch (err) {
      console.error('[membership] profile 预检失败，继续走支付流程', err)
      // 预检失败放行，不阻塞用户（防御式：profile 挂了不至于支付链路瘫）
    }
    // 埋点：选择套餐
    import('../../utils/tracker').then(({ track }) => track('pay_plan_select', { plan: plan.key }))
    setPaymentReq({
      productType: 'MEMBERSHIP',
      planId: plan.key,
      title: plan.name,
      amount: plan.priceUnit,
    })
    setPaymentOpen(true)
  }

  // 支付成功回调
  const handlePaySuccess = () => {
    message.success('支付成功，会员权益已开通！')
    // 刷新数据
    fetchData()
  }

  // 弹窗关闭回调
  const handlePayClose = () => {
    setPaymentOpen(false)
    setPaymentReq(null)
    // 刷新数据（可能订单被取消删除了）
    fetchData()
  }

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <Title level={3} style={{ marginBottom: 8 }}>
          <CrownOutlined style={{ color: '#faad14', marginRight: 8 }} />
          会员计划
        </Title>
        <Paragraph type="secondary" style={{ maxWidth: 420, margin: '0 auto', fontSize: 15 }}>
          选择适合您的方案，解锁更多标准智能服务
        </Paragraph>
        <Button type="link" onClick={() => nav('/membership/benefits')} style={{ marginTop: 4, fontSize: 14 }}>
          查看完整权益对照表 &rarr;
        </Button>
        {!isLoggedIn && (
          <Button type="link" onClick={() => nav('/login')} style={{ marginTop: 4 }}>
            请先登录再开通会员
          </Button>
        )}
      </div>

      <Row gutter={24} justify="center" align="stretch">
        {plans.map((p) => {
          const isPro = p.key === 'pro'
          const isEnterprise = p.key === 'enterprise'
          return (
            <Col xs={24} sm={24} md={8} key={p.key}>
              <Card
                hoverable
                style={{
                  borderRadius: 14,
                  border: isPro ? '2px solid #faad14' : isEnterprise ? '2px solid #722ed1' : '1px solid #f0f0f0',
                  textAlign: 'center',
                  position: 'relative',
                  background: p.bg,
                  height: '100%',
                  transform: isPro ? 'scale(1.03)' : undefined,
                  boxShadow: isPro ? '0 8px 32px rgba(250, 173, 20, 0.12)' : isEnterprise ? '0 8px 32px rgba(114, 46, 209, 0.10)' : undefined,
                  zIndex: isPro ? 1 : 0,
                }}
                styles={{ body: { padding: '28px 24px 24px' } }}
              >
                {p.originalPrice > p.price && (
                  <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0,
                    background: 'linear-gradient(90deg, #ff4d4f, #ff7a45)',
                    color: '#fff', fontSize: 12, fontWeight: 600,
                    padding: '4px 0', borderRadius: '12px 12px 0 0',
                    textAlign: 'center',
                  }}>
                    <FireOutlined style={{ marginRight: 4 }} />
                    早鸟优惠进行中
                  </div>
                )}
                {p.badge && (
                  <Tag
                    color="gold"
                    style={{
                      position: 'absolute', top: p.originalPrice > p.price ? 24 : -1, right: 20,
                      fontWeight: 700, fontSize: 13, padding: '2px 12px',
                      borderRadius: '0 0 8px 8px', border: 'none',
                    }}
                  >
                    {p.badge}
                  </Tag>
                )}
                <Title level={4} style={{ color: p.color, marginBottom: 4 }}>
                  {p.name}
                </Title>
                {p.key === 'pro' && (
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 2 }}>
                    基于个人会员能力升级
                  </Text>
                )}
                {p.price > 0 ? (
                  <div style={{ margin: '16px 0 20px' }}>
                    {p.originalPrice > p.price && (
                      <div style={{ marginBottom: 6 }}>
                        <Text delete style={{ fontSize: 14, color: '#b0b0b0' }}>
                          ¥{p.originalPrice}/{p.unit}
                        </Text>
                        <Tag
                          color="#ff4d4f"
                          style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, borderRadius: 4, border: 'none', verticalAlign: 'middle' }}
                        >
                          限时优惠
                        </Tag>
                      </div>
                    )}
                    <Text style={{ fontSize: 14, color: '#8c8c8c', verticalAlign: 'top', lineHeight: '40px' }}>¥</Text>
                    <Text style={{ fontSize: 42, fontWeight: 700, color: p.color, lineHeight: 1 }}>{p.price}</Text>
                    <Text type="secondary" style={{ fontSize: 14 }}> / {p.unit}</Text>
                  </div>
                ) : (
                  <div style={{ margin: '16px 0 20px' }}>
                    <Text style={{ fontSize: 28, fontWeight: 600, color: p.color }}>{p.priceText || '联系销售'}</Text>
                  </div>
                )}

                <div style={{ textAlign: 'left', marginBottom: 16 }}>
                  <List
                    size="small"
                    dataSource={p.features}
                    renderItem={(f: string) => (
                      <List.Item style={{ border: 'none', padding: '5px 0', justifyContent: 'flex-start' }}>
                        <CheckOutlined style={{ color: p.color, marginRight: 10, fontSize: 13 }} />
                        <Text style={{ fontSize: 13.5 }}>{f}</Text>
                      </List.Item>
                    )}
                  />
                </div>

                {p.note && (
                  <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 18, padding: '0 4px', textAlign: 'left' }}>
                    {p.note}
                  </Paragraph>
                )}

                {(() => {
                  const targetRank = tierRank[p.key] ?? 0
                  if (currentTier === p.key) {
                    return <Button disabled block size="large" style={{ borderRadius: 8, height: 44 }}>当前方案</Button>
                  }
                  if (isLoggedIn && targetRank < currentRank && p.price > 0) {
                    return <Button disabled block size="large" style={{ borderRadius: 8, height: 44, color: '#8c8c8c' }}>已包含在当前方案中</Button>
                  }
                  if (p.price > 0 && pendingOrderNo) {
                    return (
                      <Tooltip title="您有未完成的会员订单，请先在「我的订单」处理">
                        <Button
                          block
                          size="large"
                          style={{ borderRadius: 8, height: 44, fontWeight: 600 }}
                          onClick={() => nav('/orders')}
                        >
                          查看待处理订单
                        </Button>
                      </Tooltip>
                    )
                  }
                  if (p.price > 0) {
                    return (
                      <Button
                        type="primary"
                        block
                        size="large"
                        style={{
                          background: p.color, borderColor: p.color, borderRadius: 8, height: 44,
                          fontWeight: 600, fontSize: 15,
                        }}
                        onClick={() => handleBuy(p)}
                      >
                        {!isLoggedIn ? '登录后开通' : currentRank > 0 ? '升级方案' : '立即开通'}
                      </Button>
                    )
                  }
                  return <Button block size="large" style={{ borderRadius: 8, height: 44, fontWeight: 600 }}>联系销售</Button>
                })()}
              </Card>
            </Col>
          )
        })}
      </Row>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 36, borderRadius: 10 }}
        message="信息说明"
        description="本平台展示的标准信息及 AI 辅助分析内容仅供参考，不代表官方发布内容或正式审查结论；标准的引用、使用及传播，请以官方或授权渠道为准，并遵守相关版权规定。"
      />

      {/* 支付弹窗 — 在当前页面直接弹出 */}
      <PaymentModal
        open={paymentOpen}
        payment={paymentReq}
        onClose={handlePayClose}
        onSuccess={handlePaySuccess}
      />
    </div>
  )
}
