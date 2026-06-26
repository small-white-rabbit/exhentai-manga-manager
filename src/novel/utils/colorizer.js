/**
 * 内容上色：把纯文本转成带 <span class="..."> 的 HTML。
 * 规则集从 ColorTxt 抽取，简化为几类常见模式。
 * 调用方负责 CSS（每条规则对应一个 class）。
 */

const RULES = [
  // 中文引号内容
  { name: 'quote-cn', pattern: /“([^”]{1,200})”/g, className: 'cl-quote' },
  // 单引号内容
  { name: 'quote-single', pattern: /‘([^’]{1,200})’/g, className: 'cl-quote-single' },
  // 数字（含小数、百分号）
  { name: 'number', pattern: /\b\d+(?:\.\d+)?%?\b/g, className: 'cl-number' },
  // 省略号
  { name: 'ellipsis', pattern: /……|\.\.\./g, className: 'cl-ellipsis' },
  // 破折号
  { name: 'dash', pattern: /——|--/g, className: 'cl-dash' }
]

/**
 * 转义 HTML 特殊字符。
 */
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 把文本上色为 HTML。
 * @param {string} text 纯文本
 * @param {Array<string>} highlightWords 额外高亮词数组
 * @returns {string} HTML 字符串
 */
const colorize = (text, highlightWords = []) => {
  // 先收集所有匹配区间 [{start, end, className}]
  const ranges = []

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    let m
    while ((m = rule.pattern.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, className: rule.className })
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++
    }
  }

  // 高亮词
  for (const word of highlightWords) {
    if (!word) continue
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'g')
    let m
    while ((m = re.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, className: 'cl-highlight' })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  // 区间可能有重叠，按 start 排序，重叠的保留先出现的
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  let lastEnd = -1
  for (const r of ranges) {
    if (r.start >= lastEnd) {
      merged.push(r)
      lastEnd = r.end
    }
  }

  // 拼接 HTML
  let result = ''
  let cursor = 0
  for (const r of merged) {
    result += escapeHtml(text.slice(cursor, r.start))
    result += `<span class="${r.className}">${escapeHtml(text.slice(r.start, r.end))}</span>`
    cursor = r.end
  }
  result += escapeHtml(text.slice(cursor))
  return result
}

module.exports = { RULES, colorize, escapeHtml }
