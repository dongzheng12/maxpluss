/**
 * 专家评审投票 — 申请详情页（P0-2A，只读）
 */
const request = require('../../../utils/request')
const remoteConfig = require('../../../utils/remoteConfig')

const STATUS_LABEL = {
  DRAFT: '草稿', PAYING: '支付中', EXPERT_ARRANGING: '专家组织中',
  MEETING_SCHEDULED: '会议已定', VOTING: '会后结果整理中', VOTED: '整理已完成',
  SIGNING: '确认文件处理中', COMPLETED: '已完成',
  CANCELLED: '已取消', REFUNDED: '已退款',
}
const STATUS_CLASS = {
  DRAFT: 'tag-default', PAYING: 'tag-warning', EXPERT_ARRANGING: 'tag-processing',
  MEETING_SCHEDULED: 'tag-cyan', VOTING: 'tag-blue', VOTED: 'tag-blue',
  SIGNING: 'tag-purple', COMPLETED: 'tag-success',
  CANCELLED: 'tag-default', REFUNDED: 'tag-warning',
}
const SLOT_LABEL = { MORNING: '上午', AFTERNOON: '下午', EVENING: '晚上', ANY: '全天均可' }
const CONFID_LABEL = { NONE: '否', SENSITIVE: '一般敏感', STRICT: '严格保密' }

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/expert-vote/detail/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    no: '',
    detail: null,
    loading: true,
    showMeetingBtn: false,
    industriesText: '',
    expertCategoriesText: '',
    titleRequirementsText: '',
    orgBackgroundText: '',
    statusLabel: '',
    statusClass: 'tag-default',
    confidentialLabel: '',
    slotLabel: '',
    desiredDateText: '',
    expectedFinishText: '',
    submittedAtText: '',
    paidAtText: '',
    amountYuan: '',
    hintPaying: '申请尚未支付，支付完成后平台将组织专家。',
    hintExpertArranging: '平台正在为您组织专家并安排会议，请耐心等待会议安排通知。',
    hintMeetingScheduled: '会议已安排，请查看会议详情并按时参会。',
    hintVoting: '会议已结束，专家意见与投票结果正在整理中，请耐心等待。',
    hintVoted: '结果整理完成，确认文件正在处理中。',
    hintSigning: '确认文件正在处理中，完成后可下载最终交付文件。',
    hintCompleted: '专家评审意见与投票结果确认文件已完成。',
    hintRefunded: '已退款，金额已原路退回，预计 1-3 个工作日到账。',
  },
  onLoad(query) {
    this._applyRemoteCopy()
    const no = (query && query.no) ? String(query.no) : ''
    if (!no) {
      wx.showToast({ title: '缺少申请编号', icon: 'none' })
      return
    }
    this.setData({ no })
    this.load()
  },
  _applyRemoteCopy() {
    this.setData({
      hintPaying: remoteConfig.getCopy('expert_vote', 'hint_paying', '申请尚未支付，支付完成后平台将组织专家。'),
      hintExpertArranging: remoteConfig.getCopy('expert_vote', 'hint_expert_arranging', '平台正在为您组织专家并安排会议，请耐心等待会议安排通知。'),
      hintMeetingScheduled: remoteConfig.getCopy('expert_vote', 'hint_meeting_scheduled', '会议已安排，请查看会议详情并按时参会。'),
      hintVoting: remoteConfig.getCopy('expert_vote', 'hint_voting', '会议已结束，专家意见与投票结果正在整理中，请耐心等待。'),
      hintVoted: remoteConfig.getCopy('expert_vote', 'hint_voted', '结果整理完成，确认文件正在处理中。'),
      hintSigning: remoteConfig.getCopy('expert_vote', 'hint_signing', '确认文件正在处理中，完成后可下载最终交付文件。'),
      hintCompleted: remoteConfig.getCopy('expert_vote', 'hint_completed', '专家评审意见与投票结果确认文件已完成。'),
      hintRefunded: remoteConfig.getCopy('expert_vote', 'hint_refunded', '已退款，金额已原路退回，预计 1-3 个工作日到账。'),
    })
  },
  onShow() {
    if (this.data.no) this.load()
  },
  load() {
    this.setData({ loading: true })
    request({
      url: `/api/app/expert-votes/${this.data.no}`,
      method: 'GET',
    }).then((res) => {
      if (res.statusCode === 404) {
        wx.showToast({ title: '申请不存在', icon: 'none' })
        return
      }
      if (res.statusCode === 403) {
        wx.showToast({ title: '无权查看', icon: 'none' })
        return
      }
      const d = res.data || {}
      const hasFinalFile = !!(d.finalDeliverablePath || d.signedPdfPath)
      this.setData({
        detail: d,
        loading: false,
        statusLabel: STATUS_LABEL[d.status] || d.status,
        statusClass: STATUS_CLASS[d.status] || 'tag-default',
        // 仅 MEETING_SCHEDULED 把"查看会议"作为主按钮
        showMeetingPrimary: d.status === 'MEETING_SCHEDULED',
        // VOTING / VOTED / SIGNING / COMPLETED：会议作为历史记录二级链接
        showMeetingHistory: ['VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].indexOf(d.status) >= 0,
        isCompletedWithFile: d.status === 'COMPLETED' && hasFinalFile,
        isCompletedNoFile: d.status === 'COMPLETED' && !hasFinalFile,
        industriesText: arrayJoin(d.industries),
        expertCategoriesText: arrayJoin(d.expertCategories),
        titleRequirementsText: arrayJoin(d.titleRequirements),
        orgBackgroundText: arrayJoin(d.orgBackgroundRequirements),
        confidentialLabel: CONFID_LABEL[d.confidentialLevel] || d.confidentialLevel || '-',
        slotLabel: SLOT_LABEL[d.desiredSlot] || d.desiredSlot || '-',
        desiredDateText: d.desiredDate ? formatDate(d.desiredDate) : '-',
        expectedFinishText: d.expectedFinishAt ? formatDate(d.expectedFinishAt) : '-',
        submittedAtText: d.submittedAt ? formatDateTime(d.submittedAt) : '-',
        paidAtText: d.paidAt ? formatDateTime(d.paidAt) : '-',
        amountYuan: typeof d.totalAmount === 'number' ? (d.totalAmount / 100).toFixed(0) : '-',
      })
    }).catch(() => {
      this.setData({ loading: false })
    })
  },
  goMeeting() {
    if (!this.data.no) return
    wx.navigateTo({ url: `/pages/expert-vote/meeting/index?no=${this.data.no}` })
  },
  downloadSigned() {
    if (!this.data.no) return
    const config = require('../../../utils/config')
    const session = require('../../../utils/session')
    const token = session.getToken()
    wx.showLoading({ title: '下载中...', mask: true })
    wx.downloadFile({
      url: `${config.API_BASE}/api/app/expert-votes/${this.data.no}/download-signed`,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        wx.hideLoading()
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'docx',
            success() {},
            fail() { wx.showToast({ title: '打开失败，请稍后再试', icon: 'none' }) },
          })
        } else {
          wx.showToast({ title: '下载失败：' + res.statusCode, icon: 'none' })
        }
      },
      fail() {
        wx.hideLoading()
        wx.showToast({ title: '网络错误，下载失败', icon: 'none' })
      },
    })
  },
})

function arrayJoin(v) {
  if (Array.isArray(v) && v.length) return v.join('、')
  return '-'
}
function pad(n) { return String(n).padStart(2, '0') }
function formatDate(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatDateTime(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
