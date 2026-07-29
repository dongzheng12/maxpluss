// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({ nodeApi: { get: vi.fn().mockResolvedValue({}) } }))
vi.mock('../../contexts/ContactSalesContext', () => ({ useContactSales: () => ({ openContact: vi.fn() }) }))

import { renderWithProviders, screen } from '../../test/utils'
import ProductBxzPage from './index'

describe('ProductBxzPage smoke', () => {
  it('renders the product landing content', () => {
    renderWithProviders(<ProductBxzPage />, { route: '/product/biaozhunxiaozhi' })
    expect(screen.getAllByText('标准小智 · 用标准').length).toBeGreaterThan(0)
  })
})
