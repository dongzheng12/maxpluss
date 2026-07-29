// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAppConfig = vi.fn()
vi.mock('../../api/app', () => ({ getAppConfig: () => getAppConfig() }))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import BenefitsPage from './benefits'
import { fallbackBenefitsMatrix } from './benefitsMatrix'

describe('BenefitsPage smoke', () => {
  beforeEach(() => {
    getAppConfig.mockReset().mockResolvedValue({})
  })

  it('renders the benefits comparison with all column labels', async () => {
    renderWithProviders(<BenefitsPage />)
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled())
    for (const col of fallbackBenefitsMatrix.columns) {
      expect(screen.getAllByText(col.label).length).toBeGreaterThan(0)
    }
  })

  it('renders a row for each benefit in the matrix', async () => {
    renderWithProviders(<BenefitsPage />)
    const firstSection = fallbackBenefitsMatrix.sections[0]
    const firstBenefit = firstSection.rows[0]
    expect(await screen.findByText(firstBenefit.name)).toBeInTheDocument()
  })
})
