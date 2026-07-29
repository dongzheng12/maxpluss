// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchStandards = vi.fn()
const getIndustryStandards = vi.fn()
vi.mock('../../api/standards', () => ({
  searchStandards: (...a: unknown[]) => searchStandards(...a),
  getIndustryStandards: (...a: unknown[]) => getIndustryStandards(...a),
}))

// Grant access so the search quota gate never blocks the smoke flow.
vi.mock('../../hooks/useAccess', () => ({
  useAccess: () => ({
    isLoggedIn: true,
    isPaid: true,
    checkAndConsume: () => true,
    requireLogin: () => true,
  }),
}))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import StandardsPage from './index'

describe('StandardsPage smoke', () => {
  beforeEach(() => {
    searchStandards.mockReset().mockResolvedValue({
      items: [{ code: 'GB/T 1.1-2020', name: '标准化工作导则', status: '现行' }],
      total: 1,
      status_counts: { 现行: 1 },
    })
    getIndustryStandards.mockReset().mockResolvedValue({ mandatory: [], recommended: [] })
  })

  it('runs a keyword search from the query string and lists results', async () => {
    renderWithProviders(<StandardsPage />, { route: '/standards?q=导则' })
    await waitFor(() => expect(searchStandards).toHaveBeenCalled())
    expect(searchStandards.mock.calls[0][0]).toMatchObject({ q: '导则' })
    expect(await screen.findByText('GB/T 1.1-2020')).toBeInTheDocument()
  })

  it('does not fire a search when there is no query', async () => {
    renderWithProviders(<StandardsPage />, { route: '/standards' })
    // Allow effects to settle; keyword search must stay idle without a query.
    await Promise.resolve()
    expect(searchStandards).not.toHaveBeenCalled()
  })
})
