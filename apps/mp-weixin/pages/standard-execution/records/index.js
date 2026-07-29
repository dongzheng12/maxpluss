/**
 * 我的完成记录 — 列表 + wx.showModal 详情（一期）
 */
const se = require('../../../utils/standardExecution')

const PAGE_SIZE = 20
const RELOAD_FAILURE_COOLDOWN_MS = 4000

Page({
  _reloadPromise: null,
  _lastFailureAt: 0,

  data: {
    items: [],
    page: 1,
    total: 0,
    loading: false,
    finished: false,
    empty: false,
  },

  onLoad() { this._reload({ force: true }) },

  onPullDownRefresh() {
    this._reload({ force: true }).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.loading || this.data.finished) return
    this._loadMore()
  },

  showDetail(e) {
    const idx = e.currentTarget.dataset.idx
    const rec = this.data.items[idx]
    if (!rec) return
    const lines = [
      `标题：${rec.title}`,
      rec.taskTitle ? `\n任务：${rec.taskTitle}` : '',
      rec.sourceTitle ? `\n来源：${rec.sourceTitle}` : '',
      rec.summary ? `\n摘要：${rec.summary}` : '',
      `\n状态：${rec.statusLabel || se.RECORD_STATUS_LABEL[rec.status] || rec.status}`,
      `\n附件：${rec.attachmentCount || 0} 份`,
      `\n完成时间：${rec.recordDate}`,
    ].filter(Boolean).join('')
    wx.showModal({
      title: '记录详情',
      content: lines,
      showCancel: false,
      confirmText: '关闭',
    })
  },

  _reload(options) {
    const opts = options || {}
    if (this._reloadPromise) return this._reloadPromise
    const now = Date.now()
    if (!opts.force && this._lastFailureAt && now - this._lastFailureAt < RELOAD_FAILURE_COOLDOWN_MS) {
      return Promise.resolve(null)
    }

    this._reloadPromise = this._fetch(1).then((res) => {
      this.setData({
        items: (res && res.data) || [],
        total: (res && res.total) || 0,
        page: 1,
        finished: ((res && res.data) || []).length >= ((res && res.total) || 0),
        empty: !((res && res.data) || []).length,
      })
    }).catch((e) => {
      this._lastFailureAt = Date.now()
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    }).finally(() => {
      this._reloadPromise = null
    })
    return this._reloadPromise
  },

  _loadMore() {
    const next = this.data.page + 1
    return this._fetch(next).then((res) => {
      const newItems = (res && res.data) || []
      const all = this.data.items.concat(newItems)
      this.setData({
        items: all,
        page: next,
        total: (res && res.total) || all.length,
        finished: all.length >= ((res && res.total) || all.length),
      })
    }).catch((e) => {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    })
  },

  _fetch(page) {
    this.setData({ loading: true })
    return se.listRecords({ page, pageSize: PAGE_SIZE })
      .then((res) => ({
        ...res,
        data: ((res && res.data) || []).map(this._normalizeRecord),
      }))
      .finally(() => this.setData({ loading: false }))
  },

  _normalizeRecord(rec) {
    const task = (rec && rec.task) || {}
    const requirement = (rec && rec.requirement) || task.requirement || {}
    const attachments = Array.isArray(rec && rec.attachments) ? rec.attachments : []
    return {
      ...rec,
      taskTitle: rec.taskTitle || task.title || '',
      sourceTitle: rec.sourceTitle || (requirement.source && requirement.source.title) || requirement.sourceTitle || '',
      statusLabel: se.RECORD_STATUS_LABEL[rec.status] || rec.status || '未知',
      attachmentCount: rec.attachmentCount || attachments.length || 0,
    }
  },
})
