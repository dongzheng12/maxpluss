// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listExpertVotes = vi.fn()
vi.mock('../../api/app', () => ({
  listExpertVotes: () => listExpertVotes(),
  deleteExpertVoteDraft: vi.fn(),
}))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import ExpertVoteListPage from './index'

describe('ExpertVoteListPage (public) smoke', () => {
  beforeEach(() => { listExpertVotes.mockReset().mockResolvedValue({ items: [] }) })
  it('renders the expert-review landing and loads the list', async () => {
    renderWithProviders(<ExpertVoteListPage />, { route: '/expert-vote' })
    expect(await screen.findByRole('heading', { name: /专家评审投票/ })).toBeInTheDocument()
    await waitFor(() => expect(listExpertVotes).toHaveBeenCalled())
  })
})
