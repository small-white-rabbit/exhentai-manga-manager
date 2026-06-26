<template>
  <el-drawer v-model="visible" title="阅读设置" direction="rtl" size="360px">
    <el-form label-position="top" size="small">
      <el-form-item label="字体来源">
        <el-radio-group v-model="local.fontSource" @change="emitChange">
          <el-radio-button label="builtin">内置</el-radio-button>
          <el-radio-button label="import">导入</el-radio-button>
          <el-radio-button label="system">系统</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="字体" v-if="local.fontSource === 'builtin'">
        <el-select v-model="local.fontFamily" @change="emitChange" style="width:100%">
          <el-option label="京華老宋体" value="JingHuaLaoSongTi" />
          <el-option label="霞鹜文楷" value="LXGWWenKai" />
          <el-option label="浪漫雅圆" value="LangManYaYuan" />
        </el-select>
      </el-form-item>

      <el-form-item label="字体" v-if="local.fontSource === 'import'">
        <el-select v-model="local.fontFamily" @change="emitChange" style="width:100%">
          <el-option v-for="f in importedFonts" :key="f" :label="f" :value="f" />
        </el-select>
        <el-button size="small" @click="$emit('import-font')" style="margin-top:8px">+ 导入字体</el-button>
      </el-form-item>

      <el-form-item label="字体" v-if="local.fontSource === 'system'">
        <el-select v-model="local.fontFamily" @change="emitChange" style="width:100%" filterable>
          <el-option v-for="f in systemFonts" :key="f" :label="f" :value="f" />
        </el-select>
      </el-form-item>

      <el-form-item label="字号">
        <el-slider v-model="local.fontSize" :min="14" :max="32" :step="1" @change="emitChange" show-input />
      </el-form-item>

      <el-form-item label="行高">
        <el-slider v-model="local.lineHeight" :min="1.4" :max="2.4" :step="0.1" @change="emitChange" show-input />
      </el-form-item>

      <el-form-item label="行首缩进">
        <el-radio-group v-model="local.indent" @change="emitChange">
          <el-radio-button :label="0">无</el-radio-button>
          <el-radio-button :label="2">2 字符</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="空行压缩">
        <el-switch v-model="local.collapseBlank" @change="emitChange" />
      </el-form-item>

      <el-form-item label="配色主题">
        <el-radio-group v-model="local.theme" @change="emitChange">
          <el-radio-button label="light">亮色</el-radio-button>
          <el-radio-button label="dark">暗色</el-radio-button>
          <el-radio-button label="eye">护眼</el-radio-button>
          <el-radio-button label="custom">自定义</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="local.theme === 'custom'">
        <el-form-item label="背景色">
          <el-color-picker v-model="local.bgColor" @change="emitChange" />
        </el-form-item>
        <el-form-item label="文字色">
          <el-color-picker v-model="local.fgColor" @change="emitChange" />
        </el-form-item>
      </template>

      <el-form-item label="内容上色">
        <el-switch v-model="local.colorize" @change="emitChange" />
      </el-form-item>

      <el-form-item label="章节标题常驻">
        <el-switch v-model="local.stickyChapterTitle" @change="emitChange" />
      </el-form-item>

      <el-form-item label="阅读区宽度">
        <el-slider v-model="local.readerWidth" :min="600" :max="1200" :step="50" @change="emitChange" show-input />
      </el-form-item>
    </el-form>
  </el-drawer>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  settings: { type: Object, required: true },
  importedFonts: { type: Array, default: () => [] },
  systemFonts: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'change', 'import-font'])

const visible = ref(props.modelValue)
watch(() => props.modelValue, v => { visible.value = v })
watch(visible, v => emit('update:modelValue', v))

const local = ref({ ...props.settings })
watch(() => props.settings, v => { local.value = { ...v } }, { deep: true })

const emitChange = () => {
  emit('change', { ...local.value })
}
</script>
