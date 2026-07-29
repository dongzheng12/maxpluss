// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const adminGetExpertVote = vi.fn()
vi.mock('../../../api/admin', () => ({
  adminGetExpertVote: (...a: unknown[]) => adminGetExpertVote(...a),
  adminSaveExpertVoteArrangement: vi.fn(),
  adminConfirmExpertVoteMeeting: vi.fn(),
  adminDownloadExpertVoteAttachment: vi.fn(),
}))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => ({ no: 'EV-1' }) }
})

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminExpertVoteDetailPage from './detail'

const vote = {
  requestNo: 'EV-1',
  status: 'EXPERT_ARRANGING',
  projectName: '某标准评审项目',
  projectType: '制定',
  standardType: '国标',
  standardStatus: '现行',
  applicant: { name: '张三', org: '某公司', phone: '13800138000' },
  order: { orderNo: 'ORD-1', status: 'PAID' },
  orderNo: 'ORD-1',
  totalAmount: 100000,
  paidAt: '2026-01-01T00:00:00Z',
  expertCount: 3,
  expertCategories: [],
  expertSourceType: 'PLATFORM',
  industries: [],
  attachments: [],
  userSpecifiedExperts: [],
  participatingOrgs: [],
  draftingOrgs: [],
  disputePoints: [],
  keywords: [],
  titleRequirements: '',
  orgBackgroundRequirements: '',
  confidentialLevel: 'NORMAL',
  desiredSlot: '',
  desiredDate: '',
  expectedFinishAt: '',
  meetingArrangedAt: '',
  extraExpertNote: '',
}

describe('AdminExpertVoteDetailPage smoke', () => {
  beforeEach(() => {
    adminGetExpertVote.mockReset().mockResolvedValue(vote)
  })

  it('loads the vote and exposes the meeting-arrangement state action', async () => {
    renderWithProviders(<AdminExpertVoteDetailPage />)
    await waitFor(() => expect(adminGetExpertVote).toHaveBeenCalledWith('EV-1'))
    expect(await screen.findByText('某标准评审项目')).toBeInTheDocument()
    // EXPERT_ARRANGING state surfaces the confirm-meeting transition button.
    expect(screen.getByRole('button', { name: /确认会议安排/ })).toBeInTheDocument()
  })
})
