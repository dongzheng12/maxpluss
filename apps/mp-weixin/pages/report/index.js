/**
 * 比对报告 — 支持 1v1 + 全库相似度分析两种报告格式
 * @date   2026-03-25
 */
const config = require('../../utils/config')
const request = require('../../utils/request')
const remoteConfig = require('../../utils/remoteConfig')

// hash 风格文件名兜底 — 跟 apps/web/src/pages/compare-report/index.tsx prettifyFileName 必须保持判定逻辑完全一致
function prettifyFileName(name, fallback) {
  if (!name) return fallback || '对比文档'
  var stem = name.replace(/\.[^.]+$/, '')
  if (/^[A-Za-z0-9]{20,}$/.test(stem)) return fallback || '对比文档'
  return name
}

// 1对1 模式下把 documentName 从 "A.pdf vs B.pdf" 改成自然表达
function naturalDocName(documentName, isPair) {
  if (!documentName) return '未命名文档'
  if (!isPair) return documentName
  if (documentName.indexOf(' vs ') >= 0) {
    var parts = documentName.split(' vs ')
    return '1对1 比对：' + prettifyFileName(parts[0], '主文档') + ' 与 ' + prettifyFileName(parts[1], '对比文档')
  }
  return documentName
}

Page({
  data: {
    loading: true,
    taskNo: '',
    documentName: '',
    displayDocName: '',
    compareMode: '',
    status: '',
    freeRisk: [],
    riskLevel: '',
    riskLabel: '',
    preview: null,
    unlocked: false,
    exportUnlocked: false,
    report: null,
    unlockPrice: 0,
    exportPrice: 0,
    errorMessage: ''
  },
  _pollTimer: null,
  // 分阶段轮询状态：前 5 分钟 3s / 之后 10s / 30 分钟硬停
  _pollStartedAt: null,
  _pollStopped: false,

  onLoad(options) {
    // 进入页面 = 重置轮询状态
    this._pollStartedAt = null
    this._pollStopped = false
    if (options.taskNo) {
      this.setData({ taskNo: options.taskNo })
      this.loadReport(options.taskNo)
    }
  },

  onShow() {
    // 重新进入页面 = 重置轮询状态
    this._pollStartedAt = null
    this._pollStopped = false
    if (this.data.taskNo && !this.data.loading) {
      this.loadReport(this.data.taskNo)
    }
  },

  loadReport(taskNo) {
    this.setData({ loading: true })
    request({
      url: `/api/app/compare/tasks/${taskNo}`,
      method: 'GET',
      success: (res) => {
        const d = res.data
        if (!d || !d.taskNo) {
          wx.showToast({ title: '报告不存在', icon: 'none' })
          this.setData({ loading: false, status: 'NOT_FOUND' })
          return
        }
        // FAILED 状态
        if (d.status === 'FAILED') {
          this.setData({
            loading: false,
            status: 'FAILED',
            documentName: d.documentName || '',
            errorMessage: d.errorMessage || '比对任务处理失败，请重新发起比对。'
          })
          this._stopPoll()
          return
        }
        // PROCESSING / PENDING 状态 → 轮询
        if (d.status === 'PENDING' || d.status === 'PROCESSING') {
          this.setData({
            loading: false,
            status: d.status,
            documentName: d.documentName || ''
          })
          this._startPoll()
          return
        }
        this._stopPoll()
        var access = d.access || {}
        var offer = d.unlockOffer || {}
        var report = d.report || null

        // riskLevel / riskLabel 现在由后端始终返回（不依赖 report 是否解锁）
        var riskLevel = d.riskLevel || (report && report.risk_level) || ''
        var riskLabel = d.riskLabel || (report && report.risk_label) || ''

        // 预处理 preview 数据（免费预览层，始终可用）
        var preview = d.preview || null
        if (preview) {
          var ov = preview.summaryOverallMax || 0
          preview._overallPct = (ov * 100).toFixed(1)
          preview._overallColor = ov >= 0.4 ? '#e74c3c' : ov >= 0.2 ? '#f39c12' : '#27ae60'
          preview._dupColor = preview.duplicationRate > 30 ? '#e74c3c' : '#27ae60'
          preview._refIssueColor = preview.referencesIssueCount > 0 ? '#f39c12' : '#27ae60'
          if (preview.topSimilarPreview) {
            preview.topSimilarPreview.forEach(function (item) {
              item._scorePct = Math.round(item.overall_score || 0)
            })
          }
        }

        // 预处理 library 模式数据（WXML 不支持 .toFixed / .join 等方法）
        if (report && d.compareMode === 'library') {
          // 评估总览：预计算显示值和颜色
          if (report.summary) {
            var ov = report.summary.overall_max || 0
            report.summary._overallPct = (ov * 100).toFixed(1)
            report.summary._overallColor = ov >= 0.4 ? '#e74c3c' : ov >= 0.2 ? '#f39c12' : '#27ae60'
            var dims = report.summary.dimensions || {}
            report.summary._titlePct = ((dims.title || 0) * 100).toFixed(1)
            report.summary._contentPct = ((dims.content || 0) * 100).toFixed(1)
            report.summary._structurePct = ((dims.structure || 0) * 100).toFixed(1)
            report.summary._referencePct = ((dims.reference || 0) * 100).toFixed(1)
            report.summary._termPct = ((dims.term || 0) * 100).toFixed(1)
          }
          if (report.references) {
            report.references._issueColor = (report.references.issues || []).length > 0 ? '#f39c12' : '#27ae60'
            report.references._issueCount = (report.references.issues || []).length
          }
          if (report.duplication) {
            report.duplication._dupColor = report.duplication.estimated_rate > 30 ? '#e74c3c' : '#27ae60'
          }
          // top_similar：预计算匹配章节相似度百分比 + 有效性标签
          var statusMap = { '现行': { text: '现行', cls: 'valid' }, '作废': { text: '已废止', cls: 'obsolete' }, '废止': { text: '已废止', cls: 'obsolete' }, '即将实施': { text: '即将实施', cls: 'upcoming' } }
          if (report.top_similar) {
            report.top_similar.forEach(function (item) {
              if (item.matched_sections) {
                item.matched_sections.forEach(function (sec) {
                  sec._simPct = Math.round((sec.similarity || 0) * 100)
                })
              }
              // 有效性标签预处理
              var si = statusMap[item.status]
              if (si) { item._statusText = si.text; item._statusClass = si.cls }
              // 术语匹配描述
              if (item.matched_refs) {
                item._refsCount = item.matched_refs.length
              }
            })
          }
          // 术语详情：预处理 matched_in 展示文本
          if (report.terms && report.terms.details) {
            report.terms.details.forEach(function (item) {
              var codes = item.matched_in || []
              item._matchText = codes[0] + (codes.length > 1 ? ' 等' + codes.length + '条' : '')
            })
          }
          // 结构缺失：预拼接字符串
          if (report.structure && report.structure.missing) {
            report.structure._missingText = report.structure.missing.join('、')
          }
          // 结构子维度：预处理列项嵌套和附录问题
          if (report.structure) {
            report.structure._gapIssues = report.structure.gap_issues || []
            report.structure._depthIssues = report.structure.depth_issues || []
            report.structure._listNestingIssues = report.structure.list_nesting_issues || []
            report.structure._appendixIssues = report.structure.appendix_issues || []
          }
          // dangling_sections：确保 dangling 数组存在
          if (report.dangling_sections) {
            report.dangling_sections.dangling = report.dangling_sections.dangling || []
          }
          // industry_landscape：直接透传（available 字段控制显示）
        }

        // 1对1 报告显示层处理：
        // - similarStandards[*].title 可能是浏览器 cache hash 名 → 兜底
        // - similarStandards[*].code='USER_B' / type='用户文档' 是后端内部 key → wxml wx:if 隐藏
        // - documentName 'A.pdf vs B.pdf' → 自然语言「主文档 与 对比文档」
        var isPair = (d.compareMode === 'pair' || d.compareMode === 'ONE_TO_ONE')
        var displayDocName = naturalDocName(d.documentName || '', isPair)

        // 1对1 文件对比摘要：拆出 fileAName / fileBName + 取首条 similarStandard 的维度值
        var pairSummary = null
        if (isPair && report && report.similarStandards && report.similarStandards.length > 0) {
          var docName = d.documentName || ''
          var parts = docName.split(' vs ')
          var fileAName = prettifyFileName(parts[0] || '', '主文档')
          var fileBName = prettifyFileName(parts[1] || '', '对比文档')
          var s0 = report.similarStandards[0]
          pairSummary = {
            fileAName: fileAName,
            fileBName: fileBName,
            overallSimilarity: s0.overallSimilarity || 0,
            titleSimilarity: s0.titleSimilarity || 0,
            scopeSimilarity: s0.scopeSimilarity || 0,
            textSimilarity: s0.textSimilarity || 0
          }
        }

        // 章节跳号已对外隐藏：filter freeRisk + conclusions 中含"跳号"的字符串
        // 后端 dedup report.py 仍在产出 structure.gap_issues 字段供内部使用，
        // 前端不再展示对应表格 + 不展示对应文本
        var filteredFreeRisk = (d.freeRisk || []).filter(function (r) { return r.indexOf('跳号') < 0 })
        if (report && report.conclusions) {
          report.conclusions = report.conclusions.filter(function (c) { return c.indexOf('跳号') < 0 })
        }
        if (preview && preview.conclusions) {
          preview.conclusions = preview.conclusions.filter(function (c) { return c.indexOf('跳号') < 0 })
        }

        this.setData({
          loading: false,
          documentName: d.documentName || '',
          displayDocName: displayDocName,
          compareMode: d.compareMode || '',
          status: d.status || '',
          freeRisk: filteredFreeRisk,
          riskLevel: riskLevel,
          riskLabel: riskLabel,
          preview: preview,
          unlocked: !!access.fullReportUnlocked,
          exportUnlocked: !!access.exportUnlocked,
          report: report,
          pairSummary: pairSummary,
          unlockPrice: 0,
          exportPrice: 0
        })
      },
      fail: () => {
        wx.showToast({ title: '加载失败', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  goCompare() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/compare/index' }) })
  },

  retryTask() {
    const { taskNo } = this.data
    wx.showLoading({ title: '提交中...' })
    request({
      url: `/api/app/compare/tasks/${taskNo}/retry`,
      method: 'POST',
      success: () => {
        wx.hideLoading()
        wx.showToast({ title: '已重新提交', icon: 'success' })
        this.setData({ status: 'PENDING', errorMessage: '' })
        this._startPoll()
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '重试失败', icon: 'none' })
      }
    })
  },

  unlockReport() {
    const { taskNo, preview } = this.data
    // 低质量报告警告
    if (preview) {
      var maxSim = preview.summaryOverallMax || 0
      var matchCount = preview.topSimilarCount || 0
      var isLowQuality = (maxSim < 0.15 && matchCount < 3) || matchCount === 0
      if (isLowQuality) {
        wx.showModal({
          title: '报告质量提示',
          content: '本次比对结果相似度较低（最高 ' + (maxSim * 100).toFixed(1) + '%），报告的参考价值可能有限。',
          confirmText: '仍然解锁',
          cancelText: '暂不解锁',
          success: (r) => { if (r.confirm) this._proceedUnlock(taskNo) }
        })
        return
      }
    }
    this._proceedUnlock(taskNo)
  },

  _proceedUnlock(taskNo) {
    wx.showLoading({ title: '处理中...' })
    request({
      url: `/api/app/compare/tasks/${taskNo}/unlock-order`,
      method: 'POST',
      success: (res) => {
        wx.hideLoading()
        // 403 = 无权限或额度用完
        if (res.statusCode === 403) {
          wx.showModal({
            title: '需要会员权限',
            content: res.data?.error || '全库相似度分析报告需要会员权限',
            confirmText: '查看会员',
            success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/membership/index' }) }
          })
          return
        }
        const order = res.data
        if (!order || !order.orderNo) {
          wx.showToast({ title: '创建订单失败', icon: 'none' })
          return
        }
        // 会员免费解锁：后端直接返回 status=PAID + memberFree=true
        if (order.memberFree || order.status === 'PAID') {
          wx.showToast({ title: '会员权益：报告已解锁', icon: 'success' })
          this.loadReport(taskNo)
          return
        }
        // 其他情况（不应出现，保留兼容）
        wx.showToast({ title: '订单已创建', icon: 'success' })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '网络错误', icon: 'none' })
      }
    })
  },

  _startPoll: function () {
    this._stopPoll()
    // 30 分钟硬停后只有「重新进入页面」（onLoad/onShow 重置）才能恢复
    // 单 task 视图不存在「新 pending 任务」语义
    if (this._pollStopped) return
    if (this._pollStartedAt == null) this._pollStartedAt = Date.now()
    var elapsed = Date.now() - this._pollStartedAt
    var delay
    if (elapsed >= 30 * 60 * 1000) delay = null
    else if (elapsed < 5 * 60 * 1000) delay = 3000
    else delay = 10000
    if (delay === null) {
      this._pollStopped = true
      return
    }
    var self = this
    this._pollTimer = setTimeout(function () {
      if (self.data.taskNo) self.loadReport(self.data.taskNo)
    }, delay)
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  onUnload() {
    this._stopPoll()
  },

  // 1.0.2 微信原生右上角菜单分享
  // 微信原生菜单无法完全屏蔽（要屏蔽得改用自定义 button + page json enableShareAppMessage:false）
  // 折中：status !== COMPLETED 时降级为产品通用介绍（不带 taskNo），实质防止泄漏未完成报告
  // imageUrl 不传 — 依赖微信自动截图，等设计稿出来再补
  onShareAppMessage() {
    var defaultTitle = remoteConfig.getShare('share_default_title', '标准小智 · 标准比对工具')
    var prefix = remoteConfig.getShare('share_report_title_prefix', '我的标准比对报告')
    var fallbackName = remoteConfig.getShare('share_report_fallback_doc_name', '风险提示报告')
    if (this.data.status !== 'COMPLETED') {
      return {
        title: defaultTitle,
        path: '/pages/home/index',  // 白名单路径，不远程化
      }
    }
    return {
      title: prefix + '：' + (this.data.displayDocName || this.data.documentName || fallbackName),
      path: '/pages/report/index?taskNo=' + (this.data.taskNo || ''),
    }
  },

  onShareTimeline() {
    var tlDefault = remoteConfig.getShare('share_timeline_default_title', '标准小智 · 标准比对工具')
    var tlReport = remoteConfig.getShare('share_timeline_report_title', '标准小智 · 比对报告')
    if (this.data.status !== 'COMPLETED') {
      return { title: tlDefault }
    }
    return {
      title: tlReport,
      query: 'taskNo=' + (this.data.taskNo || ''),
    }
  },
})
