/**
 * 预约记录 — 真实 API 对接
 * @date   2026-03-24
 */
var config = require('../../utils/config')
var request = require('../../utils/request')
var dateUtil = require('../../utils/date')

var STATUS_MAP = {
  PENDING: '待联系',
  CONTACTED: '已联系',
  COMPLETED: '已完成',
  CANCELLED: '已取消'
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/booking-records/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: true,
    records: []
  },

  onShow() {
    this.loadBookings()
  },

  loadBookings() {
    this.setData({ loading: true })
    request({
      url: '/api/app/bookings',
      method: 'GET',
      success: (res) => {
        var data = res.data
        var items = (data && data.items) ? data.items : []
        var records = items.map(function (item) {
          var statusText = STATUS_MAP[item.status] || item.status || '待联系'
          return {
            id: item.bookingNo || item.id,
            bookingNo: item.bookingNo || '',
            title: item.demandType || '标准服务预约',
            status: statusText,
            statusClass: statusText === '已联系' || statusText === '已完成' ? 'tag-green' : 'tag-orange',
            createdAt: dateUtil.formatDate(item.createdAt),
            desc: item.demandDesc || '',
            // 详情 modal 用：保留原始字段，避免再次请求
            demandType: item.demandType || '',
            demandDesc: item.demandDesc || '',
            name: item.name || '',
            phone: item.phone || '',
            organization: item.organization || ''
          }
        })
        this.setData({ loading: false, records: records })
      },
      fail: () => {
        wx.showToast({ title: '加载预约记录失败', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  onRecordTap(e) {
    var id = e.currentTarget.dataset.id
    if (!id) return
    var record = (this.data.records || []).find(function (r) { return r.id === id })
    if (!record) return
    var lines = []
    if (record.bookingNo) lines.push('单号：' + record.bookingNo)
    if (record.demandType) lines.push('类型：' + record.demandType)
    lines.push('状态：' + record.status)
    if (record.createdAt) lines.push('提交时间：' + record.createdAt)
    if (record.name) lines.push('联系人：' + record.name)
    if (record.phone) lines.push('电话：' + record.phone)
    if (record.organization) lines.push('单位：' + record.organization)
    if (record.demandDesc) lines.push('需求说明：' + record.demandDesc)
    wx.showModal({
      title: record.title || '预约详情',
      content: lines.join('\n'),
      showCancel: false,
      confirmText: '我知道了'
    })
  }
})
