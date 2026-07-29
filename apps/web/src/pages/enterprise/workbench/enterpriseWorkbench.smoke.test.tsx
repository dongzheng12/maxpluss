// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// The heavy WorkbenchV2 component has its own logic tests (commit/linkage/model);
// this verifies the enterprise page wires it with scope="enterprise".
vi.mock('../../../components/se/workbenchV2/WorkbenchV2', () => ({
  default: (props: { scope?: string }) => <div data-testid="workbench" data-scope={props.scope} />,
}))

import { renderWithProviders, screen } from '../../../test/utils'
import EnterpriseWorkbenchPage from './index'

describe('EnterpriseWorkbenchPage smoke', () => {
  it('mounts the workbench in enterprise scope', () => {
    renderWithProviders(<EnterpriseWorkbenchPage />, { route: '/enterprise/workbench' })
    const wb = screen.getByTestId('workbench')
    expect(wb).toBeInTheDocument()
    expect(wb).toHaveAttribute('data-scope', 'enterprise')
  })
})
