/**
 * 扫一扫 — 商品标准查询
 * 拍照 → CLIP 识别 + OCR → 匹配标准 → 以商品为中心展示关联图谱
 */
var session = require('../../utils/session')
var config = require('../../utils/config')
var request = require('../../utils/request')
var subscribe = require('../../utils/subscribe')

Page({
  data: {
    step: 'home',
    // loading
    loadingMode: '',         // 'scan' = 三步进度, 'query' = 简单 spinner
    loadingStep: 0,
    loadingText: '',
    // 结果（recognition_mode 三态：exact / category / general）
    recognized: '',
    confidence: 0,
    confidencePct: 0,
    standards: [],
    graphNodes: [],
    topStandard: null,
    matchSource: '',
    matchSourceLabel: '',
    ocrPreview: '',
    recognitionMode: 'general',
    industryToken: null,
    riskDirections: [],
    serviceOffer: null,
    conclusionTitle: '',
    conclusionTone: '',
    confidenceLevel: 'low',
    confidenceTip: '',
    purchaseAdvice: null,
    // 其他
    error: '',
    history: [],
    historySwipedIdx: -1
  },

  onShow: function () {
    this._hasLeft = false
    if (this.data.step === 'loading' && !this._uploading) {
      // 上传已结束但用户离开过——检查是否有暂存结果
      if (this._pendingResult) {
        var r = this._pendingResult
        this._pendingResult = null
        session.consumeFeature('scan')
        this._loadHistory()
        this._showResult(r.recognized, r.confidence, r.standards, r.extra || {})
        return
      }
      if (this._pendingError) {
        var err = this._pendingError
        this._pendingError = null
        this._loadHistory()
        this.setData({ step: 'error', error: err })
        return
      }
      this.setData({ step: 'home' })
    }
    this._loadHistory()
  },

  // ═══ 入口：拍照 ═══
  takePhoto: function () {
    if (!this._checkLogin()) return
    // 营销自动化 R15：首扫奖励订阅授权
    // 在用户点击「拍照」同步栈里弹授权窗，命中 wx 要求的"用户触发"条件。
    // 即便识别最终失败也无伤 —— 未扫码的用户本就无 R15 触发条件，后端规则查询
    // 靠 firstScanAt 兜底，不会误发
    subscribe.requestSubscribe(subscribe.TEMPLATES.R15_FIRST_SCAN_REWARD)

    var self = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      camera: 'back',
      success: function (res) {
        var file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        self._doScan(file.tempFilePath)
      }
    })
  },

  // ═══ 拍照识别流程 ═══
  _doScan: function (filePath) {
    var self = this
    this._uploading = true
    this._pendingResult = null
    this._pendingError = null
    this._scanStartTime = Date.now()

    // 生成临时 key，先写一条「识别中」的历史
    var pendingKey = '_pending_' + Date.now()
    this._pendingHistoryKey = pendingKey
    this._savePendingHistory(pendingKey)

    this.setData({
      step: 'loading', loadingMode: 'scan',
      loadingStep: 0, loadingText: '正在识别商品...',
      error: '', recognized: '', confidence: 0, confidencePct: 0, standards: [], graphNodes: [],
      advice: null, topStandard: null, matchSource: '', matchSourceLabel: '', ocrPreview: ''
    })

    // 定时推进进度文案
    var stepTimer = null
    var currentStep = 0
    var delays = [2500, 3500]
    var texts = ['正在提取文字...', '正在匹配标准...']
    function advance() {
      if (currentStep < delays.length) {
        self.setData({ loadingStep: currentStep + 1, loadingText: texts[currentStep] })
        currentStep++
        if (currentStep < delays.length) {
          stepTimer = setTimeout(advance, delays[currentStep])
        }
      }
    }
    stepTimer = setTimeout(advance, delays[0])

    wx.uploadFile({
      url: config.API_BASE + '/api/app/scan/recognize',
      filePath: filePath,
      name: 'file',
      timeout: 180000,
      header: { Authorization: 'Bearer ' + session.getToken() },
      success: function (uploadRes) {
        if (stepTimer) clearTimeout(stepTimer)
        self._uploading = false

        if (uploadRes.statusCode !== 200) {
          var errMsg = '识别服务暂不可用'
          try { var ed = JSON.parse(uploadRes.data); if (ed.error) errMsg = ed.error } catch (e) {}
          if (uploadRes.statusCode === 504) errMsg = '识别超时，请稍后重试'
          else if (uploadRes.statusCode === 503) errMsg = '识别服务暂未启动，请稍后重试'
          self._updatePendingHistory(pendingKey, null, errMsg)
          self._finishLoading(function () {
            self.setData({ step: 'error', error: errMsg })
          })
          return
        }

        var data
        try { data = JSON.parse(uploadRes.data) } catch (e) {
          self._updatePendingHistory(pendingKey, null, '返回数据异常')
          self._finishLoading(function () {
            self.setData({ step: 'error', error: '返回数据异常' })
          })
          return
        }

        var recognized = data.recognized || ''
        var confidence = data.confidence || 0
        var standards = data.standards || []
        var matchSource = data.match_source || 'unknown'
        var matchSourceLabel = data.match_source_label || self._getMatchSourceLabel(matchSource)
        var ocrPreview = data.ocr_preview || ''
        // P0 止血新增字段，前端只吃后端给的三态，不本地推
        var recognitionMode = data.recognition_mode || 'general'
        var industryToken = data.industry_token || null
        var riskDirections = data.risk_directions || []
        var serviceOffer = data.service_offer || null
        var confidenceLevel = data.confidence_level || 'low'
        var confidenceTip = data.confidence_tip || ''
        var purchaseAdvice = data.purchase_advice || { level: 'weak', label: '建议较弱', tip: '仅作初步参考' }

        // general 模式 + 没有任何 industry token + 完全无法定性 → 进 error 流
        if (recognitionMode === 'general' && !industryToken && !recognized) {
          var errText = data.error || '未能识别到标准信息，请对准商品包装上的标准号重新拍摄'
          self._updatePendingHistory(pendingKey, null, errText)
          self._finishLoading(function () {
            self.setData({ step: 'error', error: errText })
          })
          return
        }

        // 更新历史记录：存全量字段，历史回看时直接用
        self._updatePendingHistory(pendingKey, {
          recognized: recognized,
          confidence: confidence,
          standards: standards,
          recognitionMode: recognitionMode,
          industryToken: industryToken,
          matchSource: matchSource,
          matchSourceLabel: matchSourceLabel,
          ocrPreview: ocrPreview,
          riskDirections: riskDirections,
          serviceOffer: serviceOffer,
          confidenceLevel: confidenceLevel,
          confidenceTip: confidenceTip,
          purchaseAdvice: purchaseAdvice
        }, null)

        // 显示完成动画，保证最少 3 秒 loading
        self.setData({ loadingStep: 3, loadingText: '分析完成' })
        self._finishLoading(function () {
          // 如果用户已经离开了页面，暂存结果，等 onShow 时展示
          if (self._hasLeft) {
            self._pendingResult = {
              recognized: recognized,
              confidence: confidence,
              standards: standards,
              extra: {
                recognitionMode: recognitionMode,
                industryToken: industryToken,
                matchSource: matchSource,
                matchSourceLabel: matchSourceLabel,
                ocrPreview: ocrPreview,
                riskDirections: riskDirections,
                serviceOffer: serviceOffer,
                confidenceLevel: confidenceLevel,
                confidenceTip: confidenceTip,
                purchaseAdvice: purchaseAdvice
              }
            }
            return
          }

          self._showResult(recognized, confidence, standards, {
            recognitionMode: recognitionMode,
            industryToken: industryToken,
            matchSource: matchSource,
            matchSourceLabel: matchSourceLabel,
            ocrPreview: ocrPreview,
            riskDirections: riskDirections,
            serviceOffer: serviceOffer,
            confidenceLevel: confidenceLevel,
            confidenceTip: confidenceTip,
            purchaseAdvice: purchaseAdvice
          })
        })
      },
      fail: function () {
        if (stepTimer) clearTimeout(stepTimer)
        self._uploading = false
        self._updatePendingHistory(pendingKey, null, '网络错误')
        self._finishLoading(function () {
          if (self._hasLeft) {
            self._pendingError = '网络错误，请检查连接后重试'
            return
          }
          self.setData({ step: 'error', error: '网络错误，请检查连接后重试' })
        })
      }
    })
  },

  // 保证 loading 至少显示 3 秒，然后执行 callback
  _finishLoading: function (callback) {
    var elapsed = Date.now() - (this._scanStartTime || 0)
    var minDuration = 3000
    var remaining = Math.max(0, minDuration - elapsed)
    if (remaining > 0) {
      setTimeout(callback, remaining)
    } else {
      setTimeout(callback, 600)
    }
  },

  // ═══ 展示结果页（纯还原，不做二次判断）═══
  _showResult: function (recognized, confidence, standards, extra) {
    extra = extra || {}
    var recognitionMode = extra.recognitionMode || 'general'
    // 图谱：只要有 standards 就画（不再只限 exact/category）
    var nodes = (standards && standards.length > 0) ? this._buildGraphNodes(standards) : []
    var topStandard = (standards && standards.length > 0) ? standards[0] : null
    var matchSource = extra.matchSource || 'unknown'
    var matchSourceLabel = extra.matchSourceLabel || this._getMatchSourceLabel(matchSource)
    var ocrPreview = extra.ocrPreview || ''
    var conclusion = this._buildConclusion(recognized, recognitionMode)
    var pa = extra.purchaseAdvice || { level: 'weak', label: '建议较弱', conclusion: '仅作初步参考', explanation: '', basis: '' }

    this.setData({
      step: 'result',
      recognized: recognized || '未能识别',
      confidence: confidence,
      confidencePct: Math.round((confidence || 0) * 100),
      standards: standards || [],
      graphNodes: nodes,
      topStandard: topStandard,
      matchSource: matchSource,
      matchSourceLabel: matchSourceLabel,
      ocrPreview: ocrPreview,
      recognitionMode: recognitionMode,
      industryToken: extra.industryToken || null,
      riskDirections: extra.riskDirections || [],
      serviceOffer: extra.serviceOffer || null,
      conclusionTitle: conclusion.title,
      conclusionTone: conclusion.tone,
      confidenceLevel: extra.confidenceLevel || 'low',
      confidenceTip: extra.confidenceTip || '',
      purchaseAdvice: pa
    })
  },

  // 结论文案，由 recognition_mode 直接决定，前端不做评分
  _buildConclusion: function (recognized, mode) {
    if (mode === 'exact') return { title: '已找到对应标准', tone: 'good' }
    if (mode === 'category') return { title: '已识别到商品类别', tone: 'mid' }
    if (recognized) return { title: '已完成初步识别', tone: 'weak' }
    return { title: '未能识别商品，建议重新拍摄', tone: 'weak' }
  },

  _getMatchSourceLabel: function (source) {
    if (source === 'ocr_code') return '包装标准号直连'
    if (source === 'ocr_text') return '包装文字匹配'
    if (source === 'category_keyword') return '商品类别关联'
    return '综合匹配'
  },

  // ═══ 构建图谱节点坐标 ═══
  _buildGraphNodes: function (standards) {
    var count = Math.min(standards.length, 8)
    var nodes = []
    var radius = count <= 3 ? 180 : (count <= 5 ? 220 : 250)
    for (var i = 0; i < count; i++) {
      var angle = (2 * Math.PI * i / count) - Math.PI / 2
      nodes.push({
        code: standards[i].code,
        name: standards[i].name || '',
        status: standards[i].status || '',
        x: Math.round(radius * Math.cos(angle)),
        y: Math.round(radius * Math.sin(angle)),
        angleDeg: Math.round(angle * 180 / Math.PI),
        lineLen: radius
      })
    }
    return nodes
  },

  // ═══ 点击图谱标准节点 → 跳详情页 ═══
  onStdNodeTap: function (e) {
    var code = e.currentTarget.dataset.code
    if (code) {
      wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(code) + '&from=scan' })
    }
  },

  // ═══ 点击服务推荐 → 跳全库比对 ═══
  onServiceOfferTap: function () {
    var offer = this.data.serviceOffer
    if (offer && offer.cta && offer.cta.url) {
      wx.navigateTo({ url: offer.cta.url })
    }
  },

  onHide: function () {
    if (this._uploading) {
      this._hasLeft = true
    }
  },

  onUnload: function () {
    if (this._uploading) {
      this._hasLeft = true
    }
  },

  // ═══ 历史记录 ═══

  // 立即写入一条「识别中…」的占位记录
  _savePendingHistory: function (key) {
    try {
      var list = wx.getStorageSync('scan_history') || []
      list.unshift({
        key: key,
        recognized: '识别中…',
        confidence: 0,
        standards: [],
        status: 'pending',
        time: new Date().toLocaleDateString('zh-CN')
      })
      if (list.length > 20) list = list.slice(0, 20)
      wx.setStorageSync('scan_history', list)
      this.setData({ history: list })
    } catch (e) {}
  },

  // 识别完成后，把占位记录更新为真实结果 或 标记失败
  _updatePendingHistory: function (pendingKey, result, errorMsg) {
    try {
      var list = wx.getStorageSync('scan_history') || []
      var idx = -1
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === pendingKey) { idx = i; break }
      }
      if (idx === -1) return

      if (result && result.standards && result.standards.length > 0) {
        // 成功：替换为真实数据
        var realKey = (result.recognized || '') + '_' + result.standards[0].code
        // 去重：如果已有同 key 的旧记录，先删掉
        list = list.filter(function (item, i2) {
          return i2 === idx || item.key !== realKey
        })
        // 重新定位 idx
        for (var j = 0; j < list.length; j++) {
          if (list[j].key === pendingKey) { idx = j; break }
        }
        list[idx] = {
          key: realKey,
          recognized: result.recognized || '未知商品',
          confidence: result.confidence || 0,
          standards: result.standards.slice(0, 8).map(function (s) {
            return { code: s.code, name: s.name || '', status: s.status || '' }
          }),
          recognitionMode: result.recognitionMode || 'general',
          industryToken: result.industryToken || null,
          matchSource: result.matchSource || result.match_source || '',
          matchSourceLabel: result.matchSourceLabel || '',
          ocrPreview: result.ocrPreview || '',
          riskDirections: result.riskDirections || [],
          serviceOffer: result.serviceOffer || null,
          confidenceLevel: result.confidenceLevel || 'low',
          confidenceTip: result.confidenceTip || '',
          purchaseAdvice: result.purchaseAdvice || null,
          status: 'done',
          time: new Date().toLocaleDateString('zh-CN')
        }
      } else {
        // 失败：标记为 failed
        list[idx].status = 'failed'
        list[idx].recognized = '识别失败'
        list[idx].error = errorMsg || '未知错误'
      }
      wx.setStorageSync('scan_history', list)
      this.setData({ history: list })
    } catch (e) {}
  },

  _loadHistory: function () {
    try {
      var list = wx.getStorageSync('scan_history') || []
      this.setData({ history: list, historySwipedIdx: -1 })
    } catch (e) {
      this.setData({ history: [] })
    }
  },

  // 点击历史记录 → 简单 loading → 结果页
  selectHistory: function (e) {
    var idx = e.currentTarget.dataset.index
    var item = this.data.history[idx]
    if (!item) return
    // pending 状态不可点击
    if (item.status === 'pending') {
      wx.showToast({ title: '正在识别中，请稍候', icon: 'none' })
      return
    }
    // failed 状态提示
    if (item.status === 'failed') {
      wx.showToast({ title: item.error || '识别失败', icon: 'none' })
      return
    }
    if ((item.standards && item.standards.length > 0) || item.recognitionMode) {
      this.setData({ step: 'loading', loadingMode: 'query', loadingText: '查询中...' })
      var self = this
      setTimeout(function () {
        self._showResult(item.recognized, item.confidence, item.standards || [], {
          recognitionMode: item.recognitionMode || 'general',
          industryToken: item.industryToken || null,
          matchSource: item.matchSource || item.match_source || '',
          matchSourceLabel: item.matchSourceLabel || '',
          ocrPreview: item.ocrPreview || '',
          riskDirections: item.riskDirections || [],
          serviceOffer: item.serviceOffer || null,
          confidenceLevel: item.confidenceLevel || 'low',
          confidenceTip: item.confidenceTip || '',
          purchaseAdvice: item.purchaseAdvice || null
        })
      }, 400)
      return
    }
    // 旧格式兼容（只有 code）
    if (item.code) {
      wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(item.code) })
    }
  },

  // 左滑删除
  _touchStartX: 0,
  onHistoryTouchStart: function (e) {
    this._touchStartX = e.touches[0].clientX
  },
  onHistoryTouchMove: function (e) {
    var dx = e.touches[0].clientX - this._touchStartX
    var idx = e.currentTarget.dataset.index
    if (dx < -50) {
      this.setData({ historySwipedIdx: idx })
    } else if (dx > 30) {
      this.setData({ historySwipedIdx: -1 })
    }
  },
  deleteHistory: function (e) {
    var key = e.currentTarget.dataset.key
    if (!key) return
    try {
      var list = wx.getStorageSync('scan_history') || []
      list = list.filter(function (item) { return item.key !== key })
      wx.setStorageSync('scan_history', list)
      this.setData({ history: list, historySwipedIdx: -1 })
    } catch (err) {}
  },
  clearHistory: function () {
    var self = this
    wx.showModal({
      title: '确认清空', content: '确定清空所有查询记录？',
      success: function (res) {
        if (res.confirm) {
          try { wx.removeStorageSync('scan_history') } catch (e) {}
          self.setData({ history: [], historySwipedIdx: -1 })
        }
      }
    })
  },

  // ═══ 辅助 ═══
  _checkLogin: function () {
    if (session.getToken()) return true
    session.ensureLogin()
    return false
  },
  goBack: function () {
    this.setData({ step: 'home', error: '', historySwipedIdx: -1 })
    this._loadHistory()
  }
})
