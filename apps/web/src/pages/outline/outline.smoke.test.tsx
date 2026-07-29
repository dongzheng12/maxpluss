// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/standards', () => ({ generateOutline: vi.fn().mockResolvedValue({ outline: [] }) }))

import { renderWithProviders, screen } from '../../test/utils'
import OutlinePage from './index'

describe('OutlinePage smoke', () => {
  it('renders the outline-generation page intro', () => {
    renderWithProviders(<OutlinePage />)
    expect(screen.getByText(/输入一句话描述您要编写的标准内容/)).toBeInTheDocument()
  })
})
