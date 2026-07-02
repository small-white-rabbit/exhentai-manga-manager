/**
 * 内容上色：把纯文本转成带内联样式的 HTML。
 * 规则集从 ColorTxt 抽取，支持完整的配色方案：
 * - 引号内文字（对话）
 * - 括号内文字（书名、注释）
 * - 标点符号
 * - 特殊标记
 * - 数字
 * - 英文字母
 */

const escapeHtml = (s) => {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 特殊标记字符
const SPECIAL_MARKERS = /[·•▪*＊✲❈※☆♡♥○●√✔☑×✘☒]/

// 标点符号（不含成对括号开符）
const PUNCTUATION_CLASS = /[,.。!！?？:：;；、）\]\}｝】〗》＞><…—\-]/

// 拉丁字母（含全角拉丁、Latin-1、Latin Extended）
const LATIN_LETTERS_BMP =
  'A-Za-z\\uFF21-\\uFF3A\\uFF41-\\uFF5A' +
  '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF' +
  '\\u0100-\\u017F' +
  '\\u0180-\\u024F'
const LATIN_WORD = new RegExp(`[${LATIN_LETTERS_BMP}]+`)

// 数字（含全角数字）
const NUMBER = /[0-9０-９]+/

// 成对符号定义：[开符, 闭符, type]
// type: 'quote' = 引号（对话）, 'bracket' = 括号（书名）
const PAIRS = [
  ['\u201c', '\u201d', 'quote'],
  ['\u300c', '\u300d', 'quote'],
  ['\u300e', '\u300f', 'quote'],
  ['\u2018', '\u2019', 'quote'],
  ['\u2018', "'", 'quote'],
  ['\u300a', '\u300b', 'bracket'],
  ['\uff1c', '\uff1e', 'bracket'],
  ['(', ')', 'bracket'],
  ['\uff08', '\uff09', 'bracket'],
  ['[', ']', 'bracket'],
  ['\u3010', '\u3011', 'bracket'],
  ['\u3016', '\u3017', 'bracket'],
  ['{', '}', 'bracket'],
  ['\uff5b', '\uff5d', 'bracket']
]

// 闭符集合（快速查找）
const CLOSE_CHARS = new Set(PAIRS.map(p => p[1]))

// 配色方案
const COLORS = {
  light: {
    quote: '#a31515',
    bracket: '#001080',
    punctuation: '#267f99',
    special: '#f56c6c',
    number: '#795e26',
    english: '#af00db',
    highlight: 'background:#fde68a;padding:0 2px;border-radius:2px;'
  },
  dark: {
    quote: '#ce9178',
    bracket: '#9cdcfe',
    punctuation: '#4ec9b0',
    special: '#f56c6c',
    number: '#dcdcaa',
    english: '#c586c0',
    highlight: 'background:#fde68a;padding:0 2px;border-radius:2px;'
  }
}

/**
 * 获取指定类型的颜色值
 */
const getColor = (type, theme) => {
  const palette = COLORS[theme] || COLORS.light
  return palette[type] || palette.punctuation
}

/**
 * 生成带内联样式的 span
 */
const makeSpan = (text, color, extraStyle = '') => {
  return `<span style="color:${color};${extraStyle}">${escapeHtml(text)}</span>`
}

/**
 * 处理成对符号内的内容
 */
const processDelimited = (text, startIdx, closeChar, type, theme) => {
  const openChar = text[startIdx]
  let depth = 1
  let i = startIdx + 1
  const len = text.length

  while (i < len && depth > 0) {
    const ch = text[i]
    if (ch === closeChar) {
      depth--
      if (depth === 0) {
        const innerText = text.slice(startIdx + 1, i)
        const innerColor = getColor(type, theme)
        const punctColor = getColor('punctuation', theme)
        const openSpan = makeSpan(openChar, punctColor)
        const closeSpan = makeSpan(closeChar, punctColor)
        const innerSpan = `<span style="color:${innerColor}">${colorizeInner(innerText, theme)}</span>`
        return { endIdx: i + 1, html: openSpan + innerSpan + closeSpan }
      }
    } else if (ch === openChar) {
      depth++
    }
    i++
  }

  // 未找到闭符，只处理开符
  const punctColor = getColor('punctuation', theme)
  return {
    endIdx: startIdx + 1,
    html: makeSpan(openChar, punctColor)
  }
}

/**
 * 处理成对符号内部的内容
 */
const colorizeInner = (text, theme) => {
  if (!text) return ''
  const len = text.length
  let result = ''
  let i = 0

  while (i < len) {
    const ch = text[i]

    let foundPair = false
    for (const [open, close, type] of PAIRS) {
      if (ch === open) {
        const { endIdx, html } = processDelimited(text, i, close, type, theme)
        result += html
        i = endIdx
        foundPair = true
        break
      }
    }
    if (foundPair) continue

    if (SPECIAL_MARKERS.test(ch)) {
      result += makeSpan(ch, getColor('special', theme))
      i++
      continue
    }

    if (NUMBER.test(ch)) {
      let numStr = ch
      while (i + 1 < len && NUMBER.test(text[i + 1])) {
        numStr += text[++i]
      }
      result += makeSpan(numStr, getColor('number', theme))
      i++
      continue
    }

    if (LATIN_WORD.test(ch)) {
      let wordStr = ch
      while (i + 1 < len && LATIN_WORD.test(text[i + 1])) {
        wordStr += text[++i]
      }
      result += makeSpan(wordStr, getColor('english', theme))
      i++
      continue
    }

    if (PUNCTUATION_CLASS.test(ch)) {
      result += makeSpan(ch, getColor('punctuation', theme))
      i++
      continue
    }

    if (CLOSE_CHARS.has(ch)) {
      result += makeSpan(ch, getColor('punctuation', theme))
      i++
      continue
    }

    result += escapeHtml(ch)
    i++
  }

  return result
}

const COLORIZE_MAX_CHARS = 500000

/**
 * 主着色函数
 * @param {string} text 纯文本
 * @param {Array<string>} highlightWords 额外高亮词数组
 * @param {string} theme 主题 ('light' 或 'dark')
 * @returns {string} HTML 字符串
 */
const colorize = (text, highlightWords = [], theme = 'light') => {
  if (!text) return ''
  if (text.length > COLORIZE_MAX_CHARS) {
    return escapeHtml(text)
  }

  const len = text.length
  let result = ''
  let i = 0

  while (i < len) {
    const ch = text[i]

    let foundPair = false
    for (const [open, close, type] of PAIRS) {
      if (ch === open) {
        const { endIdx, html } = processDelimited(text, i, close, type, theme)
        result += html
        i = endIdx
        foundPair = true
        break
      }
    }
    if (foundPair) continue

    if (SPECIAL_MARKERS.test(ch)) {
      result += makeSpan(ch, getColor('special', theme))
      i++
      continue
    }

    if (NUMBER.test(ch)) {
      let numStr = ch
      while (i + 1 < len && NUMBER.test(text[i + 1])) {
        numStr += text[++i]
      }
      result += makeSpan(numStr, getColor('number', theme))
      i++
      continue
    }

    if (LATIN_WORD.test(ch)) {
      let wordStr = ch
      while (i + 1 < len && LATIN_WORD.test(text[i + 1])) {
        wordStr += text[++i]
      }
      result += makeSpan(wordStr, getColor('english', theme))
      i++
      continue
    }

    if (PUNCTUATION_CLASS.test(ch)) {
      result += makeSpan(ch, getColor('punctuation', theme))
      i++
      continue
    }

    if (CLOSE_CHARS.has(ch)) {
      result += makeSpan(ch, getColor('punctuation', theme))
      i++
      continue
    }

    result += escapeHtml(ch)
    i++
  }

  // 处理高亮词
  if (highlightWords && highlightWords.length > 0) {
    const hlStyle = COLORS[theme]?.highlight || COLORS.light.highlight
    for (const word of highlightWords) {
      if (!word) continue
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escaped, 'gi')
      result = result.replace(re, match => {
        return `<span style="${hlStyle}">${match}</span>`
      })
    }
  }

  return result
}

export { colorize, colorizeInner, escapeHtml, COLORS }
