<template>
  <div class="novel-reader-overlay" :style="readerStyle">
    <div class="reader-top-bar">
      <el-button @click="$emit('back')" :icon="ArrowLeft" size="small">返回书库</el-button>
      <div class="reader-title">{{ store.currentNovel?.title }}</div>
      <el-button @click="settingsVisible = true" :icon="Setting" size="small">设置</el-button>
    </div>

    <div class="reader-body">
      <div class="chapter-list">
        <div
          v-for="ch in store.chapters"
          :key="ch.id"
          class="chapter-item"
          :class="{ active: ch.index === store.currentChapterIndex }"
          @click="jumpToChapter(ch.index)"
        >
          {{ ch.title }}
        </div>
      </div>

      <div class="chapter-content" ref="contentRef" :style="contentStyle" @scroll="onScroll">
        <div
          v-for="(seg, i) in loadedChapters"
          :key="i"
          class="chapter-segment"
        >
          <div class="segment-title" v-if="settings.stickyChapterTitle !== false">{{ seg.title }}</div>
          <div v-if="settings.colorize" v-html="seg.html"></div>
          <div v-else class="plain-text">{{ seg.text }}</div>
        </div>
        <div v-if="loadingMore" class="loading-more">加载下一章...</div>
        <div v-if="noMore" class="loading-more">已是最后一章</div>
      </div>
    </div>

    <ReaderSettings
      v-model="settingsVisible"
      :settings="settings"
      :imported-fonts="importedFonts"
      :system-fonts="systemFonts"
      @change="onSettingsChange"
      @import-font="importFont"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { ArrowLeft, Setting } from '@element-plus/icons-vue'
import { useNovelStore } from '../stores/novel'
import { colorize } from '../utils/colorizer'
import { applyIndent, collapseBlankLines } from '../utils/text-format'
import ReaderSettings from './ReaderSettings.vue'

const props = defineProps({
  settings: { type: Object, required: true }
})
const emit = defineEmits(['back', 'update-settings'])

const store = useNovelStore()
const settingsVisible = ref(false)
const contentRef = ref(null)
const importedFonts = ref([])
const systemFonts = ref([])

const settings = ref({ ...props.settings })
watch(() => props.settings, v => { settings.value = { ...v } }, { deep: true })

// 流式加载：已加载的章节段
const loadedChapters = ref([])
const loadingMore = ref(false)
const noMore = ref(false)

const processText = (text) => {
  let t = text || ''
  if (settings.value.collapseBlank) t = collapseBlankLines(t)
  if (settings.value.indent) t = applyIndent(t, settings.value.indent)
  return t
}

const buildSegment = (title, text) => {
  const processed = processText(text)
  return {
    title,
    text: processed,
    html: colorize(processed, settings.value.highlightWords || [])
  }
}

// 加载指定章节并重置流式列表
const jumpToChapter = async (idx) => {
  await store.loadChapter(idx)
  loadedChapters.value = [buildSegment(store.chapters[idx]?.title || '', store.currentChapterText)]
  noMore.value = idx >= store.chapters.length - 1
  nextTick(() => { contentRef.value && (contentRef.value.scrollTop = 0) })
}

// 流式加载下一章
const loadNext = async () => {
  if (loadingMore.value || noMore.value) return
  const nextIdx = store.currentChapterIndex + loadedChapters.value.length
  if (nextIdx >= store.chapters.length) {
    noMore.value = true
    return
  }
  loadingMore.value = true
  try {
    const text = await window.ipcRenderer.invoke('novel:read-chapter', store.currentNovel.id, nextIdx)
    loadedChapters.value.push(buildSegment(store.chapters[nextIdx]?.title || '', text))
  } finally {
    loadingMore.value = false
  }
}

const onScroll = () => {
  const el = contentRef.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
    loadNext()
  }
}

const readerStyle = computed(() => {
  const theme = settings.value.theme
  let bg = '#f5deb3', fg = '#5b4636'
  if (theme === 'light') { bg = '#fff'; fg = '#333' }
  else if (theme === 'dark') { bg = '#1a1a1a'; fg = '#eee' }
  else if (theme === 'custom') { bg = settings.value.bgColor; fg = settings.value.fgColor }
  return {
    background: bg,
    color: fg,
    fontFamily: fontStack.value,
    fontSize: (settings.value.fontSize || 18) + 'px',
    lineHeight: settings.value.lineHeight || 1.8
  }
})

const fontStack = computed(() => {
  const f = settings.value.fontFamily
  if (!f) return 'inherit'
  return `"${f}", "Microsoft YaHei", serif`
})

const contentStyle = computed(() => ({
  maxWidth: (settings.value.readerWidth || 800) + 'px',
  margin: '0 auto'
}))

const onSettingsChange = (newSettings) => {
  settings.value = newSettings
  // 重新渲染已加载章节
  loadedChapters.value = loadedChapters.value.map(seg => buildSegment(seg.title, seg.text))
  emit('update-settings', newSettings)
}

const importFont = async () => {
  const result = await window.ipcRenderer.invoke('novel:import-font-dialog')
  if (result) {
    importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
  }
}

// 初始化：加载当前章节
const initChapter = async () => {
  if (store.currentNovel && store.currentChapterText) {
    loadedChapters.value = [buildSegment(
      store.chapters[store.currentChapterIndex]?.title || '',
      store.currentChapterText
    )]
    noMore.value = store.currentChapterIndex >= store.chapters.length - 1
  }
}

onMounted(async () => {
  systemFonts.value = await window.ipcRenderer.invoke('novel:system-fonts')
  importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
  await initChapter()
})

// 监听 store 章节变化（首次打开书时）
watch(() => store.currentChapterText, () => {
  if (loadedChapters.value.length === 0) {
    initChapter()
  }
})
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
}
.reader-top-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  background: rgba(0,0,0,0.08);
  border-bottom: 1px solid rgba(0,0,0,0.1);
  flex-shrink: 0;
}
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
}
.chapter-list {
  width: 220px;
  overflow-y: auto;
  border-right: 1px solid rgba(0,0,0,0.1);
  padding: 8px 0;
  flex-shrink: 0;
}
.chapter-item {
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
}
.chapter-item:hover { background: rgba(0,0,0,0.05); }
.chapter-item.active { background: rgba(59,130,246,0.2); font-weight: bold; }
.chapter-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 48px 80px;
}
.chapter-segment {
  margin-bottom: 48px;
}
.segment-title {
  font-size: 1.2em;
  font-weight: bold;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(128,128,128,0.2);
}
.plain-text { white-space: pre-wrap; }
.loading-more {
  text-align: center;
  padding: 24px;
  color: rgba(128,128,128,0.6);
  font-size: 13px;
}

/* 上色 class */
:deep(.cl-quote) { color: #d97706; }
:deep(.cl-quote-single) { color: #d97706; }
:deep(.cl-number) { color: #2563eb; }
:deep(.cl-ellipsis) { color: #6b7280; }
:deep(.cl-dash) { color: #6b7280; }
:deep(.cl-highlight) { background: #fde68a; padding: 0 2px; border-radius: 2px; }
</style>
