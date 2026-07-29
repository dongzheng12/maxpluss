// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listInvoices = vi.fn()
const createInvoice = vi.fn()
vi.mock('../../api/app', () => ({
  listInvoices: () => listInvoices(),
  createInvoice: (...a: unknown[]) => createInvoice(...a),
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import InvoicesPage from './index'

describe('InvoicesPage smoke', () => {
  beforeEach(() => {
    listInvoices.mockReset().mockResolvedValue({ items: [] })
    createInvoice.mockReset().mockResolvedValue({})
  })

  it('keeps the apply-invoice modal hidden until the action opens it', async () => {
    renderWithProviders(<InvoicesPage />)
    await waitFor(() => expect(listInvoices).toHaveBeenCalled())
    // No order number form field is visible before opening.
    expect(screen.queryByPlaceholderText('请输入已支付的订单号')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /申请发票/ }))
    expect(await screen.findByPlaceholderText('请输入已支付的订单号')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /提交申请/ })).toBeInTheDocument()
  })

  it('auto-opens the modal with the order number prefilled from the query', async () => {
    renderWithProviders(<InvoicesPage />, { route: '/invoices?orderNo=ORD-42' })
    const orderField = await screen.findByPlaceholderText('请输入已支付的订单号')
    await waitFor(() => expect((orderField as HTMLInputElement).value).toBe('ORD-42'))
  })
})
