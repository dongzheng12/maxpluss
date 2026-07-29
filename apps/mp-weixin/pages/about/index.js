/**
 * 关于页面
 * @date   2026-03-21
 */
Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/about/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    year: new Date().getFullYear()
  },
  tapIcp() {
    wx.setClipboardData({
      data: '京ICP备20023187号-8',
      success: () => wx.showToast({ title: '已复制备案号', icon: 'success' })
    })
  }
})
