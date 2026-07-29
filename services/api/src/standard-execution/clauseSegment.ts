import { z } from 'zod'

export type ClauseChunk = {
  clauseNo: string
  title: string
  text: string
  chunkIndex: number
}

const AiClauseChunkSchema = z.object({
  clauseNo: z.string().optional().default(''),
  title: z.string().optional().default(''),
  text: z.string().min(1),
})
const AiClauseChunksSchema = z.array(AiClauseChunkSchema).min(1)

const CLAUSE_HEAD_RE = /^\s*((?:\d{1,2}(?:\.\d{1,3}){0,5}|[一二三四五六七八九十百]+[、.．]|第[一二三四五六七八九十百\d]+[章节条款]|附录\s*[A-ZＡ-Ｚ]))\s+(.{1,100})$/
const NUMBERED_HEAD_RE = /^\s*(\d{1,2}(?:\.\d{1,3}){0,5})[、.)）]?\s*(.{1,100})$/
const CHINESE_HEAD_RE = /^\s*([一二三四五六七八九十百]+)[、.．]\s*(.{1,100})$/
const CN_SECTION_HEAD_RE = /^\s*(第[一二三四五六七八九十百\d]+[章节条款])\s*(.{1,100})$/

function normalizeText(rawText: string): string {
  return rawText
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseHeading(line: string): { clauseNo: string; title: string } | null {
  const numbered = line.match(NUMBERED_HEAD_RE)
  if (numbered) return { clauseNo: numbered[1], title: numbered[2].trim() }
  const chinese = line.match(CHINESE_HEAD_RE)
  if (chinese) return { clauseNo: chinese[1], title: chinese[2].trim() }
  const cnSection = line.match(CN_SECTION_HEAD_RE)
  if (cnSection) return { clauseNo: cnSection[1], title: cnSection[2].trim() }
  const match = line.match(CLAUSE_HEAD_RE)
  if (!match) return null
  return { clauseNo: match[1].replace(/[、.．]$/, ''), title: match[2].trim() }
}

function chunkLongText(text: string, maxLen = 1200): ClauseChunk[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    if (!current) {
      current = paragraph
    } else if ((current + '\n\n' + paragraph).length <= maxLen) {
      current += '\n\n' + paragraph
    } else {
      chunks.push(current)
      current = paragraph
    }
  }
  if (current) chunks.push(current)
  return chunks.map((chunk, index) => ({
    clauseNo: '',
    title: `片段 ${index + 1}`,
    text: chunk,
    chunkIndex: index,
  }))
}

export function segmentClausesByRule(rawText: string): ClauseChunk[] {
  const text = normalizeText(rawText)
  if (!text) return []
  const lines = text.split('\n')
  const chunks: Array<Omit<ClauseChunk, 'chunkIndex'>> = []
  let current: Omit<ClauseChunk, 'chunkIndex'> | null = null

  for (const line of lines) {
    if (!line.trim()) continue
    const heading = parseHeading(line)
    if (heading) {
      if (current) chunks.push(current)
      current = {
        clauseNo: heading.clauseNo,
        title: heading.title,
        text: line,
      }
      continue
    }
    if (current) {
      current.text += '\n' + line
    }
  }

  if (current) chunks.push(current)
  if (chunks.length >= 2) {
    return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }))
  }
  return chunkLongText(text)
}

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function buildClauseSegmentPrompt(rawText: string): string {
  return `你是标准条款切分助手。请把下面标准正文切分成条款单元，只返回 JSON 数组，不要输出解释。

每项字段：
- clauseNo: 条款编号，没有则为空字符串
- title: 条款标题，没有则提炼 12 字以内标题
- text: 条款完整原文

标准正文：
${normalizeText(rawText).slice(0, 24000)}`
}

export async function segmentClauses(
  rawText: string,
  options: { aiCaller?: (prompt: string) => Promise<string> } = {},
): Promise<ClauseChunk[]> {
  const ruleChunks = segmentClausesByRule(rawText)
  const normalized = normalizeText(rawText)
  const ruleLooksUseful = ruleChunks.length >= 2 || normalized.length <= 1200
  if (ruleLooksUseful || !options.aiCaller) return ruleChunks

  try {
    const raw = await options.aiCaller(buildClauseSegmentPrompt(rawText))
    const parsed = AiClauseChunksSchema.parse(JSON.parse(stripJsonFence(raw)))
    return parsed.map((chunk, index) => ({
      clauseNo: chunk.clauseNo ?? '',
      title: chunk.title || chunk.clauseNo || `片段 ${index + 1}`,
      text: chunk.text,
      chunkIndex: index,
    }))
  } catch {
    return ruleChunks
  }
}
