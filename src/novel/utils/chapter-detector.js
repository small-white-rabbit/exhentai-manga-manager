/**
 * 章节识别规则集（从 ColorTxt 抽取，纯函数无副作用）。
 * 每条规则：{ name, pattern (RegExp, g+m), }
 * 匹配到的行作为章节标题，章节正文 = 该行末到下一匹配行首。
 */

const DEFAULT_RULES = [
  // 第X章 / 第X回 / 第X节
  { name: 'cn-chapter', pattern: /^\s*第[\s\d一二三四五六七八九十百千零〇两\s]+[章回节卷集部篇]\s*.{0,40}$/gm },
  // Chapter X
  { name: 'en-chapter', pattern: /^\s*Chapter\s+[\dIVXLCDM]+\s*.{0,40}$/gim },
  // 第X章（带书名号等装饰）
  { name: 'cn-chapter-decorated', pattern: /^\s*[【《〈「『]?\s*第[\s\d一二三四五六七八九十百千零〇两\s]+[章回节卷集部篇]\s*[】》〉」』]?\s*.{0,40}$/gm },
  // 序章 / 楔子 / 引子 / 尾声 / 后记 / 番外
  { name: 'cn-special', pattern: /^\s*(序章|楔子|引子|尾声|终章|后记|番外篇?\s*\d*)\s*.{0,40}$/gm },
  // 纯数字标题行（独立成行，2-6 位数字）
  { name: 'numeric', pattern: /^\s*(\d{1,6})\s*$/gm }
]

/**
 * 用给定规则集从文本中识别章节。
 * @param {string} text 全文
 * @param {Array} rules 规则数组，默认 DEFAULT_RULES
 * @returns {Array<{title: string, startOffset: number, endOffset: number, charCount: number}>}
 *          startOffset/endOffset 是字符偏移（非字节），调用方需自行换算
 */
const detectChapters = (text, rules = DEFAULT_RULES) => {
  const matches = [] // {ruleIndex, title, charOffset}

  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri]
    rule.pattern.lastIndex = 0
    let m
    while ((m = rule.pattern.exec(text)) !== null) {
      // 取匹配到的整行（去掉首尾空白）作为标题
      const title = m[0].trim()
      matches.push({ ruleIndex: ri, title, charOffset: m.index })
      // 防止零宽匹配死循环
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++
    }
  }

  // 按字符偏移排序
  matches.sort((a, b) => a.charOffset - b.charOffset)

  // 去重：同一位置多个规则命中，只保留第一个（优先级高的规则在前）
  const deduped = []
  let lastOffset = -1
  for (const mt of matches) {
    if (mt.charOffset !== lastOffset) {
      deduped.push(mt)
      lastOffset = mt.charOffset
    }
  }

  // 构造章节列表
  const chapters = []
  if (deduped.length === 0) {
    // 无章节识别：整篇作为一章
    chapters.push({
      title: '全文',
      startOffset: 0,
      endOffset: text.length,
      charCount: text.length
    })
    return chapters
  }

  if (deduped[0].charOffset > 0) {
    // 开头有序言
    const end = deduped[0].charOffset
    chapters.push({
      title: '序言',
      startOffset: 0,
      endOffset: end,
      charCount: end
    })
  }

  for (let i = 0; i < deduped.length; i++) {
    const cur = deduped[i]
    const nextOffset = i + 1 < deduped.length ? deduped[i + 1].charOffset : text.length
    // 章节正文从标题行末开始
    const titleEnd = cur.charOffset + cur.title.length
    chapters.push({
      title: cur.title,
      startOffset: titleEnd,
      endOffset: nextOffset,
      charCount: nextOffset - titleEnd
    })
  }

  return chapters
}

module.exports = { DEFAULT_RULES, detectChapters }
