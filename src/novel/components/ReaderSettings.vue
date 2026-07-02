<template>
  <el-drawer v-model="visible" title="阅读设置" direction="rtl" size="360px" @closed="handleClose" class="reader-settings-drawer">
    <el-form label-position="top" size="small">
      <el-form-item label="字体来源">
        <el-radio-group v-model="local.fontSource" @change="handleChange">
          <el-radio-button label="builtin">内置</el-radio-button>
          <el-radio-button label="import">导入</el-radio-button>
          <el-radio-button label="system">系统</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="字体" v-if="local.fontSource === 'builtin'">
        <el-select v-model="local.fontFamily" @change="handleChange" style="width:100%">
          <el-option label="京華老宋体" value="JingHuaLaoSongTi" />
          <el-option label="霞鹜文楷" value="LXGWWenKai" />
          <el-option label="浪漫雅圆" value="LangManYaYuan" />
        </el-select>
      </el-form-item>

      <el-form-item label="字体" v-if="local.fontSource === 'import'">
        <el-select v-model="local.fontFamily" @change="handleChange" style="width:100%">
          <el-option v-for="f in importedFonts" :key="f" :label="f" :value="f" />
        </el-select>
        <el-button size="small" @click="$emit('import-font')" style="margin-top:8px">+ 导入字体</el-button>
      </el-form-item>

      <el-form-item label="字体" v-if="local.fontSource === 'system'">
        <el-select v-model="local.fontFamily" @change="handleChange" style="width:100%" filterable>
          <el-option v-for="f in systemFonts" :key="f" :label="f" :value="f" />
        </el-select>
      </el-form-item>

      <el-form-item label="字号">
        <el-slider
          :model-value="local.fontSize"
          @update:model-value="val => { local.fontSize = val; handleChange() }"
          :min="12" :max="48" :step="1"
          show-input
        />
      </el-form-item>

      <el-form-item label="行高">
        <el-slider
          :model-value="local.lineHeight"
          @update:model-value="val => { local.lineHeight = val; handleChange() }"
          :min="1" :max="3" :step="0.1"
          show-input
        />
      </el-form-item>

      <el-form-item label="行首缩进">
        <el-radio-group v-model="local.indent" @change="handleChange">
          <el-radio-button :label="0">无</el-radio-button>
          <el-radio-button :label="2">2 字符</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="空行压缩">
        <el-switch v-model="local.collapseBlank" @change="handleChange" />
      </el-form-item>

      <el-form-item label="配色主题">
        <el-radio-group v-model="local.theme" @change="handleChange">
          <el-radio-button label="light">亮色</el-radio-button>
          <el-radio-button label="white">白底</el-radio-button>
          <el-radio-button label="dark">暗色</el-radio-button>
          <el-radio-button label="eye">护眼</el-radio-button>
          <el-radio-button label="custom">自定义</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="local.theme === 'custom'">
        <el-form-item label="背景色">
          <el-color-picker v-model="local.bgColor" @change="handleChange" />
        </el-form-item>
        <el-form-item label="文字色">
          <el-color-picker v-model="local.fgColor" @change="handleChange" />
        </el-form-item>
      </template>

      <el-form-item label="内容上色">
        <el-switch v-model="local.colorize" @change="handleChange" />
      </el-form-item>

      <el-form-item label="章节标题常驻">
        <el-switch v-model="local.stickyChapterTitle" @change="handleChange" />
      </el-form-item>

      <el-form-item label="阅读区宽度">
        <el-slider v-model="local.readerWidth" :min="600" :max="1200" :step="50" @change="handleChange" @input="handleChange" show-input />
      </el-form-item>

      <el-divider content-position="left">语音朗读</el-divider>

      <el-form-item label="引擎">
        <el-radio-group v-model="local.ttsEngine" @change="handleChange">
          <el-radio-button label="edge">Edge TTS</el-radio-button>
          <el-radio-button label="system">系统语音</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="朗读方案" v-if="local.ttsEngine === 'edge'">
        <el-radio-group v-model="local.ttsScheme" @change="handleChange">
          <el-radio-button label="single">单音色</el-radio-button>
          <el-radio-button label="multi">旁白/对白</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <!-- 单音色方案：Edge -->
      <template v-if="local.ttsEngine === 'edge' && local.ttsScheme === 'single'">
        <el-form-item label="音色">
          <el-select v-model="local.ttsVoiceId" @change="handleChange" style="width:100%" popper-class="tts-voice-select-dropdown">
            <el-option
              v-for="v in edgeVoices"
              :key="v.id"
              :label="`${v.label} - ${v.description}`"
              :value="v.id"
            />
          </el-select>
        </el-form-item>
      </template>

      <!-- 多音色方案：Edge -->
      <template v-if="local.ttsEngine === 'edge' && local.ttsScheme === 'multi'">
        <el-form-item label="旁白音色">
          <el-select v-model="local.ttsNarrationVoiceId" @change="handleChange" style="width:100%" popper-class="tts-voice-select-dropdown">
            <el-option v-for="v in edgeVoices" :key="v.id" :label="`${v.label} - ${v.description}`" :value="v.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="对白音色">
          <el-select v-model="local.ttsDialogueVoiceId" @change="handleChange" style="width:100%" popper-class="tts-voice-select-dropdown">
            <el-option v-for="v in edgeVoices" :key="v.id" :label="`${v.label} - ${v.description}`" :value="v.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="对白男声">
          <el-select v-model="local.ttsDialogueMaleVoiceId" @change="handleChange" style="width:100%" popper-class="tts-voice-select-dropdown">
            <el-option v-for="v in edgeVoices.filter(x => x.gender === 'male')" :key="v.id" :label="`${v.label} - ${v.description}`" :value="v.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="对白女声">
          <el-select v-model="local.ttsDialogueFemaleVoiceId" @change="handleChange" style="width:100%" popper-class="tts-voice-select-dropdown">
            <el-option v-for="v in edgeVoices.filter(x => x.gender === 'female')" :key="v.id" :label="`${v.label} - ${v.description}`" :value="v.id" />
          </el-select>
        </el-form-item>
      </template>

      <!-- 系统语音引擎 -->
      <el-form-item label="音色" v-if="local.ttsEngine === 'system'">
        <el-select v-model="local.ttsVoiceId" @change="handleChange" style="width:100%" filterable clearable placeholder="系统默认">
          <el-option v-for="v in systemVoices" :key="v.voiceURI" :label="`${v.name} (${v.lang})`" :value="v.voiceURI" />
        </el-select>
      </el-form-item>

      <el-form-item label="语速">
        <el-slider v-model="local.ttsRate" :min="0.5" :max="2" :step="0.05" @change="handleChange" @input="handleChange" show-input />
      </el-form-item>

      <el-form-item label="音调">
        <el-slider v-model="local.ttsPitch" :min="0.5" :max="2" :step="0.05" @change="handleChange" @input="handleChange" show-input />
      </el-form-item>

      <el-form-item label="音量">
        <el-slider v-model="local.ttsVolume" :min="0" :max="1" :step="0.05" @change="handleChange" @input="handleChange" show-input />
      </el-form-item>
    </el-form>
  </el-drawer>
</template>

<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  settings: { type: Object, required: true },
  importedFonts: { type: Array, default: () => [] },
  systemFonts: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'change', 'import-font', 'close'])

// 完整默认设置，用作合并 base 防止丢字段
const DEFAULT_SETTINGS = {
  fontSource: 'builtin', fontFamily: 'JingHuaLaoSongTi', fontSize: 24, lineHeight: 1.5,
  indent: 0, collapseBlank: true, theme: 'light', bgColor: '#f5deb3', fgColor: '#5b4636',
  colorize: true, highlightWords: [], stickyChapterTitle: true, readerWidth: 800,
  ttsEngine: 'edge', ttsScheme: 'multi', ttsVoiceId: 'zh-CN-YunjianNeural',
  ttsNarrationVoiceId: 'zh-CN-YunjianNeural', ttsDialogueVoiceId: 'zh-CN-YunxiNeural',
  ttsDialogueMaleVoiceId: 'zh-CN-YunxiNeural', ttsDialogueFemaleVoiceId: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 1, ttsPitch: 1, ttsVolume: 1,
  _v: 4
}

const visible = ref(props.modelValue)
watch(() => props.modelValue, v => { visible.value = v })
watch(visible, v => emit('update:modelValue', v))

const local = ref({ ...DEFAULT_SETTINGS, ...props.settings })
const isInitializing = ref(false)
// 每次打开抽屉时从父组件重新初始化本地设置，避免循环同步问题
watch(() => props.modelValue, (isOpen) => {
  if (isOpen) {
    isInitializing.value = true
    local.value = { ...DEFAULT_SETTINGS, ...props.settings }
    nextTick(() => { isInitializing.value = false })
  }
})

// 兜底：只要 local 因用户操作发生变化，就通知父组件
watch(local, () => {
  if (isInitializing.value) return
  emit('change', { ...local.value })
}, { deep: true })

// 统一变更通知：所有控件都调用此函数把当前完整设置 emit 给父组件
const handleChange = () => {
  emit('change', { ...local.value })
}
const handleClose = () => {
  emit('close')
}

// Edge TTS 中文音色列表（从主进程获取）
const edgeVoices = ref([])
// 系统语音列表（Web Speech API）
const systemVoices = ref([])

const loadSystemVoices = () => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    systemVoices.value = window.speechSynthesis.getVoices()
  }
}

onMounted(async () => {
  // 加载 Edge TTS 音色
  try {
    edgeVoices.value = await window.ipcRenderer.invoke('novel:edge-tts-voices')
  } catch (e) {
    console.warn('load edge voices failed', e)
  }
  // 加载系统语音
  loadSystemVoices()
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = loadSystemVoices
  }
})

</script>

<style>
.reader-settings-drawer .el-select .el-select__wrapper {
  color: #303133;
}
.reader-settings-drawer .el-select .el-select__placeholder {
  color: #a8abb2;
}
.tts-voice-select-dropdown {
  z-index: 9999 !important;
}
.tts-voice-select-dropdown .el-select-dropdown__item {
  color: #303133;
}
</style>
