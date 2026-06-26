import { defineStore } from 'pinia'

export const useNovelStore = defineStore('novel', {
  state: () => ({
    novelList: [],
    currentNovel: null,
    currentChapterIndex: 0,
    currentChapterText: '',
    chapters: [],
    loading: false
  }),
  actions: {
    async loadNovelList() {
      this.loading = true
      try {
        this.novelList = await window.ipcRenderer.invoke('novel:list')
      } finally {
        this.loading = false
      }
    },
    async importNovel() {
      const result = await window.ipcRenderer.invoke('novel:import-dialog')
      if (!result) return
      await this.loadNovelList()
    },
    async openNovel(novel) {
      this.currentNovel = novel
      this.chapters = await window.ipcRenderer.invoke('novel:chapters', novel.id)
      const progress = novel.readProgress || { chapterIdx: 0, charOffset: 0 }
      this.currentChapterIndex = progress.chapterIdx
      await this.loadChapter(this.currentChapterIndex)
    },
    async loadChapter(idx) {
      if (!this.currentNovel) return
      this.currentChapterIndex = idx
      this.currentChapterText = await window.ipcRenderer.invoke('novel:read-chapter', this.currentNovel.id, idx)
      // 保存进度
      await window.ipcRenderer.invoke('novel:save-progress', this.currentNovel.id, { chapterIdx: idx, charOffset: 0 })
    },
    async closeNovel() {
      this.currentNovel = null
      this.chapters = []
      this.currentChapterText = ''
      this.currentChapterIndex = 0
    }
  }
})
