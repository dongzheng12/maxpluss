import { describe, expect, it } from 'vitest'
import {
  EXPERT_VOTE_REFUNDABLE_STATUSES,
  canRefundOrder,
  getAdminDisplayStatus,
  getExpertVoteStatusColor,
  getExpertVoteStatusLabel,
  isExpertVoteRefundableStatus,
} from './expertVoteUi'

describe('expert vote UI status mapping', () => {
  it('keeps user and admin labels distinct where product wording differs', () => {
    expect(getExpertVoteStatusLabel('VOTING', 'user')).toBe('会后结果整理中')
    expect(getExpertVoteStatusLabel('VOTING', 'admin')).toBe('待整理结果')
    expect(getExpertVoteStatusLabel('SIGNING', 'user')).toBe('确认文件处理中')
    expect(getExpertVoteStatusLabel('SIGNING', 'admin')).toBe('待上传交付文件')
  })

  it('returns safe fallback label and color for unknown statuses', () => {
    expect(getExpertVoteStatusLabel('UNKNOWN', 'user')).toBe('未知状态')
    expect(getExpertVoteStatusColor('UNKNOWN', 'admin')).toBe('default')
    expect(getAdminDisplayStatus({ status: 'NOPE' })).toEqual({ label: '未知状态', color: 'default' })
  })
})

describe('expert vote refund gating', () => {
  it('keeps the refundable whitelist at pre-meeting statuses only', () => {
    expect(EXPERT_VOTE_REFUNDABLE_STATUSES).toEqual(['EXPERT_ARRANGING', 'MEETING_SCHEDULED'])
    expect(isExpertVoteRefundableStatus('EXPERT_ARRANGING')).toBe(true)
    expect(isExpertVoteRefundableStatus('MEETING_SCHEDULED')).toBe(true)
  })

  it.each(['VOTING', 'VOTED', 'SIGNING', 'COMPLETED', 'REFUNDED', 'CANCELLED'])(
    'rejects expert-vote refund status %s',
    (status) => {
      expect(isExpertVoteRefundableStatus(status)).toBe(false)
      expect(canRefundOrder({
        status: 'PAID',
        productType: 'EXPERT_VOTE',
        expertVoteRequestStatus: status,
      })).toBe(false)
    },
  )

  it('allows non-expert paid orders and pre-meeting expert-vote orders', () => {
    expect(canRefundOrder({ status: 'PAID', productType: 'MEMBERSHIP' })).toBe(true)
    expect(canRefundOrder({
      status: 'PAID',
      productType: 'EXPERT_VOTE',
      expertVoteRequestStatus: 'EXPERT_ARRANGING',
    })).toBe(true)
    expect(canRefundOrder({
      status: 'PAID',
      productType: 'EXPERT_VOTE',
      expertVoteRequestStatus: 'MEETING_SCHEDULED',
    })).toBe(true)
  })

  it('rejects unpaid, missing, or unbound expert-vote orders', () => {
    expect(canRefundOrder(null)).toBe(false)
    expect(canRefundOrder({ status: 'PENDING', productType: 'MEMBERSHIP' })).toBe(false)
    expect(canRefundOrder({ status: 'PAID', productType: 'EXPERT_VOTE' })).toBe(false)
  })
})
