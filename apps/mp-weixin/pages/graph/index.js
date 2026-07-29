/**
 * 标准图谱页 — 展示标准关联关系（系列/版本/相关）
 * @date 2026-03-21
 */

const session = require('../../utils/session')
const request = require('../../utils/request')
const { API_BASE } = require('../../utils/config')

Page({
  data: {
    keyword: '',
    candidates: [],
    graph: null,
    // ── 传给 standard-graph 组件的数据 ──
    graphCenter: null,
    graphMetrics: null,
    graphChain: [],
    graphRelated: [],
    graphLibrary: [],
    loading: false
  },

  onLoad(query) {
    if (query.code) {
      const code = decodeURIComponent(query.code)
      this.setData({ keyword: code })
      this.loadGraph(code)
      return
    }
    if (query.id) {
      this.setData({ keyword: query.id })
      this.loadGraph(query.id)
      return
    }
    if (query.keyword) {
      const kw = decodeURIComponent(query.keyword)
      this.setData({ keyword: kw })
      this.searchStandards(kw)
    }
  },

  onKeywordInput(e) {
    const keyword = e.detail.value
    this.setData({ keyword })
    if (keyword.trim()) {
      this.searchStandards(keyword.trim())
    } else {
      this.setData({ candidates: [] })
    }
  },

  submitSearch() {
    const q = (this.data.keyword || '').trim()
    if (!q) return
    // 只触发搜索，不自动选第一个，让用户自己点
    this.searchStandards(q)
  },

  chooseCandidate(e) {
    const code = e.currentTarget.dataset.code
    // 跳转新页面，返回时能回到搜索结果列表
    wx.navigateTo({ url: `/pages/graph/index?code=${encodeURIComponent(code)}` })
  },

  // ── 搜索标准 ──
  searchStandards(q) {
    request({
      url: '/api/v1/search',
      data: { q, limit: 6 },
      success: (res) => {
        const results = res.data && res.data.results ? res.data.results : []
        this.setData({
          candidates: results.map(s => ({
            code: s.code,
            name: s.name,
            status: s.status
          }))
        })
      }
    })
  },

  // ── 加载图谱 ──
  loadGraph(code) {
    if (!session.requireLogin(null, true)) {
      session.requireLogin()
      return
    }
    if (!session.checkAndConsume('graph')) return

    this.setData({ loading: true, graph: null, candidates: [] })

    request({
      url: `/api/v1/standard/${encodeURIComponent(code)}/relations`,
      success: (res) => {
        const d = res.data
        if (!d || d.error) {
          this.setData({ loading: false })
          wx.showToast({ title: d ? d.error : '未找到', icon: 'none' })
          return
        }

        const rel = d.relations || {}
        const seriesItems = (rel.series && rel.series.items) || []
        const versionItems = (rel.versions && rel.versions.items) || []
        const similarItems = (rel.similar && rel.similar.items) || []

        // ── 组件数据：centerNode ──
        // ── 组件数据：relationMetrics（先算，centerNode 要用） ──
        const versionCount = versionItems.length + 1 // +1 含当前标准
        const similarCount = similarItems.length
        const seriesCount = seriesItems.length
        const graphMetrics = {
          versionCount,
          similarCount,
          seriesCount,
          totalCount: versionCount + similarCount + seriesCount
        }

        // ── 组件数据：centerNode ──
        const graphCenter = {
          code: d.code,
          name: d.name || '',
          total_relations: graphMetrics.totalCount
        }

        // ── 组件数据：replacementChain（name 字段） ──
        const graphChain = [
          ...versionItems.map(v => ({ code: v.code, name: v.name, isCurrent: false })),
          { code: d.code, name: d.name || '', isCurrent: true }
        ]

        // ── 组件数据：relatedNodes ──
        const graphRelated = similarItems.map(s => ({
          code: s.code,
          name: s.name,
          relation: '相关'
        }))

        // ── 组件数据：libraryStandards ──
        const graphLibrary = seriesItems.map(s => ({
          code: s.code,
          name: s.name,
          status: s.status || ''
        }))

        // ── 页面自身展示数据 ──
        const graph = {
          standard: { code: d.code, name: d.name, status: '' },
          summary: `共发现 ${d.total_relations} 个关联标准，包括系列标准、历史版本和语义相关标准。`,
          citedSummary: seriesItems.length
            ? `该标准属于 ${rel.series ? rel.series.base : ''} 系列，共 ${seriesItems.length + 1} 个分册。`
            : '暂无系列关联信息。'
        }

        this.setData({
          loading: false,
          keyword: d.code,
          graph,
          graphCenter,
          graphMetrics,
          graphChain,
          graphRelated,
          graphLibrary
        })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      }
    })
  },

  // ── 组件内列表项点击 → 跳转详情 ──
  onGraphItemTap(e) {
    const code = e.detail.code
    if (code) {
      wx.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(code)}` })
    }
  }
})
