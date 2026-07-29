/**
 * 邀请好友页（任务六 R14）
 *
 * 进入 → GET /api/app/referral/code 拿小程序码 base64 + 邀请码
 * 长按图片可保存到相册（微信原生 image 组件支持）
 */
var request = require('../../utils/request')
var session = require('../../utils/session')
var subscribe = require('../../utils/subscribe')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/referral/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: true,
    qrcodeBase64: '',
    code: '',
    totalInvited: 0,
    errorMsg: '',
  },

  onLoad: function () {
    if (!session.isLoggedIn()) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      setTimeout(function () { wx.navigateBack() }, 1200)
      return
    }
    this._loadCode()
  },

  onPullDownRefresh: function () {
    this._loadCode(function () { wx.stopPullDownRefresh() })
  },

  _loadCode: function (cb) {
    var self = this
    self.setData({ loading: true, errorMsg: '' })
    request({
      url: '/api/app/referral/code',
      method: 'GET',
      success: function (res) {
        if (res.statusCode === 200 && res.data && res.data.qrcodeBase64) {
          self.setData({
            loading: false,
            qrcodeBase64: res.data.qrcodeBase64,
            code: res.data.code,
            totalInvited: res.data.totalInvited || 0,
          })
        } else {
          var msg = (res.data && res.data.error) || '邀请码加载失败'
          self.setData({ loading: false, errorMsg: msg })
        }
        if (cb) cb()
      },
      fail: function () {
        self.setData({ loading: false, errorMsg: '网络错误，请下拉刷新重试' })
        if (cb) cb()
      }
    })
  },

  copyCode: function () {
    if (!this.data.code) return
    var self = this
    wx.setClipboardData({
      data: self.data.code,
      success: function () { wx.showToast({ title: '邀请码已复制', icon: 'success' }) },
    })
  },

  previewImage: function () {
    if (!this.data.qrcodeBase64) return
    // 用户点击「查看二维码」同步栈：同时请求 R14 模板授权，供后端发"邀请奖励已到账"推送
    subscribe.requestSubscribe(subscribe.TEMPLATES.REFERRAL)
    wx.previewImage({ urls: [this.data.qrcodeBase64] })
  },
})
