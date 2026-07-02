<template>
  <div class="novel-library">
    <!-- 10px 固定背景色条（滚动时保持不动） -->
    <div class="library-top-gap"></div>

    <!-- 导入进度条（epub 解析时显示） -->
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

    <!-- 阅读器打开时隐藏书库内容，防止底层文本被选中 -->
    <div v-show="!store.currentNovel" class="library-content">
      <div v-if="store.loading" class="library-empty">扫描中...</div>
      <div v-else-if="store.novelList.length === 0" class="library-empty">
        还没有小说，请先在设置中添加小说库目录，再点击顶部「扫描」按钮
      </div>
      <div v-else-if="store.filteredNovelList.length === 0" class="library-empty">
        没有匹配的小说
      </div>
      <el-row v-else :gutter="20" class="library-card-area">
        <el-col :span="24" class="library-card-list">
          <div
            v-for="novel in store.paginatedNovelList"
            :key="novel.id"
            class="library-card-frame"
          >
            <NovelCard
              :novel="novel"
              @open="openNovel"
            />
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 分页栏 -->
    <el-row v-if="!store.currentNovel && store.filteredNovelList.length > 0" class="pagination-bar">
      <el-pagination
        v-model:current-page="store.currentPage"
        v-model:page-size="store.pageSize"
        :page-sizes="[12, 24, 42, 72, 500]"
        size="small"
        layout="total, sizes, prev, pager, next, jumper"
        :total="store.filteredNovelList.length"
        @size-change="handleSizeChange"
        @current-change="handleCurrentPageChange"
        background
      />
    </el-row>

    <NovelReaderMonaco
      v-if="store.currentNovel"
      :settings="novelSettings"
      @back="store.closeNovel"
      @update-settings="saveSettings"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useNovelStore } from '../stores/novel'
import NovelCard from '../components/NovelCard.vue'
import NovelReaderMonaco from '../components/NovelReaderMonaco.vue'

const store = useNovelStore()

const novelSettings = ref({})

const progressPercent = computed(() => {
  const p = store.importProgress
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.current / p.total) * 100))
})

const progressStatus = computed(() => {
  if (store.importProgress.phase === 'done') return 'success'
  return ''
})

const loadSettings = async () => {
  const setting = await window.ipcRenderer.invoke('load-setting')
  novelSettings.value = setting.novel || {}
}

const saveSettings = (newSettings) => {
  // 仅更新内存状态；持久化由 NovelReader 直接通过 IPC 完成，避免多源写入互相覆盖
  novelSettings.value = { ...novelSettings.value, ...newSettings }
}

const openNovel = async (novel) => {
  await store.openNovel(novel)
}

const scanNovelLibrary = () => store.scanNovelLibrary()
const importNovel = () => store.importNovel()
const searchNovel = (q) => {
  store.searchNovel(q)
  store.currentPage = 1
}
const shuffleNovel = () => store.shuffleNovel()
const sortNovelList = (sortBy) => store.sortNovelList(sortBy)
const rebuildCache = () => store.rebuildCache()
const handleSizeChange = (size) => store.setPageSize(size)
const handleCurrentPageChange = (page) => store.setCurrentPage(page)

defineExpose({ scanNovelLibrary, importNovel, searchNovel, shuffleNovel, sortNovelList, rebuildCache })

const handleImportProgress = (_e, progress) => {
  store.setImportProgress(progress)
}

onMounted(async () => {
  await loadSettings()
  await store.loadNovelList()
  if (window.ipcRenderer && window.ipcRenderer.on) {
    window.ipcRenderer.on('novel:import-progress', handleImportProgress)
  }
})

onBeforeUnmount(() => {
  if (window.ipcRenderer && window.ipcRenderer.removeListener) {
    window.ipcRenderer.removeListener('novel:import-progress', handleImportProgress)
  }
})
</script>

<style scoped>
.novel-library {
  width: 100%;
  height: 100%;
  overflow: hidden;
  padding: 16px;
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
}
.library-content {
  flex: 1;
  overflow: hidden;
}
.library-empty {
  text-align: center;
  padding: 80px 16px;
  color: #888;
}
.library-card-area {
  height: 100%;
  overflow-x: hidden;
  overflow-y: hidden;
  justify-content: center;
  .library-card-list {
    height: 100%;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-content: flex-start;
    overflow-y: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    &::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }
  }
}
.library-card-frame {
  min-width: 234px;
  min-height: 340px;
  display: inline-block;
}
.pagination-bar {
  margin: 4px 0;
  justify-content: center;
  .el-pagination--small .el-select {
    width: 110px;
    .el-select__wrapper {
      text-align: center;
    }
  }
}
.import-progress-overlay {
  position: fixed;
  top: 60px;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
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
