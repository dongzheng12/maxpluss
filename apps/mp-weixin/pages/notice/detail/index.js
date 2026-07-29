/**
 * 公告详情
 * 从 /pages/home/index 跳转过来，options.id 为公告 id
 * 优先调 GET /api/app/announcements/:id 拉最新内容，失败时若有传入的 title/date/content 也可降级展示
 */
var request = require('../../../utils/request')

Page({
  data: {
    loading: true,
    notFound: false,
    notice: { id: '', title: '', date: '', content: '' }
  },

  onLoad(options) {
    var id = options && options.id ? decodeURIComponent(options.id) : ''
    if (!id) {
      this.setData({ loading: false, notFound: true })
      return
    }
    this.setData({ notice: { id: id, title: '', date: '', content: '' } })
    this._load(id)
  },

  _load(id) {
    var self = this
    request({
      url: '/api/app/announcements/' + encodeURIComponent(id),
      method: 'GET',
      success: function (res) {
        var d = res && res.data
        if (!d || !d.id) {
          self.setData({ loading: false, notFound: true })
          return
        }
        self.setData({
          loading: false,
          notFound: false,
          notice: {
            id: d.id,
            title: d.title || '',
            date: d.date || '',
            content: d.content || ''
          }
        })
      },
      fail: function () {
        self.setData({ loading: false, notFound: true })
      }
    })
  }
})
