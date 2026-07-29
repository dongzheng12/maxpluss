import dayjs from 'dayjs'

export function formatCnyFromCents(cents: number | null | undefined, fallback = '-'): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return fallback
  return `¥${(cents / 100).toFixed(2)}`
}

export function formatDateTime(
  value: string | Date | null | undefined,
  pattern = 'YYYY-MM-DD HH:mm:ss',
  fallback = '-',
): string {
  if (!value) return fallback
  const d = dayjs(value)
  return d.isValid() ? d.format(pattern) : fallback
}

export function formatDate(value: string | Date | null | undefined, fallback = '-'): string {
  return formatDateTime(value, 'YYYY-MM-DD', fallback)
}
