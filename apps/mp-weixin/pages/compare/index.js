/**
 * 比对入口 — 对接真实 API
 * @date   2026-03-21
 */
const config = require('../../utils/config')
const request = require('../../utils/request')
const remoteConfig = require('../../utils/remoteConfig')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/compare/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    tasks: [],
    loading: false,
    totalCount: 0,
    doneCount: 0,
    pendingCount: 0,
    failedCount: 0,
    hasPending: false,
    pollStoppedDisplay: false
  },
  _pollTimer: null,
  // 分阶段轮询状态：前 5 分钟 3s / 之后 10s / 30 分钟硬停
  _pollStartedAt: null,
  _pollStopped: false,
  _pollStopSnapshot: null,

  onShow() {
    // 重新进入页面 = 重置轮询状态
    this._pollStartedAt = null
    this._pollStopped = false
    this._pollStopSnapshot = null
    if (this.data.pollStoppedDisplay) this.setData({ pollStoppedDisplay: false })
    this.loadTasks()
    this._startPoll()
  },

  onHide() { this._stopPoll() },
  onUnload() { this._stopPoll() },

  _startPoll: function () {
    this._stopPoll()
    if (!this.data.hasPending) {
      this._pollStartedAt = null
      this._pollStopped = false
      this._pollStopSnapshot = null
      return
    }
    // 30 分钟硬停后，只有出现新 pending taskNo 才重启
    if (this._pollStopped) {
      var snap = this._pollStopSnapshot || {}
      var pendingNos = (this.data.tasks || [])
        .filter(function (t) { return t.status === 'PENDING' || t.status === 'PROCESSING' })
        .map(function (t) { return t.taskNo })
      var hasNew = false
      for (var i = 0; i < pendingNos.length; i++) {
        if (!snap[pendingNos[i]]) { hasNew = true; break }
      }
      if (!hasNew) return
      this._pollStopped = false
      this._pollStartedAt = Date.now()
      this._pollStopSnapshot = null
    }
    if (this._pollStartedAt == null) this._pollStartedAt = Date.now()
    var elapsed = Date.now() - this._pollStartedAt
    var delay
    if (elapsed >= 30 * 60 * 1000) delay = null
    else if (elapsed < 5 * 60 * 1000) delay = 3000
    else delay = 10000
    if (delay === null) {
      this._pollStopped = true
      var snapNew = {}
      var nos = (this.data.tasks || [])
        .filter(function (t) { return t.status === 'PENDING' || t.status === 'PROCESSING' })
        .map(function (t) { return t.taskNo })
      for (var j = 0; j < nos.length; j++) snapNew[nos[j]] = true
      this._pollStopSnapshot = snapNew
      this.setData({ pollStoppedDisplay: true })
      return
    }
    var self = this
    this._pollTimer = setTimeout(function () {
      if (self.data.hasPending) {
        self.loadTasks()
        self._startPoll()
      } else {
        self._stopPoll()
      }
    }, delay)
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  loadTasks() {
    this.setData({ loading: true })
    request({
      url: '/api/app/compare/tasks',
      method: 'GET',
      success: (res) => {
        var data = res.data || {}
        var _S = { PENDING: '排队中', PROCESSING: '处理中', COMPLETED: '已完成', FAILED: '失败' }
        var items = (data.items || []).map(function (t) {
          if (t.createdAt) {
            var d = new Date(t.createdAt)
            var mm = String(d.getMonth() + 1).padStart(2, '0')
            var dd = String(d.getDate()).padStart(2, '0')
            var hh = String(d.getHours()).padStart(2, '0')
            var mi = String(d.getMinutes()).padStart(2, '0')
            t._createdFmt = mm + '-' + dd + ' ' + hh + ':' + mi
          }
          // 任务状态文案 — 走 mp_copy_status 远程配置,fallback 与 wxml 历史值字面一致
          t.displayStatus = remoteConfig.getCopy('status', t.status, _S[t.status] || t.status)
          return t
        })
        const done = items.filter(t => t.status === 'COMPLETED').length
        const pending = items.filter(t => t.status === 'PENDING' || t.status === 'PROCESSING').length
        const failed = items.filter(t => t.status === 'FAILED').length
        this.setData({
          tasks: items,
          totalCount: items.length,
          doneCount: done,
          pendingCount: pending,
          failedCount: failed,
          hasPending: pending > 0
        })
        // 没有 PENDING 任务了就停止轮询
        if (pending === 0) this._stopPoll()
      },
      fail: () => {
        wx.showToast({ title: '加载失败', icon: 'none' })
      },
      complete: () => {
        this.setData({ loading: false })
      }
    })
  },
  goLaunch() {
    wx.navigateTo({ url: '/pages/compare-launch/index' })
  },
  // 30 分钟硬停后用户主动刷新：重置轮询窗口 + 拉一次最新数据
  refreshAfterStop() {
    this._pollStartedAt = Date.now()
    this._pollStopped = false
    this._pollStopSnapshot = null
    this.setData({ pollStoppedDisplay: false })
    this.loadTasks()
    this._startPoll()
  },
  // 重新比对：失败任务直接跳转上传页（用户换文件再提交）
  reCompare() {
    wx.navigateTo({ url: '/pages/compare-launch/index' })
  },
  retryTask(e) {
    const taskNo = e.currentTarget.dataset.taskno
    wx.showModal({
      title: '重试比对',
      content: '将重新处理此比对任务，确定吗？',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '提交中...' })
        request({
          url: `/api/app/compare/tasks/${taskNo}/retry`,
          method: 'POST',
          success: () => {
            wx.hideLoading()
            wx.showToast({ title: '已重新提交', icon: 'success' })
            this.loadTasks()
          },
          fail: () => {
            wx.hideLoading()
            wx.showToast({ title: '重试失败', icon: 'none' })
          }
        })
      }
    })
  },
  deleteTask(e) {
    const taskNo = e.currentTarget.dataset.taskno
    wx.showModal({
      title: '确认删除',
      content: '删除后无法恢复，确定要删除此比对任务吗？',
      confirmColor: '#e74c3c',
      success: (res) => {
        if (!res.confirm) return
        request({
          url: `/api/app/compare/tasks/${taskNo}`,
          method: 'DELETE',
          success: () => {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.loadTasks()
          },
          fail: () => {
            wx.showToast({ title: '删除失败', icon: 'none' })
          }
        })
      }
    })
  },

  openReport(e) {
    const taskNo = e.currentTarget.dataset.taskno
    const status = e.currentTarget.dataset.status
    if (status === 'PENDING' || status === 'PROCESSING') {
      wx.showToast({ title: '任务处理中，请稍候', icon: 'none' })
      return
    }
    if (status === 'FAILED') {
      wx.showToast({ title: '任务处理失败', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/report/index?taskNo=${taskNo}` })
  }
})
