// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderWithProviders, screen, userEvent } from '../../test/utils'
import NotFoundPage from './index'

// Canary smoke test proving the jsdom + Testing Library harness mounts a real
// page, renders antd components, and exercises an interaction. Keep this green
// as the baseline every page smoke test builds on.
describe('NotFoundPage smoke', () => {
  it('renders the 404 result and a primary action', () => {
    renderWithProviders(<NotFoundPage />)
    expect(screen.getByText('页面不存在')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回首页' })).toBeInTheDocument()
  })

  it('lets the user click the back-to-home action without crashing', async () => {
    renderWithProviders(<NotFoundPage />, { route: '/does-not-exist' })
    await userEvent.click(screen.getByRole('button', { name: '返回首页' }))
    // Navigation target is "/"; the button stays mounted (no throw on click).
    expect(screen.getByText('页面不存在')).toBeInTheDocument()
  })
})
