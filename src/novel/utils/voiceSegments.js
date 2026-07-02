// 语音朗读：旁白/对白分段（移植自 ColorTxt voiceReadSegments.ts）
// 将一行文本按启用的引号对切分为 narration/dialogue 段

export const VOICE_QUOTE_PAIRS = [
  { style: 'double', open: '\u201C', close: '\u201D', label: '""' },
  { style: 'single', open: '\u2018', close: '\u2019', label: "''" },
  { style: 'corner', open: '\u300C', close: '\u300D', label: '「」' },
  { style: 'doubleCorner', open: '\u300E', close: '\u300F', label: '『』' }
]

export const DEFAULT_QUOTE_STYLES = ['double', 'single', 'corner', 'doubleCorner']

function enabledPairs (quoteStyles) {
  const set = new Set(quoteStyles)
  return VOICE_QUOTE_PAIRS.filter(p => set.has(p.style))
}

function tryMatchOpen (text, pos, pairs) {
  for (const pair of pairs) {
    if (text.startsWith(pair.open, pos)) {
      return { pair, next: pos + pair.open.length }
    }
  }
  return null
}

// 将一行文本切分为 narration/dialogue 段
// 返回 [{ kind: 'narration'|'dialogue', text, quoteOpen?, quoteClose? }]
export function parseVoiceSegments (line, quoteStyles = DEFAULT_QUOTE_STYLES) {
  const pairs = enabledPairs(quoteStyles)
  const segments = []

  const pushSegment = (kind, text, quote) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) {
      last.text += text
      if (kind === 'dialogue' && quote) {
        last.quoteOpen = quote.open
        last.quoteClose = quote.close
      }
    } else {
      segments.push({
        kind,
        text,
        ...(kind === 'dialogue' && quote ? { quoteOpen: quote.open, quoteClose: quote.close } : {})
      })
    }
  }

  if (pairs.length === 0) {
    pushSegment('narration', line)
    return segments
  }

  let pos = 0
  let inDialogue = false
  let activePair = null

  while (pos < line.length) {
    if (inDialogue && activePair) {
      const closeIdx = line.indexOf(activePair.close, pos)
      if (closeIdx < 0) {
        pushSegment('dialogue', line.slice(pos), { open: activePair.open, close: activePair.close })
        return segments
      }
      pushSegment('dialogue', line.slice(pos, closeIdx), { open: activePair.open, close: activePair.close })
      pos = closeIdx + activePair.close.length
      inDialogue = false
      activePair = null
      continue
    }
    const openHit = tryMatchOpen(line, pos, pairs)
    if (openHit) {
      inDialogue = true
      activePair = openHit.pair
      pos = openHit.next
      continue
    }
    let nextSpecial = line.length
    for (const pair of pairs) {
      const idx = line.indexOf(pair.open, pos)
      if (idx >= 0 && idx < nextSpecial) nextSpecial = idx
    }
    if (nextSpecial > pos) {
      pushSegment('narration', line.slice(pos, nextSpecial))
    }
    pos = nextSpecial
  }

  return segments
}

// 把文本切成适合 TTS 合成的小块（按句号/问号/感叹号/分号，每块不超过 maxLen 字）
// 跳过纯空白块，避免朗读时出现停顿
export function splitTTSChunks (text, maxLen = 200) {
  const parts = text.replace(/\s+/g, ' ').split(/(?<=[。！？!?\n；;])/)
  const chunks = []
  let buf = ''
  const flush = () => {
    const trimmed = buf.trim()
    if (trimmed && /[\p{L}\p{N}\u4e00-\u9fff]/u.test(trimmed)) {
      chunks.push(trimmed)
    }
    buf = ''
  }
  for (const p of parts) {
    if ((buf + p).length > maxLen) {
      flush()
      buf = p
    } else {
      buf += p
    }
  }
  flush()
  return chunks
}

// 判断文本是否有可朗读内容
export function hasSpeakableText (text) {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (!t) return false
  return /[\p{L}\p{N}\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/u.test(t)
}
