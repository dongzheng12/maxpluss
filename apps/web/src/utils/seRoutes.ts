export function isSERoute(pathname: string): boolean {
  return (
    pathname === '/admin/standard-execution' ||
    pathname.startsWith('/admin/standard-execution/') ||
    pathname === '/enterprise' ||
    pathname.startsWith('/enterprise/')
  )
}
