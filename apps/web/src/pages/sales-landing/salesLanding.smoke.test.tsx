// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a) } }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => ({ salesCode: 'ABC123' }) }
})

import { renderWithProviders, waitFor } from '../../test/utils'
import SalesLandingPage from './index'

describe('SalesLandingPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockRejectedValue({ response: { status: 404 } }) })
  it('fetches the sales landing profile by code', async () => {
    renderWithProviders(<SalesLandingPage />, { route: '/s/ABC123' })
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalled())
  })
})
