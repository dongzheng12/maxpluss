/**
 * 设置页
 */
const session = require('../../utils/session')
const remoteConfig = require('../../utils/remoteConfig')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/settings/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    user: null
  },

  onShow() {
    this.setData({ user: session.getUser() })
  },

  goTerms() {
    wx.navigateTo({ url: '/pages/about/terms' })
  },
  goChangePassword() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/change-password/index' }))
  },
  goNotificationSettings() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/notification-settings/index' }))
  },
  goPrivacy() {
    wx.navigateTo({ url: '/pages/about/privacy' })
  },
  goService: function () {
    var email = remoteConfig.getContact('contact_email', 'biaozhunxiaozhi@tbzy.org.cn')
    wx.showModal({
      title: '联系客服',
      content: '如有订单、发票、会员服务或使用问题，请通过邮箱联系我们\n\n' + email,
      confirmText: '复制邮箱',
      cancelText: '关闭',
      success: function (res) {
        if (res.confirm) {
          wx.setClipboardData({
            data: email,
            success: function () {
              wx.showToast({ title: '已复制邮箱地址', icon: 'success' })
            }
          })
        }
      },
      fail: function (err) {
        console.error('[settings] showModal fail', err)
      }
    })
  },

  logout() {
    session.logout()
    getApp().globalData.user = null
    wx.showToast({ title: '已退出登录', icon: 'none' })
    this.setData({ user: null })
  }
})
