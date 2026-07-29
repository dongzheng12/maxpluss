var remoteConfig = require('../../utils/remoteConfig')
var benefitsMatrix = require('../../utils/membershipBenefitsMatrix')

function buildBenefitsView(matrix) {
  var resolved = benefitsMatrix.resolveMembershipBenefitsMatrix(matrix)
  return {
    columns: resolved.columns.slice(),
    sections: benefitsMatrix.toMiniProgramSections(resolved),
    notes: resolved.noteItems.slice(),
  }
}

var fallbackView = buildBenefitsView(benefitsMatrix.fallbackBenefitsMatrix)

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/membership-benefits/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    // 价格对照表 — 走远程 pricing 接口，加载中/失败时显示占位文案而不是假价
    personalPriceText: '价格加载中',
    proPriceText: '价格加载中',
    columns: fallbackView.columns,
    sections: fallbackView.sections,
    notes: fallbackView.notes,
  },

  onShow: function () {
    this._loadBenefitsMatrix()
    this._loadPricing()
  },

  _loadBenefitsMatrix: function () {
    var self = this
    remoteConfig.loadRemoteConfig().then(function () {
      var matrix = remoteConfig.getMembershipBenefitsMatrix(benefitsMatrix.fallbackBenefitsMatrix)
      var view = buildBenefitsView(matrix)
      self.setData({
        columns: view.columns,
        sections: view.sections,
        notes: view.notes,
      })
    }).catch(function () {
      var view = buildBenefitsView(benefitsMatrix.fallbackBenefitsMatrix)
      self.setData({
        columns: view.columns,
        sections: view.sections,
        notes: view.notes,
      })
    })
  },

  _loadPricing: function () {
    var self = this
    remoteConfig.loadPricing().then(function (data) {
      if (!data || !Array.isArray(data.plans)) {
        // 接口失败 → 保留 "价格加载中" 占位，不显示假价
        return
      }
      var personal = data.plans.find(function (p) { return p.id === 'personal' })
      var pro = data.plans.find(function (p) { return p.id === 'pro' })
      var unitOf = function (p) { return (p && p.unit) || '年' }
      self.setData({
        personalPriceText: (personal && personal.price > 0) ? ('¥' + personal.price + '/' + unitOf(personal)) : '价格加载中',
        proPriceText: (pro && pro.price > 0) ? ('¥' + pro.price + '/' + unitOf(pro)) : '价格加载中',
      })
    })
  }
})
