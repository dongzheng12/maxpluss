// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderWithProviders, screen } from '../../test/utils'
import TermsPage from './index'

describe('TermsPage smoke', () => {
  it('renders the terms-of-service document', () => {
    renderWithProviders(<TermsPage />)
    expect(screen.getByText('用户注册服务协议')).toBeInTheDocument()
  })
})
