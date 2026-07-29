/**
 * 发票申请 — 真实 API 对接
 * @date   2026-03-24
 */
var config = require('../../utils/config')
var request = require('../../utils/request')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/invoice/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    orderNo: '',
    titleType: 'personal',
    title: '',
    taxNo: '',
    email: '',
    remark: '',
    submitting: false
  },

  onLoad(query) {
    this.setData({ orderNo: query.orderNo || '' })
  },

  chooseType(e) {
    this.setData({ titleType: e.currentTarget.dataset.type })
  },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onTaxNoInput(e) { this.setData({ taxNo: e.detail.value }) },
  onEmailInput(e) { this.setData({ email: e.detail.value }) },
  onRemarkInput(e) { this.setData({ remark: e.detail.value }) },

  submit() {
    var d = this.data
    if (!d.orderNo) {
      wx.showToast({ title: '缺少订单信息', icon: 'none' })
      return
    }
    if (!d.title) {
      wx.showToast({ title: '请填写发票抬头', icon: 'none' })
      return
    }
    if (d.titleType === 'company' && !d.taxNo) {
      wx.showToast({ title: '企业发票请填写税号', icon: 'none' })
      return
    }
    if (!d.email || d.email.indexOf('@') < 0) {
      wx.showToast({ title: '请填写正确的收票邮箱', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...' })

    request({
      url: '/api/app/invoices',
      method: 'POST',
      data: {
        orderNo: d.orderNo,
        type: 'NORMAL',
        titleType: d.titleType === 'company' ? 'COMPANY' : 'PERSONAL',
        title: d.title,
        taxNo: d.taxNo || undefined,
        email: d.email,
        remark: d.remark || undefined
      },
      success: (res) => {
        wx.hideLoading()
        if (res.statusCode === 200 || res.statusCode === 201) {
          wx.showToast({ title: '发票申请已提交', icon: 'success' })
          setTimeout(function () { wx.navigateBack() }, 1500)
        } else {
          var msg = (res.data && res.data.error) || '提交失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '网络错误', icon: 'none' })
      },
      complete: () => {
        this.setData({ submitting: false })
      }
    })
  }
})
