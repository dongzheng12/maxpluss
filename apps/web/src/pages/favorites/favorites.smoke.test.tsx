// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pyApiGet = vi.fn()
vi.mock('../../api/client', () => ({ pyApi: { get: (...a: unknown[]) => pyApiGet(...a) } }))

import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/utils'
import FavoritesPage from './index'

describe('FavoritesPage smoke', () => {
  beforeEach(() => {
    pyApiGet.mockReset().mockResolvedValue({ code: 'GB/T 1.1-2020', name: '标准化工作导则', status: '现行' })
  })

  it('lists favorites read from localStorage', async () => {
    localStorage.setItem('bxz_favorites', JSON.stringify(['GB/T 1.1-2020']))
    renderWithProviders(<FavoritesPage />)
    await waitFor(() => expect(pyApiGet).toHaveBeenCalled())
    expect(await screen.findByText(/GB\/T 1.1-2020/)).toBeInTheDocument()
  })

  it('removes a favorite and updates localStorage', async () => {
    localStorage.setItem('bxz_favorites', JSON.stringify(['GB/T 1.1-2020']))
    renderWithProviders(<FavoritesPage />)
    await screen.findByText(/GB\/T 1.1-2020/)
    fireEvent.click(screen.getByRole('button', { name: /取消收藏/ }))
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('bxz_favorites') || '[]')).not.toContain('GB/T 1.1-2020'),
    )
  })

  it('shows an empty state with no favorites', async () => {
    renderWithProviders(<FavoritesPage />)
    expect(await screen.findByText('还没有收藏任何标准')).toBeInTheDocument()
  })
})
