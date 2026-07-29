/**
 * ICS 分类 — 真实 API 对接
 * @date   2026-03-24
 */
var config = require('../../utils/config')
var request = require('../../utils/request')

function flattenResults(roots, keyword) {
  var query = (keyword || '').trim().toLowerCase()
  if (!query) return []
  var result = []
  roots.forEach(function (root) {
    if (root.name.toLowerCase().includes(query)) {
      (root.children || []).forEach(function (child) {
        (child.children || []).forEach(function (leaf) {
          result.push({
            rootCode: root.code,
            rootName: root.name,
            childCode: child.code,
            childName: child.name,
            code: leaf.code,
            name: leaf.name,
            path: root.code + ' ' + root.name + ' > ' + child.code + ' ' + child.name + ' > ' + leaf.code + ' ' + leaf.name
          })
        })
      })
    }
    (root.children || []).forEach(function (child) {
      if (child.name.toLowerCase().includes(query)) {
        (child.children || []).forEach(function (leaf) {
          result.push({
            rootCode: root.code,
            rootName: root.name,
            childCode: child.code,
            childName: child.name,
            code: leaf.code,
            name: leaf.name,
            path: root.code + ' ' + root.name + ' > ' + child.code + ' ' + child.name + ' > ' + leaf.code + ' ' + leaf.name
          })
        })
      }
      ;(child.children || []).forEach(function (leaf) {
        if (leaf.name.toLowerCase().includes(query)) {
          result.push({
            rootCode: root.code,
            rootName: root.name,
            childCode: child.code,
            childName: child.name,
            code: leaf.code,
            name: leaf.name,
            path: root.code + ' ' + root.name + ' > ' + child.code + ' ' + child.name + ' > ' + leaf.code + ' ' + leaf.name
          })
        }
      })
    })
  })
  return result
}

Page({
  data: {
    loading: true,
    roots: [],
    activeRootCode: '',
    activeRoot: null,
    keyword: '',
    searchResults: []
  },

  onLoad() {
    this.loadIcs()
  },

  loadIcs() {
    this.setData({ loading: true })
    request({
      url: '/api/app/ics',
      method: 'GET',
      success: (res) => {
        var data = res.data
        var items = (data && data.items) ? data.items : []
        if (items.length > 0) {
          this.setData({
            loading: false,
            roots: items,
            activeRootCode: items[0].code,
            activeRoot: items[0]
          })
        } else {
          this.setData({ loading: false })
        }
      },
      fail: () => {
        wx.showToast({ title: '加载 ICS 分类失败', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  switchRoot(e) {
    var code = e.currentTarget.dataset.code
    var activeRoot = this.data.roots.find(function (item) { return item.code === code })
    this.setData({ activeRootCode: code, activeRoot: activeRoot })
  },

  onKeywordInput(e) {
    var keyword = e.detail.value
    this.setData({ keyword: keyword, searchResults: flattenResults(this.data.roots, keyword) })
  },

  chooseLeaf(e) {
    var dataset = e.currentTarget.dataset
    getApp().globalData.icsSelection = {
      rootCode: dataset.rootcode,
      rootName: dataset.rootname,
      childCode: dataset.childcode,
      childName: dataset.childname,
      code: dataset.code,
      name: dataset.name,
      path: dataset.rootcode + ' ' + dataset.rootname + ' > ' + dataset.childcode + ' ' + dataset.childname + ' > ' + dataset.code + ' ' + dataset.name
    }
    wx.navigateBack()
  }
})
