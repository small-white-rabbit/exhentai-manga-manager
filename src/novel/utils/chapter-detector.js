const CN_NUM = '零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟'

const DEFAULT_RULES = [
  {
    name: 'cn-chapter',
    pattern: new RegExp(`^\\s*第\\s*[0-9０-９${CN_NUM}\\s]+\\s*[章回节卷集部篇折]\\s*.{0,60}$`, 'gmu')
  },
  {
    name: 'cn-chapter-decorated',
    pattern: new RegExp(`^\\s*[【\\[（(《「『]?\\s*第\\s*[0-9０-９${CN_NUM}\\s]+\\s*[章回节卷集部篇折]\\s*[】\\]）)》」』]?\\s*.{0,60}$`, 'gmu')
  },
  {
    name: 'cn-volume',
    pattern: new RegExp(`^\\s*(正文\\s*)?(卷|集|部|篇)\\s*[0-9０-９${CN_NUM}]+\\s*.{0,60}$`, 'gmu')
  },
  {
    name: 'en-chapter',
    pattern: /^\s*(chapter|section|part|volume|book)\s+[\dIVXLCDMivxlcdm]+\b.{0,60}$/gimu
  },
  {
    name: 'special',
    pattern: /^\s*(楔子|序章|序幕|引子|终章|番外(?:篇)?\s*\d*|后记|尾声|外传|幕间)\s*.{0,60}$/gmu
  },
  {
    name: 'numeric',
    pattern: /^\s*(\d{1,6}|[０-９]{1,6})\s*$/gmu
  }
]

const PREFACE_RE = /^(序|序言|前言|自序|原序|题序|小序|总序|代序|译序|后序|绪论|绪言|题记|附录|目录|版权|封面|插图|人物介绍|登场人物)\s*.{0,40}$/u

const isPrefaceTitle = (title) => {
  const t = String(title || '').trim()
  return t.length > 0 && PREFACE_RE.test(t)
}

const detectChapters = (text, rules = DEFAULT_RULES) => {
  const source = String(text || '')
  const matches = []

  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri]
    rule.pattern.lastIndex = 0
    let m
    while ((m = rule.pattern.exec(source)) !== null) {
      const title = m[0].trim()
      if (title && !isPrefaceTitle(title)) {
        matches.push({ ruleIndex: ri, title, charOffset: m.index })
      }
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++
    }
  }

  matches.sort((a, b) => a.charOffset - b.charOffset || a.ruleIndex - b.ruleIndex)

  const deduped = []
  let lastOffset = -1
  for (const match of matches) {
    if (match.charOffset === lastOffset) continue
    deduped.push(match)
    lastOffset = match.charOffset
  }

  if (deduped.length === 0) {
    return [{
      title: '全文',
      startOffset: 0,
      endOffset: source.length,
      charCount: source.length
    }]
  }

  return deduped.map((cur, i) => {
    const nextOffset = i + 1 < deduped.length ? deduped[i + 1].charOffset : source.length
    const titleEnd = cur.charOffset + cur.title.length
    return {
      title: cur.title,
      startOffset: titleEnd,
      endOffset: nextOffset,
      charCount: Math.max(0, nextOffset - titleEnd)
    }
  })
}

module.exports = { DEFAULT_RULES, detectChapters, isPrefaceTitle }
