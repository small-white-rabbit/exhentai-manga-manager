<template>
  <el-dialog
    v-model="visible"
    :title="$t('c.cropCover')"
    width="80vw"
    align-center
    destroy-on-close
    @close="handleCancel"
    class="cover-crop-dialog"
  >
    <div class="crop-container" ref="containerRef">
      <img
        ref="imageRef"
        :src="imageSrc"
        class="crop-image"
        draggable="false"
        @load="initCropBox"
      />
      <div
        v-if="imageLoaded"
        class="crop-overlay"
        :style="overlayStyle"
        @mousedown="startDrag"
      >
        <div class="crop-box" :style="boxStyle">
          <div class="crop-handle crop-handle-n" @mousedown.stop="startResize('n', $event)"></div>
          <div class="crop-handle crop-handle-s" @mousedown.stop="startResize('s', $event)"></div>
          <div class="crop-handle crop-handle-e" @mousedown.stop="startResize('e', $event)"></div>
          <div class="crop-handle crop-handle-w" @mousedown.stop="startResize('w', $event)"></div>
          <div class="crop-handle crop-handle-nw" @mousedown.stop="startResize('nw', $event)"></div>
          <div class="crop-handle crop-handle-ne" @mousedown.stop="startResize('ne', $event)"></div>
          <div class="crop-handle crop-handle-sw" @mousedown.stop="startResize('sw', $event)"></div>
          <div class="crop-handle crop-handle-se" @mousedown.stop="startResize('se', $event)"></div>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="handleCancel">{{ $t('c.cancel') }}</el-button>
      <el-button type="primary" @click="handleConfirm">{{ $t('c.confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const visible = ref(false)
const imageSrc = ref('')
const naturalWidth = ref(0)
const naturalHeight = ref(0)
const displayWidth = ref(0)
const displayHeight = ref(0)
const imageLoaded = ref(false)
const resolvePromise = ref(null)

const containerRef = ref(null)
const imageRef = ref(null)

const COVER_RATIO = 500 / 707

const crop = ref({ x: 0, y: 0, w: 0, h: 0 })

const overlayStyle = computed(() => ({
  width: `${displayWidth.value}px`,
  height: `${displayHeight.value}px`,
  left: `${((containerRef.value?.clientWidth || 0) - displayWidth.value) / 2}px`,
  top: `${((containerRef.value?.clientHeight || 0) - displayHeight.value) / 2}px`
}))

const boxStyle = computed(() => ({
  left: `${crop.value.x}px`,
  top: `${crop.value.y}px`,
  width: `${crop.value.w}px`,
  height: `${crop.value.h}px`
}))

const initCropBox = () => {
  const img = imageRef.value
  if (!img) return
  naturalWidth.value = img.naturalWidth
  naturalHeight.value = img.naturalHeight
  displayWidth.value = img.clientWidth
  displayHeight.value = img.clientHeight
  imageLoaded.value = true

  const containerW = displayWidth.value
  const containerH = displayHeight.value
  const containerRatio = containerW / containerH

  let w, h
  if (containerRatio > COVER_RATIO) {
    h = containerH
    w = h * COVER_RATIO
  } else {
    w = containerW
    h = w / COVER_RATIO
  }
  crop.value = {
    x: (containerW - w) / 2,
    y: (containerH - h) / 2,
    w,
    h
  }
}

let dragState = null

const startDrag = (e) => {
  if (e.target.classList.contains('crop-handle')) return
  dragState = {
    type: 'drag',
    startX: e.clientX,
    startY: e.clientY,
    startCropX: crop.value.x,
    startCropY: crop.value.y
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

const startResize = (handle, e) => {
  dragState = {
    type: 'resize',
    handle,
    startX: e.clientX,
    startY: e.clientY,
    startCrop: { ...crop.value }
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

const clamp = (val, min, max) => Math.max(min, Math.min(max, val))

const onMouseMove = (e) => {
  if (!dragState) return
  const dx = e.clientX - dragState.startX
  const dy = e.clientY - dragState.startY
  const maxW = displayWidth.value
  const maxH = displayHeight.value

  if (dragState.type === 'drag') {
    crop.value.x = clamp(dragState.startCropX + dx, 0, maxW - crop.value.w)
    crop.value.y = clamp(dragState.startCropY + dy, 0, maxH - crop.value.h)
  } else if (dragState.type === 'resize') {
    const sc = dragState.startCrop
    let newX = sc.x
    let newY = sc.y
    let newW = sc.w
    let newH = sc.h
    const minSize = 32

    switch (dragState.handle) {
      case 'se':
        newW = clamp(sc.w + dx, minSize, maxW - sc.x)
        newH = newW / COVER_RATIO
        if (sc.y + newH > maxH) {
          newH = maxH - sc.y
          newW = newH * COVER_RATIO
        }
        break
      case 'nw':
        newW = clamp(sc.w - dx, minSize, sc.x + sc.w)
        newH = newW / COVER_RATIO
        newX = sc.x + sc.w - newW
        newY = sc.y + sc.h - newH
        if (newY < 0) {
          newY = 0
          newH = sc.y + sc.h
          newW = newH * COVER_RATIO
          newX = sc.x + sc.w - newW
        }
        break
      case 'ne':
        newW = clamp(sc.w + dx, minSize, maxW - sc.x)
        newH = newW / COVER_RATIO
        newY = sc.y + sc.h - newH
        if (newY < 0) {
          newY = 0
          newH = sc.y + sc.h
          newW = newH * COVER_RATIO
        }
        break
      case 'sw':
        newW = clamp(sc.w - dx, minSize, sc.x + sc.w)
        newH = newW / COVER_RATIO
        newX = sc.x + sc.w - newW
        if (sc.y + newH > maxH) {
          newH = maxH - sc.y
          newW = newH * COVER_RATIO
          newX = sc.x + sc.w - newW
        }
        break
      case 'n':
        newH = clamp(sc.h - dy, minSize, sc.y + sc.h)
        newW = newH * COVER_RATIO
        newX = sc.x + (sc.w - newW) / 2
        newY = sc.y + sc.h - newH
        if (newX < 0) {
          newX = 0
          newW = sc.w + 2 * sc.x
          newH = newW / COVER_RATIO
          newY = sc.y + sc.h - newH
        } else if (newX + newW > maxW) {
          newX = sc.x + sc.w - newW
        }
        break
      case 's':
        newH = clamp(sc.h + dy, minSize, maxH - sc.y)
        newW = newH * COVER_RATIO
        newX = sc.x + (sc.w - newW) / 2
        if (newX < 0) {
          newX = 0
          newW = sc.w + 2 * sc.x
          newH = newW / COVER_RATIO
        } else if (newX + newW > maxW) {
          newX = sc.x + sc.w - newW
        }
        break
      case 'e':
        newW = clamp(sc.w + dx, minSize, maxW - sc.x)
        newH = newW / COVER_RATIO
        newY = sc.y + (sc.h - newH) / 2
        if (newY < 0) {
          newY = 0
          newH = sc.h + 2 * sc.y
          newW = newH * COVER_RATIO
        } else if (newY + newH > maxH) {
          newY = sc.y + sc.h - newH
        }
        break
      case 'w':
        newW = clamp(sc.w - dx, minSize, sc.x + sc.w)
        newH = newW / COVER_RATIO
        newX = sc.x + sc.w - newW
        newY = sc.y + (sc.h - newH) / 2
        if (newY < 0) {
          newY = 0
          newH = sc.h + 2 * sc.y
          newW = newH * COVER_RATIO
          newX = sc.x + sc.w - newW
        } else if (newY + newH > maxH) {
          newY = sc.y + sc.h - newH
        }
        break
    }

    newX = clamp(newX, 0, maxW - newW)
    newY = clamp(newY, 0, maxH - newH)
    newW = clamp(newW, minSize, maxW - newX)
    newH = clamp(newH, minSize, maxH - newY)

    crop.value = { x: newX, y: newY, w: newW, h: newH }
  }
}

const onMouseUp = () => {
  dragState = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

const open = (src) => {
  imageSrc.value = src
  imageLoaded.value = false
  visible.value = true
  return new Promise((resolve) => {
    resolvePromise.value = resolve
  })
}

const handleCancel = () => {
  visible.value = false
  if (resolvePromise.value) {
    resolvePromise.value(null)
    resolvePromise.value = null
  }
}

const handleConfirm = () => {
  const scaleX = naturalWidth.value / displayWidth.value
  const scaleY = naturalHeight.value / displayHeight.value
  const result = {
    left: Math.round(crop.value.x * scaleX),
    top: Math.round(crop.value.y * scaleY),
    width: Math.round(crop.value.w * scaleX),
    height: Math.round(crop.value.h * scaleY)
  }
  visible.value = false
  if (resolvePromise.value) {
    resolvePromise.value(result)
    resolvePromise.value = null
  }
}

defineExpose({ open })
</script>

<style scoped>
.crop-container {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 300px;
  background: #000;
  overflow: hidden;
}
.crop-image {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}
.crop-overlay {
  position: absolute;
  cursor: move;
}
.crop-box {
  position: absolute;
  border: 2px dashed #fff;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
}
.crop-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 2px solid #409eff;
  border-radius: 50%;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
  z-index: 2;
}
.crop-handle-n { top: -6px; left: 50%; transform: translateX(-50%); cursor: n-resize; }
.crop-handle-s { bottom: -6px; left: 50%; transform: translateX(-50%); cursor: s-resize; }
.crop-handle-e { top: 50%; right: -6px; transform: translateY(-50%); cursor: e-resize; }
.crop-handle-w { top: 50%; left: -6px; transform: translateY(-50%); cursor: w-resize; }
.crop-handle-nw { top: -6px; left: -6px; cursor: nw-resize; }
.crop-handle-ne { top: -6px; right: -6px; cursor: ne-resize; }
.crop-handle-sw { bottom: -6px; left: -6px; cursor: sw-resize; }
.crop-handle-se { bottom: -6px; right: -6px; cursor: se-resize; }
</style>
