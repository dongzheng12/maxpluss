/**
 * PaymentModal — 微信 Native 扫码支付弹窗
 *
 * 创建订单 → 发起 Native 支付 → 展示二维码 → 轮询结果
 * 用户关闭弹窗（取消支付）→ 自动取消本次创建的订单
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Modal, Typography, Button, Result, Spin, Radio, Tag, Empty } from 'antd'
import { TagOutlined } from '@ant-design/icons'
import { QRCodeSVG } from 'qrcode.react'
import { createOrder, payOrder, getOrderStatus, cancelOrder, getApplicableCoupons, type ApplicableCoupon } from '../api/app'
import { track } from '../utils/tracker'

const { Text } = Typography

export interface PaymentRequest {
  // 与后端 services/api/src/appRoutes.ts:2652 createOrderSchema 的 z.enum 对齐：
  // MEMBERSHIP / STANDARD_PREVIEW / STANDARD_DOWNLOAD / COMPARE_REPORT / COMPARE_EXPORT
  // 例外：EXPERT_VOTE 不在白名单内，专家评审订单由后端 POST /api/app/expert-votes 提交时
  // 一并创建，前端拿到 orderNo 后必须传 existingOrderNo 给本组件，PaymentModal 会跳过
  // createOrder 直接走 payOrder（见本文件 useEffect / proceedOrderAndPay 对 existingOrderNo 的分支）。
  // 该字段此时仅作前端埋点标签用途，不会发到 /api/app/orders。
  productType: string
  planId?: string
  productRef?: string
  title: string
  amount?: number
}

interface PaymentModalProps {
  open: boolean
  payment: PaymentRequest | null
  existingOrderNo?: string
  onClose: () => void
  onSuccess?: (orderNo: string) => void
}

type Step = 'loading' | 'select-coupon' | 'native' | 'paid' | 'error'

export default function PaymentModal({ open, payment, existingOrderNo, onClose, onSuccess }: PaymentModalProps) {
  const [step, setStep] = useState<Step>('loading')
  const [, setOrderNo] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [orderInfo, setOrderInfo] = useState<any>(null)
  const [codeUrl, setCodeUrl] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [coupons, setCoupons] = useState<ApplicableCoupon[]>([])
  const [selectedCouponId, setSelectedCouponId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const orderNoRef = useRef('')

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback((no: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const res = await getOrderStatus(no)
        if (res.status === 'PAID') {
          stopPolling()
          setStep('paid')
        } else if (res.status === 'FAILED') {
          stopPolling()
          setStep('error')
          setErrorMsg('支付失败，请重试')
        }
      } catch { /* 网络错误静默，继续轮询 */ }
    }, 3000)
  }, [stopPolling])

  // 实际下单 + 发起支付 + 展示二维码（fromCouponId: 选完券后调用）
  const proceedOrderAndPay = useCallback(async (userCouponId: string | null) => {
    if (!payment) return
    setStep('loading')
    setErrorMsg('')

    try {
      let no: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let orderRes: any
      if (existingOrderNo) {
        no = existingOrderNo
        orderRes = { orderNo: no, title: payment.title, amount: payment.amount }
      } else {
        orderRes = await createOrder({
          productType: payment.productType,
          planId: payment.planId,
          productRef: payment.productRef,
          title: payment.title,
          amount: payment.amount || 0,
          ...(userCouponId ? { userCouponId } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        no = orderRes?.orderNo
        if (!no) throw new Error('订单创建失败')
      }
      setOrderNo(no)
      orderNoRef.current = no

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payRes: any = await payOrder(no, 'WECHAT')
      setOrderInfo({ ...orderRes, ...payRes })

      if (payRes?.payMode === 'native' && payRes?.codeUrl) {
        setCodeUrl(payRes.codeUrl)
        setStep('native')
        track('pay_qr_show', { plan: payment.planId, amount: orderRes?.amount, trade_type: 'NATIVE', coupon: !!userCouponId })
        startPolling(no)
      } else if (payRes?.payMode === 'mock-paid' || payRes?.status === 'PAID') {
        // 本地 dev-only：BXZ_PAY_AUTO_SUCCESS=true 时后端直接标 PAID，无需轮询
        setStep('paid')
      } else {
        setStep('error')
        setErrorMsg('支付服务暂时不可用，请稍后重试')
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setStep('error')
      setErrorMsg(e?.response?.data?.error || e?.message || '支付发起失败')
    }
  }, [payment, existingOrderNo, startPolling])

  // 弹窗打开：先尝试拉适用券，有券进入 select-coupon step；无券或非会员订单直接下单
  useEffect(() => {
    if (!open || !payment) return

    let cancelled = false

    const init = async () => {
      setStep('loading')
      setErrorMsg('')
      setOrderNo('')
      orderNoRef.current = ''
      setCoupons([])
      setSelectedCouponId(null)
      track('pay_modal_open', { source: existingOrderNo ? 'order_list' : 'menu', plan: payment.planId })

      // 继续支付已有订单：跳过选券，直接发起支付
      if (existingOrderNo) {
        await proceedOrderAndPay(null)
        return
      }

      // 仅会员订单展示选券（其他 productType 模板少，简化体验）
      if (payment.productType !== 'MEMBERSHIP') {
        await proceedOrderAndPay(null)
        return
      }

      // 拉适用券，失败/空都降级直接下单
      try {
        const r = await getApplicableCoupons({
          productType: payment.productType,
          planId: payment.planId,
          productRef: payment.productRef,
        })
        if (cancelled) return
        const usable = (r.items || []).filter(c => c.applicable)
        if (usable.length === 0) {
          await proceedOrderAndPay(null)
          return
        }
        // 默认选择抵扣最大的
        const best = usable.reduce((a, b) => a.calculatedDiscount > b.calculatedDiscount ? a : b)
        setCoupons(usable)
        setSelectedCouponId(best.id)
        setStep('select-coupon')
      } catch {
        if (cancelled) return
        await proceedOrderAndPay(null)
      }
    }

    init()

    return () => {
      cancelled = true
      stopPolling()
    }
  }, [open, payment, existingOrderNo, proceedOrderAndPay, stopPolling])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  // 关闭弹窗：仅「新建订单」模式下自动取消
  const handleClose = async () => {
    stopPolling()
    const no = orderNoRef.current
    if (no && step !== 'paid' && !existingOrderNo) {
      cancelOrder(no).catch(() => {})
      track('pay_cancel', { plan: payment?.planId, stage: step === 'native' ? 'qr' : 'modal' })
    }
    if (step === 'paid' && no) {
      onSuccess?.(no)
    }
    onClose()
  }

  const handleDone = () => {
    const no = orderNoRef.current
    if (no) onSuccess?.(no)
    onClose()
  }

  const amountText = orderInfo?.amountYuan
    || (orderInfo?.amount ? `¥${(orderInfo.amount / 100).toFixed(2)}` : '')

  const titleText = (() => {
    if (step === 'paid') return '支付成功'
    if (step === 'error') return '支付异常'
    if (step === 'loading') return '正在发起支付...'
    if (step === 'select-coupon') return '选择优惠券'
    return '微信扫码支付'
  })()

  const selectedCoupon = coupons.find(c => c.id === selectedCouponId) || null
  const originalAmount = payment?.amount || 0
  const finalAmount = selectedCoupon
    ? Math.max(1, originalAmount - selectedCoupon.calculatedDiscount)
    : originalAmount

  return (
    <Modal
      title={titleText}
      open={open}
      onCancel={handleClose}
      footer={null}
      width={480}
      centered
      destroyOnClose
    >
      {/* 加载中 */}
      {step === 'loading' && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">正在创建订单并发起支付...</Text>
          </div>
        </div>
      )}

      {/* 选择优惠券 */}
      {step === 'select-coupon' && payment && (
        <div>
          <div style={{ marginBottom: 16, padding: 12, background: '#fafafa', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text>{payment.title}</Text>
              <Text>原价 ¥{(originalAmount / 100).toFixed(2)}</Text>
            </div>
            {selectedCoupon && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: '#fa8c16' }}>
                <Text style={{ color: '#fa8c16' }}>优惠券抵扣</Text>
                <Text style={{ color: '#fa8c16' }}>-¥{(selectedCoupon.calculatedDiscount / 100).toFixed(2)}</Text>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px dashed #d9d9d9' }}>
              <Text strong>应付</Text>
              <Text strong style={{ fontSize: 20, color: '#cf1322' }}>¥{(finalAmount / 100).toFixed(2)}</Text>
            </div>
          </div>

          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            <TagOutlined /> 可用优惠券（{coupons.length}）
          </Text>

          <Radio.Group
            value={selectedCouponId}
            onChange={(e) => setSelectedCouponId(e.target.value)}
            style={{ display: 'block', maxHeight: 320, overflowY: 'auto' }}
          >
            {coupons.length === 0 ? (
              <Empty description="暂无可用券" />
            ) : (
              coupons.map(c => (
                <Radio
                  key={c.id}
                  value={c.id}
                  style={{ display: 'flex', alignItems: 'center', padding: 10, marginBottom: 8, borderRadius: 6, border: '1px solid #f0f0f0', width: '100%' }}
                >
                  <span style={{ marginLeft: 4 }}>
                    <Text strong>{c.name}</Text>
                    <Tag color="orange" style={{ marginLeft: 8, fontSize: 11 }}>
                      抵扣 ¥{(c.calculatedDiscount / 100).toFixed(2)}
                    </Tag>
                    <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                      {c.minAmount > 0 ? `满 ¥${(c.minAmount / 100).toFixed(0)} 可用` : '无门槛'}
                      ｜ 有效期至 {new Date(c.expiresAt).toLocaleDateString()}
                    </div>
                  </span>
                </Radio>
              ))
            )}
            <Radio
              value={null}
              style={{ display: 'flex', alignItems: 'center', padding: 10, marginTop: 4, borderRadius: 6, border: '1px solid #f0f0f0', width: '100%' }}
            >
              <span style={{ marginLeft: 4 }}><Text type="secondary">不使用优惠券</Text></span>
            </Radio>
          </Radio.Group>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button onClick={handleClose}>取消</Button>
            <Button type="primary" onClick={() => proceedOrderAndPay(selectedCouponId)}>
              确认下单 ¥{(finalAmount / 100).toFixed(2)}
            </Button>
          </div>
        </div>
      )}

      {/* Native 真实支付二维码 */}
      {step === 'native' && codeUrl && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ fontSize: 16 }}>{orderInfo?.title}</Text>
            <br />
            <Text style={{ fontSize: 28, color: '#cf1322', fontWeight: 700 }}>
              {amountText}
            </Text>
          </div>

          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, display: 'inline-block',
            marginBottom: 16, border: '1px solid #f0f0f0',
          }}>
            <QRCodeSVG value={codeUrl} size={240} />
          </div>

          <div style={{ marginBottom: 8 }}>
            <Text type="secondary">请使用微信扫描二维码完成支付</Text>
          </div>
          <div style={{ marginBottom: 16 }}>
            <Spin size="small" />
            <Text type="secondary" style={{ marginLeft: 8 }}>等待支付结果...</Text>
          </div>
        </div>
      )}

      {/* 支付成功 */}
      {step === 'paid' && (
        <Result
          status="success"
          title="支付成功"
          subTitle="您的会员权益已自动开通，感谢您的支持！"
          extra={<Button type="primary" onClick={handleDone}>完成</Button>}
        />
      )}

      {/* 错误 */}
      {step === 'error' && (
        <Result
          status="error"
          title="支付异常"
          subTitle={errorMsg || '请稍后重试'}
          extra={<Button type="primary" onClick={handleClose}>关闭</Button>}
        />
      )}
    </Modal>
  )
}
