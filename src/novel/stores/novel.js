import { defineStore } from 'pinia'
import { shuffle as _shuffle } from 'lodash'
import {
  formatPhysicalLinesForReader
} from '../utils/readerDisplayPipeline'

const LINE_BREAK_RE = /\r\n|\r|\n/g

function normalizeTextDecoderEncoding (encoding) {
  const enc = String(encoding || 'utf-8').trim().toLowerCase().replace(/_/g, '-')
  if (enc === 'gb2312' || enc === 'gbk' || enc === 'gb18030' || enc === 'hz-gb-2312') return 'gb18030'
  if (enc === 'utf8' || enc === 'utf-8-bom') return 'utf-8'
  if (enc === 'unicode' || enc === 'utf16' || enc === 'utf-16') return 'utf-16le'
  return enc || 'utf-8'
}

function decodeAndSplitBuffer (buffer, encoding = 'utf-8') {
  const decoder = new TextDecoder(normalizeTextDecoderEncoding(encoding), { fatal: false })
  const text = decoder.decode(buffer)
  const normalized = text.replace(LINE_BREAK_RE, '\n')
  const lines = normalized.length > 0 ? normalized.split('\n') : []
  return { text, normalized, physicalLines: lines }
}

const NOVEL_PAGE_SIZE_KEY = 'novelPageSize'

export const useNovelStore = defineStore('novel', {
  state: () => ({
    novelList: [],
    currentNovel: null,
    currentChapterIndex: 0,
    chapters: [],
    loading: false,
    searchQuery: '',
    savedScrollTop: 0,
    savedPhysicalLine: null,
    savedWrappedLineIndex: 0,
    savedTtsLine: null,
    savedTtsChapterIdx: null,
    sortBy: '',
    fullText: '',
    physicalLines: [],
    displayText: '',
    displayLineToPhysicalLine: [],
    chapterDisplayLines: [],
    chapterTitleDisplayLineByPhysical: new Map(),
    readingProgressSynced: false,
    importing: false,
    importProgress: { phase: '', current: 0, total: 0, message: '' },
    loadError: '',
    formattingDisplay: false,
    pageSize: parseInt(localStorage.getItem(NOVEL_PAGE_SIZE_KEY)) || 24,
    currentPage: 1,
  }),
  getters: {
    filteredNovelList(state) {
      const q = (state.searchQuery || '').trim().toLowerCase()
      if (!q) return state.novelList
      return state.novelList.filter(n => {
        const title = (n.title || '').toLowerCase()
        const author = (n.author || '').toLowerCase()
        return title.includes(q) || author.includes(q)
      })
    },
    paginatedNovelList(state) {
      const list = this.filteredNovelList
      const start = (state.currentPage - 1) * state.pageSize
      return list.slice(start, start + state.pageSize)
    },
    totalPages(state) {
      return Math.ceil(this.filteredNovelList.length / state.pageSize)
    }
  },
  actions: {
    async loadNovelList() {
      this.loading = true
      this.loadError = ''
      try {
        this.novelList = await window.ipcRenderer.invoke('novel:list', { sortBy: this.sortBy })
      } catch (e) {
        console.error('loadNovelList failed:', e)
        this.loadError = e?.message || '加载小说列表失败'
        this.novelList = []
      } finally {
        this.loading = false
      }
    },
    searchNovel(query) {
      this.searchQuery = query || ''
    },
    shuffleNovel() {
      this.novelList = _shuffle(this.novelList)
    },
    sortNovelList(sortBy) {
      this.sortBy = sortBy || ''
      this.currentPage = 1
      this.loadNovelList()
    },
    setPageSize(pageSize) {
      this.pageSize = pageSize
      localStorage.setItem(NOVEL_PAGE_SIZE_KEY, pageSize)
      this.currentPage = 1
    },
    setCurrentPage(page) {
      this.currentPage = page
    },
    async importNovel() {
      this.importing = true
      this.importProgress = { phase: 'starting', current: 0, total: 100, message: '准备导入...' }
      try {
        const result = await window.ipcRenderer.invoke('novel:import-dialog')
        if (!result) return
        await this.loadNovelList()
      } finally {
        setTimeout(() => { this.importing = false }, 500)
      }
    },
    setImportProgress(progress) {
      this.importProgress = progress || { phase: '', current: 0, total: 0, message: '' }
    },
    async scanNovelLibrary() {
      this.loading = true
      try {
        await window.ipcRenderer.invoke('novel:scan-library')
        await this.loadNovelList()
      } finally {
        this.loading = false
      }
    },
    async rebuildCache() {
      this.loading = true
      this.importing = true
      this.importProgress = { phase: 'rebuilding', current: 0, total: 100, message: '正在重建缓存...' }
      try {
        await window.ipcRenderer.invoke('novel:rebuild-cache')
        await this.loadNovelList()
      } finally {
        this.loading = false
        setTimeout(() => { this.importing = false }, 500)
      }
    },
    async clearAllNovels() {
      this.loading = true
      try {
        await window.ipcRenderer.invoke('novel:clear-all')
        this.novelList = []
        this.currentNovel = null
        this.chapters = []
        this.currentChapterIndex = 0
        this.savedScrollTop = 0
      } finally {
        this.loading = false
      }
    },
    async openNovel(novel) {
      this.currentNovel = novel
      this.readingProgressSynced = false
      this.loadError = ''
      try {
        const fresh = await window.ipcRenderer.invoke('novel:get-progress', novel.id)
        const progress = fresh || novel.readProgress || { chapterIdx: 0, scrollTop: 0 }
        this.currentChapterIndex = progress.chapterIdx || 0
        this.savedScrollTop = progress.scrollTop || 0
        this.savedPhysicalLine = progress.physicalLine ?? null
        this.savedWrappedLineIndex = progress.wrappedLineIndex || 0
        this.savedTtsLine = progress.ttsLine ?? null
        this.savedTtsChapterIdx = progress.ttsChapterIdx ?? null
        await this.loadFullText()
      } catch (e) {
        console.error('openNovel failed:', e)
        this.loadError = e?.message || '打开小说失败'
      }
    },
    async loadFullText() {
      if (!this.currentNovel) return
      this.loading = true
      this.loadError = ''
      try {
        const { buffer, encoding } = await window.ipcRenderer.invoke('novel:read-full-text', this.currentNovel.id)
        const { text, physicalLines } = decodeAndSplitBuffer(buffer, encoding || 'utf-8')
        this.fullText = text || ''
        this.physicalLines = physicalLines || []
      } catch (e) {
        console.error('loadFullText failed:', e)
        this.fullText = ''
        this.physicalLines = []
        this.displayText = ''
        this.loadError = e?.message || '加载小说内容失败'
        throw e
      } finally {
        this.loading = false
      }
    },
    async rebuildDisplayText(options = {}) {
      const collapseBlank = options.collapseBlank ?? true
      const leadIndentFullWidth = options.leadIndentFullWidth ?? false
      const minCharCount = options.minCharCount ?? 100
      
      this.formattingDisplay = true
      const total = Math.max(1, this.physicalLines.length)
      this.importProgress = {
        phase: 'formatting',
        current: 0,
        total,
        message: '正在排版小说...'
      }
      
      try {
        const result = await formatPhysicalLinesForReader(this.physicalLines, {
          compressBlankLines: collapseBlank,
          compressBlankKeepOneBlank: collapseBlank,
          leadIndentFullWidth,
          minCharCount
        }, (current, totalLines) => {
          this.importProgress = {
            phase: 'formatting',
            current,
            total: totalLines,
            message: `正在排版... ${Math.round(current / totalLines * 100)}%`
          }
        })

        this.displayText = result.text
        this.displayLineToPhysicalLine = result.displayLineToPhysicalLine
        this.chapterTitleDisplayLineByPhysical = result.chapterTitleDisplayLineByPhysical

        this.chapters = result.chapters.map((c, i) => ({
          index: i,
          title: c.title,
          lineNumber: c.lineNumber,
          charCount: c.charCount,
          physicalLine: 0,
          startOffset: c.startOffset,
          endOffset: c.endOffset
        }))

        this.chapterDisplayLines = this.chapters.map(ch => ({
          index: ch.index,
          title: ch.title,
          physicalLine: ch.lineNumber,
          displayLine: ch.lineNumber
        }))

        const savedIdx = this.currentChapterIndex
        this.currentChapterIndex = Math.max(0, Math.min(savedIdx, this.chapters.length - 1))

        this.importProgress = {
          phase: 'done',
          current: total,
          total,
          message: '排版完成'
        }
      } catch (e) {
        console.error('rebuildDisplayText failed:', e)
        this.loadError = e?.message || '排版小说失败'
        throw e
      } finally {
        this.formattingDisplay = false
      }
    },
    async loadChapter(idx) {
      if (!this.currentNovel) return
      this.currentChapterIndex = idx
    },
    async saveProgress(progress) {
      if (!this.currentNovel) return
      await window.ipcRenderer.invoke('novel:save-progress', this.currentNovel.id, progress)
    },
    async closeNovel() {
      this.currentNovel = null
      this.chapters = []
      this.currentChapterIndex = 0
      this.savedScrollTop = 0
      this.savedPhysicalLine = null
      this.savedWrappedLineIndex = 0
      this.savedTtsLine = null
      this.savedTtsChapterIdx = null
      this.fullText = ''
      this.physicalLines = []
      this.displayText = ''
      this.displayLineToPhysicalLine = []
      this.chapterDisplayLines = []
      this.chapterTitleDisplayLineByPhysical = new Map()
      this.readingProgressSynced = false
      this.loadError = ''
    }
  }
})
