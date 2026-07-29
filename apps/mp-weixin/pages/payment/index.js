/**
 * 支付页 — 扫码支付 + 上传凭证
 * 流程：展示商品 → 点击支付 → 展示收款码 → 用户扫码 → 上传凭证 → 24h 确认
 * @date   2026-03-26
 */
var config = require('../../utils/config')
var session = require('../../utils/session')
var request = require('../../utils/request')
var tracker = require('../../utils/tracker')

/** 格式化金额（元），保留两位小数 */
function fmtPrice(price) {
  return Number(price).toFixed(2)
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/payment/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: false,
    payment: null,
    channel: 'wechat',
    orderNo: '',
    // 支付步骤：info → (jsapi → done) | (qrcode → upload → done)
    step: 'info',
    // done 页文案区分：'paid' = JSAPI 真实付款已开通；'verify' = 凭证上传等核实
    doneMode: 'paid',
    receiptPath: '',
    uploading: false,
    // ─── 优惠券（阶段三）─────────────────────────────────
    // BXZ_COUPON_ENABLED=false 时 applicable 接口返 []，applicableCount=0，入口灰态
    applicableCoupons: [],
    applicableCount: 0,           // 仅 applicable=true 的张数
    couponsLoading: false,         // 优惠券骨架屏标志
    selectedCouponId: null,
    selectedCoupon: null,
    showCouponSheet: false,
    discountAmount: 0,            // 分（仅 selectedCoupon 存在时 > 0）
    discountAmountFmt: '0.00',    // 元（展示用）
    finalAmount: 0,               // 分（折后应付，与未来 order.amount 对齐）
    finalAmountFmt: '0.00'        // 元
  },

  onLoad(query) {
    tracker.trackPageView('pages/payment/index')
    tracker.track('pay_modal_open', { source: query.flow || 'menu' })
    var flow = query.flow || 'download'

    if (flow === 'download' && query.id) {
      this.setData({ loading: true })
      request({
        url: '/api/app/standards/' + encodeURIComponent(query.id),
        method: 'GET',
        success: (res) => {
          var s = res.data
          var dlAmt = s ? (s.downloadPrice || 0) : 0
          this.setData({
            loading: false,
            payment: {
              flow: flow, standardId: query.id,
              title: s ? s.title : '标准信息查阅',
              amount: dlAmt, amountFmt: fmtPrice(dlAmt),
              originAmount: dlAmt,
              desc: s ? (s.code + ' 按次查阅标准信息') : '按次查阅标准信息',
              productType: 'STANDARD_DOWNLOAD', productRef: query.id
            }
          })
          this._loadApplicableCoupons()
        },
        fail: () => {
          this.setData({
            loading: false,
            payment: { flow: flow, title: '标准查阅', amount: 0, amountFmt: '0.00', originAmount: 0, desc: '按次查阅', productType: 'STANDARD_DOWNLOAD', productRef: query.id }
          })
        }
      })
      return
    }

    if (flow === 'report') {
      var taskNo = query.taskNo || ''
      var rptAmt = Number(query.amount) || 0
      this.setData({
        payment: {
          flow: flow, title: '文档比对分析报告',
          amount: rptAmt, amountFmt: fmtPrice(rptAmt),
          originAmount: rptAmt,
          desc: '分析报告解锁',
          productType: 'COMPARE_REPORT', productRef: taskNo
        }
      })
      this._loadApplicableCoupons()
      return
    }

    // 专家评审投票（P0-2B-1）：订单已在申请提交时由 /api/app/expert-votes/:no/submit 直接事务建好，
    // 这里不再走 POST /api/app/orders（后端已禁止 EXPERT_VOTE 通过通用 createOrder 创建）。
    // payment 页只负责调起支付：query 必带 orderNo / amount（元）/ title / requestNo
    if (flow === 'expertVote') {
      var evAmount = Number(query.amount)
      if (!Number.isFinite(evAmount) || evAmount <= 0 || !query.orderNo) {
        wx.showModal({
          title: '支付信息加载失败',
          content: '请返回申请页重新提交',
          showCancel: false,
          success: function () { wx.navigateBack({ delta: 1 }) },
        })
        return
      }
      var evTitle = query.title ? decodeURIComponent(query.title) : '专家评审投票'
      this.setData({
        orderNo: String(query.orderNo),
        payment: {
          flow: 'expertVote',
          title: evTitle,
          amount: evAmount, amountFmt: fmtPrice(evAmount),
          originAmount: evAmount,
          desc: '专家评审投票服务',
          productType: 'EXPERT_VOTE',
          productRef: String(query.requestNo || ''),
          orderNo: String(query.orderNo),
        }
      })
      // EXPERT_VOTE 第一版不支持优惠券，跳过 _loadApplicableCoupons
      return
    }

    if (flow === 'upgrade') {
      // amount 必须由 membership 页携带（基于 /api/app/membership/plans 真实价格算出的差价）
      // 缺失/非法 → 不展示支付，避免假价下单（提审一致性 & 价格法律风险）
      var amount = Number(query.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        wx.showModal({
          title: '支付信息加载失败',
          content: '请返回会员页重新进入',
          showCancel: false,
          success: function () { wx.navigateBack({ delta: 1 }) },
        })
        return
      }
      this.setData({
        payment: {
          flow: flow, planId: query.to || 'pro',
          title: '升级专业会员',
          amount: amount, amountFmt: fmtPrice(amount),
          originAmount: amount,
          desc: '补差价升级', productType: 'MEMBERSHIP'
        }
      })
      this._loadApplicableCoupons()
      return
    }

    // membership（开通）
    var planId = query.planId || 'pro'
    var title = query.title ? decodeURIComponent(query.title) : (planId === 'personal' ? '个人会员' : '专业会员')
    // amount 必须由 membership 页携带；缺失 → 不展示支付（删除 598/998 假价兜底）
    var memberAmount = Number(query.amount)
    if (!Number.isFinite(memberAmount) || memberAmount <= 0) {
      wx.showModal({
        title: '支付信息加载失败',
        content: '请返回会员页重新进入',
        showCancel: false,
        success: function () { wx.navigateBack({ delta: 1 }) },
      })
      return
    }
    this.setData({
      payment: {
        flow: 'membership', planId: planId,
        title: title,
        amount: memberAmount, amountFmt: fmtPrice(memberAmount),
        originAmount: memberAmount,
        desc: '会员权益开通', productType: 'MEMBERSHIP'
      }
    })
    this._loadApplicableCoupons()
  },

  // ─── 优惠券辅助 ─────────────────────────────────────────
  // 拉可用券：BXZ_COUPON_ENABLED=false 时后端返 {items:[]}，前端入口显示"暂无可用优惠券"灰态
  _loadApplicableCoupons() {
    var p = this.data.payment
    if (!p || !p.productType || !p.amount || p.amount <= 0) return
    // 非 MEMBERSHIP/STANDARD 类（如 COMPARE_REPORT amount=0）跳过
    if (p.productType === 'COMPARE_REPORT' || p.productType === 'COMPARE_EXPORT') return

    var self = this
    var qs = 'productType=' + encodeURIComponent(p.productType)
    if (p.planId) qs += '&planId=' + encodeURIComponent(p.planId)
    if (p.productRef) qs += '&productRef=' + encodeURIComponent(p.productRef)

    // 加载态：避免「暂无可用优惠券」骨架闪烁 —— 入口先显示骨架,接口返回再切真实状态
    self.setData({ couponsLoading: true })

    request({
      url: '/api/app/coupons/applicable?' + qs,
      method: 'GET',
      success: function (res) {
        var data = (res && res.data) || {}
        var items = data.items || []
        // 预格式化字段：calculatedDiscount/minAmount 是分，wxml 显示需转元
        items = items.map(function (i) {
          return Object.assign({}, i, {
            calculatedDiscountFmt: fmtPrice((i.calculatedDiscount || 0) / 100),
            minAmountFmt: fmtPrice((i.minAmount || 0) / 100)
          })
        })
        var applicableCount = items.filter(function (i) { return i.applicable }).length
        self.setData({
          applicableCoupons: items,
          applicableCount: applicableCount,
          couponsLoading: false
        })
      },
      fail: function () {
        // 静默：拉券失败不阻塞支付
        self.setData({ couponsLoading: false })
      }
    })
  },

  // 打开/关闭选券弹层
  openCouponSheet() {
    if (!this.data.applicableCoupons || this.data.applicableCoupons.length === 0) return
    this.setData({ showCouponSheet: true })
  },
  closeCouponSheet() {
    this.setData({ showCouponSheet: false })
  },

  // 选中某张券（或"不使用优惠券"）
  pickCoupon(e) {
    var id = e.currentTarget.dataset.id || null
    var p = this.data.payment
    if (!p) return
    var origin = p.amount  // 原价（分*100? 否——这里 amount 是元，需要换算）
    // 注：mp 端 payment.amount 是元（数字），applicable 接口的 calculatedDiscount 是分
    // 这里全部按"分"对齐，mp 展示再除 100；保持单一事实源是后端 createOrder 返回的 order.amount
    if (!id) {
      // 不使用优惠券
      this.setData({
        selectedCouponId: null,
        selectedCoupon: null,
        discountAmount: 0,
        discountAmountFmt: '0.00',
        finalAmount: 0,
        finalAmountFmt: '0.00',
        showCouponSheet: false
      })
      return
    }
    var picked = null
    for (var i = 0; i < this.data.applicableCoupons.length; i++) {
      if (this.data.applicableCoupons[i].id === id) { picked = this.data.applicableCoupons[i]; break }
    }
    if (!picked || !picked.applicable) {
      this.setData({ showCouponSheet: false })
      return
    }
    // calculatedDiscount 是分（int），mp 展示需 / 100
    var discountCents = picked.calculatedDiscount || 0
    var originCents = Math.round(origin * 100)
    var finalCents = originCents - discountCents
    this.setData({
      selectedCouponId: picked.id,
      selectedCoupon: picked,
      discountAmount: discountCents,
      discountAmountFmt: fmtPrice(discountCents / 100),
      finalAmount: finalCents,
      finalAmountFmt: fmtPrice(finalCents / 100),
      showCouponSheet: false
    })
  },

  chooseChannel(e) {
    this.setData({ channel: e.currentTarget.dataset.channel })
  },

  // 步骤1：创建订单 → wx.login 拿 code → /pay → wx.requestPayment → 轮询订单状态
  submitPayment() {
    var p = this.data.payment
    if (!p) return
    var self = this

    // NOTE: R06 订阅授权已从支付链路移除（2026-04-14 hotfix）
    // 原因：wx 订阅授权弹窗 + 二维码支付层叠加，用户视角两层浮层冲突，违反
    //      "同一时刻只能出现一个核心浮层"原则。拿掉后支付二维码单独展示。
    // 后续：R06 quota 获取改到其他时机（候选：订单列表页 PENDING 订单卡片
    //      主动按钮），此次先不做，等下一迭代。

    // 专家评审：订单已建好，跳过 createOrder，直接走 _callPay
    if (p.flow === 'expertVote' && p.orderNo) {
      wx.showLoading({ title: '准备支付...', mask: true })
      wx.login({
        success: function (loginRes) {
          if (!loginRes.code) {
            wx.hideLoading()
            wx.showToast({ title: '微信登录失败', icon: 'none' })
            return
          }
          self._callPay(p.orderNo, loginRes.code)
        },
        fail: function () {
          wx.hideLoading()
          wx.showToast({ title: '微信登录失败', icon: 'none' })
        }
      })
      return
    }

    wx.showLoading({ title: '创建订单...', mask: true })

    // 不传 amount：后端 resolveOrderAmount 服务端硬算，前端 amount 完全被忽略；
    // 而且前端可能拿到 0.1 等浮点（从 orders 列表 0.1 元入场），会被 zod int() 拒
    var orderData = {
      productType: p.productType || 'MEMBERSHIP',
      title: p.title,
      channel: 'WECHAT'
    }
    if (p.planId) orderData.planId = p.planId
    if (p.productRef) orderData.productRef = p.productRef
    // 阶段三：选中优惠券则带 userCouponId；后端 BXZ_COUPON_ENABLED=false 时自动忽略
    if (this.data.selectedCouponId) orderData.userCouponId = this.data.selectedCouponId

    request({
      url: '/api/app/orders',
      method: 'POST',
      data: orderData,
      success: function (res) {
        var order = res.data
        if (!order || !order.orderNo) {
          wx.hideLoading()
          wx.showToast({ title: '创建订单失败', icon: 'none' })
          return
        }

        self.setData({ orderNo: order.orderNo })

        // wx.login → 拿 code → 后端换 openid → JSAPI 下单
        wx.login({
          success: function (loginRes) {
            if (!loginRes.code) {
              wx.hideLoading()
              wx.showToast({ title: '微信登录失败', icon: 'none' })
              return
            }
            self._callPay(order.orderNo, loginRes.code)
          },
          fail: function () {
            wx.hideLoading()
            wx.showToast({ title: '微信登录失败', icon: 'none' })
          }
        })
      },
      fail: function (err) {
        wx.hideLoading()
        // 阶段三：4xx 多半是券失效/被锁/范围错——清掉选中并重拉 applicable，提示用户重选
        var statusCode = err && err.statusCode
        var errMsg = (err && err.data && err.data.error) || ''
        if (self.data.selectedCouponId && statusCode >= 400 && statusCode < 500) {
          self.setData({
            selectedCouponId: null,
            selectedCoupon: null,
            discountAmount: 0,
            discountAmountFmt: '0.00',
            finalAmount: 0,
            finalAmountFmt: '0.00'
          })
          self._loadApplicableCoupons()
          wx.showToast({ title: errMsg || '优惠券已失效，请重新选择', icon: 'none' })
          return
        }
        wx.showToast({ title: errMsg || '网络错误', icon: 'none' })
      }
    })
  },

  // 调 /pay 接口（带 wxLoginCode），后端返回 jsapi payParams 或 qrcode mock fallback
  _callPay: function (orderNo, wxLoginCode) {
    var self = this
    request({
      url: '/api/app/orders/' + orderNo + '/pay',
      method: 'POST',
      data: { channel: 'WECHAT', wxLoginCode: wxLoginCode },
      success: function (payRes) {
        wx.hideLoading()
        var data = (payRes && payRes.data) || {}

        // payMode === 'jsapi' → 拉起原生支付
        if (data.payMode === 'jsapi' && data.payParams) {
          tracker.track('pay_qr_show', { plan: self.data.payment && self.data.payment.planId, amount: self.data.payment && self.data.payment.amount, trade_type: 'JSAPI' })
          self._invokeRequestPayment(data.payParams)
          return
        }

        // 本地 dev-only：BXZ_PAY_AUTO_SUCCESS=true 时后端直接标 PAID
        if (data.payMode === 'mock-paid' || data.status === 'PAID') {
          self.setData({ step: 'done', doneMode: 'paid' })
          return
        }

        // payMode === 'qrcode' （mock fallback） → 走原有上传凭证流程
        if (data.payMode === 'qrcode') {
          self.setData({ step: 'qrcode' })
          return
        }

        // 兜底：未知 payMode 也走 qrcode
        self.setData({ step: 'qrcode' })
      },
      fail: function (err) {
        wx.hideLoading()
        var msg = (err && err.errMsg) || '支付下单失败'
        wx.showToast({ title: msg, icon: 'none' })
        self.setData({ step: 'qrcode' })
      }
    })
  },

  // 调 wx.requestPayment 拉起原生支付窗口
  _invokeRequestPayment: function (payParams) {
    var self = this
    wx.requestPayment({
      timeStamp: payParams.timeStamp,
      nonceStr: payParams.nonceStr,
      package: payParams.package,
      signType: payParams.signType || 'RSA',
      paySign: payParams.paySign,
      success: function () {
        // 支付成功 → 轮询订单状态确认服务端已收到回调
        wx.showLoading({ title: '确认支付...', mask: true })
        self._pollOrderStatus(0)
      },
      fail: function (err) {
        var emsg = (err && err.errMsg) || ''
        if (emsg.indexOf('cancel') >= 0) {
          tracker.track('pay_cancel', { plan: self.data.payment && self.data.payment.planId, stage: 'jsapi' })
          wx.showToast({ title: '支付已取消', icon: 'none' })
        } else {
          wx.showToast({ title: '支付失败：' + emsg, icon: 'none' })
        }
      }
    })
  },

  // 轮询订单状态：最多 15 次，每 2 秒一次（30 秒上限）
  _pollOrderStatus: function (attempt) {
    var self = this
    if (attempt >= 15) {
      wx.hideLoading()
      wx.showToast({ title: '支付确认超时，请稍后查看订单', icon: 'none' })
      return
    }
    request({
      url: '/api/app/orders/' + self.data.orderNo + '/status',
      method: 'GET',
      success: function (res) {
        var status = res && res.data && res.data.status
        if (status === 'PAID') {
          wx.hideLoading()
          self.setData({ step: 'done', doneMode: 'paid' })
          return
        }
        if (status === 'FAILED' || status === 'CANCELLED') {
          wx.hideLoading()
          wx.showToast({ title: '订单已失败/取消', icon: 'none' })
          return
        }
        // 还在 PAYING，继续轮询
        setTimeout(function () { self._pollOrderStatus(attempt + 1) }, 2000)
      },
      fail: function () {
        // 网络错误也继续重试
        setTimeout(function () { self._pollOrderStatus(attempt + 1) }, 2000)
      }
    })
  },

  // 步骤2：用户长按保存二维码 → 点击"我已支付"
  goUpload() {
    this.setData({ step: 'upload' })
  },

  // 上传凭证页 → 返回二维码页
  backToQrcode() {
    this.setData({ step: 'qrcode' })
  },

  // 步骤3：选择凭证图片
  chooseReceipt() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        var path = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (path) {
          this.setData({ receiptPath: path })
        }
      }
    })
  },

  // 步骤4：上传凭证
  uploadReceipt() {
    if (!this.data.receiptPath || !this.data.orderNo) return
    this.setData({ uploading: true })

    wx.uploadFile({
      url: config.API_BASE + '/api/app/orders/' + this.data.orderNo + '/receipt',
      filePath: this.data.receiptPath,
      name: 'file',
      header: { 'Authorization': 'Bearer ' + session.getToken() },
      timeout: 30000,
      success: (res) => {
        this.setData({ uploading: false })
        if (res.statusCode === 200) {
          this.setData({ step: 'done', doneMode: 'verify' })
        } else {
          var data
          try { data = JSON.parse(res.data) } catch (e) { data = {} }
          wx.showToast({ title: data.error || '上传失败', icon: 'none' })
        }
      },
      fail: () => {
        this.setData({ uploading: false })
        wx.showToast({ title: '网络错误', icon: 'none' })
      }
    })
  },

  // 完成后跳转
  goNext() {
    var p = this.data.payment
    if (!p) return
    if (p.flow === 'report') {
      var taskNo = p.productRef || ''
      if (taskNo) {
        wx.redirectTo({ url: '/pages/report/index?taskNo=' + taskNo })
      } else {
        wx.navigateTo({ url: '/pages/orders/index' })
      }
      return
    }
    if (p.flow === 'membership' || p.flow === 'upgrade') {
      wx.redirectTo({ url: '/pages/my-member/index' })
      return
    }
    if (p.flow === 'expertVote') {
      var evNo = p.productRef || ''
      if (evNo) {
        wx.redirectTo({ url: '/pages/expert-vote/detail/index?no=' + evNo })
      } else {
        wx.redirectTo({ url: '/pages/expert-vote/index' })
      }
      return
    }
    wx.navigateTo({ url: '/pages/orders/index' })
  },

  // 预览二维码大图
  previewQR() {
    wx.previewImage({
      urls: ['/images/pay-qrcode.jpg'],
      current: '/images/pay-qrcode.jpg'
    })
  }
})
