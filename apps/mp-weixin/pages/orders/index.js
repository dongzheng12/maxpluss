/**
 * 我的订单 — 真实 API 对接
 * @date   2026-03-24
 */
const config = require('../../utils/config')
const session = require('../../utils/session')
const request = require('../../utils/request')
const dateUtil = require('../../utils/date')

// 前端 tab → 后端 productType 映射
var TAB_MAP = {
  all: null,
  membership: ['MEMBERSHIP'],
  download: ['STANDARD_PREVIEW', 'STANDARD_DOWNLOAD'],
  compare: ['COMPARE_REPORT', 'COMPARE_EXPORT']
}

// 后端状态 → 中文显示
var STATUS_MAP = {
  PAID: '已支付',
  PENDING: '待支付',
  PAYING: '支付中',
  PENDING_VERIFY: '待确认',
  PROCESSING: '处理中',
  CANCELLED: '已取消',
  FAILED: '支付失败',
  REFUNDED: '已退款'
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/orders/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: true,
    activeTab: 'all',
    orders: [],
    filtered: []
  },

  onLoad() {
    if (!session.requireLogin()) return
    this.loadOrders()
  },

  onShow() {
    // 从支付页返回时刷新
    if (!this.data.loading && this.data.orders.length > 0) {
      this.loadOrders()
    }
  },

  loadOrders() {
    this.setData({ loading: true })
    request({
      url: '/api/app/orders',
      method: 'GET',
      success: (res) => {
        var data = res.data
        var items = (data && data.items) ? data.items : []
        // 格式化每条订单
        var orders = items.map(function (item) {
          // 发票可申请：支付成功满 7 天
          var canInvoice = false
          var invoiceCountdown = ''
          if (item.status === 'PAID' && item.paidAt && item.amount > 0 && (item.invoiceStatus || 'NOT_REQUESTED') === 'NOT_REQUESTED') {
            var paidMs = new Date(item.paidAt).getTime()
            var elapsed = Date.now() - paidMs
            if (elapsed >= 7 * 24 * 60 * 60 * 1000) {
              canInvoice = true
            } else {
              var daysLeft = Math.ceil((7 * 24 * 60 * 60 * 1000 - elapsed) / (24 * 60 * 60 * 1000))
              invoiceCountdown = '支付满 7 天后可申请发票（还需 ' + daysLeft + ' 天）'
            }
          }
          return {
            orderNo: item.orderNo || '',
            productType: item.productType || '',
            productRef: item.productRef || '',
            title: item.title || '未知订单',
            status: item.status || 'PENDING',
            statusText: STATUS_MAP[item.status] || item.status || '未知',
            amount: item.amount || 0,
            invoiceStatus: item.invoiceStatus || 'NOT_REQUESTED',
            createdAt: dateUtil.formatDate(item.createdAt),
            canInvoice: canInvoice,
            invoiceCountdown: invoiceCountdown
          }
        })
        this.setData({ loading: false, orders: orders })
        this.filterOrders()
      },
      fail: () => {
        wx.showToast({ title: '加载订单失败', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab })
    this.filterOrders()
  },

  filterOrders() {
    var activeTab = this.data.activeTab
    var types = TAB_MAP[activeTab]
    var filtered
    if (!types) {
      filtered = this.data.orders
    } else {
      filtered = this.data.orders.filter(function (item) {
        return types.indexOf(item.productType) !== -1
      })
    }
    this.setData({ filtered: filtered })
  },

  openInvoice(e) {
    wx.navigateTo({ url: '/pages/invoice/index?orderNo=' + e.currentTarget.dataset.orderno })
  },

  cancelOrder(e) {
    var orderNo = e.currentTarget.dataset.orderno
    var title = e.currentTarget.dataset.title || '此订单'
    var that = this
    wx.showModal({
      title: '确认取消订单？',
      content: '订单「' + title + '」将被取消，取消后如需购买请重新下单。',
      confirmText: '确认取消',
      confirmColor: '#ff4d4f',
      success: function (res) {
        if (!res.confirm) return
        request({
          url: '/api/app/orders/' + orderNo + '/cancel',
          method: 'POST',
          success: function () {
            wx.showToast({ title: '订单已取消', icon: 'success' })
            that.loadOrders()
          },
          fail: function () {
            wx.showToast({ title: '取消失败', icon: 'none' })
          }
        })
      }
    })
  },

  goPayment(e) {
    var order = e.currentTarget.dataset.order
    if (!order) return
    // 跳转到支付页，带上订单信息
    var url = '/pages/payment/index?flow=' + (order.productType === 'MEMBERSHIP' ? 'membership' : order.productType === 'COMPARE_REPORT' ? 'report' : 'download')
    // order.amount 来自后端，单位是分；payment 页 query.amount 期望元，所以除以 100
    url += '&amount=' + (order.amount / 100)
    if (order.productRef) url += '&id=' + order.productRef + '&taskNo=' + order.productRef
    wx.navigateTo({ url: url })
  }
})
