// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListEnterpriseApiKeys = vi.fn()
const seListEnterpriseWebhooks = vi.fn()

vi.mock('../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/standardExecution')>()),
  seListEnterpriseApiKeys: () => seListEnterpriseApiKeys(),
  seListEnterpriseWebhooks: () => seListEnterpriseWebhooks(),
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import EnterpriseOpenApiPage from './index'

describe('EnterpriseOpenApiPage smoke', () => {
  beforeEach(() => {
    seListEnterpriseApiKeys.mockReset().mockResolvedValue({
      data: [{
        id: 'key-1',
        name: 'MES',
        scopes: ['records:write'],
        lastUsedAt: null,
        expiresAt: null,
        isActive: true,
        createdAt: '2026-06-17T00:00:00.000Z',
        revokedAt: null,
      }],
    })
    seListEnterpriseWebhooks.mockReset().mockResolvedValue({
      data: [{
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['record.created'],
        isActive: true,
        lastTriggeredAt: null,
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      }],
    })
  })

  it('renders API keys and webhooks', async () => {
    renderWithProviders(<EnterpriseOpenApiPage />, { route: '/enterprise/open-api' })
    await waitFor(() => expect(seListEnterpriseApiKeys).toHaveBeenCalled())
    expect(await screen.findByText('MES')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/hook')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /创建 Key/ })).toBeInTheDocument()
  })
})
