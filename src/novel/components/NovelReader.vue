<template>
  <div class="novel-reader" :style="readerStyle">
    <div class="reader-top-bar">
      <el-button @click="$emit('back')" :icon="ArrowLeft">返回</el-button>
      <div class="reader-title" v-if="settings.stickyChapterTitle">
        {{ currentChapterTitle }}
      </div>
      <el-button @click="settingsVisible = true" :icon="Setting">设置</el-button>
    </div>

    <div class="reader-body">
      <div class="chapter-list">
        <div
          v-for="ch in store.chapters"
          :key="ch.id"
          class="chapter-item"
          :class="{ active: ch.index === store.currentChapterIndex }"
          @click="store.loadChapter(ch.index)"
        >
          {{ ch.title }}
        </div>
      </div>

      <div class="chapter-content" ref="contentRef" :style="contentStyle">
        <div v-if="settings.colorize" v-html="renderedHtml"></div>
        <div v-else class="plain-text">{{ renderedText }}</div>

        <div class="chapter-nav">
          <el-button @click="prevChapter" :disabled="store.currentChapterIndex <= 0">上一章</el-button>
          <el-button @click="nextChapter" :disabled="store.currentChapterIndex >= store.chapters.length - 1">下一章</el-button>
        </div>
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
watch(() => props.settings, v => { settings.value = { ...v } })

const currentChapterTitle = computed(() => {
  const ch = store.chapters[store.currentChapterIndex]
  return ch ? ch.title : ''
})

const processedText = computed(() => {
  let text = store.currentChapterText || ''
  if (settings.value.collapseBlank) text = collapseBlankLines(text)
  if (settings.value.indent) text = applyIndent(text, settings.value.indent)
  return text
})

const renderedHtml = computed(() => {
  return colorize(processedText.value, settings.value.highlightWords || [])
})

const renderedText = computed(() => processedText.value)

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
    fontSize: settings.value.fontSize + 'px',
    lineHeight: settings.value.lineHeight
  }
})

const fontStack = computed(() => {
  const f = settings.value.fontFamily
  if (!f) return 'inherit'
  return `"${f}", serif`
})

const contentStyle = computed(() => ({
  maxWidth: settings.value.readerWidth + 'px',
  margin: '0 auto'
}))

const prevChapter = () => {
  if (store.currentChapterIndex > 0) {
    store.loadChapter(store.currentChapterIndex - 1)
    nextTick(() => { contentRef.value && (contentRef.value.scrollTop = 0) })
  }
}
const nextChapter = () => {
  if (store.currentChapterIndex < store.chapters.length - 1) {
    store.loadChapter(store.currentChapterIndex + 1)
    nextTick(() => { contentRef.value && (contentRef.value.scrollTop = 0) })
  }
}

const onSettingsChange = (newSettings) => {
  settings.value = newSettings
  emit('update-settings', newSettings)
}

const importFont = async () => {
  const result = await window.ipcRenderer.invoke('novel:import-font-dialog')
  if (result) {
    importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
  }
}

onMounted(async () => {
  systemFonts.value = await window.ipcRenderer.invoke('novel:system-fonts')
  importedFonts.value = await window.ipcRenderer.invoke('novel:imported-fonts')
})
</script>

<style scoped>
.novel-reader {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.reader-top-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: rgba(0,0,0,0.05);
  border-bottom: 1px solid rgba(0,0,0,0.1);
}
.reader-title {
  flex: 1;
  font-size: 14px;
  text-align: center;
}
.reader-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.chapter-list {
  width: 240px;
  overflow-y: auto;
  border-right: 1px solid rgba(0,0,0,0.1);
  padding: 8px 0;
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
  white-space: pre-wrap;
  word-break: break-word;
}
.plain-text { white-space: pre-wrap; }
.chapter-nav {
  display: flex;
  justify-content: space-between;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid rgba(0,0,0,0.1);
}

/* 上色 class */
:deep(.cl-quote) { color: #d97706; }
:deep(.cl-quote-single) { color: #d97706; }
:deep(.cl-number) { color: #2563eb; }
:deep(.cl-ellipsis) { color: #6b7280; }
:deep(.cl-dash) { color: #6b7280; }
:deep(.cl-highlight) { background: #fde68a; padding: 0 2px; border-radius: 2px; }
</style>
