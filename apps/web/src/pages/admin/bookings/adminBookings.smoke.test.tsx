// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), patch: vi.fn() },
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminBookingsPage from './index'

describe('AdminBookingsPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [] })
  })

  it('renders the service-booking page and loads bookings', async () => {
    renderWithProviders(<AdminBookingsPage />)
    expect(screen.getByText('服务预约')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/bookings'))
  })
})
