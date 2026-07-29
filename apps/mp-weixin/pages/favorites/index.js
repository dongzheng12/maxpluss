/**
 * 我的收藏 — 真实 API 对接
 * @date   2026-03-24
 */
var config = require('../../utils/config')
var session = require('../../utils/session')
var request = require('../../utils/request')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/favorites/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: false,
    standards: []
  },

  onShow() {
    if (!session.requireLogin()) return
    this.loadFavorites()
  },

  loadFavorites() {
    var ids = session.getFavorites()
    if (!ids || ids.length === 0) {
      this.setData({ standards: [], loading: false })
      return
    }

    this.setData({ loading: true })
    var results = []
    var done = 0
    var total = ids.length
    var self = this

    ids.forEach(function (id) {
      request({
        url: '/api/app/standards/' + encodeURIComponent(id),
        method: 'GET',
        success: function (res) {
          if (res.data && res.data.id) {
            results.push(res.data)
          }
        },
        complete: function () {
          done++
          if (done >= total) {
            self.setData({ standards: results, loading: false })
          }
        }
      })
    })
  },

  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/index?id=' + e.currentTarget.dataset.id })
  }
})
