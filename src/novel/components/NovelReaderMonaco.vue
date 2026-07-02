<template>
  <div class="novel-reader-overlay" :style="readerStyle">
    <transition name="fade-progress">
      <div v-if="store.importing || store.formattingDisplay" class="import-progress-overlay">
        <div class="import-progress-card">
          <div class="import-progress-title">{{ progressTitle }}</div>
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

    <div v-if="settings.stickyChapterTitle && currentChapterName" class="chapter-title-bar" :style="chapterTitleBarStyle">
      {{ currentChapterName }}
    </div>

    <div class="reader-body">
      <div v-show="!chapterListHidden" class="chapter-list" :style="sideBarStyle">
        <div
          v-for="ch in store.chapters"
          :key="ch.index"
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

      <div class="chapter-content" ref="contentRef" :style="contentContainerStyle">
        <div v-if="store.displayText" class="virtual-scroll" ref="scrollRef" @scroll="onScroll" :style="scrollContainerStyle">
          <div class="scroll-padding" :style="{ height: totalHeight + 'px' }"></div>
          <div class="visible-content" :style="visibleContentStyle">
            <div
              v-for="(line, index) in visibleLines"
              :key="line.key"
              class="text-line"
              :class="{ 
                'chapter-title': line.isChapterTitle,
                'tts-highlight': line.isTtsHighlight
              }"
              v-html="line.html || line.text || '\u00A0'"
            >
            </div>
          </div>
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
import { ref, onMounted, watch, onUnmounted, nextTick, computed, toRaw } from 'vue'
import { useNovelStore } from '../stores/novel'
import { parseVoiceSegments, splitTTSChunks, hasSpeakableText } from '../utils/voiceSegments'
import { colorize, escapeHtml } from '../utils/colorizer'
import { ArrowLeft, Setting, ArrowUp, ArrowDown, VideoPlay, VideoPause, Fold, Expand } from '@element-plus/icons-vue'
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
const scrollRef = ref(null)
const importedFonts = ref([])
const systemFonts = ref([])
const topBarHidden = ref(false)
const chapterListHidden = ref(false)

const settings = ref({ ...DEFAULT_SETTINGS, ...props.settings })
watch(() => props.settings, v => { settings.value = { ...DEFAULT_SETTINGS, ...v } }, { deep: false })

const activeChapterIdx = ref(store.currentChapterIndex)

const currentChapterName = computed(() => {
  const ch = (store.chapters || [])[activeChapterIdx.value]
  return ch ? ch.title : ''
})

const displayLines = computed(() => {
  if (!store.displayText) return []
  return store.displayText.split('\n')
})

const lineHeight = computed(() => {
  const fs = settings.value.fontSize || 24
  const mult = settings.value.lineHeight || 1.5
  return Math.round(fs * mult) + 4
})

const totalHeight = computed(() => {
  return displayLines.value.length * lineHeight.value
})

const viewportHeight = ref(0)
const scrollOffset = ref(0)
const firstVisibleIndex = ref(0)
const visibleCount = ref(0)

const colorizeEnabled = computed(() => settings.value.colorize ?? true)

const colorizeCache = new Map()
let lastColorizeKey = ''

const chapterLineSet = computed(() => {
  const set = new Set()
  for (const ch of store.chapters) {
    set.add(ch.lineNumber)
  }
  return set
})

const getColorizeCacheKey = () => {
  const hw = JSON.stringify(settings.value.highlightWords || [])
  return `${colorizeEnabled.value ? '1' : '0'}_${hw}`
}

const visibleLines = computed(() => {
  const lines = displayLines.value
  const start = Math.max(0, firstVisibleIndex.value - 3)
  const end = Math.min(lines.length, start + visibleCount.value + 6)
  const result = new Array(end - start)
  const useColorize = colorizeEnabled.value
  const highlightWords = settings.value.highlightWords || []
  const chSet = chapterLineSet.value
  
  const cacheKey = getColorizeCacheKey()
  if (cacheKey !== lastColorizeKey) {
    colorizeCache.clear()
    lastColorizeKey = cacheKey
  }
  
  for (let i = start; i < end; i++) {
    const text = lines[i] || ''
    let html = ''
    if (useColorize && text) {
      const cached = colorizeCache.get(i)
      if (cached && cached.text === text) {
        html = cached.html
      } else {
        html = colorize(text, highlightWords)
        colorizeCache.set(i, { text, html })
      }
    }
    result[i - start] = {
      key: i,
      text: text || '\u00A0',
      html,
      originalIndex: i,
      isChapterTitle: chSet.has(i + 1),
      isTtsHighlight: ttsPlaying.value && i >= ttsHighlightRange.value.start && i <= ttsHighlightRange.value.end
    }
  }
  return result
})

const ttsHighlightRange = computed(() => {
  if (ttsCurrentChapterIdx.value < 0 || !ttsPlaying.value) {
    return { start: -1, end: -1 }
  }
  
  const chunkIdx = ttsCurrentChunkIndex.value
  if (chunkIdx < 0 || chunkIdx >= ttsChunks.length) {
    return { start: -1, end: -1 }
  }
  
  const chunk = ttsChunks[chunkIdx]
  if (!chunk) return { start: -1, end: -1 }
  
  return {
    start: chunk.startLine,
    end: chunk.endLine
  }
})

function isChapterTitle(lineIndex) {
  return chapterLineSet.value.has(lineIndex + 1)
}

let scrollRaf = null
let pendingScrollTop = 0
let pendingViewport = 0
let saveProgressTimer = null
const SAVE_PROGRESS_DELAY = 1000
let ttsSaveTimer = null
const TTS_SAVE_DELAY = 500

function saveCurrentProgress() {
  if (!store.currentNovel) return
  const scrollEl = scrollRef.value
  if (!scrollEl) return
  
  const scrollTop = scrollEl.scrollTop
  const currentLine = Math.floor(scrollTop / lineHeight.value)
  const progress = {
    chapterIdx: activeChapterIdx.value,
    scrollTop: scrollTop,
    physicalLine: currentLine,
    wrappedLineIndex: currentLine
  }
  
  if (ttsPlaying.value && ttsCurrentChunkIndex.value >= 0 && ttsChunks[ttsCurrentChunkIndex.value]) {
    const chunk = ttsChunks[ttsCurrentChunkIndex.value]
    progress.ttsLine = chunk.startLine
    progress.ttsChapterIdx = chunk.chapterIdx
  } else if (store.savedTtsLine != null) {
    progress.ttsLine = store.savedTtsLine
    progress.ttsChapterIdx = store.savedTtsChapterIdx
  }
  
  store.saveProgress(progress).catch(e => console.error('保存进度失败', e))
}

function scheduleSaveTtsProgress() {
  if (ttsSaveTimer) {
    clearTimeout(ttsSaveTimer)
  }
  ttsSaveTimer = setTimeout(() => {
    saveCurrentProgress()
  }, TTS_SAVE_DELAY)
}

function scheduleSaveProgress() {
  if (saveProgressTimer) {
    clearTimeout(saveProgressTimer)
  }
  saveProgressTimer = setTimeout(() => {
    saveCurrentProgress()
  }, SAVE_PROGRESS_DELAY)
}

function onScroll(e) {
  const target = e.target
  pendingScrollTop = target.scrollTop
  pendingViewport = target.clientHeight
  
  if (ttsPlaying.value && ttsAutoScrollEnabled) {
    ttsAutoScrollEnabled = false
  }
  
  scheduleSaveProgress()
  
  if (scrollRaf) return
  
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null
    const scrollTop = pendingScrollTop
    const viewport = pendingViewport
    
    viewportHeight.value = viewport
    scrollOffset.value = scrollTop
    
    const startIndex = Math.floor(scrollTop / lineHeight.value)
    const count = Math.ceil(viewport / lineHeight.value)
    
    firstVisibleIndex.value = startIndex
    visibleCount.value = count
    
    updateActiveChapter(startIndex)
  })
}

let ttsResumeScrollTimer = null
const resumeTtsAutoScroll = () => {
  if (ttsResumeScrollTimer) clearTimeout(ttsResumeScrollTimer)
  ttsResumeScrollTimer = setTimeout(() => {
    ttsAutoScrollEnabled = true
    if (ttsPlaying.value && ttsCurrentChunkIndex.value >= 0 && ttsChunks[ttsCurrentChunkIndex.value]) {
      ttsAutoScrollToCurrentChunk(ttsChunks[ttsCurrentChunkIndex.value])
    }
  }, 3000)
}

function updateActiveChapter(startLineIdx) {
  const chapters = store.chapters
  if (!chapters || chapters.length === 0) return
  
  let lo = 0
  let hi = chapters.length - 1
  let currentIdx = 0
  
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chapters[mid].lineNumber - 1 <= startLineIdx) {
      currentIdx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  
  if (currentIdx !== activeChapterIdx.value) {
    activeChapterIdx.value = currentIdx
  }
}

function jumpToChapter(idx) {
  stopTTS()
  activeChapterIdx.value = idx
  const chapter = store.chapters[idx]
  if (!chapter) return
  
  const scrollEl = scrollRef.value
  if (!scrollEl) return
  
  const targetTop = (chapter.lineNumber - 1) * lineHeight.value
  const currentIdx = activeChapterIdx.value
  const diff = Math.abs(idx - currentIdx)
  
  if (diff <= 10) {
    scrollEl.scrollTo({ top: targetTop, behavior: 'smooth' })
  } else {
    scrollEl.scrollTop = targetTop
  }
}

const contentContainerStyle = computed(() => ({
  display: 'flex',
  justifyContent: 'center',
  width: '100%',
  background: themeColors.value.bg
}))

const scrollContainerStyle = computed(() => ({
  width: settings.value.readerWidth ? `${settings.value.readerWidth}px` : '100%',
  maxWidth: '100%',
  margin: '0 auto'
}))

const visibleContentStyle = computed(() => ({
  transform: `translateY(${scrollOffset.value}px)`,
  position: 'absolute',
  top: '0px',
  left: '16px',
  right: '16px',
  width: 'calc(100% - 32px)'
}))

const progressTitle = computed(() => {
  const phase = store.importProgress.phase
  if (phase === 'formatting') return '正在排版小说...'
  if (phase === 'rebuilding') return '正在重建缓存...'
  return '正在导入小说'
})

const onBack = () => {
  stopTTS()
  saveCurrentProgress()
  emit('back')
}

const ttsPlaying = ref(false)
const ttsLoading = ref(false)
const ttsAudioCtx = ref(null)
const ttsAbortRef = ref(false)
const ttsCurrentText = ref('')
const ttsCurrentChunkIndex = ref(-1)
const ttsCurrentChapterIdx = ref(-1)
let currentSource = null
let ttsGainNode = null
let ttsScheduledEnd = 0
const PREFETCH_DEPTH = 6
const ttsPrefetchQueue = ref([])
const ttsSynthesizing = new Set()
let ttsChunks = []
let ttsAutoScrollEnabled = true
let lastAutoScrollChapter = -1
const PREFETCH_LOOKAHEAD_VOICE = 2

const synthesizeChunk = async (chunk) => {
  const result = await window.ipcRenderer.invoke('novel:edge-tts', {
    text: chunk.text,
    voice: chunk.voiceId,
    lang: 'zh-CN',
    rate: settings.value.ttsRate ?? 1,
    pitch: settings.value.ttsPitch ?? 1
  })
  if (!result.ok) return null
  return result.mp3
}

const synthesizeAndDecode = async (chunk) => {
  const mp3 = await synthesizeChunk(chunk)
  if (!mp3 || ttsAbortRef.value) return null
  if (!ttsAudioCtx.value) ttsAudioCtx.value = new (window.AudioContext || window.webkitAudioContext)()
  const ctx = ttsAudioCtx.value
  return new Promise((resolve) => {
    ctx.decodeAudioData(mp3.slice(0), (audioBuffer) => {
      const trimmed = trimAudioSilence(audioBuffer, ctx)
      resolve(trimmed)
    }, () => resolve(null))
  })
}

const trimAudioSilence = (buffer, ctx, threshold = 0.01, minSilence = 0.02) => {
  if (!buffer || buffer.length === 0) return buffer
  const sampleRate = buffer.sampleRate
  const numChannels = buffer.numberOfChannels
  const minSilenceSamples = Math.floor(minSilence * sampleRate)
  
  let start = 0
  let end = buffer.length
  
  for (let ch = 0; ch < numChannels; ch++) {
    const data = buffer.getChannelData(ch)
    let chStart = 0
    let chEnd = data.length
    
    for (let i = 0; i < data.length - minSilenceSamples; i++) {
      let above = false
      for (let j = 0; j < minSilenceSamples; j++) {
        if (Math.abs(data[i + j]) > threshold) {
          above = true
          break
        }
      }
      if (above) { chStart = i; break }
    }
    
    for (let i = data.length - 1; i >= minSilenceSamples; i--) {
      let above = false
      for (let j = 0; j < minSilenceSamples; j++) {
        if (Math.abs(data[i - j]) > threshold) {
          above = true
          break
        }
      }
      if (above) { chEnd = i + 1; break }
    }
    
    if (chStart > start) start = chStart
    if (chEnd < end) end = chEnd
  }
  
  if (start >= end) return buffer
  if (start === 0 && end === buffer.length) return buffer
  
  const newLength = end - start
  const newBuffer = ctx.createBuffer(numChannels, newLength, sampleRate)
  for (let ch = 0; ch < numChannels; ch++) {
    const oldData = buffer.getChannelData(ch)
    const newData = newBuffer.getChannelData(ch)
    newData.set(oldData.subarray(start, end))
  }
  return newBuffer
}

const ensurePrefetch = (chunks, currentIndex) => {
  if (ttsAbortRef.value) return
  
  const currentVoiceId = chunks[currentIndex]?.voiceId
  
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
  
  if (currentVoiceId) {
    for (let offset = 1; offset <= PREFETCH_LOOKAHEAD_VOICE; offset++) {
      const lookAheadIdx = currentIndex + offset
      if (lookAheadIdx >= chunks.length) break
      const lookAheadChunk = chunks[lookAheadIdx]
      if (lookAheadChunk.voiceId !== currentVoiceId) {
        const futureIdx = lookAheadIdx + 1
        if (futureIdx < chunks.length && !ttsSynthesizing.has(futureIdx)) {
          ttsSynthesizing.add(futureIdx)
          synthesizeAndDecode(chunks[futureIdx]).then(audioBuffer => {
            ttsSynthesizing.delete(futureIdx)
            if (audioBuffer && !ttsAbortRef.value) {
              if (!ttsPrefetchQueue.value.some(item => item.chunkIndex === futureIdx)) {
                ttsPrefetchQueue.value.push({ chunkIndex: futureIdx, chunk: chunks[futureIdx], audioBuffer })
              }
            }
          }).catch(() => { ttsSynthesizing.delete(futureIdx) })
        }
      }
    }
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

const buildTTSChunks = () => {
  const scheme = settings.value.ttsScheme || 'single'
  const engine = settings.value.ttsEngine || 'edge'
  const chunks = []
  const chapters = store.chapters || []
  const lines = displayLines.value
  if (!lines || lines.length === 0 || chapters.length === 0) return chunks
  
  const chapterLineSet = new Set()
  const chapterIdxByLine = new Map()
  for (let i = 0; i < chapters.length; i++) {
    const lineIdx = chapters[i].lineNumber - 1
    chapterLineSet.add(lineIdx)
    chapterIdxByLine.set(lineIdx, i)
  }
  
  let currentChapterIdx = 0
  let segmentChunkIdx = 0
  
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (chapterLineSet.has(lineIdx)) {
      currentChapterIdx = chapterIdxByLine.get(lineIdx)
      segmentChunkIdx = 0
      continue
    }
    
    const line = lines[lineIdx]
    const trimmed = line.trim()
    if (!trimmed || !hasSpeakableText(trimmed)) continue
    
    if (scheme === 'multi' && engine === 'edge') {
      const segs = parseVoiceSegments(trimmed)
      for (const s of segs) {
        if (!s.text.trim() || !hasSpeakableText(s.text)) continue
        const voiceId = s.kind === 'dialogue'
          ? (settings.value.ttsDialogueVoiceId || 'zh-CN-YunxiNeural')
          : (settings.value.ttsNarrationVoiceId || 'zh-CN-YunjianNeural')
        for (const c of splitTTSChunks(s.text)) {
          chunks.push({ 
            text: c, 
            voiceId, 
            chapterIdx: currentChapterIdx, 
            segmentChunkIdx,
            startLine: lineIdx,
            endLine: lineIdx
          })
          segmentChunkIdx++
        }
      }
    } else {
      const voiceId = settings.value.ttsVoiceId || 'zh-CN-YunjianNeural'
      for (const c of splitTTSChunks(trimmed)) {
        chunks.push({ 
          text: c, 
          voiceId, 
          chapterIdx: currentChapterIdx, 
          segmentChunkIdx,
          startLine: lineIdx,
          endLine: lineIdx
        })
        segmentChunkIdx++
      }
    }
  }
  return chunks
}

const startTTS = async (startFromCurrentPosition = true) => {
  const engine = settings.value.ttsEngine || 'edge'
  if (engine === 'system') { startSystemTTS(); return }
  ttsChunks = buildTTSChunks()
  if (ttsChunks.length === 0) {
    console.warn('TTS: 没有可朗读的内容块，请检查章节和内容是否正常')
    return
  }
  ttsPlaying.value = true
  ttsAbortRef.value = false
  ttsPrefetchQueue.value = []
  ttsSynthesizing.clear()
  ttsAutoScrollEnabled = true
  lastAutoScrollChapter = -1
  
  let startChunkIdx = 0
  
  if (startFromCurrentPosition) {
    const scrollEl = scrollRef.value
    if (scrollEl) {
      const scrollTop = scrollEl.scrollTop
      const viewportHeight = scrollEl.clientHeight
      const lh = lineHeight.value
      
      // 虚拟滚动中 visibleLines 多渲染了 3 行作为上方缓冲，
      // 实际可视区域第一行 = firstVisibleIndex - 3
      const firstLine = Math.max(0, Math.floor(scrollTop / lh) - 3)
      const lastLine = Math.ceil((scrollTop + viewportHeight) / lh) + 3
      
      const lines = displayLines.value
      const chapters = store.chapters || []
      const chapterLineSet = new Set()
      for (let i = 0; i < chapters.length; i++) {
        chapterLineSet.add(chapters[i].lineNumber - 1)
      }
      
      // 找可视区域内第一个有内容的行（非空、非章节标题、有可朗读文本）
      let firstContentLine = -1
      for (let i = firstLine; i < lastLine && i < lines.length; i++) {
        const line = lines[i] || ''
        const trimmed = line.trim()
        if (!trimmed) continue
        if (chapterLineSet.has(i)) continue
        if (hasSpeakableText(trimmed)) {
          firstContentLine = i
          break
        }
      }
      
      if (firstContentLine >= 0) {
        // 二分查找第一个 startLine >= firstContentLine 的 chunk
        let lo = 0, hi = ttsChunks.length - 1
        let found = ttsChunks.length
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (ttsChunks[mid].startLine >= firstContentLine) {
            found = mid
            hi = mid - 1
          } else {
            lo = mid + 1
          }
        }
        if (found < ttsChunks.length) {
          startChunkIdx = found
        }
      } else {
        // 可视区域内没有内容，找下面最近的
        for (let i = 0; i < ttsChunks.length; i++) {
          if (ttsChunks[i].startLine >= firstLine) {
            startChunkIdx = i
            break
          }
        }
      }
    }
  }
  
  ttsCurrentChunkIndex.value = startChunkIdx - 1
  ttsCurrentChapterIdx.value = startChunkIdx > 0 ? ttsChunks[Math.max(0, startChunkIdx - 1)].chapterIdx : 0
  
  if (!ttsAudioCtx.value) ttsAudioCtx.value = new (window.AudioContext || window.webkitAudioContext)()
  const ctx = ttsAudioCtx.value
  if (ctx.state === 'suspended') await ctx.resume()
  ttsGainNode = ctx.createGain()
  ttsGainNode.gain.value = settings.value.ttsVolume ?? 1
  ttsGainNode.connect(ctx.destination)
  ttsScheduledEnd = 0
  
  let prefillComplete = false

  for (let i = startChunkIdx; i < ttsChunks.length; i++) {
    if (ttsAbortRef.value) break
    const chunk = ttsChunks[i]
    
    ttsCurrentChunkIndex.value = i
    ttsCurrentChapterIdx.value = chunk.chapterIdx
    ttsCurrentText.value = chunk.text
    
    if (i - startChunkIdx < 3) {
      ensurePrefetch(ttsChunks, i)
    }
    
    ttsAutoScrollToCurrentChunk(chunk)
    
    if (i % 10 === 0) {
      scheduleSaveTtsProgress()
    }
    
    if (!prefillComplete) {
      await new Promise(r => setTimeout(r, 30))
    }
    
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
    
    if (i - startChunkIdx < 3) {
      prefillComplete = true
    }
    
    ensurePrefetch(ttsChunks, i)
    
    if (i < ttsChunks.length - 1 && !ttsAbortRef.value) {
      while (ctx.currentTime < ttsScheduledEnd - 0.01 && !ttsAbortRef.value) {
        await new Promise(r => setTimeout(r, 10))
      }
    }
  }

  while (ctx.currentTime < ttsScheduledEnd - 0.05 && !ttsAbortRef.value) {
    await new Promise(r => setTimeout(r, 50))
  }
  ttsPlaying.value = false
  ttsLoading.value = false
  ttsCurrentChunkIndex.value = -1
  ttsCurrentChapterIdx.value = -1
  ttsPrefetchQueue.value = []
  ttsSynthesizing.clear()
  if (ttsGainNode) { try { ttsGainNode.disconnect() } catch {} ttsGainNode = null }
}

let ttsScrollRaf = null
const ttsAutoScrollToCurrentChunk = (chunk) => {
  if (!ttsAutoScrollEnabled) return
  
  const scrollEl = scrollRef.value
  if (!scrollEl) return
  
  if (lastAutoScrollChapter !== chunk.chapterIdx) {
    lastAutoScrollChapter = chunk.chapterIdx
    activeChapterIdx.value = chunk.chapterIdx
  }
  
  if (ttsScrollRaf) return
  
  ttsScrollRaf = requestAnimationFrame(() => {
    ttsScrollRaf = null
    const scrollEl = scrollRef.value
    if (!scrollEl) return
    
    const targetLine = chunk.startLine
    const targetTop = targetLine * lineHeight.value
    const viewportHeight = scrollEl.clientHeight
    const currentScrollTop = scrollEl.scrollTop
    
    if (Math.abs(targetTop - currentScrollTop) > viewportHeight * 0.3) {
      const scrollTo = Math.max(0, targetTop - viewportHeight * 0.3)
      scrollEl.scrollTo({ top: scrollTo, behavior: 'smooth' })
    }
  })
}

const startSystemTTS = () => {
  const voiceId = settings.value.ttsVoiceId
  const chunks = buildTTSChunks()
  if (chunks.length === 0) return
  let i = 0
  ttsPlaying.value = true
  ttsAbortRef.value = false
  window.speechSynthesis.cancel()
  const speakNext = () => {
    if (ttsAbortRef.value || i >= chunks.length) { ttsPlaying.value = false; return }
    ttsCurrentText.value = chunks[i].text
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
  ttsCurrentChunkIndex.value = -1
  ttsCurrentChapterIdx.value = -1
  ttsPrefetchQueue.value = []
  ttsSynthesizing.clear()
  if (ttsAudioCtx.value) { try { ttsAudioCtx.value.close() } catch {} ttsAudioCtx.value = null }
  if (ttsGainNode) { try { ttsGainNode.disconnect() } catch {} ttsGainNode = null }
  currentSource = null
  ttsScheduledEnd = 0
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
}

const toggleTTS = () => { ttsPlaying.value ? stopTTS() : startTTS() }

const themeColors = computed(() => {
  const theme = settings.value?.theme || 'light'
  if (theme === 'dark') return { bg: '#1e1e1e', fg: '#d4d4d4', title: '#569cd6', side: '#222222', topBar: 'rgba(255,255,255,0.04)' }
  if (theme === 'white') return { bg: '#ffffff', fg: '#000000', title: '#333333', side: '#f8f8f8', topBar: 'rgba(0,0,0,0.04)' }
  if (theme === 'eye') return { bg: '#f5deb3', fg: '#5b4636', title: '#b88230', side: '#f0dcb0', topBar: 'rgba(0,0,0,0.04)' }
  if (theme === 'custom') return { bg: settings.value?.bgColor || '#f4ead7', fg: settings.value?.fgColor || '#000000', title: '#b88230', side: settings.value?.bgColor || '#f4ead7', topBar: 'rgba(0,0,0,0.04)' }
  return { bg: '#f4ead7', fg: '#000000', title: '#b88230', side: '#f0e6cf', topBar: 'rgba(0,0,0,0.04)' }
})

const readerStyle = computed(() => ({
  background: themeColors.value.bg,
  color: themeColors.value.fg,
  fontFamily: fontStack.value,
  fontSize: (settings.value.fontSize || 24) + 'px',
  lineHeight: computedLineHeight.value + 'px',
  '--reader-title-color': themeColors.value.title,
  '--reader-bg': themeColors.value.bg,
  '--line-height': lineHeight.value + 'px'
}))

const topBarStyle = computed(() => ({
  background: themeColors.value.topBar,
  borderBottomColor: 'rgba(128,128,128,0.15)'
}))

const sideBarStyle = computed(() => ({
  background: themeColors.value.side,
  borderRightColor: 'rgba(128,128,128,0.15)'
}))

const chapterTitleBarStyle = computed(() => ({
  background: themeColors.value.bg,
  color: themeColors.value.title,
  borderBottomColor: 'rgba(128,128,128,0.1)'
}))

const fontStack = computed(() => {
  const f = settings.value.fontFamily
  if (!f) return '"Microsoft YaHei", serif'
  return `"${f}", "Microsoft YaHei", serif`
})

const computedLineHeight = computed(() => {
  const fs = settings.value.fontSize || 24
  const mult = settings.value.lineHeight || 1.5
  return Math.max(1, Math.round(fs * mult))
})

const progressPercent = computed(() => {
  const p = store.importProgress
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.current / p.total) * 100))
})

const progressStatus = computed(() => store.importProgress.phase === 'done' ? 'success' : '')

const persistSettings = async () => {
  const toSave = JSON.parse(JSON.stringify(toRaw(settings.value)))
  try {
    await window.ipcRenderer.invoke('save-setting', { novel: toSave })
  } catch (e) { console.error('NovelReader: 保存设置失败', e) }
}
const flushPersistSettings = () => persistSettings()

const onSettingsChange = async (newSettings) => {
  settings.value = { ...settings.value, ...newSettings }
  emit('update-settings', newSettings)
  store.rebuildDisplayText({
    collapseBlank: settings.value.collapseBlank,
    leadIndentFullWidth: settings.value.indent > 0
  })
  persistSettings()
}

const importFont = async () => {
  const result = await window.ipcRenderer.invoke('novel:import-font-dialog')
  if (result) importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
}

watch(() => store.currentChapterIndex, (newIdx) => {
  activeChapterIdx.value = newIdx
})

watch(() => store.displayText, async () => {
  colorizeCache.clear()
  if (scrollRef.value) {
    const viewport = scrollRef.value.clientHeight
    viewportHeight.value = viewport
    visibleCount.value = Math.ceil(viewport / lineHeight.value)
  }
  
  await nextTick()
  restoreReadingPosition()
})

function restoreReadingPosition() {
  const scrollEl = scrollRef.value
  if (!scrollEl || !store.currentNovel) return
  
  const savedScrollTop = store.savedScrollTop
  const savedPhysicalLine = store.savedPhysicalLine
  
  if (savedScrollTop && savedScrollTop > 0) {
    scrollEl.scrollTop = savedScrollTop
    return
  }
  
  if (savedPhysicalLine != null && savedPhysicalLine > 0) {
    const targetTop = savedPhysicalLine * lineHeight.value
    scrollEl.scrollTop = targetTop
    return
  }
  
  if (store.currentChapterIndex >= 0) {
    const chapter = store.chapters[store.currentChapterIndex]
    if (chapter) {
      const targetTop = (chapter.lineNumber - 1) * lineHeight.value
      scrollEl.scrollTop = targetTop
    }
  }
}

watch(() => store.physicalLines, async (lines) => {
  if (!isReady || !store.currentNovel || lines.length === 0) return
  if (store.readingProgressSynced) return
  
  await store.rebuildDisplayText({
    collapseBlank: settings.value.collapseBlank,
    leadIndentFullWidth: settings.value.indent > 0
  })
}, { deep: true })

watch(() => [settings.value.collapseBlank, settings.value.indent], async ([collapseBlank, indent]) => {
  if (!isReady || !store.currentNovel || store.physicalLines.length === 0) return
  
  const savedScrollTop = scrollRef.value?.scrollTop || 0
  
  await store.rebuildDisplayText({
    collapseBlank,
    leadIndentFullWidth: indent > 0
  })
  
  await nextTick()
  
  if (scrollRef.value) {
    scrollRef.value.scrollTop = savedScrollTop
  }
})

let isReady = false

onMounted(async () => {
  isReady = true
  systemFonts.value = await window.ipcRenderer.invoke('novel:system-fonts')
  importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
  
  try {
    const latestSetting = await window.ipcRenderer.invoke('load-setting')
    if (latestSetting?.novel) {
      settings.value = { ...DEFAULT_SETTINGS, ...latestSetting.novel }
      emit('update-settings', { ...latestSetting.novel })
    }
  } catch (e) { console.warn('NovelReader: 加载最新设置失败', e) }
  
  await nextTick()
  
  if (store.physicalLines.length > 0 && store.currentNovel) {
    await store.rebuildDisplayText({
      collapseBlank: settings.value.collapseBlank,
      leadIndentFullWidth: settings.value.indent > 0
    })
  }
  
  await nextTick()
  
  if (scrollRef.value) {
    const viewport = scrollRef.value.clientHeight
    viewportHeight.value = viewport
    visibleCount.value = Math.ceil(viewport / lineHeight.value)
  }
  
  window.addEventListener('keydown', handleKeyboard)
})

onUnmounted(() => {
  stopTTS()
  saveCurrentProgress()
  flushPersistSettings()
  isReady = false
  window.removeEventListener('keydown', handleKeyboard)
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = null
  }
  if (ttsScrollRaf) {
    cancelAnimationFrame(ttsScrollRaf)
    ttsScrollRaf = null
  }
  if (saveProgressTimer) {
    clearTimeout(saveProgressTimer)
    saveProgressTimer = null
  }
  if (ttsSaveTimer) {
    clearTimeout(ttsSaveTimer)
    ttsSaveTimer = null
  }
  if (ttsResumeScrollTimer) {
    clearTimeout(ttsResumeScrollTimer)
    ttsResumeScrollTimer = null
  }
  colorizeCache.clear()
  ttsChunks = []
})

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
  
  const scrollEl = scrollRef.value
  if (!scrollEl) return
  
  const pageHeight = scrollEl.clientHeight * 0.8
  const lh = lineHeight.value || 1
  
  switch (e.key) {
    case 'PageUp':
    case 'ArrowLeft':
      e.preventDefault(); scrollEl.scrollBy({ top: -pageHeight, behavior: 'smooth' }); break
    case 'PageDown':
    case 'ArrowRight':
      e.preventDefault(); scrollEl.scrollBy({ top: pageHeight, behavior: 'smooth' }); break
    case 'ArrowUp':
      e.preventDefault(); scrollEl.scrollBy({ top: -lh * 3, behavior: 'smooth' }); break
    case 'ArrowDown':
      e.preventDefault(); scrollEl.scrollBy({ top: lh * 3, behavior: 'smooth' }); break
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

.chapter-list::-webkit-scrollbar,
.virtual-scroll::-webkit-scrollbar {
  width: 8px;
}
.chapter-list::-webkit-scrollbar-track,
.virtual-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.chapter-list::-webkit-scrollbar-thumb,
.virtual-scroll::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.15);
  border-radius: 4px;
}
.chapter-list::-webkit-scrollbar-thumb:hover,
.virtual-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.25);
}

.chapter-list {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.15) transparent;
}
.virtual-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.15) transparent;
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
  border-right: 1px solid rgba(128,128,128,0.1);
  text-align: left;
}
.chapter-list-toggle-collapsed {
  width: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-right: 1px solid rgba(128,128,128,0.1);
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
.chapter-item:hover { background: rgba(128,128,128,0.08); }
.chapter-item.active { background: rgba(184,130,48,0.15); font-weight: bold; }
.chapter-content {
  flex: 1;
  overflow: hidden;
  position: relative;
}
.chapter-title-bar {
  flex-shrink: 0;
  text-align: center;
  padding: 8px 16px;
  font-weight: 600;
  font-size: 1em;
  color: var(--reader-title-color, #b88230);
  border-bottom: 1px solid var(--reader-border-color, rgba(128,128,128,0.1));
}
.virtual-scroll {
  height: 100%;
  overflow-y: auto;
  position: relative;
  padding: 16px;
  box-sizing: border-box;
}
.scroll-padding {
  width: 1px;
  pointer-events: none;
}
.visible-content {
  position: absolute;
  top: 0;
  left: 16px;
  right: 16px;
  width: calc(100% - 32px);
}
.text-line {
  white-space: pre-wrap;
  word-break: break-word;
  text-align: left;
}
.text-line.chapter-title {
  font-size: 1.2em;
  font-weight: bold;
  text-align: center;
  margin-top: 16px;
  margin-bottom: 16px;
  color: var(--reader-title-color, #b88230);
}

.text-line :deep(.cl-quote) {
  color: #c0392b;
}
.text-line :deep(.cl-quote-single) {
  color: #8e44ad;
}
.text-line :deep(.cl-number) {
  color: #2980b9;
  font-weight: 500;
}
.text-line :deep(.cl-ellipsis) {
  color: #7f8c8d;
}
.text-line :deep(.cl-dash) {
  color: #16a085;
}
.text-line :deep(.cl-highlight) {
  background: rgba(241, 196, 15, 0.3);
  border-radius: 2px;
  padding: 0 2px;
}

.text-line.tts-highlight {
  background: rgba(241, 196, 15, 0.25);
  border-radius: 3px;
  transition: background-color 0.15s ease;
}

.text-line.tts-highlight.chapter-title {
  background: rgba(241, 196, 15, 0.35);
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
