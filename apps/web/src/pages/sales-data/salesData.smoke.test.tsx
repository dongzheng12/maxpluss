// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a) } }))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import SalesDataPage from './index'

describe('SalesDataPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [] }) })
  it('renders the attributed-orders page and loads data', async () => {
    renderWithProviders(<SalesDataPage />)
    expect(screen.getByText('归因订单')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalled())
  })
})
