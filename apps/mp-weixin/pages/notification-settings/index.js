/**
 * 消息通知设置页
 *
 * 原则：所有订阅授权入口统一在此。主流程按钮（支付/扫码/大纲/小智）不再触发
 * wx.requestSubscribeMessage，避免与业务浮层冲突。
 *
 * 一次性请求 3 个最高优先级模板（微信限制 tmplIds.length ≤ 3）：
 *  - R06 订单待支付提醒
 *  - R10/R11 会员到期提醒
 *  - R04/R05/R09 次数卡消费通知（功能次数不足）
 *
 * R14 邀请、R15 首扫奖励在各自场景里补充触发，不在此页面。
 */
var subscribe = require('../../utils/subscribe')
var session = require('../../utils/session')

var TEMPLATES_TO_REQUEST = [
  subscribe.TEMPLATES.R06_UNPAID_RECALL,
  subscribe.TEMPLATES.MEMBER_EXPIRE,
  subscribe.TEMPLATES.QUOTA_LOW,
]

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/notification-settings/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: false,
    acceptedCount: 0,
    declinedCount: 0,
    hasResult: false,
  },

  onLoad: function () {
    if (!session.isLoggedIn()) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      setTimeout(function () { wx.navigateBack() }, 1200)
    }
  },

  /**
   * 「开启通知」按钮 — 必须在此 tap 同步栈里调 wx.requestSubscribeMessage
   */
  onEnableNotifications: function () {
    var self = this
    if (self.data.loading) return
    self.setData({ loading: true })

    subscribe.requestSubscribeBatch(TEMPLATES_TO_REQUEST, {
      onDone: function (result) {
        self.setData({
          loading: false,
          hasResult: true,
          acceptedCount: result.accepted.length,
          declinedCount: result.declined.length,
        })
        if (result.accepted.length === TEMPLATES_TO_REQUEST.length) {
          wx.showToast({ title: '已全部开启', icon: 'success' })
        } else if (result.accepted.length > 0) {
          wx.showToast({ title: '已部分开启', icon: 'none' })
        } else {
          wx.showToast({ title: '未开启通知', icon: 'none' })
        }
      }
    })
  },
})
