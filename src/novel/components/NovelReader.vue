<template>
  <div class="novel-reader-overlay" :style="readerStyle">
    <!-- epub 导入进度条（必须在 overlay 内，否则会被遮挡） -->
    <transition name="fade-progress">
      <div v-if="store.importing" class="import-progress-overlay">
        <div class="import-progress-card">
          <div class="import-progress-title">正在导入小说</div>
          <el-progress
            :percentage="progressPercent"
            :status="progressStatus"
            :stroke-width="14"
            :show-text="true"
          />
          <div class="import-progress-message">{{ store.importProgress.message || '准备中...' }}</div>
        </div>
      </div>
    </transition>

    <div v-if="!topBarHidden" class="reader-top-bar" :style="topBarStyle">
      <el-button @click="onBack" :icon="ArrowLeft" size="small">返回书库</el-button>
      <el-button @click="topBarHidden = true" :icon="ArrowDown" size="small" circle title="隐藏顶栏"></el-button>
      <el-button @click="chapterListHidden = !chapterListHidden" :icon="chapterListHidden ? Expand : Fold" size="small" circle :title="chapterListHidden ? '显示章节列表' : '隐藏章节列表'"></el-button>
      <div class="reader-title">{{ store.currentNovel?.title }}</div>
      <el-button @click="toggleTTS" :type="ttsPlaying ? 'danger' : (ttsLoading ? 'warning' : '')" size="small" title="语音朗读" :loading="ttsLoading && !ttsPlaying">
        <el-icon v-if="!ttsPlaying && !ttsLoading"><VideoPlay /></el-icon>
        <el-icon v-else-if="ttsPlaying"><VideoPause /></el-icon>
      </el-button>
      <el-button @click="settingsVisible = true" :icon="Setting" size="small">设置</el-button>
    </div>
    <div v-else class="reader-top-bar-trigger" @click="topBarHidden = false" title="显示顶栏">
      <el-icon><ArrowUp /></el-icon>
    </div>

    <!-- 10px 固定背景色条（滚动时保持不动） -->
    <div class="reader-top-bar-gap" :style="{ background: themeColors.bg }"></div>

    <div class="reader-body">
      <div v-show="!chapterListHidden" class="chapter-list" :style="sideBarStyle">
        <div
          v-for="ch in store.chapters"
          :key="ch.id"
          class="chapter-item"
          :class="{ active: ch.index === activeChapterIdx }"
          @click="jumpToChapter(ch.index)"
        >
          {{ ch.title }}
        </div>
      </div>
      <div v-show="chapterListHidden" class="chapter-list-toggle-collapsed" @click="chapterListHidden = false" title="显示章节列表">
        <el-icon><Expand /></el-icon>
      </div>

      <div class="chapter-content" ref="contentRef" :style="contentStyle" @scroll="onScroll">
        <!-- sticky 当前章节名（ColorTxt 风格） -->
        <div v-if="settings.stickyChapterTitle !== false" class="sticky-chapter" :style="stickyStyle">
          {{ currentChapterTitle }}
        </div>
        <div v-if="store.loadError" class="reader-error">
          <div>加载失败：{{ store.loadError }}</div>
          <el-button @click="retryLoad" size="small" style="margin-top: 12px;">重试</el-button>
        </div>
        <div v-else-if="settings.colorize" class="reader-text" :style="textStyle">
          <div
            v-for="(p, i) in renderedParagraphs"
            :key="i"
            class="reader-paragraph"
            v-html="colorizeParagraph(p)"
          ></div>
          <div v-if="isRendering" class="reader-loading-more">正在加载更多内容…</div>
        </div>
        <div v-else class="reader-text" :style="textStyle">
          <div v-for="(p, i) in renderedParagraphs" :key="i" class="reader-paragraph">{{ p }}</div>
          <div v-if="isRendering" class="reader-loading-more">正在加载更多内容…</div>
        </div>
      </div>
    </div>

    <ReaderSettings
      v-model="settingsVisible"
      :settings="settings"
      :imported-fonts="importedFonts"
      :system-fonts="systemFonts"
      @change="onSettingsChange"
      @close="flushPersistSettings"
      @import-font="importFont"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, toRaw } from 'vue'
import { ArrowLeft, Setting, ArrowUp, ArrowDown, VideoPlay, VideoPause, Fold, Expand } from '@element-plus/icons-vue'
import { useNovelStore } from '../stores/novel'
import { colorize } from '../utils/colorizer'
import { parseVoiceSegments, splitTTSChunks, hasSpeakableText } from '../utils/voiceSegments'
import ReaderSettings from './ReaderSettings.vue'

const props = defineProps({
  settings: { type: Object, required: true }
})
const emit = defineEmits(['back', 'update-settings'])

const DEFAULT_SETTINGS = {
  fontSource: 'builtin',
  fontFamily: 'JingHuaLaoSongTi',
  fontSize: 24,
  lineHeight: 1.5,
  indent: 0,
  collapseBlank: true,
  theme: 'light',
  bgColor: '#f5deb3',
  fgColor: '#5b4636',
  colorize: true,
  highlightWords: [],
  stickyChapterTitle: true,
  readerWidth: 800,
  ttsEngine: 'edge',
  ttsScheme: 'multi',
  ttsVoiceId: 'zh-CN-YunjianNeural',
  ttsNarrationVoiceId: 'zh-CN-YunjianNeural',
  ttsDialogueVoiceId: 'zh-CN-YunxiNeural',
  ttsDialogueMaleVoiceId: 'zh-CN-YunxiNeural',
  ttsDialogueFemaleVoiceId: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 1,
  ttsPitch: 1,
  ttsVolume: 1,
  _v: 4
}

const store = useNovelStore()
const settingsVisible = ref(false)
const contentRef = ref(null)
const importedFonts = ref([])
const systemFonts = ref([])
const topBarHidden = ref(false)
const chapterListHidden = ref(false)

const settings = ref({ ...DEFAULT_SETTINGS, ...props.settings })
watch(() => props.settings, v => { settings.value = { ...DEFAULT_SETTINGS, ...v } }, { deep: false })

const activeChapterIdx = ref(store.currentChapterIndex)
const isJumping = ref(false)
const isRestoring = ref(false)
const isReady = ref(false)
let initChapterLock = false

let saveTimer = null
let lastScrollTop = 0
let scrollDirection = 0 // 1=down, -1=up

// ColorTxt 风格：程序性滚动计数器
let programmaticScrollDepth = 0
const beginProgrammaticScroll = () => { programmaticScrollDepth++ }
const endProgrammaticScroll = () => {
  setTimeout(() => { programmaticScrollDepth = Math.max(0, programmaticScrollDepth - 1) }, 500)
}

const waitTwoPaintFrames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

const setScrollTopSafely = async (top) => {
  beginProgrammaticScroll()
  await waitTwoPaintFrames()
  const el = contentRef.value
  if (el) el.scrollTop = top
  endProgrammaticScroll()
}

const READER_VIEWPORT_RESTORE_SLOT_FROM_TOP = 2

const displayLineToPhysicalLine = (displayLine) => {
  const map = store.displayLineToPhysicalLine
  if (!map || map.length === 0) return Math.max(1, Math.floor(displayLine))
  const idx = Math.max(0, Math.min(map.length - 1, Math.floor(displayLine) - 1))
  return map[idx] || 1
}

const physicalLineToDisplayLine = (physicalLine) => {
  const p = Math.max(1, Math.floor(physicalLine))
  // 优先使用标题物理行→标题展示行映射，避免落到标题前的留白空行
  const titleMap = store.chapterTitleDisplayLineByPhysical
  const cached = titleMap instanceof Map ? titleMap.get(p) : undefined
  if (cached != null && cached >= 1) return cached
  const map = store.displayLineToPhysicalLine
  if (!map || map.length === 0) return p
  for (let i = 0; i < map.length; i++) {
    if (map[i] >= p) return i + 1
  }
  return map.length
}

/** 获取文本偏移处字符的包围矩形（DOM 坐标） */
const getRectAtTextOffset = (root, offset) => {
  const total = root.textContent.length
  if (total === 0) return null
  const safeOffset = Math.max(0, Math.min(total - 1, offset))
  const range = createRangeByCharOffset(root, safeOffset, safeOffset + 1)
  if (!range) return null
  try {
    range.collapse(true)
    return range.getBoundingClientRect()
  } catch (e) {
    return null
  }
}

const captureViewportAnchor = () => {
  const el = contentRef.value
  if (!el) return { physicalLine: 1, wrappedLineIndex: 0 }
  const lineHeight = computedLineHeight.value || 1
  const slot = READER_VIEWPORT_RESTORE_SLOT_FROM_TOP
  const offsetHeights = Math.max(1, Math.floor(slot)) - 1
  const textEl = el.querySelector('.reader-text')
  let physicalLine = 1
  let wrappedLineIndex = 0

  const fallback = () => {
    const targetY = el.scrollTop + offsetHeights * lineHeight
    const displayLine = Math.max(1, Math.floor(targetY / lineHeight) + 1)
    physicalLine = displayLineToPhysicalLine(displayLine)
    const lineStartY = (displayLine - 1) * lineHeight
    wrappedLineIndex = Math.max(0, Math.floor((targetY - lineStartY) / lineHeight))
  }

  try {
    const elRect = el.getBoundingClientRect()
    const probeX = elRect.left + 16
    const probeY = elRect.top + offsetHeights * lineHeight
    const caret = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(probeX, probeY)
      : (document.caretPositionFromPoint
          ? document.caretPositionFromPoint(probeX, probeY)
          : null)
    if (!caret || !textEl) { fallback(); return { physicalLine, wrappedLineIndex } }

    const node = caret.startContainer || caret.offsetNode
    const offset = caret.startOffset || caret.offset
    const preRange = document.createRange()
    preRange.selectNodeContents(textEl)
    preRange.setEnd(node, offset)
    const textBefore = preRange.toString()
    preRange.detach()

    const displayLine = Math.max(1, textBefore.split('\n').length)
    physicalLine = displayLineToPhysicalLine(displayLine)

    // 计算在当前展示行内的 wrap 行索引
    const caretRect = getRectAtTextOffset(textEl, textBefore.length)
    const displayLineStartOffset = textBefore.lastIndexOf('\n') + 1
    const displayLineStartRect = getRectAtTextOffset(textEl, displayLineStartOffset)
    if (caretRect && displayLineStartRect && lineHeight > 0) {
      wrappedLineIndex = Math.max(0, Math.round((caretRect.top - displayLineStartRect.top) / lineHeight))
    }
  } catch (e) {
    fallback()
  }

  return { physicalLine, wrappedLineIndex }
}

const computeScrollTopFromAnchor = (physicalLine, wrappedLineIndex = 0) => {
  const el = contentRef.value
  if (!el) return 0
  const lineHeight = computedLineHeight.value || 1
  const slot = READER_VIEWPORT_RESTORE_SLOT_FROM_TOP
  const offsetHeights = Math.max(1, Math.floor(slot)) - 1
  const probeOffset = offsetHeights * lineHeight
  const displayLine = physicalLineToDisplayLine(physicalLine)
  // 纯行高估算：避免访问 scrollHeight / getBoundingClientRect 在大文本下强制布局导致卡死
  const totalDisplayLines = Math.max(0, store.displayLineToPhysicalLine.length)
  const lineStartY = (displayLine - 1) * lineHeight
  const pointY = lineStartY + Math.max(0, Math.floor(wrappedLineIndex)) * lineHeight
  const targetTop = pointY - probeOffset
  const maxTop = Math.max(0, totalDisplayLines * lineHeight - el.clientHeight)
  return Math.max(0, Math.min(maxTop, targetTop))
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const escapeHtml = (s) => {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const createRangeByCharOffset = (root, start, end) => {
  let charCount = 0
  let startSet = false
  const range = document.createRange()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  let node
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length
    if (!startSet) {
      if (charCount + len > start) {
        range.setStart(node, start - charCount)
        startSet = true
      } else {
        charCount += len
        continue
      }
    }
    if (startSet) {
      if (charCount + len >= end) {
        range.setEnd(node, end - charCount)
        return range
      }
    }
    charCount += len
  }
  return null
}

const clearTTSHighlight = (el) => {
  const textEl = el ? el.querySelector('.reader-text') : null
  if (!textEl) return
  const oldMark = textEl.querySelector('mark.tts-current')
  if (oldMark) {
    const parent = oldMark.parentNode
    parent.replaceChild(document.createTextNode(oldMark.textContent), oldMark)
    parent.normalize()
  }
  ttsHighlightRange = null
}

let ttsHighlightRange = null
let lastHighlightChunkIndex = -1
let lastTTSMatchEnd = 0

const highlightCurrentTTSChunk = (chunk, chunkIndex = 0) => {
  const el = contentRef.value
  if (!el || !chunk) return
  const text = typeof chunk === 'string' ? chunk : chunk.text
  if (!text) return

  const textEl = el.querySelector('.reader-text')
  if (!textEl) return
  clearTTSHighlight(el)

  const needleRaw = text.slice(0, 80).trim()
  if (!needleRaw) return
  const escapedNeedle = escapeRegExp(needleRaw).replace(/\s+/g, '\\s+')
  const re = new RegExp(escapedNeedle, 'g')
  const rootText = textEl.textContent || ''

  re.lastIndex = lastTTSMatchEnd
  let m = re.exec(rootText)
  if (!m) { re.lastIndex = 0; m = re.exec(rootText) }
  if (!m) return

  const range = createRangeByCharOffset(textEl, m.index, m.index + m[0].length)
  if (!range) return
  try {
    const mark = document.createElement('mark')
    range.surroundContents(mark)
    mark.classList.add('tts-current')
    ttsHighlightRange = range
    lastHighlightChunkIndex = chunkIndex
    lastTTSMatchEnd = m.index + m[0].length
    const rect = mark.getBoundingClientRect()
    const containerRect = el.getBoundingClientRect()
    const offset = rect.top - containerRect.top - (containerRect.height / 2) + (rect.height / 2)
    beginProgrammaticScroll()
    el.scrollTo({ top: el.scrollTop + offset, behavior: 'smooth' })
    endProgrammaticScroll()
  } catch (e) {
    lastTTSMatchEnd = m.index + m[0].length
  }
}

const buildTTSChunks = () => {
  const scheme = settings.value.ttsScheme || 'single'
  const engine = settings.value.ttsEngine || 'edge'
  const chunks = []
  const chapters = store.chapters || []
  const fullText = store.fullText || ''
  if (!fullText) return chunks
  for (let idx = 0; idx < chapters.length; idx++) {
    const ch = chapters[idx]
    const chapterIdx = ch.index ?? idx
    const chapterText = fullText.slice(ch.startOffset, ch.endOffset)
    const lines = chapterText.split('\n')
    let body = lines.slice(1).join('\n')
    body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n').replace(/^\s+|\s+$/g, '')
    if (!hasSpeakableText(body)) continue
    let segmentChunkIdx = 0
    if (scheme === 'multi' && engine === 'edge') {
      for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || !hasSpeakableText(trimmed)) continue
        const segs = parseVoiceSegments(trimmed)
        for (const s of segs) {
          if (!s.text.trim() || !hasSpeakableText(s.text)) continue
          const voiceId = s.kind === 'dialogue'
            ? (settings.value.ttsDialogueVoiceId || 'zh-CN-YunxiNeural')
            : (settings.value.ttsNarrationVoiceId || 'zh-CN-YunjianNeural')
          for (const c of splitTTSChunks(s.text)) {
            chunks.push({ text: c, voiceId, chapterIdx, segmentChunkIdx })
            segmentChunkIdx++
          }
        }
      }
    } else {
      const voiceId = settings.value.ttsVoiceId || 'zh-CN-YunjianNeural'
      for (const c of splitTTSChunks(body)) {
        chunks.push({ text: c, voiceId, chapterIdx, segmentChunkIdx })
        segmentChunkIdx++
      }
    }
  }
  return chunks
}

const ttsPlaying = ref(false)
const ttsLoading = ref(false)
const ttsAudioCtx = ref(null)
const ttsAbortRef = ref(false)
const ttsCurrentText = ref('')
let currentSource = null
let ttsGainNode = null
let ttsScheduledEnd = 0
const PREFETCH_DEPTH = 4
const ttsPrefetchQueue = ref([])
const ttsSynthesizing = new Set()

const synthesizeChunk = async (chunk) => {
  const result = await window.ipcRenderer.invoke('novel:edge-tts', {
    text: chunk.text,
    voice: chunk.voiceId,
    lang: 'zh-CN',
    rate: settings.value.ttsRate ?? 1,
    pitch: settings.value.ttsPitch ?? 1
  })
  if (!result.ok) {
    console.warn('Edge TTS 合成失败', result.error)
    return null
  }
  return result.mp3
}

const synthesizeAndDecode = async (chunk) => {
  const mp3 = await synthesizeChunk(chunk)
  if (!mp3 || ttsAbortRef.value) return null
  if (!ttsAudioCtx.value) ttsAudioCtx.value = new (window.AudioContext || window.webkitAudioContext)()
  const ctx = ttsAudioCtx.value
  return new Promise((resolve) => {
    ctx.decodeAudioData(mp3.slice(0), (audioBuffer) => resolve(audioBuffer), () => resolve(null))
  })
}

const ensurePrefetch = (chunks, currentIndex) => {
  if (ttsAbortRef.value) return
  for (let offset = 1; offset <= PREFETCH_DEPTH; offset++) {
    const nextIdx = currentIndex + offset
    if (nextIdx >= chunks.length) break
    if (ttsPrefetchQueue.value.some(item => item.chunkIndex === nextIdx)) continue
    if (ttsSynthesizing.has(nextIdx)) continue
    ttsSynthesizing.add(nextIdx)
    synthesizeAndDecode(chunks[nextIdx]).then(audioBuffer => {
      ttsSynthesizing.delete(nextIdx)
      if (audioBuffer && !ttsAbortRef.value) {
        if (!ttsPrefetchQueue.value.some(item => item.chunkIndex === nextIdx)) {
          ttsPrefetchQueue.value.push({ chunkIndex: nextIdx, chunk: chunks[nextIdx], audioBuffer })
        }
      }
    }).catch(() => { ttsSynthesizing.delete(nextIdx) })
  }
}

const getChunkAudioBuffer = async (chunk, index) => {
  const queuedIdx = ttsPrefetchQueue.value.findIndex(item => item.chunkIndex === index)
  if (queuedIdx >= 0) return ttsPrefetchQueue.value.splice(queuedIdx, 1)[0].audioBuffer
  if (ttsSynthesizing.has(index)) {
    let waited = 0
    while (ttsSynthesizing.has(index) && waited < 5000 && !ttsAbortRef.value) {
      await new Promise(r => setTimeout(r, 50))
      waited += 50
    }
    const qIdx = ttsPrefetchQueue.value.findIndex(item => item.chunkIndex === index)
    if (qIdx >= 0) return ttsPrefetchQueue.value.splice(qIdx, 1)[0].audioBuffer
  }
  return await synthesizeAndDecode(chunk)
}

const startTTS = async () => {
  const engine = settings.value.ttsEngine || 'edge'
  if (engine === 'system') { startSystemTTS(); return }
  const chunks = buildTTSChunks()
  if (chunks.length === 0) return
  ttsPlaying.value = true
  ttsAbortRef.value = false
  ttsPrefetchQueue.value = []
  ttsSynthesizing.clear()
  lastTTSMatchEnd = 0
  if (!ttsAudioCtx.value) ttsAudioCtx.value = new (window.AudioContext || window.webkitAudioContext)()
  const ctx = ttsAudioCtx.value
  if (ctx.state === 'suspended') await ctx.resume()
  ttsGainNode = ctx.createGain()
  ttsGainNode.gain.value = settings.value.ttsVolume ?? 1
  ttsGainNode.connect(ctx.destination)
  ttsScheduledEnd = 0

  for (let i = 0; i < chunks.length; i++) {
    if (ttsAbortRef.value) break
    const chunk = chunks[i]
    const audioBuffer = await getChunkAudioBuffer(chunk, i)
    if (!audioBuffer || ttsAbortRef.value) break
    ttsLoading.value = false
    const startAt = Math.max(ctx.currentTime, ttsScheduledEnd)
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ttsGainNode)
    source.start(startAt)
    ttsScheduledEnd = startAt + audioBuffer.duration
    currentSource = source
    const highlightDelayMs = Math.max(0, (startAt - ctx.currentTime) * 1000)
    setTimeout(() => {
      if (!ttsAbortRef.value) {
        ttsCurrentText.value = chunk.text
        highlightCurrentTTSChunk(chunk, i)
      }
    }, highlightDelayMs)
    ensurePrefetch(chunks, i)
    if (i < chunks.length - 1 && !ttsAbortRef.value) {
      while (ctx.currentTime < startAt - 0.02 && !ttsAbortRef.value) {
        await new Promise(r => setTimeout(r, 20))
      }
    }
  }

  while (ctx.currentTime < ttsScheduledEnd - 0.05 && !ttsAbortRef.value) {
    await new Promise(r => setTimeout(r, 50))
  }
  ttsPlaying.value = false
  ttsLoading.value = false
  ttsPrefetchQueue.value = []
  ttsSynthesizing.clear()
  if (ttsGainNode) { try { ttsGainNode.disconnect() } catch {} ttsGainNode = null }
}

const startSystemTTS = () => {
  const voiceId = settings.value.ttsVoiceId
  const chunks = buildTTSChunks()
  if (chunks.length === 0) return
  let i = 0
  ttsPlaying.value = true
  ttsAbortRef.value = false
  lastTTSMatchEnd = 0
  window.speechSynthesis.cancel()
  const speakNext = () => {
    if (ttsAbortRef.value || i >= chunks.length) { ttsPlaying.value = false; return }
    ttsCurrentText.value = chunks[i].text
    highlightCurrentTTSChunk(chunks[i], i)
    const u = new SpeechSynthesisUtterance(chunks[i].text)
    u.lang = 'zh-CN'
    u.rate = settings.value.ttsRate ?? 1
    u.pitch = settings.value.ttsPitch ?? 1
    u.volume = settings.value.ttsVolume ?? 1
    if (voiceId) {
      const v = window.speechSynthesis.getVoices().find(vv => vv.voiceURI === voiceId)
      if (v) { u.voice = v; u.lang = v.lang }
    }
    u.onend = () => { i++; if (ttsPlaying.value) speakNext() }
    u.onerror = () => { i++; if (ttsPlaying.value) speakNext() }
    window.speechSynthesis.speak(u)
  }
  speakNext()
}

const stopTTS = () => {
  ttsAbortRef.value = true
  ttsPlaying.value = false
  ttsLoading.value = false
  ttsCurrentText.value = ''
  ttsPrefetchQueue.value = []
  ttsSynthesizing.clear()
  lastHighlightChunkIndex = -1
  lastTTSMatchEnd = 0
  const el = contentRef.value
  if (el) clearTTSHighlight(el)
  if (ttsAudioCtx.value) { try { ttsAudioCtx.value.close() } catch {} ttsAudioCtx.value = null }
  if (ttsGainNode) { try { ttsGainNode.disconnect() } catch {} ttsGainNode = null }
  currentSource = null
  ttsScheduledEnd = 0
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
}

const toggleTTS = () => { ttsPlaying.value ? stopTTS() : startTTS() }

const updateActiveChapter = () => {
  const el = contentRef.value
  if (!el) return
  const textEl = el.querySelector('.reader-text')
  if (!textEl) return
  const rect = el.getBoundingClientRect()
  // 用视口约 3/4 处的 caret 位置找当前字符，再映射到物理行/章节
  // 这样不受 white-space:pre-wrap 换行影响
  const probeX = rect.left + 16
  const probeY = rect.top + Math.max(1, el.clientHeight * 0.75)
  let physicalLine = 1
  try {
    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(probeX, probeY)
      : (document.caretPositionFromPoint
          ? document.caretPositionFromPoint(probeX, probeY)
          : null)
    if (range) {
      const node = range.startContainer || range.offsetNode
      const offset = range.startOffset || range.offset
      const preRange = document.createRange()
      preRange.selectNodeContents(textEl)
      preRange.setEnd(node, offset)
      const textBefore = preRange.toString()
      const displayLine = Math.max(1, textBefore.split('\n').length)
      physicalLine = displayLineToPhysicalLine(displayLine)
      preRange.detach()
    }
  } catch (e) {
    // 降级：仍用行高估算
    const lineHeight = computedLineHeight.value || 1
    const visibleStart = Math.floor(el.scrollTop / lineHeight) + 1
    const visibleSpan = Math.max(0, Math.floor(el.clientHeight / lineHeight))
    const probeDisplayLine = Math.max(1, visibleStart + Math.floor(visibleSpan * 0.75))
    physicalLine = displayLineToPhysicalLine(probeDisplayLine)
  }
  const list = store.chapterDisplayLines || []
  let idx = 0
  for (const c of list) {
    if (c.physicalLine <= physicalLine) idx = c.index
    else break
  }
  activeChapterIdx.value = idx
}

const jumpToChapter = async (idx) => {
  stopTTS()
  const target = (store.chapterDisplayLines || []).find(c => c.index === idx)
  if (!target) return
  isJumping.value = true
  beginProgrammaticScroll()
  try {
    activeChapterIdx.value = idx
    const targetTop = computeScrollTopFromAnchor(target.physicalLine, 0)
    await setScrollTopSafely(targetTop)
    scheduleSave()
  } finally {
    isJumping.value = false
    endProgrammaticScroll()
  }
}

const onScroll = () => {
  const el = contentRef.value
  if (!el || isRestoring.value || isJumping.value || programmaticScrollDepth > 0) return
  const st = el.scrollTop
  scrollDirection = st > lastScrollTop ? 1 : (st < lastScrollTop ? -1 : 0)
  lastScrollTop = st
  if (store.readingProgressSynced) {
    scheduleSave()
    updateActiveChapter()
  }
}

const scheduleSave = () => {
  if (isRestoring.value || isJumping.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { flushSave() }, 1500)
}

const flushSave = () => {
  if (isRestoring.value || isJumping.value) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const el = contentRef.value
  const scrollTop = el ? Math.round(el.scrollTop) : 0
  const anchor = captureViewportAnchor()
  store.saveProgress({
    chapterIdx: activeChapterIdx.value,
    scrollTop,
    physicalLine: anchor.physicalLine,
    wrappedLineIndex: anchor.wrappedLineIndex
  })
}

const onBack = () => {
  stopTTS()
  try { flushSave() } catch (e) { console.error('flushSave failed on back:', e) }
  emit('back')
}

const retryLoad = () => {
  if (!store.currentNovel) return
  store.loadFullText().catch(() => {})
}

const themeColors = computed(() => {
  const theme = settings.value?.theme || 'light'
  if (theme === 'dark') return { bg: '#1e1e1e', fg: '#d4d4d4', title: '#569cd6', side: '#252526', topBar: 'rgba(255,255,255,0.06)' }
  if (theme === 'white') return { bg: '#ffffff', fg: '#000000', title: '#333333', side: '#f0f0f0', topBar: 'rgba(0,0,0,0.06)' }
  if (theme === 'eye') return { bg: '#f5deb3', fg: '#5b4636', title: '#b88230', side: '#ede0c0', topBar: 'rgba(0,0,0,0.06)' }
  if (theme === 'custom') return { bg: settings.value?.bgColor || '#f4ead7', fg: settings.value?.fgColor || '#000000', title: '#b88230', side: settings.value?.bgColor || '#f4ead7', topBar: 'rgba(0,0,0,0.06)' }
  return { bg: '#f4ead7', fg: '#000000', title: '#b88230', side: '#ece1c5', topBar: 'rgba(0,0,0,0.06)' }
})

const computedLineHeight = computed(() => {
  const fs = settings.value.fontSize || 24
  const mult = settings.value.lineHeight || 1.5
  return Math.max(1, Math.round(fs * mult))
})

const readerStyle = computed(() => ({
  background: themeColors.value.bg,
  color: themeColors.value.fg,
  fontFamily: fontStack.value,
  fontSize: (settings.value.fontSize || 24) + 'px',
  lineHeight: computedLineHeight.value + 'px',
  '--reader-title-color': themeColors.value.title,
  '--reader-bg': themeColors.value.bg
}))

const topBarStyle = computed(() => ({
  background: themeColors.value.topBar,
  borderBottomColor: 'rgba(128,128,128,0.15)'
}))

const sideBarStyle = computed(() => ({
  background: themeColors.value.side,
  borderRightColor: 'rgba(128,128,128,0.15)'
}))

const stickyStyle = computed(() => ({
  background: themeColors.value.bg,
  color: themeColors.value.title,
  borderBottomColor: 'rgba(128,128,128,0.2)'
}))

const fontStack = computed(() => {
  const f = settings.value.fontFamily
  if (!f) return '"Microsoft YaHei", serif'
  return `"${f}", "Microsoft YaHei", serif`
})

const contentStyle = computed(() => ({
  maxWidth: (settings.value.readerWidth || 800) + 'px',
  margin: '0 auto'
}))

const textStyle = computed(() => ({
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}))

const progressPercent = computed(() => {
  const p = store.importProgress
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.current / p.total) * 100))
})
const progressStatus = computed(() => store.importProgress.phase === 'done' ? 'success' : '')

const currentChapterTitle = computed(() => {
  const ch = store.chapters[activeChapterIdx.value]
  return ch ? ch.title : ''
})

const displayParagraphs = computed(() => {
  const text = store.displayText || ''
  return text.split(/\n\n+/).filter(Boolean)
})

const colorizeParagraph = (p) => {
  if (!settings.value.colorize) return escapeHtml(p)
  const theme = settings.value.theme === 'dark' ? 'dark' : 'light'
  return colorize(p, settings.value.highlightWords || [], theme)
}

const INITIAL_PARAGRAPHS = 100
const PARAGRAPH_BATCH_SIZE = 100
const renderedCount = ref(0)
const renderRaf = ref(null)
const renderedParagraphs = computed(() => displayParagraphs.value.slice(0, renderedCount.value))
const isRendering = computed(() => renderedCount.value < displayParagraphs.value.length)

const clearRenderRaf = () => {
  if (renderRaf.value) {
    cancelAnimationFrame(renderRaf.value)
    renderRaf.value = null
  }
}

const renderParagraphsProgressively = () => {
  clearRenderRaf()
  const total = displayParagraphs.value.length
  renderedCount.value = Math.min(INITIAL_PARAGRAPHS, total)
  const step = () => {
    if (renderedCount.value >= total) {
      renderRaf.value = null
      return
    }
    renderedCount.value = Math.min(total, renderedCount.value + PARAGRAPH_BATCH_SIZE)
    renderRaf.value = requestAnimationFrame(step)
  }
  renderRaf.value = requestAnimationFrame(step)
}

watch(() => displayParagraphs.value, () => {
  renderParagraphsProgressively()
}, { immediate: true })

const persistSettings = async () => {
  const toSave = JSON.parse(JSON.stringify(toRaw(settings.value)))
  try {
    await window.ipcRenderer.invoke('save-setting', { novel: toSave })
  } catch (e) { console.error('NovelReader: 保存设置失败', e) }
}
const flushPersistSettings = () => persistSettings()

const onSettingsChange = async (newSettings) => {
  const anchor = captureViewportAnchor()
  settings.value = { ...settings.value, ...newSettings }
  emit('update-settings', newSettings)
  store.rebuildDisplayText({
    collapseBlank: settings.value.collapseBlank,
    leadIndentFullWidth: settings.value.indent > 0
  })
  await nextTick()
  await waitTwoPaintFrames()
  const targetTop = computeScrollTopFromAnchor(anchor.physicalLine, anchor.wrappedLineIndex)
  await setScrollTopSafely(targetTop)
  persistSettings()
}

const importFont = async () => {
  const result = await window.ipcRenderer.invoke('novel:import-font-dialog')
  if (result) importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
}

const restoreProgress = async () => {
  if (store.readingProgressSynced || isRestoring.value || isJumping.value) return
  const el = contentRef.value
  if (!el) return
  isRestoring.value = true
  isJumping.value = true
  beginProgrammaticScroll()
  try {
    let targetTop = store.savedScrollTop || 0
    if (typeof store.savedPhysicalLine === 'number' && store.savedPhysicalLine > 0) {
      targetTop = computeScrollTopFromAnchor(store.savedPhysicalLine, store.savedWrappedLineIndex || 0)
    }
    await waitTwoPaintFrames()
    el.scrollTop = targetTop
    lastScrollTop = targetTop
    updateActiveChapter()
    store.readingProgressSynced = true
    await nextTick()
  } finally {
    isRestoring.value = false
    isJumping.value = false
    endProgrammaticScroll()
  }
}

const initChapter = async () => {
  if (!store.currentNovel || !store.displayText) return
  // 避免重复重置/恢复：设置改变等场景会由调用方自行管理 readingProgressSynced
  if (store.readingProgressSynced) return
  if (initChapterLock) return
  initChapterLock = true
  try {
    activeChapterIdx.value = store.currentChapterIndex
    await nextTick()
    await restoreProgress()
  } finally {
    initChapterLock = false
  }
}

onMounted(async () => {
  systemFonts.value = await window.ipcRenderer.invoke('novel:system-fonts')
  importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
  try {
    const latestSetting = await window.ipcRenderer.invoke('load-setting')
    if (latestSetting?.novel) {
      settings.value = { ...DEFAULT_SETTINGS, ...latestSetting.novel }
      emit('update-settings', { ...latestSetting.novel })
    }
  } catch (e) { console.warn('NovelReader: 加载最新设置失败', e) }
  isReady.value = true
  if (store.physicalLines.length > 0 && store.currentNovel && !store.readingProgressSynced) {
    store.rebuildDisplayText({
      collapseBlank: settings.value.collapseBlank,
      leadIndentFullWidth: settings.value.indent > 0
    })
    await initChapter()
  }
  window.addEventListener('keydown', handleKeyboard)

  const reimportHandler = async (_e, novelId) => {
    if (!store.currentNovel || store.currentNovel.id !== novelId) return
    store.readingProgressSynced = false
    await store.loadFullText()
    // physicalLines 变化会触发 watcher 自动 rebuild + initChapter
  }
  if (window.ipcRenderer && window.ipcRenderer.on) {
    window.ipcRenderer.on('novel:epub-reimported', reimportHandler)
  }
})

onBeforeUnmount(() => {
  stopTTS()
  flushSave()
  flushPersistSettings()
  clearRenderRaf()
  isRestoring.value = false
  isJumping.value = false
  isReady.value = false
  window.removeEventListener('keydown', handleKeyboard)
})

watch(() => store.physicalLines, async (lines) => {
  if (!isReady.value || !store.currentNovel || lines.length === 0) return
  if (store.readingProgressSynced) return
  store.rebuildDisplayText({
    collapseBlank: settings.value.collapseBlank,
    leadIndentFullWidth: settings.value.indent > 0
  })
  await initChapter()
})

const scrollBySafely = (delta) => {
  const el = contentRef.value
  if (!el) return
  beginProgrammaticScroll()
  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
  el.scrollTop = Math.max(0, Math.min(maxTop, el.scrollTop + delta))
  lastScrollTop = el.scrollTop
  endProgrammaticScroll()
}

const handleKeyboard = (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (settingsVisible.value) { settingsVisible.value = false; return }
    stopTTS()
    emit('back')
    return
  }
  if (e.key === 'F12') {
    e.preventDefault()
    window.ipcRenderer.invoke('app:toggle-devtools').catch(() => {})
    return
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
  const el = contentRef.value
  if (!el) return
  const pageHeight = el.clientHeight * 0.8
  const lineHeight = computedLineHeight.value || 1
  switch (e.key) {
    case 'PageUp':
    case 'ArrowLeft':
      e.preventDefault(); scrollBySafely(-pageHeight); break
    case 'PageDown':
    case 'ArrowRight':
      e.preventDefault(); scrollBySafely(pageHeight); break
    case 'ArrowUp':
      e.preventDefault(); scrollBySafely(-lineHeight * 3); break
    case 'ArrowDown':
      e.preventDefault(); scrollBySafely(lineHeight * 3); break
  }
}
</script>

<style scoped>
.novel-reader-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  user-select: text;
  -webkit-user-select: text;
}
.reader-top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-bottom: 1px solid rgba(0,0,0,0.1);
  flex-shrink: 0;
}
.reader-top-bar-trigger {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 12px;
  cursor: pointer;
  opacity: 0.4;
  z-index: 10;
}
.reader-top-bar-gap {
  height: 10px;
  flex-shrink: 0;
}
.reader-top-bar-trigger:hover { opacity: 1; }
.reader-title {
  flex: 1;
  font-size: 14px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reader-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}
.chapter-list {
  width: 220px;
  overflow-y: auto;
  padding: 8px 0;
  flex-shrink: 0;
  border-right: 1px solid rgba(0,0,0,0.1);
  text-align: left;
}
.chapter-list-toggle-collapsed {
  width: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-right: 1px solid rgba(0,0,0,0.1);
  opacity: 0.5;
}
.chapter-list-toggle-collapsed:hover { opacity: 1; }
.chapter-item {
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chapter-item:hover { background: rgba(128,128,128,0.1); }
.chapter-item.active { background: rgba(184,130,48,0.18); font-weight: bold; }
.chapter-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 32px 80px;
  position: relative;
}
.sticky-chapter {
  position: sticky;
  top: -10px;
  margin: -10px -32px 12px;
  padding: 6px 32px;
  font-size: 0.85em;
  font-weight: bold;
  z-index: 5;
  border-bottom: 1px solid rgba(128,128,128,0.2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reader-error {
  padding: 40px 20px;
  text-align: center;
  color: #c0392b;
  font-size: 18px;
}
.reader-text {
  margin: 0;
  text-align: left;
  content-visibility: auto;
  contain-intrinsic-size: auto 500px;
}
.reader-paragraph {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0 0 0.8em 0;
  text-indent: inherit;
}
.reader-loading-more {
  text-align: center;
  padding: 20px 0;
  color: #999;
  font-size: 14px;
}
:deep(mark.tts-current) {
  background: rgba(184,130,48,0.35);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.chapter-content,
.chapter-list {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.chapter-content::-webkit-scrollbar,
.chapter-list::-webkit-scrollbar {
  display: none;
}
:deep(.cl-chapter-title) {
  color: var(--reader-title-color, #b88230);
  font-weight: bold;
  font-size: 1.15em;
}
.import-progress-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5000;
}
.import-progress-card {
  width: 420px;
  max-width: 90vw;
  padding: 24px;
  background: var(--el-bg-color, #fff);
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.18);
  text-align: center;
}
.import-progress-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--el-text-color-primary, #303133);
}
.import-progress-message {
  margin-top: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
  min-height: 20px;
  word-break: break-all;
}
.fade-progress-enter-active, .fade-progress-leave-active {
  transition: opacity 0.2s ease;
}
.fade-progress-enter-from, .fade-progress-leave-to {
  opacity: 0;
}
</style>
