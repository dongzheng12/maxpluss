// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const adminListExpertVotes = vi.fn()
vi.mock('../../../api/admin', () => ({ adminListExpertVotes: (...a: unknown[]) => adminListExpertVotes(...a) }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminExpertVotesPage from './index'

describe('AdminExpertVotesPage smoke', () => {
  beforeEach(() => {
    adminListExpertVotes.mockReset().mockResolvedValue({
      items: [
        { requestNo: 'EV-1', status: 'VOTING', projectName: '某标准评审', applicant: { name: '张三' } },
      ],
      total: 1,
    })
  })

  it('renders the review-management list and loads data', async () => {
    renderWithProviders(<AdminExpertVotesPage />)
    expect(screen.getByText('管理和处理专家评审投票申请')).toBeInTheDocument()
    await waitFor(() => expect(adminListExpertVotes).toHaveBeenCalled())
    expect(await screen.findByText('某标准评审')).toBeInTheDocument()
  })
})
