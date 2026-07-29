// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getHomeData = vi.fn()
vi.mock('../../api/app', () => ({ getHomeData: () => getHomeData() }))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import AnnouncementsPage from './index'

describe('AnnouncementsPage smoke', () => {
  beforeEach(() => { getHomeData.mockReset().mockResolvedValue({ announcements: [] }) })
  it('renders the all-announcements page and loads data', async () => {
    renderWithProviders(<AnnouncementsPage />)
    expect(screen.getByText('全部公告')).toBeInTheDocument()
    await waitFor(() => expect(getHomeData).toHaveBeenCalled())
  })
})
