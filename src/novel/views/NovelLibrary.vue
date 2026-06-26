<template>
  <div class="novel-library">
    <div v-if="store.loading" class="library-empty">扫描中...</div>
    <div v-else-if="store.novelList.length === 0" class="library-empty">
      还没有小说，请先在设置中添加小说库目录，再点击顶部「扫描」按钮
    </div>
    <div v-else class="library-grid">
      <NovelCard
        v-for="novel in store.novelList"
        :key="novel.id"
        :novel="novel"
        @open="openNovel"
      />
    </div>

    <NovelReader
      v-if="store.currentNovel"
      :settings="novelSettings"
      @back="store.closeNovel"
      @update-settings="saveSettings"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useNovelStore } from '../stores/novel'
import NovelCard from '../components/NovelCard.vue'
import NovelReader from '../components/NovelReader.vue'

const store = useNovelStore()

const novelSettings = ref({})

const loadSettings = async () => {
  const setting = await window.ipcRenderer.invoke('load-setting')
  novelSettings.value = setting.novel || {}
}

const saveSettings = async (newSettings) => {
  novelSettings.value = newSettings
  await window.ipcRenderer.invoke('save-setting', { novel: newSettings })
}

const openNovel = async (novel) => {
  await store.openNovel(novel)
}

const scanNovelLibrary = () => store.scanNovelLibrary()
const importNovel = () => store.importNovel()

defineExpose({ scanNovelLibrary, importNovel })

onMounted(async () => {
  await loadSettings()
  await store.loadNovelList()
})
</script>

<style scoped>
.novel-library {
  width: 100%;
  height: calc(100vh - 60px);
  overflow-y: auto;
  padding: 16px;
  box-sizing: border-box;
}
.library-empty {
  text-align: center;
  padding: 80px 16px;
  color: #888;
}
.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
}
</style>
