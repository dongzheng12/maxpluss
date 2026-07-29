// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderWithProviders, screen } from '../../test/utils'
import PrivacyPage from './index'

describe('PrivacyPage smoke', () => {
  it('renders the privacy-policy document', () => {
    renderWithProviders(<PrivacyPage />)
    expect(screen.getByText('隐私政策')).toBeInTheDocument()
  })
})
