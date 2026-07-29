/**
 * 标准信息页 — 展示单条标准完整信息
 * @date   2026-03-21
 */
const session = require('../../utils/session')
const request = require('../../utils/request')

const { API_BASE } = require('../../utils/config')

// 类型标签中文映射
const TYPE_NAMES = {
  terminology: '术语', symbol: '符号', classification: '分类',
  test_method: '试验方法', specification: '规范', code_of_practice: '规程',
  guide: '指南', product: '产品', management_system: '管理体系'
}

function typeLabel(item) {
  if (item.is_mandatory) return '强制性国家标准'
  if (item.code.startsWith('GB/T')) return '推荐性国家标准'
  if (item.code.startsWith('GB')) return '国家标准'
  if (item.code.startsWith('DB')) return '地方标准'
  if (item.code.startsWith('T/')) return '团体标准'
  return '行业标准'
}

// 状态 → 标签色调（与 standards 页保持一致）
function statusTone(s) {
  if (s === '现行') return 'green'
  if (s === '即将实施' || s === '暂不实施') return 'orange'
  if (s === '废止' || s === '作废' || s === '被代替') return 'gray'
  return 'gray'
}

Page({
  data: {
    standard: null,
    loading: true,
    hideActions: false
  },

  onLoad(query) {
    const code = query.id ? decodeURIComponent(query.id) : ''
    if (query.from === 'scan') {
      this.setData({ hideActions: true })
    }
    if (!code) {
      this.setData({ loading: false })
      return
    }
    this.fetchDetail(code)
  },

  fetchDetail(code) {
    this.setData({ loading: true })
    request({
      url: '/api/v1/standard-detail',
      data: { code },
      success: (res) => {
        const d = res.data
        if (!d || d.error) {
          this.setData({ loading: false })
          wx.showToast({ title: d ? d.error : '未找到', icon: 'none' })
          return
        }
        const relCount = d.relation_count || 0
        const standard = {
          code: d.code,
          name: d.name,
          title: d.name,
          status: d.status,
          statusTone: statusTone(d.status),
          typeLabel: typeLabel(d),
          typeTags: (d.type_tags || []).map(t => TYPE_NAMES[t] || t),
          publishDate: d.pub_date || '',
          implementDate: d.impl_date || '',
          isMandatory: d.is_mandatory,
          seriesBase: d.series_base || '',
          scope: d.scope || '',
          icsCode: d.ics_code || '',
          icsName: d.ics_name || '',
          ccs: d.ccs || '',
          ccsName: d.ccs_name || '',
          tcCommittee: d.tc_committee || '',
          draftingOrg: d.drafting_org || '',
          relationCount: relCount,
          hasVersions: d.has_versions || false,
          hasSeries: d.has_series || false,
          hasGraphNode: relCount > 0,
          isFavorite: session.isFavorite(d.code)
        }
        this.setData({ standard, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      }
    })
  },

  toggleFavorite() {
    const standard = this.data.standard
    if (!standard) return
    session.ensureLogin(() => {
      session.toggleFavorite(standard.code)
      this.setData({
        'standard.isFavorite': session.isFavorite(standard.code)
      })
      wx.showToast({ title: session.isFavorite(standard.code) ? '已收藏' : '已取消', icon: 'none' })
    })
  },

  goGraph() {
    const standard = this.data.standard
    if (!standard) return
    wx.navigateTo({ url: `/pages/graph/index?code=${encodeURIComponent(standard.code)}` })
  }
})
