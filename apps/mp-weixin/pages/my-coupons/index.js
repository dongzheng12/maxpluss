/**
 * 我的优惠券（阶段三）
 * 4 tab：可用 / 已使用 / 已过期 / 已失效
 * 适用范围 ALL/MEMBERSHIP/MEMBERSHIP_PERSONAL/MEMBERSHIP_PRO/STANDARD 中文化
 * BXZ_COUPON_ENABLED=false 时所有 tab 都返 [] → 显示空状态
 */
var session = require('../../utils/session')
var request = require('../../utils/request')
var tracker = require('../../utils/tracker')

var SCOPE_LABEL = {
  ALL: '全场通用',
  MEMBERSHIP: '会员专用',
  MEMBERSHIP_PERSONAL: '个人会员专用',
  MEMBERSHIP_PRO: '专业会员专用',
  STANDARD: '标准查阅专用'
}

function fmtPrice(p) { return Number(p).toFixed(2) }

function fmtDate(iso) {
  if (!iso) return ''
  var d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  var y = d.getFullYear()
  var m = ('0' + (d.getMonth() + 1)).slice(-2)
  var dd = ('0' + d.getDate()).slice(-2)
  return y + '-' + m + '-' + dd
}

// 是否 3 天内到期（仅可用 tab 用）
function isExpiringSoon(iso) {
  if (!iso) return false
  var diff = new Date(iso).getTime() - Date.now()
  return diff > 0 && diff < 3 * 24 * 60 * 60 * 1000
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/my-coupons/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    activeTab: 'AVAILABLE',
    tabs: [
      { key: 'AVAILABLE', label: '可用' },
      { key: 'USED', label: '已使用' },
      { key: 'EXPIRED', label: '已过期' },
      { key: 'REVOKED', label: '已失效' }
    ],
    loading: false,
    items: []
  },

  onLoad() {
    tracker.trackPageView('pages/my-coupons/index')
    var self = this
    session.ensureLogin(function () { self._load('AVAILABLE') })
  },

  switchTab(e) {
    var key = e.currentTarget.dataset.key
    if (!key || key === this.data.activeTab) return
    this.setData({ activeTab: key })
    this._load(key)
  },

  onCouponTap(e) {
    var id = e.currentTarget.dataset.id
    if (!id) return
    var item = (this.data.items || []).find(function (it) { return it.id === id })
    if (!item) return
    var STATUS_LABEL = { AVAILABLE: '可用', LOCKED: '锁定中', USED: '已使用', EXPIRED: '已过期', REVOKED: '已失效' }
    var lines = []
    lines.push('面额：' + (item.faceValue || ''))
    if (item.scopeLabel) lines.push('适用：' + item.scopeLabel)
    if (item.minAmount > 0) lines.push('门槛：满 ¥' + item.minAmountFmt + ' 可用')
    if (item.maxDiscount && item.discountType === 'PERCENT') {
      lines.push('封顶：最多减 ¥' + fmtPrice(item.maxDiscount / 100))
    }
    if (item.description) lines.push('说明：' + item.description)
    lines.push('状态：' + (STATUS_LABEL[item.status] || item.status || ''))
    if (item.expiresAtFmt) lines.push((item.status === 'EXPIRED' ? '过期时间：' : '到期：') + item.expiresAtFmt)
    if (item.status === 'USED' && item.usedAtFmt) lines.push('使用时间：' + item.usedAtFmt)
    if (item.status === 'USED' && item.usedOrderNo) lines.push('使用订单：' + item.usedOrderNo)
    if (item.code) lines.push('券码：' + item.code)
    var canCopy = !!item.code
    wx.showModal({
      title: item.name || '优惠券详情',
      content: lines.join('\n'),
      showCancel: canCopy,
      cancelText: '复制券码',
      confirmText: '关闭',
      success: function (r) {
        if (r.cancel && canCopy) {
          wx.setClipboardData({
            data: item.code,
            success: function () { wx.showToast({ title: '券码已复制', icon: 'success' }) }
          })
        }
      }
    })
  },

  _load(status) {
    var self = this
    this.setData({ loading: true, items: [] })
    request({
      url: '/api/app/coupons/my?status=' + encodeURIComponent(status),
      method: 'GET',
      success: function (res) {
        var items = (res && res.data && res.data.items) || []
        // 字段格式化：金额（分→元）+ 日期 + 适用范围中文 + 即将到期标
        items = items.map(function (i) {
          var faceValue = ''
          if (i.discountType === 'FIXED') {
            faceValue = '¥' + fmtPrice((i.discountValue || 0) / 100)
          } else if (i.discountType === 'PERCENT') {
            // 折扣值 30 = 减 30% = 7 折；展示为"X 折"
            var percentOff = i.discountValue || 0
            var foldValue = (10 - percentOff / 10).toFixed(1).replace(/\.0$/, '')
            faceValue = foldValue + ' 折'
          }
          return Object.assign({}, i, {
            faceValue: faceValue,
            scopeLabel: SCOPE_LABEL[i.applicableScope] || '',
            minAmountFmt: fmtPrice((i.minAmount || 0) / 100),
            expiresAtFmt: fmtDate(i.expiresAt),
            usedAtFmt: fmtDate(i.usedAt),
            expiringSoon: status === 'AVAILABLE' && isExpiringSoon(i.expiresAt)
          })
        })
        self.setData({ loading: false, items: items })
      },
      fail: function () {
        self.setData({ loading: false, items: [] })
      }
    })
  }
})
