/**
 * 一句话生架构
 * @date   2026-03-21
 */
const session = require('../../utils/session')
const request = require('../../utils/request')
const { API_BASE } = require('../../utils/config')

Page({
  data: {
    description: '',
    descFocus: false,
    selectedType: '',
    selectedTypeIndex: 0,
    loading: false,
    result: null,
    error: '',
    expandedClauses: {},
    stdTypeLabels: [
      '智能匹配', '术语标准', '符号标准', '分类标准',
      '试验方法标准', '规范标准', '规程标准', '指南标准',
      '产品标准', '管理体系标准'
    ],
    stdTypeValues: [
      '', '术语标准', '符号标准', '分类标准',
      '试验方法标准', '规范标准', '规程标准', '指南标准',
      '产品标准', '管理体系标准'
    ],
    exampleTags: ['不锈钢管', '食品添加剂', '焊接操作规程', '智能电网运维指南', '新能源汽车充电桩']
  },

  onDescInput(e) {
    this.setData({ description: e.detail.value })
  },

  onDescFocus() { this.setData({ descFocus: true }) },
  onDescBlur() { this.setData({ descFocus: false }) },

  onTypePick(e) {
    const idx = Number(e.detail.value)
    this.setData({
      selectedTypeIndex: idx,
      selectedType: this.data.stdTypeValues[idx] || ''
    })
  },

  tapExample(e) {
    const text = e.currentTarget.dataset.text
    this.setData({ description: text })
    this.generate()
  },

  generate() {
    const desc = (this.data.description || '').trim()
    if (!desc) return

    // 登录 + 额度检查
    if (!session.requireLogin(null, true)) {
      session.requireLogin()
      return
    }
    if (!session.checkAndConsume('outline')) return

    this.setData({ loading: true, error: '', result: null, expandedClauses: {} })

    const reqData = { description: desc }
    if (this.data.selectedType) reqData.standard_type = this.data.selectedType

    request({
      url: '/api/v1/outline',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: reqData,
      success: (res) => {
        const data = res.data
        if (!data || !data.outline) {
          this.setData({ loading: false, error: '生成失败，请稍后重试' })
          return
        }
        // 默认展开前4章
        const expanded = {}
        data.outline.forEach((item, i) => {
          if (i < 4) expanded[item.clause] = true
        })
        this.setData({ loading: false, result: data, expandedClauses: expanded })
      },
      fail: () => {
        this.setData({ loading: false, error: '网络错误，请检查后重试' })
      }
    })
  },

  toggleClause(e) {
    const clause = e.currentTarget.dataset.clause
    const expanded = { ...this.data.expandedClauses }
    expanded[clause] = !expanded[clause]
    this.setData({ expandedClauses: expanded })
  },

  toggleChild(e) {
    const key = e.currentTarget.dataset.key
    const expanded = { ...this.data.expandedClauses }
    expanded[key] = !expanded[key]
    this.setData({ expandedClauses: expanded })
  }
})
