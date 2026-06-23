<template>
  <el-drawer v-model="sideVisibleFolderTree"
    :title="$t('m.folderTree')"
    direction="ltr"
    :size="setting.folderTreeWidth ? setting.folderTreeWidth : '20%'"
    modal-class="side-tree-modal"
  >
    <el-input
      class="folder-search"
      v-model="treeFilterText"
      clearable
    ></el-input>
    <el-tree
      ref="treeRef"
      :data="folderTreeData"
      node-key="folderPath"
      :default-expanded-keys="expandNodes"
      :expand-on-click-node="false"
      :filter-node-method="filterTreeNode"
      @node-expand="handleNodeExpand"
      @node-collapse="handleNodeCollapse"
      @current-change="selectFolderTreeNode"
    ></el-tree>
  </el-drawer>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'

import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'
const appStore = useAppStore()
const { setting, bookList, pathSep, folderTreeData } = storeToRefs(appStore)

const emit = defineEmits(['chunkList'])

const sideVisibleFolderTree = ref(false)
let dirIndex = { keys: [], idxs: [] }

const openFolderTree = () => {
  sideVisibleFolderTree.value = !sideVisibleFolderTree.value
  if (sideVisibleFolderTree.value && _.isEmpty(folderTreeData.value)) {
    geneFolderTree()
  }
}

// Normalize path to POSIX style '/' and lowercase Windows drive letter
function normDir (p) {
  let s = String(p || '').replace(/[\\/]+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (/^[A-Za-z]:/.test(s)) s = s.toLowerCase()
  return s
}

// Build folder tree with trie + collapse single-child chains
function buildFolderTree (bookPathList) {
  const makeNode = (name, folderPath) => ({
    label: name,
    folderName: name,
    folderPath,
    hasDirect: false,
    _children: new Map()
  })

  const rootMap = new Map()
  for (const it of bookPathList || []) {
    const fp = normDir(it)
    if (!fp) continue

    const parts = fp.split('/')
    const dirs = parts.slice(0, -1).filter(Boolean)
    if (!dirs.length) continue

    let cursor = rootMap
    let accum = []
    for (let i = 0; i < dirs.length; i++) {
      const seg = dirs[i]
      accum.push(seg)
      let node = cursor.get(seg)
      if (!node) {
        node = makeNode(seg, accum.join('/'))
        cursor.set(seg, node)
      }
      if (i === dirs.length - 1) {
        node.hasDirect = true
      }
      cursor = node._children
    }
  }

  const collapseOne = (node) => {
    let n = node
    while (!n.hasDirect && n._children.size === 1) {
      const [, onlyChild] = n._children.entries().next().value
      n = onlyChild
    }
    return n
  }

  const topMap = new Map()
  for (const [, topNode] of rootMap) {
    const collapsed = collapseOne(topNode)
    topMap.set(collapsed.folderPath, collapsed)
  }

  const toArray = (map, isTop) => {
    const arr = []
    for (const [, n] of map) {
      arr.push({
        label: isTop ? n.folderPath : n.folderName,
        folderPath: n.folderPath,
        children: toArray(n._children, false)
      })
    }
    arr.sort((a, b) =>
      (isTop ? a.folderPath : a.label).localeCompare(isTop ? b.folderPath : b.label, undefined,
        { numeric: true, sensitivity: 'base' })
    )
    return arr
  }

  return toArray(topMap, true)
}

function getLibraryPrefixes () {
  const libs = Array.isArray(setting.value.libraries)
    ? setting.value.libraries.filter(Boolean)
    : [setting.value.library].filter(Boolean)
  return libs.map(normDir)
}

function findLibraryPrefix (dir, prefixes) {
  for (const prefix of prefixes) {
    if (dir.startsWith(prefix)) return prefix
  }
  return null
}

function buildDirIndex (bookList) {
  const keys = []
  const idxs = []
  const libraryPrefixes = getLibraryPrefixes()
  for (let i = 0; i < bookList.length; i++) {
    const b = bookList[i]
    if (b.isCollection) continue
    const p = normDir(b.filepath)
    const j = p.lastIndexOf('/')
    const dir = j >= 0 ? p.slice(0, j) : ''
    // store path relative to its library root for consistent prefix matching
    const prefix = findLibraryPrefix(dir, libraryPrefixes)
    const relativeDir = prefix
      ? dir.slice(prefix.length).replace(/^\//, '')
      : dir
    keys.push(relativeDir)
    idxs.push(i)
  }

  const order = keys.map((_, i) => i).sort((a, b) => {
    const ka = keys[a], kb = keys[b]
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const sKeys = new Array(order.length)
  const sIdxs = new Array(order.length)
  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    sKeys[k] = keys[i]
    sIdxs[k] = idxs[i]
  }
  return { keys: sKeys, idxs: sIdxs }
}

function lowerBound (keys, key) {
  let lo = 0, hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] < key) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound (keys, key) {
  let lo = 0, hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] <= key) lo = mid + 1
    else hi = mid
  }
  return lo
}

function computeRange (keys, folderPath) {
  const loKey = normDir(folderPath)
  const hiKey = loKey + '/\uFFFF\uFFFF'
  return [lowerBound(keys, loKey), upperBound(keys, hiKey)]
}

const geneFolderTree = async () => {
  const bList = _.filter(bookList.value, book => !book.isCollection)
  const filePathList = bList.map(book => book.filepath)
  folderTreeData.value = buildFolderTree(filePathList)
  dirIndex = buildDirIndex(bookList.value)
}

const selectFolderTreeNode = async (selectNode) => {
  if (!selectNode?.folderPath) {
    bookList.value.forEach(book => { book.folderHide = false })
  } else {
    bookList.value.forEach(book => { book.folderHide = true })
    if (!selectNode._range) {
      selectNode._range = computeRange(dirIndex.keys, selectNode.folderPath)
    }
    const [lo, hi] = selectNode._range
    for (let i = lo; i < hi; i++) {
      bookList.value[dirIndex.idxs[i]].folderHide = false
    }
  }
  emit('chunkList')
}

const expandNodes = ref([])
onMounted(() => {
  expandNodes.value = JSON.parse(localStorage.getItem('expandNodes')) || []
})
const handleNodeExpand = (nodeObject) => {
  let expandNodes = JSON.parse(localStorage.getItem('expandNodes')) || []
  expandNodes.push(nodeObject.folderPath)
  expandNodes = [...new Set(expandNodes)]
  localStorage.setItem('expandNodes', JSON.stringify(expandNodes))
}
const handleNodeCollapse = (nodeObject) => {
  let expandNodes = JSON.parse(localStorage.getItem('expandNodes')) || []
  expandNodes = expandNodes.filter(path => !path.includes(nodeObject.folderPath))
  localStorage.setItem('expandNodes', JSON.stringify(expandNodes))
}

const treeFilterText = ref('')
const treeRef = ref(null)
watch(treeFilterText, (value) => {
  treeRef.value.filter(value)
})
const filterTreeNode = (val, data) => {
  if (!val) return true
  return data.label.includes(val)
}

const resetSelect = () => {
  treeRef.value && treeRef.value.setCurrentKey('')
  bookList.value.forEach(book => { book.folderHide = false })
}

defineExpose({
  sideVisibleFolderTree,
  openFolderTree,
  geneFolderTree,
  resetSelect
})
</script>

<style lang="stylus">
.side-tree-modal
  background-color: var(--el-mask-color-extra-light)
  .el-drawer__body
    padding-top: 0
  .folder-search
    margin-bottom: 8px
</style>
