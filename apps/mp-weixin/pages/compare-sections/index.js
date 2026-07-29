/**
 * 章节选择页 — 真实 API 对接
 * @date   2026-03-24
 */
var session = require('../../utils/session')
var config = require('../../utils/config')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/compare-sections/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    fileAName: '',
    fileBName: '',
    sectionsA: [],
    sectionsB: [],
    allCheckedA: true,
    allCheckedB: true,
    checkedCountA: 0,
    checkedCountB: 0,
    loadingA: false,
    loadingB: false,
    comparing: false,
    errorA: '',
    errorB: ''
  },

  onLoad() {
    var app = getApp()
    var fileA = app.globalData.compareFileA
    var fileB = app.globalData.compareFileB
    if (!fileA || !fileB) {
      wx.showToast({ title: '请先上传文档', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ fileAName: fileA.name, fileBName: fileB.name })
    this._extractSections(fileA, 'A')
    this._extractSections(fileB, 'B')
  },

  // 上传文件 → 提取章节
  _extractSections(file, side) {
    var loadingKey = side === 'A' ? 'loadingA' : 'loadingB'
    var sectionsKey = side === 'A' ? 'sectionsA' : 'sectionsB'
    var checkedKey = side === 'A' ? 'checkedCountA' : 'checkedCountB'
    var allKey = side === 'A' ? 'allCheckedA' : 'allCheckedB'
    var errorKey = side === 'A' ? 'errorA' : 'errorB'
    var sideLabel = side === 'A' ? '文档A' : '文档B'
    this.setData({ [loadingKey]: true, [errorKey]: '' })

    wx.uploadFile({
      url: config.API_BASE + '/api/app/compare/extract-sections',
      filePath: file.path,
      name: 'file',
      header: { 'Authorization': 'Bearer ' + session.getToken() },
      formData: { filename: file.name },
      timeout: 180000,  // 大 PDF 解析可能 1-3 分钟
      success: (res) => {
        var data
        try { data = JSON.parse(res.data) } catch (e) { data = {} }

        // 服务端返回错误（如 422 扫描版 PDF）
        if (data && data.error) {
          this.setData({ [loadingKey]: false, [errorKey]: data.error })
          wx.showModal({
            title: sideLabel + ' 解析失败',
            content: data.error,
            showCancel: false
          })
          return
        }

        var raw = (data && data.sections) ? data.sections : []
        if (raw.length === 0) {
          this.setData({ [loadingKey]: false, [errorKey]: '未识别到章节结构，将使用全文比对' })
          wx.showToast({ title: sideLabel + ' 未识别到章节，将用全文比对', icon: 'none', duration: 2500 })
          return
        }
        var sections = raw.map(function (s, i) {
          return { id: (side === 'A' ? 'a' : 'b') + i, title: s.title, content: s.content || '', checked: true }
        })
        var update = {}
        update[loadingKey] = false
        update[sectionsKey] = sections
        update[checkedKey] = sections.length
        update[allKey] = true
        update[errorKey] = ''
        this.setData(update)
      },
      fail: (err) => {
        var emsg = (err && err.errMsg) || ''
        var isTimeout = emsg.indexOf('timeout') >= 0 || emsg.indexOf('time') >= 0
        var msg = isTimeout
          ? '解析超时（>3 分钟），建议上传文字版 PDF 或 docx 格式'
          : '网络错误，请重试'
        this.setData({ [loadingKey]: false, [errorKey]: msg })
        wx.showModal({
          title: sideLabel + ' 解析失败',
          content: msg,
          showCancel: false
        })
      }
    })
  },

  toggleAllA() {
    var newVal = !this.data.allCheckedA
    var sectionsA = this.data.sectionsA.map(function (s) { return Object.assign({}, s, { checked: newVal }) })
    this.setData({ sectionsA: sectionsA, allCheckedA: newVal, checkedCountA: newVal ? sectionsA.length : 0 })
  },

  toggleAllB() {
    var newVal = !this.data.allCheckedB
    var sectionsB = this.data.sectionsB.map(function (s) { return Object.assign({}, s, { checked: newVal }) })
    this.setData({ sectionsB: sectionsB, allCheckedB: newVal, checkedCountB: newVal ? sectionsB.length : 0 })
  },

  toggleA(e) {
    var idx = e.currentTarget.dataset.idx
    var key = 'sectionsA[' + idx + '].checked'
    var newVal = !this.data.sectionsA[idx].checked
    this.setData({ [key]: newVal })
    this._syncAllCheck('A')
  },

  toggleB(e) {
    var idx = e.currentTarget.dataset.idx
    var key = 'sectionsB[' + idx + '].checked'
    var newVal = !this.data.sectionsB[idx].checked
    this.setData({ [key]: newVal })
    this._syncAllCheck('B')
  },

  _syncAllCheck(side) {
    var arr = side === 'A' ? this.data.sectionsA : this.data.sectionsB
    var allKey = side === 'A' ? 'allCheckedA' : 'allCheckedB'
    var countKey = side === 'A' ? 'checkedCountA' : 'checkedCountB'
    var checked = arr.filter(function (s) { return s.checked })
    var update = {}
    update[allKey] = checked.length === arr.length
    update[countKey] = checked.length
    this.setData(update)
  },

  startCompare() {
    // 防重复点击：loading 期间或已在跳转中直接 return
    if (this.data.comparing || this.data.loadingA || this.data.loadingB) return
    this.setData({ comparing: true })

    var checkedA = this.data.sectionsA.filter(function (s) { return s.checked })
    var checkedB = this.data.sectionsB.filter(function (s) { return s.checked })
    // 章节为空时用全文占位，不强制拦截
    var finalA = checkedA.length ? checkedA : [{ id: 'full-a', title: '全文' }]
    var finalB = checkedB.length ? checkedB : [{ id: 'full-b', title: '全文' }]
    if (!session.checkAndConsume('compare')) {
      this.setData({ comparing: false })
      return
    }
    var app = getApp()
    app.globalData.compareSectionsA = finalA
    app.globalData.compareSectionsB = finalB
    wx.navigateTo({
      url: '/pages/compare-result/index',
      complete: () => { this.setData({ comparing: false }) }
    })
  }
})
