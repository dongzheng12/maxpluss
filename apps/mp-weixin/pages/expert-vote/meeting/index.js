/**
 * 专家评审投票 — 会议详情页（P0-2A）
 *
 * 状态 >= MEETING_SCHEDULED 才有完整会议信息。
 * 仅展示与复制操作，不允许用户编辑。
 */
const request = require('../../../utils/request')
const remoteConfig = require('../../../utils/remoteConfig')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/expert-vote/meeting/index'
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
    meetingStartText: '',
    meetingEndText: '',
    arrangedAtText: '',
    notReady: false,
    isLive: false,
    isHistory: false,
    historyHint: '',
  },
  onLoad(query) {
    const no = (query && query.no) ? String(query.no) : ''
    if (!no) {
      wx.showToast({ title: '缺少申请编号', icon: 'none' })
      return
    }
    this.setData({ no })
    this.load()
  },
  load() {
    this.setData({ loading: true })
    request({
      url: `/api/app/expert-votes/${this.data.no}`,
      method: 'GET',
    }).then((res) => {
      if (res.statusCode !== 200) {
        wx.showToast({ title: '加载失败', icon: 'none' })
        this.setData({ loading: false })
        return
      }
      const d = res.data || {}
      // 状态尚未到 MEETING_SCHEDULED：展示"会议尚未安排"
      const ready = ['MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].indexOf(d.status) >= 0
      // 仅 MEETING_SCHEDULED 是 live 状态，可以突出"复制入会链接"
      const isLive = d.status === 'MEETING_SCHEDULED'
      // VOTING / VOTED / SIGNING / COMPLETED：会议作为历史记录，标题改为"会议信息"，隐藏入会主操作
      const isHistory = ['VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].indexOf(d.status) >= 0
      // 设置导航栏标题
      wx.setNavigationBarTitle({ title: isHistory ? '会议信息' : '会议详情' })
      this.setData({
        detail: d,
        loading: false,
        notReady: !ready,
        isLive,
        isHistory,
        historyHint: d.status === 'COMPLETED'
          ? remoteConfig.getCopy('expert_vote', 'history_hint_completed', '会议已结束，本页为会议历史记录。')
          : remoteConfig.getCopy('expert_vote', 'history_hint_ongoing', '会议已结束，专家意见与投票结果整理中，本页为会议历史记录。'),
        meetingStartText: d.meetingStartAt ? formatDateTime(d.meetingStartAt) : '',
        meetingEndText: d.meetingEndAt ? formatDateTime(d.meetingEndAt) : '',
        arrangedAtText: d.meetingArrangedAt ? formatDateTime(d.meetingArrangedAt) : '',
      })
    }).catch(() => {
      this.setData({ loading: false })
    })
  },
  copyMeetingId() {
    if (!this.data.detail || !this.data.detail.tencentMeetingId) return
    wx.setClipboardData({
      data: this.data.detail.tencentMeetingId,
      success: () => wx.showToast({ title: '会议号已复制' }),
    })
  },
  copyMeetingUrl() {
    if (!this.data.detail || !this.data.detail.tencentMeetingUrl) return
    wx.setClipboardData({
      data: this.data.detail.tencentMeetingUrl,
      success: () => wx.showToast({ title: '会议链接已复制' }),
    })
  },
  copyMeetingPwd() {
    if (!this.data.detail || !this.data.detail.tencentMeetingPwd) return
    wx.setClipboardData({
      data: this.data.detail.tencentMeetingPwd,
      success: () => wx.showToast({ title: '会议密码已复制' }),
    })
  },
})

function pad(n) { return String(n).padStart(2, '0') }
function formatDateTime(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
