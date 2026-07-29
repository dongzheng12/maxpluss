/**
 * 技术委员会页 — 按地区分类浏览 TC
 * @date   2026-03-21
 */
const session = require('../../utils/session')
const request = require('../../utils/request')
const { API_BASE } = require('../../utils/config')
const PAGE_SIZE = 20

const REGIONS = [
  '所有地区',
  '北京', '上海', '天津', '重庆',
  '江苏', '广东', '山东', '浙江', '辽宁',
  '河南', '陕西', '四川', '湖北', '黑龙江',
  '安徽', '福建', '河北', '吉林', '湖南', '山西',
  '广西', '甘肃', '内蒙古', '江西', '云南', '贵州', '新疆'
]

Page({
  data: {
    keyword: '',
    loading: false,
    committees: [],
    total: 0,
    page: 1,
    hasMore: false,
    regions: REGIONS,
    selectedRegionIndex: 0
  },

  onLoad() {
    // 需要登录
    if (!session.requireLogin(null, true)) {
      session.requireLogin(() => this.fetchPage(1, false))
      return
    }
    this.fetchPage(1, false)
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value, selectedRegionIndex: -1 })
  },

  // 键盘确定 → 直接搜索
  submitSearch() {
    this.setData({ page: 1 })
    this.fetchPage(1, false)
  },

  // 右侧地区下拉选中 → 自动搜索
  onRegionPick(e) {
    const idx = Number(e.detail.value)
    const region = REGIONS[idx]
    if (idx === 0) {
      // "所有地区" → 清空关键词，拉全部
      this.setData({ selectedRegionIndex: 0, keyword: '', page: 1 })
    } else {
      this.setData({ selectedRegionIndex: idx, keyword: region, page: 1 })
    }
    this.fetchPage(1, false)
  },

  fetchPage(page, append) {
    const q = (this.data.keyword || '').trim()
    if (!append) this.setData({ loading: true, committees: [] })

    let url = `/api/v1/tc?page=${page}&page_size=${PAGE_SIZE}`
    if (q) url += `&q=${encodeURIComponent(q)}`

    request({
      url,
      method: 'GET',
      timeout: 10000,
      success: (res) => {
        const d = res.data || {}
        const items = d.items || []
        const total = d.total || 0
        const newList = append ? this.data.committees.concat(items) : items
        this.setData({
          loading: false,
          committees: newList,
          total,
          page,
          hasMore: newList.length < total
        })
      },
      fail: (err) => {
        console.error('TC API fail:', err)
        this.setData({ loading: false })
        wx.showToast({ title: '请求失败，请检查网络', icon: 'none' })
      }
    })
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.fetchPage(this.data.page + 1, true)
  }
})
