/**
 * 首页 — 真实 API 对接
 * @date   2026-03-24
 */
const config = require('../../utils/config')
const session = require('../../utils/session')
const request = require('../../utils/request')
const TC = require('../../utils/tools-config')
const { trackPageView } = require('../../utils/tracker')
const remoteConfig = require('../../utils/remoteConfig')

function getHomeTools() {
  return TC.DEFAULT_HOME_ORDER
    .map(function (key) { return TC.ALL_TOOLS.find(function (t) { return t.key === key }) })
    .filter(Boolean)
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/home/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    heroStats: [],
    notices: [],
    tools: [],
    moreIcon: require('../../utils/tool-icons').more,
    showMemberBanner: true,
    heroInput: '', // 呼叫小智 hero 输入框临时值；tap 进入聊天页时作为 ?q= 带过去
    homeLoadFailed: false, // 接口失败兜底：true 时展示「加载失败，点击重试」
    memberBannerDesc: '知识库检索与专业权益'
  },

  onShow() {
    // 未登录用户每次进入首页都跳到登录页（onShow 每次可见时触发，覆盖退出登录后切回的场景）
    if (!session.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    // 企业成员点 tabBar「首页」→ 登出并回企业版登录页
    const user = session.getUser() || {}
    if (user.enterpriseRole && user.enterpriseId) {
      session.logout()
      wx.reLaunch({ url: '/pages/login/index?tab=enterprise' })
      return
    }
    trackPageView('pages/home/index')
    this.setData({
      tools: getHomeTools(),
      showMemberBanner: !session.isPaid()
    })
    this._applyRemoteCopy()
    this.loadHome()
  },

  _applyRemoteCopy() {
    this.setData({
      memberBannerDesc: remoteConfig.getCopy('home', 'member_banner_desc', '知识库检索与专业权益'),
    })
  },

  loadHome() {
    var self = this
    if (self.data.homeLoadFailed) self.setData({ homeLoadFailed: false })
    request({
      url: '/api/app/home',
      method: 'GET',
      success: function (res) {
        var d = res.data
        if (!d) {
          self.setData({ homeLoadFailed: true })
          return
        }

        // 后端 heroStats 是对象，前端需要数组 — 只展示平台能力数据，不展示运营指标
        var stats = d.heroStats || {}
        var heroStats = [
          { label: '标准知识库', value: stats.standards ? '可用' : '—' },
          { label: '比对模式', value: '3 种' },
          { label: 'AI 工具', value: '4 项' },
          { label: '服务类型', value: '5 类' }
        ]

        // announcements → notices（content 透传给详情页二次拉取兜底）
        var notices = (d.announcements || []).map(function (item) {
          return { id: item.id, title: item.title, date: item.date, content: item.content || '' }
        })

        self.setData({ heroStats: heroStats, notices: notices, homeLoadFailed: false })
      },
      fail: function () {
        self.setData({ homeLoadFailed: true })
      }
    })
  },

  retryLoadHome() {
    this.loadHome()
  },

  onNoticeTap(e) {
    var id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/notice/detail/index?id=' + encodeURIComponent(id) })
  },

  // 呼叫小智 hero — 点击发送按钮或回车时，如果有输入内容，通过 globalData 传给 chat tab page
  goChatWithInput() {
    var q = (this.data.heroInput || '').trim()
    if (q) {
      getApp().globalData = getApp().globalData || {}
      getApp().globalData.pendingChatQuery = q
      this.setData({ heroInput: '' })
    }
    wx.switchTab({ url: '/pages/chat/index' })
  },

  onHeroInput(e) {
    this.setData({ heroInput: e.detail.value })
  },

  // 点击输入条空白区域（非 input 本体）时的快捷处理：直接聚焦到 chat 页
  // 注：wxml 里 hero-input-row 用 catchtap 拦截 hero 外层 bindtap，避免双触发
  onHeroInputTap() {
    // 什么都不做；让 input 元素自然获取焦点。空方法用来吸收外层 tap 事件。
  },

  // 工具入口点击
  tapTool(e) {
    var key = e.currentTarget.dataset.key
    var tool = TC.ALL_TOOLS.find(function (t) { return t.key === key })
    if (!tool) return
    if (tool.isTab || TC.TAB_ROUTES.indexOf(tool.route) >= 0) {
      wx.switchTab({ url: tool.route })
    } else {
      wx.navigateTo({ url: tool.route })
    }
  },

  // 查看更多 → 工作台
  tapMore() {
    wx.switchTab({ url: '/pages/workspace/index' })
  },

  goBooking() {
    wx.navigateTo({ url: '/pages/booking/index' })
  },

  goMembership() {
    wx.navigateTo({ url: '/pages/membership/index' })
  }
})
