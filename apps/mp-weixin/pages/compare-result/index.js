/**
 * 比对结果页 — 真实 API 对接
 * @date   2026-03-24
 */
var session = require('../../utils/session')
var config = require('../../utils/config')
var request = require('../../utils/request')
var remoteConfig = require('../../utils/remoteConfig')

var DEFAULT_COMPARE_MEMBERSHIP_NOTICE = {
  launch: {
    free: '一对一比对与全库相似度分析均为会员权益内功能，按套餐次数消耗，失败不计次。',
    personalRemaining: '个人会员：全库相似度分析剩余 {remaining} 次',
    personalExhausted: '个人会员：本年度全库相似度分析 10 次完整报告额度已用完，可升级专业版',
    pro: '专业会员：全库相似度分析不限次完整报告',
    pairPageLimit: '一对一比对仅分析前 30 页内容，超出部分将跳过',
    pairMemberOnly: '一对一比对为会员专属功能，请升级会员后使用',
  },
  result: {
    free: '全库相似度分析完整报告需开通个人或专业会员，按套餐次数消耗，失败不计次。',
    personalRemaining: '个人会员：全库相似度分析剩余 {remaining} 次',
    personalExhausted: '个人会员：本年度全库相似度分析 10 次完整报告额度已用完，可升级专业版',
    pro: '专业会员：全库相似度分析不限次完整报告',
    reportLocked: '全库相似度分析报告需要会员权限，请开通个人或专业会员',
  },
}

function replaceRemaining(template, remaining) {
  return String(template).replace('{remaining}', String(remaining))
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/compare-result/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    tab: 'mapping',
    mappings: [],
    loading: true,
    linesA: [],
    linesB: [],
    priceNote: '',
    btnSuffix: ''
  },

  onLoad() {
    var app = getApp()
    var sectionsA = app.globalData.compareSectionsA || []
    var sectionsB = app.globalData.compareSectionsB || []
    if (!sectionsA.length || !sectionsB.length) {
      sectionsA = sectionsA.length ? sectionsA : [{ id: 'full-a', title: '全文' }]
      sectionsB = sectionsB.length ? sectionsB : [{ id: 'full-b', title: '全文' }]
    }
    this._runCompare(sectionsA, sectionsB)
    remoteConfig.loadRemoteConfig().then(() => {
      this._refreshPrice()
    }).catch(() => {
      this._refreshPrice()
    })
  },

  onShow() {
    // 强刷会员状态：避免后端已撤权但前端 storage 仍显示会员
    this._refreshMemberFromServer()
  },

  _refreshMemberFromServer() {
    var self = this
    request({ url: '/api/app/profile', method: 'GET' }).then(function (res) {
      var cached = session.getUser() || {}
      var m = res && res.data && res.data.membership
      if (m && m.status === 'ACTIVE' && m.plan) {
        cached.memberTier = m.plan.id || 'free'
        cached.memberExpire = m.endAt
      } else {
        cached.memberTier = 'free'
        cached.memberExpire = null
      }
      session.setUser(cached)
      self._refreshPrice()
    }).catch(function () { /* 静默：网络失败时回退本地缓存，不阻塞页面 */ })
  },

  _refreshPrice() {
    var access = session.getCompareReportAccess()
    var tier = session.getMemberTier()
    var compareNotice = remoteConfig.getCompareMembershipNotice(DEFAULT_COMPARE_MEMBERSHIP_NOTICE)
    if (session.isPro()) {
      this.setData({ priceNote: compareNotice.result.pro, btnSuffix: '' })
    } else if (tier === 'personal' && access.remaining > 0) {
      this.setData({ priceNote: replaceRemaining(compareNotice.result.personalRemaining, access.remaining), btnSuffix: '' })
    } else if (tier === 'personal' && access.remaining === 0) {
      this.setData({ priceNote: compareNotice.result.personalExhausted, btnSuffix: '' })
    } else {
      this.setData({ priceNote: compareNotice.result.free, btnSuffix: '' })
    }
  },

  _runCompare(sectionsA, sectionsB) {
    this.setData({ loading: true })
    request({
      url: '/api/app/compare/run-sections',
      method: 'POST',
      data: {
        sectionsA: sectionsA.map(function (s) { return { id: s.id, title: s.title, content: s.content || '' } }),
        sectionsB: sectionsB.map(function (s) { return { id: s.id, title: s.title, content: s.content || '' } })
      },
      success: (res) => {
        var data = res.data || {}
        var mappings = data.mappings || []
        var linesA = []
        var linesB = []
        mappings.forEach(function (m) {
          ;(m.contentA || '').split('\n').forEach(function (l) { if (l.trim()) linesA.push(l.trim()) })
          ;(m.contentB || '').split('\n').forEach(function (l) { if (l.trim()) linesB.push(l.trim()) })
        })
        this.setData({
          mappings: mappings,
          linesA: linesA,
          linesB: linesB,
          loading: false
        })
      },
      fail: () => {
        wx.showToast({ title: '比对计算失败', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  viewReport() {
    var access = session.getCompareReportAccess()
    if (access.allowed && !access.needPay) {
      wx.showToast({ title: '分析报告生成中...', icon: 'none' })
      return
    }
    wx.showModal({
      title: '需要会员权限',
      content: remoteConfig.getCompareMembershipNotice(DEFAULT_COMPARE_MEMBERSHIP_NOTICE).result.reportLocked,
      confirmText: '查看会员',
      success: function (r) { if (r.confirm) wx.navigateTo({ url: '/pages/membership/index' }) }
    })
  }
})
