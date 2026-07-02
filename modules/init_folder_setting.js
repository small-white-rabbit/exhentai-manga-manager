const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { getRootPath } = require('./utils.js')


let STORE_PATH = app.getPath('userData')
if (!fs.existsSync(STORE_PATH)) {
  fs.mkdirSync(STORE_PATH)
}
const rootPath = getRootPath()
let isPortable = false
try {
  const dataPath = path.join(rootPath, 'data')
  fs.accessSync(dataPath)
  STORE_PATH = dataPath
  isPortable = true
} catch {
  try {
    fs.accessSync(path.join(rootPath, 'portable'))
    STORE_PATH = rootPath
    isPortable = true
  } catch {
    STORE_PATH = app.getPath('userData')
  }
}

const TEMP_PATH = path.join(STORE_PATH, 'tmp')
const COVER_PATH = path.join(STORE_PATH, 'cover')
const VIEWER_PATH = path.join(STORE_PATH, 'viewer')
const NOVEL_FONT_PATH = path.join(STORE_PATH, 'fonts')

const preparePath = () => {
  fs.mkdirSync(TEMP_PATH, { recursive: true })
  fs.mkdirSync(COVER_PATH, { recursive: true })
  fs.mkdirSync(VIEWER_PATH, { recursive: true })
  fs.mkdirSync(NOVEL_FONT_PATH, { recursive: true })
}

const _mange_reader = `"${path.join(getRootPath(), 'resources/extraResources/manga_reader.exe')}"`

const prepareSetting = () => {
  let setting
  try {
    setting = JSON.parse(fs.readFileSync(path.join(STORE_PATH, 'setting.json'), { encoding: 'utf-8' }))
    if (setting.imageExplorer === '"C:\\Windows\\explorer.exe"') {
      setting.imageExplorer = _mange_reader
      fs.writeFileSync(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
    }
  } catch {
    setting = {
      proxy: undefined,
      libraries: [],
      metadataPath: undefined,
      imageExplorer: _mange_reader,
      pageSize: 42,
      loadOnStart: false,
      igneous: '',
      ipb_pass_hash: '',
      ipb_member_id: '',
      star: '',
      showComment: true,
      requireGap: 3000,
      thumbnailColumn: 10,
      showTranslation: false,
      theme: 'light e-hentai',
      widthLimit: undefined,
      directEnter: 'detail',
      language: 'default',
      folderTreeWidth: '',
      advancedSearch: true,
      autoCheckUpdates: false,
      customOptions: '',
      defaultExpandTree: true,
      hidePageNumber: false,
      skipDeleteConfirm: false,
      displayTitle: 'japaneseTitle',
      keepReadingProgress: true,
      concurrentScan: 4,
      concurrentWrite: 2,
      excludeFile: '',
      enableNovel: false,
      novel: {
        fontSource: 'builtin',        // builtin | import | system
        fontFamily: 'JingHuaLaoSongTi',
        fontSize: 24,
        lineHeight: 1.5,
        indent: 0,
        // 文本预处理：默认不压缩空行，与 ColorTxt 默认一致
        collapseBlank: false,
        theme: 'light',               // light | dark | eye | custom
        bgColor: '#f5deb3',
        fgColor: '#5b4636',
        colorize: true,
        highlightWords: [],
        stickyChapterTitle: true,
        readerWidth: 800,
        // TTS 语音朗读设置（参照 ColorTxt voiceRead）
        ttsEngine: 'edge',            // edge | system
        ttsScheme: 'multi',           // single | multi（旁白/对白）
        ttsVoiceId: 'zh-CN-YunjianNeural',          // 单音色方案
        ttsNarrationVoiceId: 'zh-CN-YunjianNeural', // 旁白音色
        ttsDialogueVoiceId: 'zh-CN-YunxiNeural',    // 对白音色（默认）
        ttsDialogueMaleVoiceId: 'zh-CN-YunxiNeural',    // 对白男声
        ttsDialogueFemaleVoiceId: 'zh-CN-XiaoxiaoNeural',// 对白女声
        ttsRate: 1,                   // 语速 0.5~2
        ttsPitch: 1,                  // 音调 0.5~2
        ttsVolume: 1                  // 音量 0~1
      },
      novelLibraries: []
    }
    fs.writeFileSync(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
  }
  // migrate single library to libraries array
  if (!Array.isArray(setting.libraries)) {
    const legacy = setting.library || setting.libraries
    setting.libraries = legacy ? [legacy] : []
    delete setting.library
  }
  // migrate novel settings to ColorTxt-aligned defaults (v4: 温和空行压缩)
  if (setting.novel && setting.novel._v !== 4) {
    const old = setting.novel
    setting.novel = {
      fontSource: old.fontSource || 'builtin',
      fontFamily: old.fontFamily || 'JingHuaLaoSongTi',
      fontSize: typeof old.fontSize === 'number' ? old.fontSize : 24,
      lineHeight: typeof old.lineHeight === 'number' ? old.lineHeight : 1.5,
      indent: typeof old.indent === 'number' ? old.indent : 0,
      collapseBlank: old.collapseBlank !== undefined ? old.collapseBlank : false,
      theme: old.theme || 'light',
      bgColor: old.bgColor || '#f5deb3',
      fgColor: old.fgColor || '#5b4636',
      colorize: old.colorize !== undefined ? old.colorize : true,
      highlightWords: old.highlightWords || [],
      stickyChapterTitle: old.stickyChapterTitle !== undefined ? old.stickyChapterTitle : true,
      readerWidth: old.readerWidth || 800,
      // TTS 字段迁移：保留已存在的值，旧的单音色字段映射到新结构
      ttsEngine: old.ttsEngine || 'edge',
      ttsScheme: old.ttsScheme || 'multi',
      ttsVoiceId: old.ttsVoiceId || 'zh-CN-YunjianNeural',
      ttsNarrationVoiceId: old.ttsNarrationVoiceId || old.ttsVoiceId || 'zh-CN-YunjianNeural',
      ttsDialogueVoiceId: old.ttsDialogueVoiceId || 'zh-CN-YunxiNeural',
      ttsDialogueMaleVoiceId: old.ttsDialogueMaleVoiceId || 'zh-CN-YunxiNeural',
      ttsDialogueFemaleVoiceId: old.ttsDialogueFemaleVoiceId || 'zh-CN-XiaoxiaoNeural',
      ttsRate: typeof old.ttsRate === 'number' ? old.ttsRate : 1,
      ttsPitch: typeof old.ttsPitch === 'number' ? old.ttsPitch : 1,
      ttsVolume: typeof old.ttsVolume === 'number' ? old.ttsVolume : 1,
      _v: 4
    }
    fs.writeFileSync(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
  }
  return setting
}

const prepareCollectionList = () => {
  let collectionList
  try {
    collectionList = JSON.parse(fs.readFileSync(path.join(STORE_PATH, 'collectionList.json'), { encoding: 'utf-8' }))
  } catch {
    collectionList = []
    fs.writeFileSync(path.join(STORE_PATH, 'collectionList.json'), JSON.stringify(collectionList, null, '  '), { encoding: 'utf-8' })
  }
  return collectionList
}

module.exports = {
  STORE_PATH,
  isPortable,
  TEMP_PATH,
  COVER_PATH,
  VIEWER_PATH,
  NOVEL_FONT_PATH,
  prepareSetting,
  prepareCollectionList,
  preparePath,
  _mange_reader,
}