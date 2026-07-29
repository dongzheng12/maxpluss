/**
 * 比对发起页 — 支持全库相似度分析 + 1v1 比对
 * @date   2026-03-25
 */
const session = require('../../utils/session')
const config = require('../../utils/config')
const request = require('../../utils/request')
const remoteConfig = require('../../utils/remoteConfig')

const DEFAULT_COMPARE_MEMBERSHIP_NOTICE = {
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
      path: '/pages/compare-launch/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    mode: 'library', // 'library' | 'pair'
    fileA: null,
    fileB: null,
    priceNote: '',
    btnPriceSuffix: '',
    submitting: false,
    submitted: false,
    // 业务提示文案 — wxml 为事实源,远程配置失败 fallback 字面值与 wxml 历史值完全一致
    copy: {
      libraryDesc: '上传一个文档，与平台标准化知识库进行相似度比对，生成参考性分析报告',
      pairDesc: '上传两个文档，按章节逐项比对相似度',
      uploadHint: '点击上传文档\n推荐 Word 文档，处理更快；PDF 扫描件较慢',
    },
  },

  onLoad() {
    this._refreshRemoteContent()
  },
  onShow() {
    // 强刷会员状态：避免后端已撤权但前端 storage 仍显示会员
    this._refreshMemberFromServer()
    this._refreshRemoteContent()
  },

  _refreshRemoteContent() {
    remoteConfig.loadRemoteConfig().then(() => {
      this._refreshCopy()
      this._refreshPriceNote()
    }).catch(() => {
      this._refreshCopy()
      this._refreshPriceNote()
    })
  },

  _refreshCopy() {
    this.setData({
      copy: {
        libraryDesc: remoteConfig.getCopy('compare', 'mp_copy_compare_library_desc', '上传一个文档，与平台标准化知识库进行相似度比对，生成参考性分析报告'),
        pairDesc: remoteConfig.getCopy('compare', 'mp_copy_compare_pair_desc', '上传两个文档，按章节逐项比对相似度'),
        uploadHint: remoteConfig.getCopy('compare', 'mp_copy_compare_upload_hint', '点击上传文档\n推荐 Word 文档，处理更快；PDF 扫描件较慢'),
      },
    })
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
      self._refreshPriceNote()
    }).catch(function () { /* 静默：网络失败时回退本地缓存，不阻塞页面 */ })
  },

  _refreshPriceNote() {
    const access = session.getCompareReportAccess()
    const tier = session.getMemberTier()
    const compareNotice = remoteConfig.getCompareMembershipNotice(DEFAULT_COMPARE_MEMBERSHIP_NOTICE)
    if (session.isPro()) {
      this.setData({ priceNote: compareNotice.launch.pro, btnPriceSuffix: '' })
    } else if (tier === 'personal' && access.remaining > 0) {
      this.setData({ priceNote: replaceRemaining(compareNotice.launch.personalRemaining, access.remaining), btnPriceSuffix: '' })
    } else if (tier === 'personal' && access.remaining === 0) {
      this.setData({ priceNote: compareNotice.launch.personalExhausted, btnPriceSuffix: '' })
    } else {
      this.setData({ priceNote: compareNotice.launch.free, btnPriceSuffix: '' })
    }
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ mode, fileA: null, fileB: null })
  },

  chooseFileA() { this._pickFile('fileA') },
  removeFileA() { this.setData({ fileA: null }) },
  chooseFileB() { this._pickFile('fileB') },
  removeFileB() { this.setData({ fileB: null }) },

  _pickFile(key) {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf', 'doc', 'docx'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        this.setData({
          [key]: {
            name: file.name,
            path: file.path,
            sizeLabel: `${(file.size / 1024 / 1024).toFixed(2)} MB`
          }
        })
      }
    })
  },

  // 排队检测
  // 跟 PC Web 一致:阈值改为 estimateMinutes > 60 才弹窗,
  // 60 分钟内静默直接提交。estimateMinutes 由 /queue-status 返回。
  // 后端队列保护拒绝处理：
  //   409 ALREADY_PROCESSING：toast 提示后跳回比对列表（用户能看到现存任务进度）
  //   429 QUEUE_FULL：弹会员升级窗，确认后跳到会员页
  // 返回 true = 已消化（调用方不再走通用错误分支），false = 不是队列错误
  _handleQueueGate(statusCode, data) {
    if (!data) return false
    if (statusCode === 409 && data.error === 'ALREADY_PROCESSING') {
      var self = this
      this.setData({ submitted: true, submitting: false })
      wx.showToast({ title: '已有任务处理中', icon: 'none', duration: 1500 })
      setTimeout(function () { wx.navigateBack() }, 1500)
      return true
    }
    if (statusCode === 429 && data.error === 'QUEUE_FULL') {
      wx.showModal({
        title: '当前排队较长',
        content: '您的位置约第 ' + data.queuePosition + ' 位，预计等待 ' + data.estimateMinutes + ' 分钟。开通会员可优先处理。',
        confirmText: '去开通',
        cancelText: '稍后',
        success: function (r) {
          if (r.confirm) wx.navigateTo({ url: '/pages/membership/index' })
        }
      })
      return true
    }
    return false
  },

  _checkQueue(callback) {
    request({ url: '/api/app/compare/queue-status', method: 'GET' })
      .then(function (res) {
        var estimateMinutes = (res.data && res.data.estimateMinutes) || 0
        if (estimateMinutes > 60) {
          wx.showModal({
            title: '排队提示',
            content: '当前队列预计等待约 ' + estimateMinutes + ' 分钟，是否继续排队？',
            confirmText: '继续排队',
            cancelText: '取消',
            success: function (r) { if (r.confirm) callback() }
          })
        } else {
          callback()
        }
      })
      .catch(function () { callback() })
  },

  // 1v1 比对：串行上传 A → 拿 partToken；上传 B → 拿 partToken；
  // 提交 ONE_TO_ONE 任务到统一 worker（与 PC Web 共用同一套真比对后端）。
  // 不再走 compare-sections 的章节选择 + sync /run-sections 路径,
  // 而是直接进 worker 真比对(fileA vs fileB 全文,绕过国标库)。
  goNext() {
    if (this.data.submitting) return
    if (!this.data.fileA || !this.data.fileB) {
      wx.showToast({ title: '请上传两个文档', icon: 'none' })
      return
    }
    if (!session.requireLogin(null, true)) {
      session.requireLogin()
      return
    }
    var self = this
    this._checkQueue(function () {
      wx.showModal({
        title: '提示',
        content: remoteConfig.getCompareMembershipNotice(DEFAULT_COMPARE_MEMBERSHIP_NOTICE).launch.pairPageLimit,
        confirmText: '继续',
        success: function (r) {
          if (r.confirm) self._doPairSubmit()
        }
      })
    })
  },

  // 1v1 串行上传 + 任务提交
  _doPairSubmit() {
    var self = this
    self.setData({ submitting: true })
    wx.showLoading({ title: '上传文档 A...', mask: true })

    self._uploadPart(self.data.fileA, function (errA, tokenA) {
      if (errA) {
        wx.hideLoading()
        self.setData({ submitting: false })
        wx.showModal({ title: '上传失败', content: '文档 A 上传失败：' + errA, showCancel: false })
        return
      }
      wx.showLoading({ title: '上传文档 B...', mask: true })
      self._uploadPart(self.data.fileB, function (errB, tokenB) {
        if (errB) {
          wx.hideLoading()
          self.setData({ submitting: false })
          wx.showModal({ title: '上传失败', content: '文档 B 上传失败：' + errB, showCancel: false })
          return
        }
        wx.showLoading({ title: '提交比对任务...', mask: true })
        wx.request({
          url: config.API_BASE + '/api/app/compare/tasks',
          method: 'POST',
          header: {
            'Authorization': 'Bearer ' + session.getToken(),
            'Content-Type': 'application/json'
          },
          data: {
            fileAToken: tokenA,
            fileBToken: tokenB,
            compareMode: 'ONE_TO_ONE'
            // documentName / fileType 后端不读（appRoutes.ts:3459 路径 2 仅看 fileAToken/fileBToken/compareMode），
            // 任务名由后端用 fileA/fileB 原始 name 自己拼，前端不要重复传以免误导后续维护
          },
          timeout: 30000,
          success: function (res) {
            wx.hideLoading()
            self.setData({ submitting: false })
            var data = res.data || {}
            // 队列保护：409=已有任务直接跳回任务列表；429=队列满，引导升级会员
            if (self._handleQueueGate(res.statusCode, data)) return
            // 一对一会员专属:免费用户后端返 403 + upgradeUrl,引导升级
            if (res.statusCode === 403 && data && data.upgradeUrl) {
              wx.showModal({
                title: '会员专属功能',
                content: data.error || remoteConfig.getCompareMembershipNotice(DEFAULT_COMPARE_MEMBERSHIP_NOTICE).launch.pairMemberOnly,
                confirmText: '去开通',
                cancelText: '稍后',
                success: function (r) {
                  if (r.confirm) wx.navigateTo({ url: '/pages/membership/index' })
                }
              })
              return
            }
            if (res.statusCode !== 200 || data.error) {
              wx.showModal({ title: '提交失败', content: data.error || ('HTTP ' + res.statusCode), showCancel: false })
              return
            }
            if (data.taskNo) {
              wx.hideLoading()
              self.setData({ submitted: true, submitting: false })
              wx.showModal({
                title: '任务已提交',
                content: '系统正在后台处理，通常需要 1-5 分钟。\n您可以先浏览其他页面，完成后回到比对页查看报告。',
                confirmText: '查看任务',
                showCancel: false,
                success: function () { wx.navigateBack() }
              })
            } else {
              wx.showModal({ title: '提交异常', content: '未获得任务编号，请重试', showCancel: false })
            }
          },
          fail: function (err) {
            wx.hideLoading()
            self.setData({ submitting: false })
            console.error('[pair-compare] submit failed:', err)
            wx.showModal({ title: '网络错误', content: '请检查网络连接后重试', showCancel: false })
          }
        })
      })
    })
  },

  // 上传单个文件到 /api/app/compare/upload-part，回调拿 partToken
  _uploadPart(file, callback) {
    wx.uploadFile({
      url: config.API_BASE + '/api/app/compare/upload-part',
      filePath: file.path,
      name: 'file',
      header: { 'Authorization': 'Bearer ' + session.getToken() },
      formData: { filename: file.name },
      timeout: 60000,
      success: function (res) {
        if (res.statusCode !== 200) {
          callback('HTTP ' + res.statusCode)
          return
        }
        var data
        try { data = JSON.parse(res.data) } catch (e) {
          callback('返回数据格式异常')
          return
        }
        if (data && data.error) { callback(data.error); return }
        if (!data || !data.partToken) { callback('未获得 partToken'); return }
        callback(null, data.partToken)
      },
      fail: function (err) {
        var msg = (err && err.errMsg) || '网络错误'
        callback(msg)
      }
    })
  },

  // 全库相似度分析：上传 → 异步提交 → 提示用户去任务列表查看
  startLibraryCompare() {
    if (this.data.submitting) return
    if (!this.data.fileA) {
      wx.showToast({ title: '请先上传文档', icon: 'none' })
      return
    }
    if (!session.requireLogin(null, true)) {
      session.requireLogin()
      return
    }
    if (!session.checkAndConsume('compare')) return

    var self = this
    this._checkQueue(function () { self._doLibrarySubmit() })
  },

  _doLibrarySubmit() {
    this.setData({ submitting: true })
    wx.showLoading({ title: '正在上传并提交任务…', mask: true })

    wx.uploadFile({
      url: config.API_BASE + '/api/app/compare/library',
      filePath: this.data.fileA.path,
      name: 'file',
      header: { 'Authorization': 'Bearer ' + session.getToken() },
      formData: {
        documentName: this.data.fileA.name,
        title: this.data.fileA.name.replace(/\.[^.]+$/, '')
      },
      timeout: 60000,
      success: (res) => {
        wx.hideLoading()
        this.setData({ submitting: false })

        var data
        try { data = JSON.parse(res.data) } catch (e) {
          wx.showModal({ title: '返回数据异常', content: '服务端返回了非 JSON 数据', showCancel: false })
          return
        }

        // 队列保护：必须先判断 409/429 再判断通用错误（library 端点也走同样的保护）
        if (this._handleQueueGate(res.statusCode, data)) return

        if (res.statusCode !== 200) {
          wx.showModal({ title: '提交失败', content: '服务端错误 HTTP ' + res.statusCode, showCancel: false })
          return
        }

        if (data && data.error) {
          wx.showModal({ title: '提交失败', content: data.error, showCancel: false })
          return
        }

        if (data && data.taskNo) {
          wx.hideLoading()
          this.setData({ submitted: true, submitting: false })
          wx.showModal({
            title: '任务已提交',
            content: '系统正在后台处理，通常需要 1-5 分钟。\n您可以先浏览其他页面，完成后回到比对页查看报告。',
            confirmText: '查看任务',
            showCancel: false,
            success: function () { wx.navigateBack() }
          })
        } else {
          wx.showModal({ title: '提交异常', content: '未获得任务编号，请重试', showCancel: false })
        }
      },
      fail: (err) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        console.error('[library-compare] upload failed:', err)
        wx.showModal({ title: '网络错误', content: '请检查网络连接后重试', showCancel: false })
      }
    })
  }
})
