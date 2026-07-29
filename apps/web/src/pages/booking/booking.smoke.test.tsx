// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listBookings = vi.fn()
vi.mock('../../api/app', () => ({ listBookings: () => listBookings(), createBooking: vi.fn() }))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import BookingPage from './index'

describe('BookingPage smoke', () => {
  beforeEach(() => { listBookings.mockReset().mockResolvedValue({ items: [] }) })
  it('renders the service-booking page and loads records', async () => {
    renderWithProviders(<BookingPage />)
    expect(await screen.findByRole('heading', { name: /标准服务预约/ })).toBeInTheDocument()
    await waitFor(() => expect(listBookings).toHaveBeenCalled())
  })
})
