import { pyApi, nodeApi } from './client'

export interface Standard {
  code: string
  name: string
  status: string
  type_tags?: string[]
  pub_date?: string
  impl_date?: string
  obsolete_date?: string
  is_mandatory?: boolean
  // 分类
  ics?: string
  ics_name?: string
  ccs?: string
  ccs_name?: string
  // 来源
  source?: string
  publisher?: string
  issuing_dept?: string
  tc_committee?: string
  drafting_org?: string
  // 标准关系
  replaces?: string
  adopted_intl?: string
  // 国际化
  name_en?: string
  // 其他
  pages?: number
  // 命中类型（engine.py 返回）
  match_type?: 'code_match' | 'fts_match' | 'name_match'
}

export interface SearchResult {
  items: Standard[]
  total: number
  status_counts?: Record<string, number>
  categories?: Record<string, number>
}

/** Python API — 海量标准元数据检索 */
export async function searchStandards(params: {
  q: string
  category?: string
  status?: string
  page?: number
  page_size?: number
  /** 排序: "" | "impl_date_desc" | "impl_date_asc" */
  sort_by?: string
}): Promise<SearchResult> {
  return pyApi.get('/api/v1/standards', { params })
}

/** Python API — quick search (autocomplete, limit results) */
export async function quickSearch(q: string, limit = 6, sort_by = '') {
  return pyApi.get('/api/v1/search', { params: { q, limit, sort_by } })
}

/** Python API — standard detail */
export async function getStandardDetail(code: string) {
  return pyApi.get('/api/v1/standard-detail', { params: { code } })
}

/** Python API — standard relations (graph) */
export async function getStandardRelations(code: string) {
  return pyApi.get(`/api/v1/standard/${encodeURIComponent(code)}/relations`)
}

/** Python API — outline generation */
export async function generateOutline(description: string, standardType?: string) {
  return pyApi.post('/api/v1/outline', { description, standard_type: standardType })
}

/** Python API — technical committees */
export async function getTechnicalCommittees(params: { page?: number; page_size?: number; q?: string }) {
  return pyApi.get('/api/v1/tc', { params })
}

/** Python API — industry standards */
export async function getIndustryStandards(q: string) {
  return pyApi.get('/api/v1/industry-standards', { params: { q } })
}

/** Node.js admin — standards CRUD */
export async function adminListStandards() {
  return nodeApi.get('/api/admin/standards')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function adminCreateStandard(data: any) {
  return nodeApi.post('/api/admin/standards', data)
}

export async function adminGetStandardContent(id: string) {
  return nodeApi.get(`/api/admin/standards/${id}/content`)
}
