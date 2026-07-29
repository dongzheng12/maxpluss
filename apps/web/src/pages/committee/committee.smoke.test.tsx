// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getTechnicalCommittees = vi.fn()
vi.mock('../../api/standards', () => ({ getTechnicalCommittees: (...a: unknown[]) => getTechnicalCommittees(...a) }))

import { renderWithProviders, screen } from '../../test/utils'
import CommitteePage from './index'

describe('CommitteePage smoke', () => {
  beforeEach(() => { getTechnicalCommittees.mockReset().mockResolvedValue({ items: [], total: 0 }) })
  it('renders the committee query page and loads committees', async () => {
    renderWithProviders(<CommitteePage />)
    expect(await screen.findByRole('heading', { name: /技术委员会查询/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('输入委员会名称或编号')).toBeInTheDocument()
  })
})
