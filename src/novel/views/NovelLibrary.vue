<template>
  <div class="novel-library">
    <el-row class="library-top-bar" :gutter="20">
      <el-col :span="2" :offset="2">
        <el-button-group>
          <el-button :icon="Reading" @click="$emit('switch', 'manga')" title="漫画"></el-button>
          <el-button type="primary" :icon="Document" title="小说"></el-button>
        </el-button-group>
      </el-col>
      <el-col :span="6">
        <el-button type="primary" @click="store.scanNovelLibrary" :icon="Refresh">扫描小说库</el-button>
        <el-button @click="store.importNovel" :icon="Plus">导入单本</el-button>
      </el-col>
    </el-row>

    <div v-if="store.loading" class="library-empty">扫描中...</div>
    <div v-else-if="store.novelList.length === 0" class="library-empty">
      还没有小说，请先在设置中添加小说库目录，再点击「扫描小说库」
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
import { Plus, Refresh, Reading, Document } from '@element-plus/icons-vue'
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

onMounted(async () => {
  await loadSettings()
  await store.loadNovelList()
})
</script>

<style scoped>
.novel-library {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  box-sizing: border-box;
}
.library-top-bar {
  margin-bottom: 12px;
}
.library-toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
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
