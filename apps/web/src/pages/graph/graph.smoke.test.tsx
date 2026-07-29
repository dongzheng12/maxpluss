// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/standards', () => ({
  getStandardRelations: vi.fn().mockResolvedValue({ relations: {} }),
  quickSearch: vi.fn().mockResolvedValue({ items: [] }),
}))

import { renderWithProviders, screen } from '../../test/utils'
import GraphPage from './index'

describe('GraphPage smoke', () => {
  it('renders the standard-graph page with its search input', () => {
    renderWithProviders(<GraphPage />)
    expect(screen.getByRole('heading', { name: /标准图谱/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/输入标准编号或名称/)).toBeInTheDocument()
  })
})
