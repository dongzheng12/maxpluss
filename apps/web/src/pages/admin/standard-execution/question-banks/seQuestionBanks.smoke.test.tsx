// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListQuestionBanksEnterprise = vi.fn()
vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seListQuestionBanksEnterprise: () => seListQuestionBanksEnterprise(),
}))

import { renderWithProviders, waitFor } from '../../../../test/utils'
import QuestionBanksPage from './index'

describe('QuestionBanksPage (enterprise) smoke', () => {
  beforeEach(() => {
    seListQuestionBanksEnterprise.mockReset().mockResolvedValue({ items: [] })
  })

  it('loads enterprise question banks under the enterprise route', async () => {
    renderWithProviders(<QuestionBanksPage />, { route: '/enterprise/question-banks' })
    await waitFor(() => expect(seListQuestionBanksEnterprise).toHaveBeenCalled())
  })
})
