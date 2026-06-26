<template>
  <div class="novel-card" @click="$emit('open', novel)">
    <div class="novel-cover">
      <img v-if="novel.coverPath" :src="coverUrl" :alt="novel.title" />
      <div v-else class="novel-cover-placeholder">
        <el-icon :size="40"><BookRound /></el-icon>
      </div>
    </div>
    <div class="novel-info">
      <div class="novel-title" :title="novel.title">{{ novel.title }}</div>
      <div class="novel-meta">
        {{ novel.chapterCount }} 章 · {{ novel.type.toUpperCase() }}
      </div>
      <div class="novel-progress" v-if="novel.readProgress && novel.readProgress.chapterIdx > 0">
        读至第 {{ novel.readProgress.chapterIdx + 1 }} 章
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { BookRound } from '@vicons/material'

const props = defineProps({
  novel: { type: Object, required: true }
})

defineEmits(['open'])

const coverUrl = computed(() => {
  if (!props.novel.coverPath) return ''
  // coverPath 是本地绝对路径，通过 file:// 协议加载
  return 'file:///' + props.novel.coverPath.replace(/\\/g, '/')
})
</script>

<style scoped>
.novel-card {
  background: #252525;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  height: 280px;
}
.novel-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 16px rgba(0,0,0,0.4);
}
.novel-cover {
  width: 100%;
  height: 200px;
  background: #111;
  display: flex;
  align-items: center;
  justify-content: center;
}
.novel-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.novel-cover-placeholder {
  color: #666;
}
.novel-info {
  padding: 10px;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.novel-title {
  font-size: 14px;
  color: #fff;
  line-height: 1.4;
  max-height: 2.8em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.novel-meta {
  font-size: 11px;
  color: #999;
}
.novel-progress {
  font-size: 11px;
  color: #3b82f6;
}
</style>
