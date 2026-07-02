// Edge TTS 合成模块（移植自 ColorTxt src/main/voiceReadEdgeTts.ts）
// 通过 WebSocket 连接微软 Bing 读 aloud 服务，返回 MP3 ArrayBuffer
const { createHash, randomBytes } = require('node:crypto')
const WebSocket = require('ws')

const EDGE_SPEECH_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const EDGE_API_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR_VERSION = '143'

const WIN_EPOCH_OFFSET = 11644473600n
const S_TO_NS = 1000000000n

function sleepMs (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function sha256HexUpper (input) {
  return createHash('sha256').update(input, 'utf8').digest('hex').toUpperCase()
}

async function generateSecMsGec () {
  let ticks = BigInt(Math.floor(Date.now() / 1000))
  ticks += WIN_EPOCH_OFFSET
  ticks -= ticks % 300n
  ticks *= S_TO_NS / 100n
  const strToHash = `${ticks.toString()}${EDGE_API_TOKEN}`
  return sha256HexUpper(strToHash)
}

function generateMuid () {
  return randomBytes(16).toString('hex').toUpperCase()
}

function randomHex (len) {
  return randomBytes(len).toString('hex')
}

function hasSpeakableTtsContent (text) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return false
  return /[\p{L}\p{N}\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/u.test(t)
}

function removeIncompatibleCharacters (text) {
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].charCodeAt(0)
    if ((code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) {
      chars[i] = ' '
    }
  }
  return chars.join('')
}

function escapeXml (text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function genSSML (lang, text, voice, rate, pitch) {
  const rateStr = `${rate >= 1 ? '+' : ''}${Math.round((rate - 1) * 100)}%`
  const pitchStr = `${pitch >= 1 ? '+' : ''}${Math.round((pitch - 1) * 50)}Hz`
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rateStr}" pitch="${pitchStr}">${escapeXml(text)}</prosody></voice></speak>`
}

function genMessage (headers, content) {
  let header = ''
  for (const key of Object.keys(headers)) {
    header += `${key}: ${headers[key]}\r\n`
  }
  return `${header}\r\n${content}`
}

function toBuffer (data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function parseTextFrame (buf) {
  const text = buf.toString('utf8')
  const sep = text.indexOf('\r\n\r\n')
  if (sep < 0) return { path: '', body: text }
  const headerBlock = text.slice(0, sep)
  const body = text.slice(sep + 4)
  let path = ''
  for (const line of headerBlock.split('\r\n')) {
    const m = line.match(/^Path:\s*(.+)$/i)
    if (m) path = m[1].trim().toLowerCase()
  }
  return { path, body }
}

function parseBinaryAudioFrame (buf) {
  if (buf.length < 2) return null
  const headerLength = buf.readUInt16BE(0)
  if (headerLength <= 0 || headerLength > buf.length - 2) return null
  const headerBytes = buf.subarray(2, 2 + headerLength)
  const body = buf.subarray(2 + headerLength)
  const headers = {}
  for (const line of headerBytes.toString('utf8').split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim().toLowerCase()
    }
  }
  if (headers.path !== 'audio') return null
  const contentType = headers['content-type'] ?? ''
  if (contentType && contentType !== 'audio/mpeg') return null
  if (body.length === 0) return null
  return body
}

function appendAudioChunk (target, chunk) {
  if (chunk.length === 0) return target
  const merged = new Uint8Array(target.byteLength + chunk.length)
  merged.set(new Uint8Array(target), 0)
  merged.set(chunk, target.byteLength)
  return merged.buffer
}

async function synthesizeEdgeTtsMp3Once (req) {
  const text = removeIncompatibleCharacters(req.text?.trim() ?? '')
  if (!text) throw new Error('Edge TTS：文本为空')
  if (!hasSpeakableTtsContent(text)) throw new Error('Edge TTS：无可朗读内容')
  const voice = req.voice?.trim() || 'zh-CN-YunjianNeural'
  const lang = req.lang?.trim() || 'zh-CN'
  const rate = Number.isFinite(req.rate) ? req.rate : 1
  const pitch = Number.isFinite(req.pitch) ? req.pitch : 1

  const connectId = randomHex(16)
  const secMsGec = await generateSecMsGec()
  const params = new URLSearchParams({
    ConnectionId: connectId,
    TrustedClientToken: EDGE_API_TOKEN,
    'Sec-MS-GEC': secMsGec,
    'Sec-MS-GEC-Version': `1-${CHROMIUM_FULL_VERSION}`
  })
  const url = `${EDGE_SPEECH_URL}?${params.toString()}`

  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: `muid=${generateMuid()};`
  }

  const date = new Date().toString()
  const ssml = genSSML(lang, text, voice, rate, pitch)

  const configMsg = genMessage(
    {
      'Content-Type': 'application/json; charset=utf-8',
      Path: 'speech.config',
      'X-Timestamp': date
    },
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: true },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
          }
        }
      }
    })
  )

  const ssmlMsg = genMessage(
    {
      'Content-Type': 'application/ssml+xml',
      Path: 'ssml',
      'X-RequestId': connectId,
      'X-Timestamp': date
    },
    ssml
  )

  return new Promise((resolve, reject) => {
    let audioData = new ArrayBuffer(0)
    let settled = false
    let lastResponseBody = ''

    const ws = new WebSocket(url, { headers })

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        try { ws.close() } catch {}
        reject(new Error('Edge TTS 超时（30s）'))
      }
    }, 30_000)

    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      fn()
    }

    const finishTurn = () => {
      try { ws.close() } catch {}
      if (!audioData.byteLength) {
        settle(() => reject(new Error(`Edge TTS 无音频数据${lastResponseBody ? `：${lastResponseBody.slice(0, 200)}` : ''}`)))
      } else {
        settle(() => resolve(audioData))
      }
    }

    ws.on('message', (data, isBinary) => {
      try {
        const buf = toBuffer(data)
        if (isBinary) {
          const audioChunk = parseBinaryAudioFrame(buf)
          if (audioChunk) audioData = appendAudioChunk(audioData, audioChunk)
          return
        }
        const { path, body } = parseTextFrame(buf)
        if (path === 'response') lastResponseBody = body.trim()
        if (path === 'turn.end') finishTurn()
      } catch {}
    })

    ws.on('error', (err) => {
      settle(() => reject(new Error(`Edge TTS WebSocket 错误：${err instanceof Error ? err.message : String(err)}`)))
    })

    ws.on('close', () => {
      if (settled) return
      if (!audioData.byteLength) {
        settle(() => reject(new Error(`Edge TTS 连接关闭且无音频${lastResponseBody ? `：${lastResponseBody.slice(0, 200)}` : ''}`)))
      } else {
        settle(() => resolve(audioData))
      }
    })

    ws.on('open', () => {
      ws.send(configMsg)
      ws.send(ssmlMsg)
    })
  })
}

// 返回单段 MP3（24kHz mono），无音频时自动重试
async function synthesizeEdgeTtsMp3 (req) {
  const maxAttempts = 3
  let lastErr = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await synthesizeEdgeTtsMp3Once(req)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      const retryable = /无音频|连接关闭且无音频|WebSocket|超时/i.test(lastErr.message) && !/无可朗读内容/.test(lastErr.message)
      if (!retryable || attempt >= maxAttempts - 1) break
      await sleepMs(250 * (attempt + 1))
    }
  }
  throw lastErr ?? new Error('Edge TTS 合成失败')
}

// Edge TTS 音色表（从 ColorTxt voiceReadEdgeTtsVoices.ts 完整移植）
// Edge TTS 中文音色表（仅保留中文相关）
const EDGE_TTS_ZH_VOICES = [
  { id: 'zh-CN-liaoning-XiaobeiNeural', lang: 'zh-CN-liaoning', gender: 'female', name: 'Xiaobei', label: '晓北 (Xiaobei)', nameZh: '晓北', description: '幽默 · 方言' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', lang: 'zh-CN-shaanxi', gender: 'female', name: 'Xiaoni', label: '晓妮 (Xiaoni)', nameZh: '晓妮', description: '明亮 · 方言' },
  { id: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN', gender: 'female', name: 'Xiaoxiao', label: '晓晓 (Xiaoxiao)', nameZh: '晓晓', description: '温暖 · 新闻、小说' },
  { id: 'zh-CN-XiaoyiNeural', lang: 'zh-CN', gender: 'female', name: 'Xiaoyi', label: '晓伊 (Xiaoyi)', nameZh: '晓伊', description: '活泼 · 卡通、小说' },
  { id: 'zh-CN-YunjianNeural', lang: 'zh-CN', gender: 'male', name: 'Yunjian', label: '云健 (Yunjian)', nameZh: '云健', description: '激情 · 体育、小说' },
  { id: 'zh-CN-YunxiaNeural', lang: 'zh-CN', gender: 'male', name: 'Yunxia', label: '云夏 (Yunxia)', nameZh: '云夏', description: '可爱 · 卡通、小说' },
  { id: 'zh-CN-YunxiNeural', lang: 'zh-CN', gender: 'male', name: 'Yunxi', label: '云希 (Yunxi)', nameZh: '云希', description: '活泼、阳光 · 小说' },
  { id: 'zh-CN-YunyangNeural', lang: 'zh-CN', gender: 'male', name: 'Yunyang', label: '云扬 (Yunyang)', nameZh: '云扬', description: '专业、可靠 · 新闻' },
  { id: 'zh-HK-HiuGaaiNeural', lang: 'zh-HK', gender: 'female', name: 'HiuGaai', label: '晓佳 (HiuGaai)', nameZh: '晓佳', description: '友善、积极 · 通用' },
  { id: 'zh-HK-HiuMaanNeural', lang: 'zh-HK', gender: 'female', name: 'HiuMaan', label: '晓曼 (HiuMaan)', nameZh: '晓曼', description: '友善、积极 · 通用' },
  { id: 'zh-HK-WanLungNeural', lang: 'zh-HK', gender: 'male', name: 'WanLung', label: '云龙 (WanLung)', nameZh: '云龙', description: '友善、积极 · 通用' },
  { id: 'zh-TW-HsiaoChenNeural', lang: 'zh-TW', gender: 'female', name: 'HsiaoChen', label: '晓臻 (HsiaoChen)', nameZh: '晓臻', description: '友善、积极 · 通用' },
  { id: 'zh-TW-HsiaoYuNeural', lang: 'zh-TW', gender: 'female', name: 'HsiaoYu', label: '晓雨 (HsiaoYu)', nameZh: '晓雨', description: '友善、积极 · 通用' },
  { id: 'zh-TW-YunJheNeural', lang: 'zh-TW', gender: 'male', name: 'YunJhe', label: '云哲 (YunJhe)', nameZh: '云哲', description: '友善、积极 · 通用' },
]

module.exports = { synthesizeEdgeTtsMp3, EDGE_TTS_ZH_VOICES }
