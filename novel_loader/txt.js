const fs = require('fs')
const iconv = require('iconv-lite')

const SAMPLE_BYTES = 64 * 1024

const normalizeEncoding = (encoding) => {
  const u = String(encoding || 'UTF-8').trim().toLowerCase().replace(/\s+/g, '').replace(/_/g, '-')
  if (!u) return 'utf8'
  if (u === 'utf-8' || u === 'utf8') return 'utf8'
  if (u === 'gb2312' || u === 'gbk' || u === 'gb-2312') return 'gb18030'
  if (u === 'utf-16le' || u === 'utf-16-le') return 'utf16le'
  if (u === 'utf-16be' || u === 'utf-16-be') return 'utf16be'
  return String(encoding || 'UTF-8').trim()
}

const encodingFromBom = (sample) => {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'utf8'
  }
  if (sample.length >= 2) {
    if (sample[0] === 0xff && sample[1] === 0xfe) return 'utf16le'
    if (sample[0] === 0xfe && sample[1] === 0xff) return 'utf16be'
  }
  return null
}

const isAsciiOnly = (sample) => {
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] >= 0x80) return false
  }
  return true
}

const isValidUtf8 = (sample) => {
  let i = 0
  const len = sample.length
  while (i < len) {
    const b = sample[i]
    if (b < 0x80) {
      i++
    } else if (b < 0xc0) {
      return false
    } else if (b < 0xe0) {
      if (i + 1 >= len) return false
      const b1 = sample[i + 1]
      if ((b1 & 0xc0) !== 0x80) return false
      if (b < 0xc2) return false
      i += 2
    } else if (b < 0xf0) {
      if (i + 2 >= len) return false
      const b1 = sample[i + 1]
      const b2 = sample[i + 2]
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return false
      if (b === 0xe0 && b1 < 0xa0) return false
      if (b === 0xed && b1 >= 0xa0) return false
      i += 3
    } else if (b < 0xf5) {
      if (i + 3 >= len) return false
      const b1 = sample[i + 1]
      const b2 = sample[i + 2]
      const b3 = sample[i + 3]
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return false
      if (b === 0xf0 && b1 < 0x90) return false
      if (b === 0xf4 && b1 >= 0x90) return false
      i += 4
    } else {
      return false
    }
  }
  return true
}

const isGbkLead = (byte) => byte >= 0x81 && byte <= 0xfe
const isGbkTrail = (byte) => (byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfe)

const looksLikeGbkFamily = (sample) => {
  let i = 0
  let hasHighByte = false
  while (i < sample.length) {
    const b = sample[i]
    if (b < 0x80) {
      i++
      continue
    }
    hasHighByte = true
    if (!isGbkLead(b)) return false
    if (i + 1 >= sample.length) return true
    if (!isGbkTrail(sample[i + 1])) return false
    i += 2
  }
  return hasHighByte
}

const countUtf8LikeSequences = (sample) => {
  let count = 0
  let i = 0
  while (i < sample.length) {
    const b = sample[i]
    if (b >= 0xc0 && b < 0xf5) {
      let seqLen = 1
      if (b < 0xe0) seqLen = 2
      else if (b < 0xf0) seqLen = 3
      else seqLen = 4
      let valid = true
      for (let j = 1; j < seqLen && i + j < sample.length; j++) {
        if ((sample[i + j] & 0xc0) !== 0x80) { valid = false; break }
      }
      if (valid && i + seqLen <= sample.length) count++
      i += seqLen
    } else {
      i++
    }
  }
  return count
}

const scoreDecodedText = (text) => {
  if (!text || text.length === 0) return { score: 0, chineseRatio: 0, invalidRatio: 0 }
  let chineseCount = 0
  let invalidCount = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0xfffd) {
      invalidCount++
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      chineseCount++
    }
  }
  const chineseRatio = chineseCount / text.length
  const invalidRatio = invalidCount / text.length
  let score = 0
  if (invalidRatio < 0.01) score += 50
  else if (invalidRatio < 0.05) score += 25
  else if (invalidRatio < 0.1) score += 10
  if (chineseRatio > 0.3) score += 30
  else if (chineseRatio > 0.15) score += 20
  else if (chineseRatio > 0.05) score += 10
  if (invalidRatio < 0.05 && chineseRatio > 0.2) score += 20
  return { score, chineseRatio, invalidRatio }
}

const detectEncodingFromSample = (sample) => {
  if (sample.length === 0) return 'utf8'

  const bom = encodingFromBom(sample)
  if (bom) return bom
  if (isAsciiOnly(sample)) return 'utf8'

  const utf8Valid = isValidUtf8(sample)
  const gbkValid = looksLikeGbkFamily(sample)

  if (utf8Valid && !gbkValid) return 'utf8'
  if (!utf8Valid && gbkValid) return 'gb18030'

  try {
    const utf8Text = iconv.decode(sample, 'utf8')
    const gbkText = iconv.decode(sample, 'gb18030')
    const utf8Score = scoreDecodedText(utf8Text)
    const gbkScore = scoreDecodedText(gbkText)

    if (utf8Score.score > gbkScore.score + 10) return 'utf8'
    if (gbkScore.score > utf8Score.score + 10) return 'gb18030'

    if (utf8Valid && utf8Score.invalidRatio < 0.001) return 'utf8'
    if (gbkScore.invalidRatio < 0.001 && gbkScore.chineseRatio > 0.1) return 'gb18030'

    return utf8Score.score >= gbkScore.score ? 'utf8' : 'gb18030'
  } catch (e) {
    if (utf8Valid) return 'utf8'
    if (gbkValid) return 'gb18030'
    return 'gb18030'
  }
}

const detectEncoding = async (filepath) => {
  const fd = await fs.promises.open(filepath, 'r')
  try {
    const buf = Buffer.alloc(SAMPLE_BYTES)
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
    if (bytesRead === 0) return 'utf8'
    return detectEncodingFromSample(buf.slice(0, bytesRead))
  } finally {
    await fd.close()
  }
}

const readBufferRange = async (filepath, startOffset = 0, endOffset = null) => {
  if (startOffset <= 0 && endOffset == null) return fs.promises.readFile(filepath)
  const stat = await fs.promises.stat(filepath)
  const start = Math.max(0, Math.min(Number(startOffset) || 0, stat.size))
  const end = endOffset == null ? stat.size : Math.max(start, Math.min(Number(endOffset) || stat.size, stat.size))
  const length = end - start
  const fd = await fs.promises.open(filepath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fd.read(buf, 0, length, start)
    return buf
  } finally {
    await fd.close()
  }
}

const decodeBuffer = (buffer, encoding) => iconv.decode(buffer, normalizeEncoding(encoding))

const readRange = async (filepath, startOffset, endOffset, encoding) => {
  const buffer = await readBufferRange(filepath, startOffset, endOffset)
  return decodeBuffer(buffer, encoding)
}

const readFull = async (filepath) => {
  const encoding = await detectEncoding(filepath)
  const buffer = await fs.promises.readFile(filepath)
  const text = decodeBuffer(buffer, encoding)
  return { text, encoding, buffer }
}

const readFullBuffer = async (filepath, preferredEncoding) => {
  let encoding = preferredEncoding
  if (!encoding) {
    encoding = await detectEncoding(filepath)
  }
  const buffer = await fs.promises.readFile(filepath)
  return { buffer, encoding }
}

const createLineSplitter = () => {
  let buf = ''
  return {
    reset() { buf = '' },
    push(chunk) {
      buf += chunk
      const out = []
      let lineStart = 0
      let i = 0
      while (i < buf.length) {
        const c = buf[i]
        if (c === '\r') {
          if (i + 1 < buf.length && buf[i + 1] === '\n') {
            out.push(buf.slice(lineStart, i))
            i += 2
            lineStart = i
          } else if (i + 1 >= buf.length) {
            buf = buf.slice(lineStart)
            return out
          } else {
            out.push(buf.slice(lineStart, i))
            i += 1
            lineStart = i
          }
        } else if (c === '\n') {
          out.push(buf.slice(lineStart, i))
          i += 1
          lineStart = i
        } else {
          i += 1
        }
      }
      buf = buf.slice(lineStart)
      return out
    },
    flushEof() {
      if (!buf) return null
      const last = buf
      buf = ''
      return last
    }
  }
}

const CHUNK_SIZE = 64 * 1024

const readTxtStream = async (filepath, onLine, onProgress) => {
  const encoding = await detectEncoding(filepath)
  const stat = await fs.promises.stat(filepath)
  const totalSize = stat.size
  let bytesRead = 0

  const fd = await fs.promises.open(filepath, 'r')
  try {
    const lineSplitter = createLineSplitter()
    let chunkBuf = Buffer.alloc(CHUNK_SIZE)

    while (true) {
      const { bytesRead: read } = await fd.read(chunkBuf, 0, CHUNK_SIZE, bytesRead)
      if (read === 0) break

      bytesRead += read
      const chunk = decodeBuffer(chunkBuf.slice(0, read), encoding)
      const lines = lineSplitter.push(chunk)

      for (const line of lines) {
        if (onLine(line) === false) return encoding
      }

      if (onProgress) {
        onProgress(Math.min(100, (bytesRead / totalSize) * 100))
      }
    }

    const tail = lineSplitter.flushEof()
    if (tail != null) {
      onLine(tail)
    }

    return encoding
  } finally {
    await fd.close()
  }
}

const utf8ByteOffsetAtCharOffset = (text, charOffset) => {
  const end = Math.max(0, Math.min(Number(charOffset) || 0, text.length))
  return Buffer.byteLength(text.slice(0, end), 'utf8')
}

const byteOffsetAtCharOffset = (text, charOffset, encoding) => {
  const end = Math.max(0, Math.min(Number(charOffset) || 0, text.length))
  const enc = normalizeEncoding(encoding)
  if (enc.toUpperCase() === 'UTF-8') return utf8ByteOffsetAtCharOffset(text, end)
  return iconv.encode(text.slice(0, end), enc).length
}

module.exports = {
  detectEncoding,
  normalizeEncoding,
  readRange,
  readFull,
  readFullBuffer,
  readTxtStream,
  createLineSplitter,
  byteOffsetAtCharOffset,
  decodeBuffer
}
