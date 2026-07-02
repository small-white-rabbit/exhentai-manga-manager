const LINE_BREAK_RE = /\r\n|\r|\n/g

const CN_NUM = '零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟'

const CHAPTER_MATCH_BUILTIN_MAIN_PATTERN = `^(第\\s*([0-9０-９${CN_NUM}]+)\\s*[章回节卷部篇折集])(?:\\s*[、.．])?\\s*(.+)?$`
const CHAPTER_MATCH_BUILTIN_ALT_PATTERN = `^([卷集部篇折]\\s*[0-9０-９${CN_NUM}]+)(?:\\s*[、.．])?\\s*(.+)?$`

const RE_MAIN = new RegExp(CHAPTER_MATCH_BUILTIN_MAIN_PATTERN)
const RE_ALT = new RegExp(CHAPTER_MATCH_BUILTIN_ALT_PATTERN)
const RE_EN = /^(chapter|section|part|volume|book)\s+([\dIVXLCDMivxlcdm]+)(?:\s+(.+))?$/i
const RE_SPECIAL = /^(楔子|序章|序幕|引子|终章|番外(?:篇)?\s*\d*|后记|尾声|外传|幕间)(?:\s+(.+))?$/

function matchToTitle(match) {
  const g1 = (match[1] ?? '').trim()
  const g3 = (match[3] ?? '').trim()
  if (g1 && g3) return `${g1} ${g3}`.trim()
  if (g1) return g1.trim()
  return (match[0] ?? '').trim() || null
}

export function detectChapterTitle(line) {
  const s = line
  let m = s.match(RE_MAIN)
  if (m) return matchToTitle(m)
  m = s.match(RE_ALT)
  if (m) return matchToTitle(m)
  m = s.match(RE_EN)
  if (m) return matchToTitle(m)
  m = s.match(RE_SPECIAL)
  if (m) return matchToTitle(m)
  return null
}

const FULL_WIDTH_INDENT_TWO = '\u3000\u3000'

function applyLeadIndentFullWidth(line) {
  let i = 0
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++
  if (i === line.length) return line
  return FULL_WIDTH_INDENT_TWO + line.slice(i)
}

function isBlankFast(line, len) {
  for (let i = 0; i < len; i++) {
    const c = line.charCodeAt(i)
    if (c !== 32 && c !== 9 && c !== 160 && c !== 12288) return false
  }
  return true
}

const BATCH_SIZE = 20000

export async function formatPhysicalLinesForReader(physicalLines, options, onProgress) {
  const compressBlankLines = options.compressBlankLines ?? false
  const compressBlankKeepOneBlank = options.compressBlankKeepOneBlank ?? false
  const leadIndentFullWidth = options.leadIndentFullWidth ?? false
  const minCharCount = options.minCharCount ?? 0
  
  const total = physicalLines.length
  const out = new Array(total * 2)
  const displayLineToPhysical = new Array(total * 2)
  const chapterTitleDisplayLineByPhysical = new Map()
  const chapters = []
  
  let outIdx = 0
  let physicalLine = 0
  let currentChapterIdx = -1
  let lastWasChapterTitle = false
  let lastWasBlank = true
  
  for (let i = 0; i < total; i++) {
    const rawLine = physicalLines[i]
    physicalLine++
    const lineLen = rawLine.length
    
    const isBlankLine = lineLen === 0 || isBlankFast(rawLine, lineLen)
    
    if (isBlankLine) {
      if (!compressBlankLines && !lastWasBlank) {
        out[outIdx] = ''
        displayLineToPhysical[outIdx] = physicalLine
        outIdx++
        lastWasBlank = true
      }
      continue
    }
    
    lastWasBlank = false
    
    const title = detectChapterTitle(rawLine)
    
    if (title) {
      if (currentChapterIdx >= 0 && chapters[currentChapterIdx].charCount < minCharCount) {
        chapters.pop()
        currentChapterIdx--
      }
      
      if (outIdx > 0 && !lastWasChapterTitle) {
        out[outIdx] = ''
        displayLineToPhysical[outIdx] = physicalLine
        outIdx++
      }
      
      out[outIdx] = title
      displayLineToPhysical[outIdx] = physicalLine
      const displayLine = outIdx + 1
      chapterTitleDisplayLineByPhysical.set(physicalLine, displayLine)
      outIdx++
      
      chapters.push({
        title,
        lineNumber: displayLine,
        charCount: 0,
        startOffset: null,
        endOffset: null
      })
      currentChapterIdx = chapters.length - 1
      
      out[outIdx] = ''
      displayLineToPhysical[outIdx] = physicalLine
      outIdx++
      lastWasChapterTitle = true
      continue
    }
    
    let shown = rawLine
    if (leadIndentFullWidth) {
      shown = applyLeadIndentFullWidth(rawLine)
    }
    
    out[outIdx] = shown
    displayLineToPhysical[outIdx] = physicalLine
    outIdx++
    
    if (currentChapterIdx >= 0) {
      chapters[currentChapterIdx].charCount += shown.length
    }
    
    if (compressBlankKeepOneBlank) {
      out[outIdx] = ''
      displayLineToPhysical[outIdx] = physicalLine
      outIdx++
    }
    
    lastWasChapterTitle = false
    
    if (onProgress && (i + 1) % BATCH_SIZE === 0) {
      onProgress(i + 1, total)
      await Promise.resolve()
    }
  }
  
  out.length = outIdx
  displayLineToPhysical.length = outIdx
  
  if (currentChapterIdx >= 0 && chapters[currentChapterIdx].charCount < minCharCount) {
    chapters.pop()
    currentChapterIdx--
  }
  
  const text = out.join('\n')
  const lines = text.split('\n')
  let offset = 0
  
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    ch.startOffset = offset
    for (let j = ch.lineNumber - 1; j < lines.length; j++) {
      offset += lines[j].length + 1
      if (i < chapters.length - 1 && j + 1 === chapters[i + 1].lineNumber) {
        break
      }
    }
    ch.endOffset = offset
  }
  
  if (onProgress) {
    onProgress(total, total)
  }
  
  return {
    text,
    displayLineToPhysicalLine: displayLineToPhysical,
    lineCount: outIdx,
    chapterTitleDisplayLineByPhysical,
    chapters
  }
}

export function formatPhysicalLinesForReaderSync(physicalLines, options) {
  const compressBlankLines = options.compressBlankLines ?? false
  const compressBlankKeepOneBlank = options.compressBlankKeepOneBlank ?? false
  const leadIndentFullWidth = options.leadIndentFullWidth ?? false
  const minCharCount = options.minCharCount ?? 0
  
  const total = physicalLines.length
  const out = new Array(total * 2)
  const displayLineToPhysical = new Array(total * 2)
  const chapterTitleDisplayLineByPhysical = new Map()
  const chapters = []
  
  let outIdx = 0
  let physicalLine = 0
  let currentChapterIdx = -1
  let lastWasChapterTitle = false
  let lastWasBlank = true
  
  for (let i = 0; i < total; i++) {
    const rawLine = physicalLines[i]
    physicalLine++
    const lineLen = rawLine.length
    
    const isBlankLine = lineLen === 0 || isBlankFast(rawLine, lineLen)
    
    if (isBlankLine) {
      if (!compressBlankLines && !lastWasBlank) {
        out[outIdx] = ''
        displayLineToPhysical[outIdx] = physicalLine
        outIdx++
        lastWasBlank = true
      }
      continue
    }
    
    lastWasBlank = false
    
    const title = detectChapterTitle(rawLine)
    
    if (title) {
      if (currentChapterIdx >= 0 && chapters[currentChapterIdx].charCount < minCharCount) {
        chapters.pop()
        currentChapterIdx--
      }
      
      if (outIdx > 0 && !lastWasChapterTitle) {
        out[outIdx] = ''
        displayLineToPhysical[outIdx] = physicalLine
        outIdx++
      }
      
      out[outIdx] = title
      displayLineToPhysical[outIdx] = physicalLine
      const displayLine = outIdx + 1
      chapterTitleDisplayLineByPhysical.set(physicalLine, displayLine)
      outIdx++
      
      chapters.push({
        title,
        lineNumber: displayLine,
        charCount: 0,
        startOffset: null,
        endOffset: null
      })
      currentChapterIdx = chapters.length - 1
      
      out[outIdx] = ''
      displayLineToPhysical[outIdx] = physicalLine
      outIdx++
      lastWasChapterTitle = true
      continue
    }
    
    let shown = rawLine
    if (leadIndentFullWidth) {
      shown = applyLeadIndentFullWidth(rawLine)
    }
    
    out[outIdx] = shown
    displayLineToPhysical[outIdx] = physicalLine
    outIdx++
    
    if (currentChapterIdx >= 0) {
      chapters[currentChapterIdx].charCount += shown.length
    }
    
    if (compressBlankKeepOneBlank) {
      out[outIdx] = ''
      displayLineToPhysical[outIdx] = physicalLine
      outIdx++
    }
    
    lastWasChapterTitle = false
  }
  
  out.length = outIdx
  displayLineToPhysical.length = outIdx
  
  if (currentChapterIdx >= 0 && chapters[currentChapterIdx].charCount < minCharCount) {
    chapters.pop()
    currentChapterIdx--
  }
  
  const text = out.join('\n')
  const lines = text.split('\n')
  let offset = 0
  
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    ch.startOffset = offset
    for (let j = ch.lineNumber - 1; j < lines.length; j++) {
      offset += lines[j].length + 1
      if (i < chapters.length - 1 && j + 1 === chapters[i + 1].lineNumber) {
        break
      }
    }
    ch.endOffset = offset
  }
  
  return {
    text,
    displayLineToPhysicalLine: displayLineToPhysical,
    lineCount: outIdx,
    chapterTitleDisplayLineByPhysical,
    chapters
  }
}

export function applyTextColorize(line, options) {
  const { highlightWords = [], colorizeQuote = true, colorizeNumber = true, colorizeEllipsis = true, colorizeDash = true } = options || {}
  
  let result = line
  
  if (colorizeQuote) {
    result = result.replace(/[“]([^”]+)[”]/g, '<span style="color:#c0392b">“$1”</span>')
    result = result.replace(/[‘]([^’]+)[’]/g, '<span style="color:#8e44ad">‘$1’</span>')
  }
  
  if (colorizeNumber) {
    result = result.replace(/([0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+)/g, 
      '<span style="color:#2980b9;font-weight:600">$1</span>')
  }
  
  if (colorizeEllipsis) {
    result = result.replace(/(\.\.\.|……|…)/g, '<span style="color:#7f8c8d">$1</span>')
  }
  
  if (colorizeDash) {
    result = result.replace(/(——|———)/g, '<span style="color:#16a085">$1</span>')
  }
  
  if (highlightWords && highlightWords.length > 0) {
    for (const word of highlightWords) {
      if (!word) continue
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(escaped, 'g'), 
        `<span style="background-color:rgba(241, 196, 15, 0.25)">${word}</span>`)
    }
  }
  
  return result
}
