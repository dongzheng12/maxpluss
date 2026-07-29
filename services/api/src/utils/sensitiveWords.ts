/**
 * 销售 bio 敏感词过滤
 *
 * 范围：政治敏感 / 色情低俗 / 违禁品 / 常见标准行业竞品品牌
 * 策略：检测即拒绝（不做替换），用户自行修改
 *
 * 维护：新增词直接往 SENSITIVE_WORDS 里加。词库按类别分段，便于审阅。
 * 注：政治敏感类按当前合规口径保守处理，避免销售推广页出现政治话题。
 */

const POLITICAL = [
  // 避免销售页出现政治评论
  '共产党', '中共', '反共', '反华', '台独', '港独', '藏独', '疆独',
  '政府打压', '政府监控', '一党专政', '民主自由', '翻墙', 'VPN',
  '敏感词', '政治风险',
  // 补充（2026-04-25 测试发现漏拦）
  '法轮功', '六四', '天安门事件', '文革', '习近平', '独立宣言',
]

const ADULT = [
  '色情', '成人', '黄色', '黄片', '约炮', '一夜情', '嫖娼',
  '卖淫', '陪睡', '援交', '情色', 'porn',
  // 补充
  '三级片', '裸聊', '小姐服务', '上门服务',
  // 移除：'AV' 误拦 AVG/average 等英文缩写（子串匹配过泛）
]

const ILLEGAL = [
  '毒品', '大麻', '冰毒', '海洛因', '吸毒', '贩毒',
  '赌博', '博彩', '六合彩', '赌场', '网赌',
  '枪支', '弹药', '炸药', '爆炸物',
  '伪造证件', '代开发票', '虚开发票',
  '高利贷', '非法集资', '传销', '洗钱',
  // 补充
  '代孕', '办假证', '假文凭', '假学历', '私彩',
]

// 标准行业常见竞品品牌（销售推广自己的产品时不得提及竞品名拉踩）
const COMPETITORS = [
  '标准全文服务', '工标网', '国家标准全文公开', '标准云', 'SAC查询',
  '中国标准服务网', '标准天地', '标准视界',
]

const OFFENSIVE = [
  // 辱骂/人身攻击——避免销售页出现攻击性语言
  '傻逼', '狗屎', '操你', '草泥马',
  // 移除：'妈的' 误拦"妈妈的"；'sb' 误拦 SBOM/USB 等英文缩写
]

const SCAM = [
  // 常见诈骗话术，规避销售页被当做诈骗素材
  '保证赚钱', '稳赚不赔', '零风险', '日入过万', '月入百万',
  '躺赚', '免费送钱', '一夜暴富',
  // 补充
  '杀猪盘', '刷单返利', '兼职刷单',
]

/** 全部敏感词（原始） */
const ALL_RAW: readonly string[] = [
  ...POLITICAL, ...ADULT, ...ILLEGAL, ...COMPETITORS, ...OFFENSIVE, ...SCAM,
]

/** 预处理：小写去重，便于检查时也小写比对（中文不受影响） */
const SENSITIVE_WORDS: string[] = Array.from(new Set(ALL_RAW.map(w => w.toLowerCase().trim()).filter(Boolean)))

import { detectUnsafeContent } from '../services/contentSafety.js'

/**
 * 检测文本是否命中敏感词
 *
 * 双层防线：
 *   1. 第三方词库（fwwdn/sensitive-stop-words，Apache 2.0）—— 政治/色情/涉枪涉爆
 *   2. 本文件 90 词小词库 —— 竞品/辱骂/诈骗等销售场景特化
 *
 * @param text 待检测文本（bio/个人介绍/公司名等）
 * @returns 命中返回命中的词；未命中返回 null
 */
export function detectSensitiveWord(text: string | null | undefined): string | null {
  if (!text || typeof text !== 'string') return null
  const safetyHit = detectUnsafeContent(text)
  if (safetyHit) return safetyHit.hit
  const lower = text.toLowerCase()
  for (const w of SENSITIVE_WORDS) {
    if (lower.includes(w)) return w
  }
  return null
}

export const SENSITIVE_WORDS_COUNT = SENSITIVE_WORDS.length
