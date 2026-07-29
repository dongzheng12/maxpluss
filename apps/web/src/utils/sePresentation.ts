const VISIBLE_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/检查点内容/g, '生成内容'],
  [/检查点/g, '生成内容'],
  [/检查要求/g, '生成内容'],
  [/执行要求库/g, '文档来源'],
  [/Requirement/g, '生成内容'],
  [/requirement/g, '生成内容'],
  [/checkpoint/g, '生成内容'],
  [/Checkpoint/g, '生成内容'],
  [/来源标准/g, '标准文档'],
  [/标准来源/g, '标准文档'],
  [/要求项/g, '生成内容'],
]

export function sanitizeSEVisibleText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  let text = String(value)
  for (const [pattern, replacement] of VISIBLE_TEXT_REPLACEMENTS) {
    text = text.replace(pattern, replacement)
  }
  return text
}

const PINYIN_INITIALS: Record<string, string> = {
  标: 'b', 准: 'z', 文: 'w', 档: 'd', 任: 'r', 务: 'w', 执: 'z', 行: 'x',
  计: 'j', 划: 'h', 审: 's', 核: 'h', 记: 'j', 录: 'l', 材: 'c', 料: 'l',
  包: 'b', 风: 'f', 险: 'x', 题: 't', 库: 'k', 组: 'z', 织: 'z', 成: 'c',
  员: 'y', 企: 'q', 业: 'y', 制: 'z', 度: 'd', 技: 'j', 术: 's', 客: 'k',
  户: 'h', 检: 'j', 查: 'c', 清: 'q', 单: 'd', 安: 'a', 全: 'q', 质: 'z',
  量: 'l', 生: 's', 产: 'c', 培: 'p', 训: 'x', 学: 'x', 习: 'x',
}

function initialsOf(value: string) {
  return Array.from(value).map((ch) => PINYIN_INITIALS[ch] || (/^[a-z0-9]$/i.test(ch) ? ch.toLowerCase() : '')).join('')
}

export function seOptionSearchText(label: unknown): string {
  const text = sanitizeSEVisibleText(label).toLowerCase()
  return `${text} ${initialsOf(text)}`
}

export function filterSEOption(input: string, option?: { label?: unknown; value?: unknown }) {
  const needle = input.trim().toLowerCase()
  if (!needle) return true
  return seOptionSearchText(option?.label ?? option?.value ?? '').includes(needle)
}

export function sortSEOptions<T extends { label?: unknown }>(items: T[]): T[] {
  return [...items].sort((a, b) => seOptionSearchText(a.label).localeCompare(seOptionSearchText(b.label), 'zh-Hans-CN'))
}
