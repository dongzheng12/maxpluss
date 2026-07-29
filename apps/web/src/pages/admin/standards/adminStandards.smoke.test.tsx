// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const adminListStandards = vi.fn()
vi.mock('../../../api/admin', () => ({ adminListStandards: () => adminListStandards() }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminStandardsPage from './index'

describe('AdminStandardsPage smoke', () => {
  beforeEach(() => {
    adminListStandards.mockReset().mockResolvedValue({ items: [] })
  })

  it('renders the standard-library management page and loads data', async () => {
    renderWithProviders(<AdminStandardsPage />)
    expect(screen.getByText('标准库管理')).toBeInTheDocument()
    await waitFor(() => expect(adminListStandards).toHaveBeenCalled())
  })
})
