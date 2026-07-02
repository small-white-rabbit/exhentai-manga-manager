const { app, BrowserWindow, ipcMain, session, dialog, shell, screen, Menu, clipboard, nativeImage, Tray } = require('electron')
const path = require('path')
const fs = require('fs')
const { brotliDecompress } = require('zlib')
const { promisify, format } = require('util')
const _ = require('lodash')
const { QueryTypes } = require('sequelize')
const { nanoid } = require('nanoid')
const sharp = require('sharp')
const { exec } = require('child_process')
const { createHash } = require('crypto')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const windowStateKeeper = require('electron-window-state')
const express = require('express')
const { globSync } = require('glob')
const { performance } = require('node:perf_hooks')
const os = require('os')

let CRASH_LOG_PATH = null

const initCrashLog = () => {
  CRASH_LOG_PATH = path.join(app.getPath('userData'), 'crash-logs')
  if (!fs.existsSync(CRASH_LOG_PATH)) {
    try { fs.mkdirSync(CRASH_LOG_PATH, { recursive: true }) } catch (e) {}
  }
}

const { prepareMangaModel, prepareMetadataModel, ensureMetaTable, installRevTriggers, prepareNovelModels } = require('./modules/database')
const { prepareTemplate } = require('./modules/prepare_menu.js')
const { getBookFilelist, geneCoverFromBuffer, getImageListByBook, getImageListByBookFast, extractImageByBook, deleteImageFromBook } = require('./fileLoader/index.js')
const { saveAppCache, LoadVerifyCache } = require('./src/services/appCache.js')
const {
  STORE_PATH, isPortable,
  TEMP_PATH, COVER_PATH, VIEWER_PATH,
  prepareSetting, prepareCollectionList, preparePath,
  NOVEL_FONT_PATH,
  _mange_reader
} = require('./modules/init_folder_setting.js')
const { findSameFile } = require('./fileLoader/folder.js')
const { makeShardedPath } = require('./fileLoader/utils.js')
const { importNovel, readTxtChapter, readEpubChapter, readFullText } = require('./novel_loader/index')
const { DEFAULT_RULES: CHAPTER_RULES } = require('./src/novel/utils/chapter-detector')
const { scanNovelFiles } = require('./novel_loader/filelist')
const { synthesizeEdgeTtsMp3, EDGE_TTS_ZH_VOICES } = require('./novel_loader/edgeTts')
const fontList = require('font-list')

preparePath()
let setting = prepareSetting()
let collectionList = prepareCollectionList()

const APP_CACHE_PATH = path.join(STORE_PATH, 'cache', 'appCache.snap')
let latestAppCache = { data: {}, dbSignature: {} }

const Manga = prepareMangaModel(path.join(STORE_PATH, './database.sqlite'))
let metadataSqliteFile
if (setting.metadataPath) {
  metadataSqliteFile = path.join(setting.metadataPath, './metadata.sqlite')
} else {
  metadataSqliteFile = path.join(STORE_PATH, './metadata.sqlite')
}
let Metadata = prepareMetadataModel(metadataSqliteFile)
let Novel, NovelChapter, NovelBookmark
const getColumns = async (sequelize, tableName) => {
  const query = `PRAGMA table_info(${tableName})`
  const [results] = await sequelize.query(query)
  return results.map(column => column.name)
}
if (setting.enableNovel) {
  const novelModels = prepareNovelModels(path.join(STORE_PATH, './database.sqlite'))
  Novel = novelModels.Novel
  NovelChapter = novelModels.NovelChapter
  NovelBookmark = novelModels.NovelBookmark
  ;(async () => {
    try {
      // 检查并添加 lastReadAt 列（如果不存在）
      const novelColumns = await getColumns(Novel.sequelize, 'Novels')
      if (!novelColumns.includes('lastReadAt')) {
        await Novel.sequelize.query('ALTER TABLE Novels ADD COLUMN lastReadAt INTEGER')
      }
      // 检查并添加 text 列到 NovelChapters（epub 章节正文）
      const chapterColumns = await getColumns(NovelChapter.sequelize, 'NovelChapters')
      if (!chapterColumns.includes('text')) {
        await NovelChapter.sequelize.query('ALTER TABLE NovelChapters ADD COLUMN text TEXT')
      }
      if (!chapterColumns.includes('byteStartOffset')) {
        await NovelChapter.sequelize.query('ALTER TABLE NovelChapters ADD COLUMN byteStartOffset INTEGER')
      }
      if (!chapterColumns.includes('byteEndOffset')) {
        await NovelChapter.sequelize.query('ALTER TABLE NovelChapters ADD COLUMN byteEndOffset INTEGER')
      }
      await Novel.sync()
      await NovelChapter.sync()
      await NovelBookmark.sync()
    } catch (e) {
      console.error('[init] 小说数据库初始化失败:', e)
    }
  })()
}
;(async () => {
    try {
      await Manga.sequelize.query(`PRAGMA busy_timeout=10000;`)
      await Metadata.sequelize.query(`PRAGMA busy_timeout=10000;`)

      const columns = await getColumns(Manga.sequelize, 'Mangas')
      if (['hiddenBook', 'readCount'].some(c => !columns.includes(c))) {
        await Manga.sync({ alter: true })
      } else {
        await Manga.sync()
      }

      if (!columns.includes('readProgress')) {
        await Manga.sequelize.query('ALTER TABLE Mangas ADD COLUMN readProgress TEXT')
      }
      if (!columns.includes('lastReadAt')) {
        await Manga.sequelize.query('ALTER TABLE Mangas ADD COLUMN lastReadAt INTEGER')
      }

      try {
        await Metadata.sync()
        await ensureMetaTable(Metadata.sequelize)
        await installRevTriggers(Metadata.sequelize, 'Metadata', 'mm')
      } catch (e) {
        console.warn('[init] metadata数据库同步失败，降级运行:', e.message)
      }

      // add meta table and revision triggers for startup cache invalidation
      await ensureMetaTable(Manga.sequelize)
      await installRevTriggers(Manga.sequelize, 'Mangas', 'mm')
    } catch (e) {
      console.error('[init] 数据库初始化失败:', e)
    }
  })()

let logFile = null
try {
  logFile = fs.createWriteStream(path.join(STORE_PATH, 'log.txt'), { flags: 'a' })
  logFile.on('error', () => { logFile = null })
} catch (e) {
  logFile = null
}
const logStdout = process.stdout
const logStderr = process.stderr

console.log = (...message) => {
  const msg = format(...message) + '\n'
  if (logFile) { try { logFile.write(msg) } catch(e) {} }
  logStdout.write(msg)
}

console.error = (...message) => {
  const msg = format(...message) + '\n'
  if (logFile) { try { logFile.write(msg) } catch(e) {} }
  logStderr.write(msg)
}

process.on('unhandledRejection', (reason, promise) => {
    const mem = process.memoryUsage()
    console.error(`[${new Date().toISOString()}] Unhandled Rejection at:`, promise, 'reason:', reason)
    console.error(`[${new Date().toISOString()}] Memory: RSS=${(mem.rss/1024/1024).toFixed(2)}MB, Heap=${(mem.heapUsed/1024/1024).toFixed(2)}MB`)
  })
  .on('uncaughtException', err => {
    const mem = process.memoryUsage()
    console.error(`[${new Date().toISOString()}] Uncaught Exception thrown:`, err)
    console.error(`[${new Date().toISOString()}] Stack:`, err.stack)
    console.error(`[${new Date().toISOString()}] Memory: RSS=${(mem.rss/1024/1024).toFixed(2)}MB, Heap=${(mem.heapUsed/1024/1024).toFixed(2)}MB`)
    try {
      sendMessageToWebContents(`程序错误: ${err.message}`)
    } catch (e) {}
  })

const sendMessageToWebContents = (message) => {
  console.log(message)
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('send-message', message)
    } catch (e) {
      console.error('Failed to send message:', e)
    }
  }
}

const getLanIP = () => {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('127.')) {
        return iface.address
      }
    }
  }
  return 'localhost'
}

let mainWindow
let tray
let screenWidth
let sendImageLock = false
let isQuitting = false

app.on('before-quit', () => {
  isQuitting = true
})

const createTray = () => {
  if (tray) return
  const iconPath = path.join(__dirname, 'public/icon.png')
  tray = new Tray(iconPath)
  tray.setToolTip('exhentai-manga-manager')
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.minimize()
      } else if (mainWindow.isMinimized()) {
        mainWindow.restore()
        mainWindow.setSkipTaskbar(false)
        mainWindow.focus()
      } else {
        mainWindow.show()
        mainWindow.setSkipTaskbar(false)
        mainWindow.focus()
      }
    }
  })
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'show window',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore()
          } else {
            mainWindow.show()
          }
          mainWindow.setSkipTaskbar(false)
          mainWindow.focus()
        }
      }
    },
    {
      label: 'exit',
      click: () => {
        isQuitting = true
        mainWindow.close()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

const createWindow = () => {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1560,
    defaultHeight: 1000
  })
  const win = new BrowserWindow({
    'x': mainWindowState.x,
    'y': mainWindowState.y,
    'width': mainWindowState.width,
    'height': mainWindowState.height,
    webPreferences: {
      webSecurity: app.isPackaged ? true : false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })
  win.loadFile('dist/index.html')
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  const menu = Menu.buildFromTemplate(prepareTemplate(win))
  Menu.setApplicationMenu(menu)
  win.webContents.on('did-finish-load', () => {
    const name = require('./package.json').name
    const version = require('./package.json').version
    win.setTitle(name + ' ' + version)
  })
  win.once('ready-to-show', () => {
    if (setting.minimizeOnStart) {
      if (setting.minimizeToTray) {
        createTray()
        win.hide()
        win.setSkipTaskbar(true)
      } else {
        win.minimize()
      }
    } else {
      win.show()
    }
  })
  win.on('close', async (event) => {
    if (setting.closeToTray && !isQuitting) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
      return
    }

    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    event.preventDefault()

    const finish = () => {
      if (!win.isDestroyed()) win.destroy()
    }

    const timer = setTimeout(finish, 1000)

    ipcMain.once('app-cache:reply-snap', async (_evt, snap) => {
      clearTimeout(timer)
      try {
        if (snap) {
          latestAppCache.data = latestAppCache.data || {}
          latestAppCache.data.bookList = snap
          console.log('snap close')
          await saveAppCache(latestAppCache, APP_CACHE_PATH, Manga.sequelize, Metadata.sequelize)
        }
      } catch (e) {
        console.error('saveAppCache on close failed:', e)
      } finally {
        finish()
      }
    })

    win.webContents.send('app-cache:request-bookList-snap')
  })
  win.on('minimize', (event) => {
    if (setting.minimizeToTray) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
    }
  })
  win.on('restore', () => {
    win.show()
    win.setSkipTaskbar(false)
  })
  win.on('show', () => {
    win.setSkipTaskbar(false)
    mainWindowState.manage(win)
  })
  return win
}

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=65536')
// app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const primaryDisplay = screen.getPrimaryDisplay()
  screenWidth = Math.floor(primaryDisplay.workAreaSize.width * primaryDisplay.scaleFactor)
  mainWindow = createWindow()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  }
})

app.on('ready', async () => {
  initCrashLog()
  if (setting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: setting.proxy
    })
  }
  // session.defaultSession.loadExtension(path.join(__dirname, './devtools'))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

process.on('exit', () => {
  app.quit()
})

// base function
const loadBookListFromBrFile = async () => {
  try {
    const buffer = await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json.br'))
    const decodeBuffer = await promisify(brotliDecompress)(buffer)
    return JSON.parse(decodeBuffer.toString())
  } catch {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), { encoding: 'utf-8' }))
    } catch {
      return []
    }
  }
}

const loadLegecyBookListFromFile = async () => {
  const bookList = await loadBookListFromBrFile()
  try {
    shell.trashItem(path.join(STORE_PATH, 'bookList.json.br'))
    shell.trashItem(path.join(STORE_PATH, 'bookList.json'))
  } catch {
    console.log('Remove Legecy BookList Failed')
  }
  return bookList
}

const loadBookListFromDatabase = async () => {
  let bookList = await Manga.findAll()
  bookList = bookList.map(b => b.toJSON())
  if (_.isEmpty(bookList)) {
    bookList = await loadLegecyBookListFromFile()
    await saveBookListToDatabase(bookList)
  }

  // Fast path: use a single SQL JOIN with COALESCE instead of loading everything into JS
  const mainStorage = Manga.sequelize.options.storage
  if (mainStorage && metadataSqliteFile && path.resolve(mainStorage) !== path.resolve(metadataSqliteFile)) {
    try {
      await Manga.sequelize.transaction(async (t) => {
        // Ensure metadata DB is attached
        const rows = await Manga.sequelize.query('PRAGMA database_list', { type: QueryTypes.SELECT, transaction: t })
        const alias = 'meta'
        const hit = rows.find(r => r.name === alias)
        if (!hit) {
          await Manga.sequelize.query(`ATTACH DATABASE $p AS ${alias}`, { bind: { p: metadataSqliteFile }, transaction: t })
        } else if (path.resolve(hit.file || '') !== path.resolve(metadataSqliteFile)) {
          await Manga.sequelize.query(`DETACH DATABASE ${alias}`, { transaction: t })
          await Manga.sequelize.query(`ATTACH DATABASE $p AS ${alias}`, { bind: { p: metadataSqliteFile }, transaction: t })
        }

        // Seed metadata table from Mangas when metadata row is missing
        await Manga.sequelize.query(`
          INSERT INTO meta.Metadata (hash, title, status, rating, tags, title_jpn, filecount, posted, filesize, category, url, mark, createdAt, updatedAt)
          SELECT m.hash, m.title, m.status, m.rating, m.tags, m.title_jpn, m.filecount, m.posted, m.filesize, m.category, m.url, m.mark, m.createdAt, m.updatedAt
          FROM main.Mangas AS m
          WHERE NOT EXISTS (SELECT 1 FROM meta.Metadata AS md WHERE md.hash = m.hash)
            AND m.rowid = (SELECT MIN(m2.rowid) FROM main.Mangas m2 WHERE m2.hash = m.hash);
        `, { transaction: t })

        // Update Mangas from Metadata when metadata has better status
        await Manga.sequelize.query(`
          UPDATE main.Mangas AS m
          SET
            title = COALESCE(md.title, m.title),
            rating = COALESCE(md.rating, m.rating),
            tags = COALESCE(md.tags, m.tags),
            title_jpn = COALESCE(md.title_jpn, m.title_jpn),
            filecount = COALESCE(md.filecount, m.filecount),
            posted = COALESCE(md.posted, m.posted),
            filesize = COALESCE(md.filesize, m.filesize),
            category = COALESCE(md.category, m.category),
            url = COALESCE(md.url, m.url),
            mark = COALESCE(md.mark, m.mark),
            status = COALESCE(md.status, m.status),
            createdAt = COALESCE(md.createdAt, m.createdAt),
            updatedAt = COALESCE(md.updatedAt, m.updatedAt)
          FROM meta.Metadata AS md
          WHERE md.hash = m.hash
            AND m.status = 'non-tag'
            AND COALESCE(md.status, 'non-tag') <> 'non-tag';
        `, { transaction: t })

        // Load joined book list
        bookList = await Manga.sequelize.query(`
          SELECT
            m.id, m.hash, m.coverPath, m.filepath, m.type, m.pageCount,
            m.bundleSize, m.mtime, m.coverHash, m.hiddenBook, m.readCount, m.exist, m.date,
            COALESCE(md.title, m.title) AS title,
            COALESCE(md.status, m.status) AS status,
            COALESCE(md.rating, m.rating) AS rating,
            COALESCE(md.tags, m.tags, '{}') AS tags,
            COALESCE(md.title_jpn, m.title_jpn) AS title_jpn,
            COALESCE(md.filecount, m.filecount) AS filecount,
            COALESCE(md.posted, m.posted) AS posted,
            COALESCE(md.filesize, m.filesize) AS filesize,
            COALESCE(md.category, m.category) AS category,
            COALESCE(md.url, m.url) AS url,
            COALESCE(md.mark, m.mark) AS mark,
            COALESCE(md.createdAt, m.createdAt) AS createdAt,
            COALESCE(md.updatedAt, m.updatedAt) AS updatedAt
          FROM main.Mangas m
          LEFT JOIN meta.Metadata md ON md.hash = m.hash;
        `, { type: QueryTypes.SELECT, transaction: t })
      })
    } catch (e) {
      console.warn('[loadBookList] ATTACH metadata失败，使用降级方案:', e.message)
      // 降级：只用主数据库
    }
  } else {
    // Fallback to original JS loop when DB paths are the same (should not happen normally)
    let metadataList = await Metadata.findAll()
    metadataList = metadataList.map(m => m.toJSON())
    const bookListLength = bookList.length
    for (let i = 0; i < bookListLength; i++) {
      const book = bookList[i]
      const findMetadata = metadataList.find(m => m.hash === book.hash)
      if (findMetadata) {
        if (book.status === 'non-tag' && findMetadata.status !== 'non-tag') await Manga.update(findMetadata, { where: { id: book.id } })
        Object.assign(book, findMetadata)
      } else {
        setProgressBar((i + 1) / bookListLength)
        await Metadata.upsert(book)
      }
    }
  }

  // Parse JSON tags
  for (const b of bookList) {
    if (typeof b.tags === 'string') {
      try {
        b.tags = JSON.parse(b.tags || '{}')
      } catch (e) {
        b.tags = {}
      }
    } else if (!b.tags) {
      b.tags = {}
    }
  }
  setProgressBar(-1)
  return bookList
}

const saveBookListToDatabase = async (data) => {
  await Manga.destroy({ truncate: true })
  await Manga.bulkCreate(data)
}

const saveBookToDatabase = async (book) => {
  await Manga.update(book, { where: { id: book.id } })
  await Metadata.upsert(book)
}

const setProgressBar = (progress) => {
  mainWindow.setProgressBar(progress)
  mainWindow.webContents.send('send-action', {
    action: 'send-progress',
    progress
  })
}

const clearFolder = async (Folder) => {
  try {
    await fs.promises.rm(Folder, { recursive: true, force: true })
    await fs.promises.mkdir(Folder, { recursive: true })
  } catch (err) {
    console.log(err)
  }
}

// ---- small concurrency limiter (p-limit style, zero deps) ----
function createLimiter(concurrency) {
  let active = 0
  const queue = []
  const next = () => {
    active--
    if (queue.length > 0) queue.shift()()
  }
  return fn =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++
        Promise.resolve()
          .then(fn)
          .then((v) => { next(); resolve(v) }, (e) => { next(); reject(e) })
      }
      if (active < concurrency) run()
      else queue.push(run)
    })
}

// ---- abortable scan context (cancels prior scan, kills children) ----
let scanContext = null
function createAbortableContext(event) {
  if (scanContext?.controller && !scanContext.controller.signal.aborted) {
    scanContext.controller.abort()
  }
  const controller = new AbortController()
  const children = new Set()
  const onAbort = () => {
    for (const cp of children) {
      if (!cp.killed) cp.kill('SIGTERM')
      setTimeout(() => { try { if (!cp.killed) cp.kill('SIGKILL') } catch {} }, 5000)
    }
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })

  const sender = event?.sender
  if (sender) {
    const abortOnDestroyed = () => controller.abort()
    sender.once('destroyed', abortOnDestroyed)
    controller.signal.addEventListener('abort', () => {
      try { sender.removeListener?.('destroyed', abortOnDestroyed) } catch {}
    }, { once: true })
  }

  const abortOnQuit = () => controller.abort()
  app.once('before-quit', abortOnQuit)
  controller.signal.addEventListener('abort', () => {
    try { app.removeListener('before-quit', abortOnQuit) } catch {}
  }, { once: true })

  scanContext = { controller, children }
  return scanContext
}

async function coverAndHashInMem(filepath, type, opts = {}) {
  const { hash, coverPath, pageCount, bundleSize, mtime, coverHash, coverSharp } =
    await geneCoverFromBuffer(filepath, type, opts)
  return { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp }
}

async function scanLibraryFilesWithExclude() {
  const toArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [])
  const uniqueBy = (arr, key) => Array.from(new Map(arr.map(x => [x[key], x])).values())

  function isSubpath(parent, child, { includeSelf = false } = {}) {
    const from = path.resolve(parent)
    const to = path.resolve(child)
    const rel = path.relative(from, to)
    if (rel === '') return !!includeSelf
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  function collapseRoots(paths) {
    const abs = [...new Set(paths.map(p => path.resolve(p)))].sort()
    const keep = []
    outer: for (const p of abs) {
      for (const k of keep) if (isSubpath(k, p, { includeSelf: false })) continue outer
      keep.push(p)
    }
    return keep
  }

  let libraries = toArray(setting.libraries)
  if (!libraries.length) return []
  libraries = collapseRoots(libraries)
  const lists = await Promise.all(libraries.map(lib => getBookFilelist(lib)))
  let list = lists.flat()
  list = uniqueBy(list, 'filepath')

  const pattern = (setting.excludeFile || '').trim()
  if (pattern) {
    try {
      const excludeRe = new RegExp(pattern)
      list = list.filter(item => !excludeRe.test(item.filepath))
    } catch (e) {
      console.warn('Illegal regular expression in setting.excludeFile:', e?.message)
    }
  }
  return list
}


// library and metadata
ipcMain.handle('load-book-list', async (event, scan) => {
  if (scan) {
    sendMessageToWebContents('Start loading library')

    const context = createAbortableContext(event)
    const { signal } = context.controller
    try {
      const dbBooks = await Manga.findAll({ raw: true })
      const byFilepath = new Map(dbBooks.map(b => [b.filepath, b]))
      const byId = new Map(dbBooks.map(b => [b.id, b]))
      // 重置 exist 标记，本次扫描未再次确认的文件会被标记为 missing
      for (const b of dbBooks) {
        b.exist = false
      }

      let list = await scanLibraryFilesWithExclude()
      const listLength = list.length
      sendMessageToWebContents(`Load ${listLength} book from library`)
      if (listLength === 0) {
        setProgressBar(-1)
        return await loadBookListFromDatabase()
      }

      const tTotal0 = performance.now()
      const workLimit = createLimiter(Math.max(1, Number(setting.concurrentScan) || 4))
      const coverLimit = createLimiter(Math.max(1, Number(setting.concurrentWrite) || 2))
      const dbLimit = createLimiter(1)
      const BATCH_SIZE = 50
      let processed = 0

      const pathExists = async (p) => {
        try {
          await fs.promises.stat(p)
          return true
        } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) }
      }

      for (let offset = 0; offset < listLength; offset += BATCH_SIZE) {
        signal?.throwIfAborted?.()
        const chunk = list.slice(offset, Math.min(offset + BATCH_SIZE, listLength))
        const chunkBooks = []

        const chunkTasks = chunk.map(({ filepath, type }, j) =>
          workLimit(async () => {
            signal?.throwIfAborted?.()
            const globalIdx = offset + j
            try {
              let found = byFilepath.get(filepath)
              if (found) {
                found.exist = true
                if (found.status === 'missing') {
                  const restoredStatus = (found.category || found.url) ? 'tagged' : 'non-tag'
                  found.status = restoredStatus
                  await dbLimit(() => Manga.update({ status: restoredStatus, exist: true }, { where: { id: found.id } }))
                }
                // migrate old flat cover path to sharded path
                if (found.coverHash && found.coverPath) {
                  const expectedSharded = makeShardedPath(COVER_PATH, found.coverHash + '.webp')
                  if (found.coverPath !== expectedSharded) {
                    try {
                      await fs.promises.mkdir(path.dirname(expectedSharded), { recursive: true })
                      await fs.promises.rename(found.coverPath, expectedSharded)
                      found.coverPath = expectedSharded
                      await dbLimit(() => Manga.update({ coverPath: expectedSharded }, { where: { id: found.id } }))
                    } catch (e) {
                      console.log(`Migrate cover failed for ${found.filepath}:`, e)
                    }
                  }
                }
                if (isPortable) {
                  const newCoverPath = makeShardedPath(COVER_PATH, path.basename(found.coverPath))
                  if (found.coverPath !== newCoverPath) {
                    found.coverPath = newCoverPath
                    await dbLimit(() => Manga.update({ coverPath: newCoverPath }, { where: { id: found.id } }))
                  }
                }
                return
              }

              const existingManga = await findSameFile(filepath, type, Manga)
              if (existingManga) {
                const prev = byId.get(existingManga.id) || null
                if (prev) {
                  const exist = await pathExists(prev.filepath)
                  if (!exist) {
                    prev.exist = true
                    const newCoverPath = makeShardedPath(COVER_PATH, path.basename(prev.coverPath))
                    prev.coverPath = newCoverPath
                    prev.filepath = filepath
                    byFilepath.set(filepath, prev)
                    await dbLimit(() => Manga.update({ filepath, coverPath: newCoverPath }, { where: { id: existingManga.id } }))
                    return
                  }
                }
              }

              const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
                await coverAndHashInMem(filepath, type, { signal, onChild: cp => context.children.add(cp) })

              if (coverPath && hash) {
                const id = nanoid()
                const newBook = {
                  title: path.basename(filepath),
                  coverPath,
                  hash,
                  filepath,
                  type,
                  id,
                  pageCount,
                  bundleSize,
                  mtime: mtime.toJSON(),
                  coverHash,
                  status: 'non-tag',
                  exist: true,
                  date: Date.now()
                }
                await coverLimit(async () => {
                  await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
                  await coverSharp.toFile(coverPath)
                })
                signal?.throwIfAborted?.()
                chunkBooks.push(newBook)
                byFilepath.set(filepath, newBook)
                byId.set(id, newBook)
              } else {
                sendMessageToWebContents(`Load ${filepath} failed because coverPath or hash is null, ${globalIdx + 1} of ${listLength}`)
              }
            } catch (e) {
              if (e?.name === 'AbortError') throw e
              sendMessageToWebContents(`Load ${filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${listLength}`)
            }
          })
        )

        const results = await Promise.allSettled(chunkTasks)
        if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) {
          throw Object.assign(new Error('Scan aborted'), { name: 'AbortError' })
        }

        if (chunkBooks.length > 0) {
          await dbLimit(() =>
            Manga.sequelize.transaction(async (t) => {
              await Manga.bulkCreate(chunkBooks, {
                transaction: t,
                validate: false,
                individualHooks: false,
                returning: false
              })
            })
          )
        }

        processed += chunk.length
        setProgressBar(processed / listLength)
        try { await clearFolder(TEMP_PATH) } catch {}
      }

      // mark books not seen in this scan as missing
      const missingUpdates = []
      for (const b of dbBooks) {
        if (!b.exist && b.status !== 'missing') {
          missingUpdates.push({ id: b.id, status: 'missing', exist: false })
        }
      }
      if (missingUpdates.length) {
        await Manga.sequelize.transaction(async (t) => {
          for (const u of missingUpdates) {
            await Manga.update({ status: u.status, exist: u.exist }, { where: { id: u.id }, transaction: t })
          }
        })
      }

      try { await clearFolder(TEMP_PATH) } catch {}
      const totalS = (performance.now() - tTotal0) / 1000
      sendMessageToWebContents(`Completed in : ${totalS.toFixed(2)} s`)
    } finally {
      setProgressBar(-1)
    }
  }
  return await loadBookListFromDatabase({ checkExists: false })
})

ipcMain.handle('remove-missing-records', async (event, arg = {}) => {
  const { confirm, vacuum } = arg
  const missingBooks = await Manga.findAll({ where: { status: 'missing' }, raw: true })
  const missingHashes = missingBooks.map(b => b.hash).filter(Boolean)
  const missingIds = missingBooks.map(b => b.id)

  let coverPaths = []
  try {
    const entries = await fs.promises.readdir(COVER_PATH, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const files = await fs.promises.readdir(path.join(COVER_PATH, entry.name))
        coverPaths.push(...files.map(name => path.join(COVER_PATH, entry.name, name)))
      } else if (entry.isFile()) {
        coverPaths.push(path.join(COVER_PATH, entry.name))
      }
    }
  } catch (err) {
    console.log(err)
  }
  const dbCovers = await Manga.findAll({ attributes: ['coverPath'], raw: true })
  const dbCoverSet = new Set(dbCovers.map(c => c.coverPath).filter(Boolean))
  const unreferencedCovers = coverPaths.filter(fullPath => !dbCoverSet.has(fullPath))

  if (!confirm) {
    return {
      totalRows: await Manga.count(),
      missingFileCount: missingIds.length,
      missingCoverCount: unreferencedCovers.length
    }
  }

  for (const id of missingIds) {
    await Manga.destroy({ where: { id } })
  }
  for (const hash of missingHashes) {
    await Metadata.destroy({ where: { hash } })
  }
  for (const coverPath of unreferencedCovers) {
    await fs.promises.rm(coverPath, { force: true, recursive: true })
  }
  if (vacuum) {
    await Manga.sequelize.query('VACUUM')
    await Metadata.sequelize.query('VACUUM')
  }
  return {
    removedFiles: missingIds.length,
    removedCovers: unreferencedCovers.length
  }
})

ipcMain.handle('force-gene-book-list', async (event, arg) => {
  const context = createAbortableContext(event)
  const { signal } = context.controller
  try {
    sendMessageToWebContents('Start rebuilding library')
    await Manga.destroy({ truncate: true })
    await clearFolder(TEMP_PATH)
    await clearFolder(COVER_PATH)

    let list = await scanLibraryFilesWithExclude()
    const listLength = list.length
    sendMessageToWebContents(`Load ${listLength} book from library`)
    if (listLength === 0) {
      setProgressBar(-1)
      return await loadBookListFromDatabase()
    }

    const tTotal0 = performance.now()
    const workLimit = createLimiter(Math.max(1, Number(setting.concurrentScan) || 4))
    const coverLimit = createLimiter(Math.max(1, Number(setting.concurrentWrite) || 2))
    const dbLimit = createLimiter(1)
    const BATCH_SIZE = 50
    let processed = 0

    for (let offset = 0; offset < listLength; offset += BATCH_SIZE) {
      signal?.throwIfAborted?.()
      const chunk = list.slice(offset, Math.min(offset + BATCH_SIZE, listLength))
      const chunkBooks = []

      const chunkTasks = chunk.map(({ filepath, type }, j) =>
        workLimit(async () => {
          signal?.throwIfAborted?.()
          const globalIdx = offset + j
          try {
            const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
              await coverAndHashInMem(filepath, type, { signal, onChild: cp => context.children.add(cp) })

            if (coverPath && hash) {
              const id = nanoid()
              chunkBooks.push({
                title: path.basename(filepath),
                coverPath,
                hash,
                filepath,
                type,
                id,
                pageCount,
                bundleSize,
                mtime: mtime.toJSON(),
                coverHash,
                status: 'non-tag',
                exist: true,
                date: Date.now()
              })
              await coverLimit(async () => {
                await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
                await coverSharp.toFile(coverPath)
              })
            } else {
              sendMessageToWebContents(`Rebuild ${filepath} failed because coverPath or hash is null, ${globalIdx + 1} of ${listLength}`)
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e
            sendMessageToWebContents(`Rebuild ${filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${listLength}`)
          }
        })
      )

      const results = await Promise.allSettled(chunkTasks)
      if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) {
        throw Object.assign(new Error('Rebuild aborted'), { name: 'AbortError' })
      }

      if (chunkBooks.length > 0) {
        await dbLimit(() =>
          Manga.sequelize.transaction(async (t) => {
            await Manga.bulkCreate(chunkBooks, {
              transaction: t,
              validate: false,
              individualHooks: false,
              returning: false
            })
          })
        )
      }

      processed += chunk.length
      setProgressBar(processed / listLength)
      try { await clearFolder(TEMP_PATH) } catch {}
    }

    try { await clearFolder(TEMP_PATH) } catch {}
    const totalS = (performance.now() - tTotal0) / 1000
    sendMessageToWebContents(`Rebuild completed in : ${totalS.toFixed(2)} s`)
  } finally {
    setProgressBar(-1)
  }
  return await loadBookListFromDatabase()
})

ipcMain.handle('patch-local-metadata', async (event, arg) => {
  const context = createAbortableContext(event)
  const { signal } = context.controller
  try {
    sendMessageToWebContents('Start patching local metadata')
    let bookList = await loadBookListFromDatabase()
    const bookListLength = bookList.length
    await clearFolder(TEMP_PATH)
    await clearFolder(COVER_PATH)

    if (bookListLength === 0) {
      setProgressBar(-1)
      return bookList
    }

    const tTotal0 = performance.now()
    const workLimit = createLimiter(Math.max(1, Number(setting.concurrentScan) || 4))
    const coverLimit = createLimiter(Math.max(1, Number(setting.concurrentWrite) || 2))
    const dbLimit = createLimiter(1)
    const BATCH_SIZE = 50
    let processed = 0

    for (let offset = 0; offset < bookListLength; offset += BATCH_SIZE) {
      signal?.throwIfAborted?.()
      const chunk = bookList.slice(offset, Math.min(offset + BATCH_SIZE, bookListLength))
      const chunkUpdates = []

      const chunkTasks = chunk.map((book, j) =>
        workLimit(async () => {
          signal?.throwIfAborted?.()
          const globalIdx = offset + j
          try {
            let { filepath, type } = book
            if (!type) type = 'archive'
            const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } =
              await coverAndHashInMem(filepath, type, { signal, onChild: cp => context.children.add(cp) })

            if (coverPath && hash) {
              _.assign(book, { type, coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash, exist: true })
              chunkUpdates.push(book)
              await coverLimit(async () => {
                await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
                await coverSharp.toFile(coverPath)
              })
            } else {
              sendMessageToWebContents(`Patch ${filepath} failed because coverPath or hash is null, ${globalIdx + 1} of ${bookListLength}`)
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e
            sendMessageToWebContents(`Patch ${book.filepath} failed because ${e?.message || e}, ${globalIdx + 1} of ${bookListLength}`)
          }
        })
      )

      const results = await Promise.allSettled(chunkTasks)
      if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) {
        throw Object.assign(new Error('Patch aborted'), { name: 'AbortError' })
      }

      if (chunkUpdates.length > 0) {
        await dbLimit(() =>
          Manga.sequelize.transaction(async (t) => {
            for (const book of chunkUpdates) {
              await Manga.update(
                _.pick(book, ['type', 'coverPath', 'hash', 'pageCount', 'bundleSize', 'mtime', 'coverHash', 'exist']),
                { where: { id: book.id }, transaction: t }
              )
            }
          })
        )
      }

      processed += chunk.length
      setProgressBar(processed / bookListLength)
      try { await clearFolder(TEMP_PATH) } catch {}
    }

    try { await clearFolder(TEMP_PATH) } catch {}
    const totalS = (performance.now() - tTotal0) / 1000
    sendMessageToWebContents(`Patch completed in : ${totalS.toFixed(2)} s`)
    return await loadBookListFromDatabase()
  } finally {
    setProgressBar(-1)
  }
})

ipcMain.handle('patch-local-metadata-by-book', async (event, book) => {
  let { filepath, type } = book
  if (!type) type = 'archive'
  try {
    const { coverPath, pageCount, bundleSize, mtime, coverHash, hash, coverSharp } = await coverAndHashInMem(filepath, type)
    if (coverPath && hash) {
      await fs.promises.mkdir(path.dirname(coverPath), { recursive: true })
      await coverSharp.toFile(coverPath)
      await clearFolder(TEMP_PATH)
      return Promise.resolve({ coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash })
    }
    throw new Error('coverPath or hash is null')
  } catch (e) {
    sendMessageToWebContents(`Patch ${book.filepath} failed because ${e?.message || e}`)
    await clearFolder(TEMP_PATH)
    return Promise.reject()
  }
})

// Function to read the .ehviewer file
function getEhviewerDataManually(dir) {
  try {
    const filePath = path.join(dir, '.ehviewer')
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8')
      const lines = fileContent.split('\n')
      if (lines.length >= 4) {
        const gid = lines[2].trim()
        const token = lines[3].trim()
        return { gid, token }
      }
    }
    return null
  } catch (error) {
    console.error('Failed to read .ehviewer file:', error)
    return null
  }
}

ipcMain.handle('get-ehviewer-data', async (event, dir) => {
  return getEhviewerDataManually(dir)
})

ipcMain.handle('get-ex-webpage', async (event, { url, cookie }) => {
  if (setting.proxy) {
    return await fetch(url, {
      headers: {
        Cookie: cookie
      },
      agent: new HttpsProxyAgent(setting.proxy)
    })
    .then(async res => {
      const result = await res.text()
      if (!result) throw new Error('Empty response, maybe the cookie is expired')
      return result
    })
    .catch(e => {
      sendMessageToWebContents(`Get ex page failed because ${e}`)
    })
  } else {
    return await fetch(url, {
      headers: {
        Cookie: cookie
      }
    })
    .then(async res => {
      const result = await res.text()
      if (!result) throw new Error('Empty response, maybe the cookie is expired')
      return result
    })
    .catch(e => {
      sendMessageToWebContents(`Get ex page failed because ${e}`)
    })
  }
})

ipcMain.handle('post-data-ex', async (event, { url, data }) => {
  if (setting.proxy) {
    return await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json'
      },
      agent: new HttpsProxyAgent(setting.proxy)
    })
    .then(res => res.text())
    .catch(e => {
      sendMessageToWebContents(`Get ex data failed because ${e}`)
    })
  } else {
    return await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    .then(res => res.text())
    .catch(e => {
      sendMessageToWebContents(`Get ex data failed because ${e}`)
    })
  }
})

ipcMain.handle('save-book', async (event, book) => {
  return await saveBookToDatabase(book)
})

// home
ipcMain.handle('load-collection-list', async (event, arg) => {
  return collectionList
})

ipcMain.handle('save-collection-list', async (event, list) => {
  collectionList = list
  const targetPath = path.join(STORE_PATH, 'collectionList.json')
  const tempPath = path.join(STORE_PATH, 'collectionList.json.tmp')
  await fs.promises.writeFile(tempPath, JSON.stringify(list, null, '  '), { encoding: 'utf-8' })
  return await fs.promises.rename(tempPath, targetPath)
})

// detail
ipcMain.handle('open-url', async (event, url) => {
  shell.openExternal(url)
})

ipcMain.handle('show-file', async (event, filepath) => {
  shell.showItemInFolder(filepath)
})

ipcMain.handle('app:toggle-devtools', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.toggleDevTools()
  }
})

ipcMain.handle('capture-screenshot-cover', async (event, rect) => {
  try {
    const image = await mainWindow.webContents.capturePage(rect)
    const screenshotPath = path.join(TEMP_PATH, `screenshot_${nanoid(8)}.png`)
    await fs.promises.writeFile(screenshotPath, image.toPNG())
    return screenshotPath
  } catch (e) {
    sendMessageToWebContents(`Capture screenshot cover failed because ${e}`)
    return null
  }
})

ipcMain.handle('use-new-cover', async (event, filepath, crop) => {
  const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(filepath))
  const coverPath = path.join(COVER_PATH, nanoid() + path.extname(filepath))
  try {
    await fs.promises.copyFile(filepath, copyTempCoverPath)
    let pipeline = sharp(copyTempCoverPath, { failOnError: false })
    if (crop && typeof crop.left === 'number' && typeof crop.top === 'number' &&
        typeof crop.width === 'number' && typeof crop.height === 'number') {
      pipeline = pipeline.extract({
        left: crop.left,
        top: crop.top,
        width: crop.width,
        height: crop.height
      })
    }
    await pipeline
      .resize(500, 707, {
        fit: 'cover'
      })
      .toFile(coverPath)
    return coverPath
  } catch (e) {
    sendMessageToWebContents(`Generate cover from ${filepath} failed because ${e}`)
  }
})

ipcMain.handle('open-local-book', async (event, filepath) => {
  if (setting.imageExplorer) {
    exec(`${setting.imageExplorer} "${filepath}"`)
  } else {
    shell.openPath(filepath)
  }
})

ipcMain.handle('get-default-manga-reader', async (event, arg) => {
  return _mange_reader
})

function findLibraryRoot(filepath) {
  const libraries = Array.isArray(setting.libraries) ? setting.libraries.filter(Boolean) : []
  for (const lib of libraries) {
    const libPath = path.resolve(lib)
    const targetPath = path.resolve(filepath)
    const rel = path.relative(libPath, targetPath)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return libPath
  }
  return null
}

ipcMain.handle('delete-local-book', async (event, filepath) => {
  const libraryRoot = findLibraryRoot(filepath)
  if (!libraryRoot) return
  try {
    const stats = await fs.promises.stat(filepath)
    if (stats.isDirectory()) {
      const imageFiles = globSync('*.@(jpg|jpeg|png|webp|avif|gif)', {
        cwd: filepath,
        nocase: true,
        absolute: true
      })

      for (const imageFile of imageFiles) {
        try {
          await shell.trashItem(imageFile)
        } catch {
          await fs.promises.rm(imageFile, { force: true })
        }
      }

      const remainingFiles = await fs.promises.readdir(filepath)
      if (remainingFiles.length === 0) {
        await shell.trashItem(filepath)
      }
    } else {
      await shell.trashItem(filepath)
    }
  } catch (e) {
    sendMessageToWebContents(`Delete ${filepath} failed because ${e}`)
  }
  await Manga.destroy({ where: { filepath: filepath } })
})

ipcMain.handle('move-local-book', async (event, oldPath, folderArr) => {
  try {
    const pathSep = require('path').sep
    const folderPath = Array.isArray(folderArr) && folderArr.length > 0 ? folderArr.join(pathSep) : ''
    const libraryRoot = findLibraryRoot(oldPath)
    if (!libraryRoot) {
      sendMessageToWebContents(`Move ${oldPath} failed because it is not inside any library`)
      return false
    }
    const newFilePath = path.join(libraryRoot, folderPath, path.basename(oldPath))
    if (oldPath !== newFilePath) {
      await fs.promises.rename(oldPath, newFilePath)
      sendMessageToWebContents(`Move ${oldPath} to ${newFilePath} successfully`)
      return newFilePath
    } else {
      sendMessageToWebContents(`Move ${oldPath} failed because the new path is the same as the old path`)
      return false
    }
  } catch (e) {
    sendMessageToWebContents(`Move ${oldPath} failed because ${e}`)
    return false
  }
})

// viewer
let currentViewerSession = null

const buildImageMetadata = async (list, bookId, type) => {
  let defaultWidth = 1000
  let defaultHeight = 1414
  const firstItem = list[0]
  // Only read first image metadata for folders (path already exists on disk).
  // Archives use on-demand extraction; skip the extra extraction here to open faster.
  if (firstItem && type === 'folder') {
    try {
      const meta = await sharp(firstItem.absolutePath, { failOnError: false }).metadata()
      if (meta.width && meta.height) {
        defaultWidth = meta.width
        defaultHeight = meta.height
      }
    } catch (e) {
      console.log('read first image metadata failed', e)
    }
  }

  return list.map((item, i) => ({
    id: `${bookId}_${i + 1}`,
    index: i + 1,
    relativePath: item.relativePath,
    originalFilepath: item.absolutePath,
    archivePath: item.archivePath || null,
    innerPath: item.innerPath || null,
    extname: path.extname(item.absolutePath || item.innerPath || ''),
    width: defaultWidth,
    height: defaultHeight,
    total: list.length
  }))
}

ipcMain.handle('load-manga-image-list', async (event, book) => {
  await clearFolder(VIEWER_PATH)

  const { filepath, type, id: bookId } = book
  const list = await getImageListByBookFast(filepath, type)

  sendImageLock = true
  const metadataList = await buildImageMetadata(list, bookId, type)
  currentViewerSession = { book, list: metadataList }

  return metadataList
})

// Process images concurrently; keep CPU/disk pressure reasonable.
const imageProcessLimiter = createLimiter(8)
const thumbnailProcessLimiter = createLimiter(4)

ipcMain.handle('load-manga-image-range', async (event, start, end) => {
  if (!currentViewerSession || !sendImageLock) return
  const { book, list } = currentViewerSession
  const { type, id: bookId } = book
  const thumbnailWidth = _.isFinite(screenWidth / setting.thumbnailColumn) ? Math.floor(screenWidth / setting.thumbnailColumn) : 384
  const widthLimit = _.isNumber(setting.widthLimit) ? Math.ceil(setting.widthLimit) : screenWidth

  const startIndex = Math.max(0, start)
  const endIndex = Math.min(list.length - 1, end)

  const processItem = async (item) => {
    if (!sendImageLock) return
    try {
      let imageFilepath = item.originalFilepath
      const extname = item.extname

      // On-demand extraction for archives / zip
      if (item.archivePath && item.innerPath) {
        imageFilepath = await extractImageByBook(item.archivePath, type, item.innerPath)
      }

      if (!imageFilepath) {
        console.log('missing image filepath', item)
        return
      }

      if (imageFilepath.search(/[%#]/) >= 0) {
        const newFilepath = path.join(VIEWER_PATH, `rename_${nanoid(8)}${extname}`)
        await fs.promises.copyFile(imageFilepath, newFilepath)
        imageFilepath = newFilepath
      }

      let { width, height } = item
      try {
        const meta = await sharp(imageFilepath, { failOnError: false }).metadata()
        if (meta.width && meta.height) {
          width = meta.width
          height = meta.height
        }
      } catch (e) {
        console.log('read image metadata failed', imageFilepath, e)
      }

      if (widthLimit !== 0 && width > widthLimit) {
        height = Math.floor(height * (widthLimit / width))
        width = widthLimit
        const resizedFilepath = path.join(VIEWER_PATH, `resized_${nanoid(8)}.jpg`)
        switch (extname) {
          case '.gif':
            break
          default:
            await sharp(imageFilepath, { failOnError: false })
              .resize({ width })
              .toFile(resizedFilepath)
            imageFilepath = resizedFilepath
            break
        }
      }

      mainWindow.webContents.send('manga-image', {
        id: item.id,
        index: item.index,
        relativePath: item.relativePath,
        filepath: imageFilepath,
        width,
        height,
        total: list.length
      })

      if (setting.viewerType !== 'comicread') {
        await thumbnailProcessLimiter(async () => {
          if (!sendImageLock) return
          let thumbnailPath = path.join(VIEWER_PATH, `thumb_${nanoid(8)}.jpg`)
          switch (extname) {
            case '.gif':
              thumbnailPath = imageFilepath
              break
            default:
              await sharp(imageFilepath, { failOnError: false })
                .resize({ width: thumbnailWidth })
                .toFile(thumbnailPath)
              break
          }
          mainWindow.webContents.send('manga-thumbnail-image', {
            id: item.id,
            thumbId: `thumb_${bookId}_${item.index}`,
            index: item.index,
            relativePath: item.relativePath,
            filepath: imageFilepath,
            thumbnailPath,
            total: list.length
          })
        })
      }
    } catch (err) {
      console.log('process image item failed', item, err)
    }
  }

  const tasks = []
  for (let i = startIndex; i <= endIndex; i++) {
    const item = list[i]
    tasks.push(imageProcessLimiter(() => processItem(item)))
  }
  await Promise.all(tasks)
})

ipcMain.handle('release-sendimagelock', () => {
  sendImageLock = false
  currentViewerSession = null
})

ipcMain.handle('delete-image', async (event, filename, filepath, type) => {
  return await deleteImageFromBook(filename, filepath, type)
})

// setting
ipcMain.handle('select-folder', async (event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory']
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('select-file', async (event, title, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openFile'],
    filters
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('load-setting', async (event, arg) => {
  return setting
})

/** Exclusive save setting with coalescing (last write wins)
 * If multiple save-settings calls happen in a short time, only the last one is applied and written to setting.json
 * This avoids the race condition where one overlaps the other, resulting in a wrong setting.json
 * */

let writing = false
let pending = null
let drainPromise = null
const SETTINGS_FILE = path.join(STORE_PATH, 'setting.json')

async function atomicWriteSettings(obj) {
  const json = JSON.stringify(obj, null, 2) + '\n'
  const tmp = SETTINGS_FILE + '.tmp'
  await fs.promises.writeFile(tmp, json, 'utf-8')
  await fs.promises.rename(tmp, SETTINGS_FILE)
}

async function applySideEffects(setting, receiveSetting) {
  if (receiveSetting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: receiveSetting.proxy
    })
  }
  if (receiveSetting.metadataPath !== setting.metadataPath) {
    Metadata = prepareMetadataModel(path.join(receiveSetting.metadataPath, './metadata.sqlite'))
    await Metadata.sync()
  }
  if (receiveSetting.enabledLANBrowsing !== setting.enabledLANBrowsing) {
    if (receiveSetting.enabledLANBrowsing) {
      enableLANBrowsing()
    } else {
      if (LANBrowsingInstance?.listening) {
        LANBrowsingInstance.close(() => {
          sendMessageToWebContents('LAN browsing closed')
        })
      }
    }
  }
  if (receiveSetting.startOnLogin !== setting.startOnLogin) {
    app.setLoginItemSettings({
      openAtLogin: receiveSetting.startOnLogin
    })
  }
  if (tray && !receiveSetting.minimizeToTray && !receiveSetting.closeToTray) {
    tray.destroy()
    tray = null
  }
}

async function saveSettingExclusive(next) {
  pending = next            // keep only the latest payload
  if (writing) return drainPromise

  writing = true
  drainPromise = (async () => {
    try {
      while (pending) {
        const patch = pending  // snapshot latest
        pending = null
        const prev = setting
        const merged = { ...prev, ...patch }
        // novel 子对象深合并：NovelLibrary 只传 { novel: {...} } 增量，
        // 其它页面（Setting/InternalViewer）已排除 novel 键，这里再做一层保护避免整体覆盖丢字段
        if (prev.novel && patch.novel && typeof prev.novel === 'object' && typeof patch.novel === 'object') {
          merged.novel = { ...prev.novel, ...patch.novel }
        }
        await applySideEffects(prev, merged) // missing settings in the later will not override the previous ones
        await atomicWriteSettings(merged)
        setting = merged
      }
    } finally {
      writing = false
      drainPromise = null
    }
  })()
  return drainPromise
}

ipcMain.handle('save-setting', (_e, receiveSetting) => saveSettingExclusive(receiveSetting))

// ====================   app cache    ====================
ipcMain.handle('app-cache:load-verify-cache', async (_e, opts = {}) => {
  try {
    return await LoadVerifyCache(APP_CACHE_PATH, Manga.sequelize, Metadata.sequelize)
  } catch (e) {
    console.log('LoadVerifyCache failed:', e)
    return { ok: false, appCache: null }
  }
})

ipcMain.on('app-cache::update-cache', (_e, appCache) => {
  latestAppCache = appCache
})

ipcMain.handle('export-database', async (event, folder) => {
  if (folder !== STORE_PATH && folder !== setting.metadataPath) {
    await fs.promises.copyFile(path.join(STORE_PATH, 'collectionList.json'), path.join(folder, 'collectionList.json'))
    await fs.promises.copyFile(metadataSqliteFile, path.join(folder, 'metadata.sqlite'))
    return true
  } else {
    sendMessageToWebContents('Export failed because the target folder is the same as the source folder')
    return false
  }
})

ipcMain.handle('import-database', async (event, arg) => {
  const { collectionListPath, metadataSqlitePath } = arg
  if (collectionListPath && metadataSqlitePath) {
    await Metadata.sequelize.close()
    await fs.promises.copyFile(collectionListPath, path.join(STORE_PATH, 'collectionList.json'))
    await fs.promises.copyFile(metadataSqlitePath, metadataSqliteFile)
    app.relaunch()
    app.exit(0)
  } else {
    sendMessageToWebContents('Import failed because the source folder is empty')
  }
})

ipcMain.handle('import-sqlite', async (event, bookList) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'SQLite', extensions: ['sqlite'] }]
  })
  if (!result.canceled) {
    const db = await open({
      filename: result.filePaths[0],
      driver: sqlite3.Database
    })
    try {
      const re = /'/g
      const bookListLength = bookList.length
      for (let i = 0; i < bookListLength; i++) {
        const book = bookList[i]
        if (book.status !== 'tagged') {
          let metadata
          // 当book type为folder时，尝试获取.ehviewer数据
          if (book.type === 'folder') {
            const dirname = book.filepath
            const ehviewerData = getEhviewerDataManually(dirname)
            const { gid, token } = ehviewerData || {}
            if (gid && token) {
              metadata = await db.get('SELECT * FROM gallery WHERE gid = ? AND token = ?', [gid, token])
            }
          }
          if (metadata === undefined) {
            // remove file extension
            const filename = path.parse(book.title).name
            metadata = await db.get(`SELECT * FROM gallery WHERE torrents LIKE ?
                                                            OR title LIKE ?
                                                            OR title_jpn LIKE ?
                                                            OR thumb LIKE ?`,
              `%${filename}%`,
              `%${filename}%`,
              `%${filename}%`,
              `%${book.coverHash}%`
            )
          }

          if (metadata) {
            metadata.tags = {
              language: metadata.language ? JSON.parse(metadata.language.replace(re, '\"')) : undefined,
              parody: metadata.parody ? JSON.parse(metadata.parody.replace(re, '\"')) : undefined,
              character: metadata.character ? JSON.parse(metadata.character.replace(re, '\"')) : undefined,
              group: metadata.group ? JSON.parse(metadata.group.replace(re, '\"')) : undefined,
              artist: metadata.artist ? JSON.parse(metadata.artist.replace(re, '\"')) : undefined,
              male: metadata.male ? JSON.parse(metadata.male.replace(re, '\"')) : undefined,
              female: metadata.female ? JSON.parse(metadata.female.replace(re, '\"')) : undefined,
              mixed: metadata.mixed ? JSON.parse(metadata.mixed.replace(re, '\"')) : undefined,
              other: metadata.other ? JSON.parse(metadata.other.replace(re, '\"')) : undefined,
              cosplayer: metadata.cosplayer ? JSON.parse(metadata.cosplayer.replace(re, '\"')) : undefined,
              rest: metadata.rest ? JSON.parse(metadata.rest.replace(re, '\"')) : undefined,
            }
            metadata.filecount = +metadata.filecount
            metadata.rating = +metadata.rating
            metadata.posted = +metadata.posted
            metadata.filesize = +metadata.filesize
            metadata.url = `https://exhentai.org/g/${metadata.gid}/${metadata.token}/`
            _.assign(book, _.pick(metadata, ['tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'category', 'url']), { status: 'tagged' })
            await saveBookToDatabase(book)
          }
          setProgressBar(i / bookListLength)
        }
      }
      await db.close()
      setProgressBar(-1)
    } catch (e) {
      console.log(e)
      await db.close()
    }
    return {
      success: true,
      bookList
    }
  } else {
    return {
      success: false
    }
  }
})


// tools

ipcMain.handle('set-progress-bar', async (event, progress) => {
  setProgressBar(progress)
})

ipcMain.handle('get-locale', async (event, arg) => {
  return app.getLocale()
})

ipcMain.handle('copy-image-to-clipboard', async (event, filepath) => {
  clipboard.writeImage(nativeImage.createFromPath(filepath))
})

ipcMain.handle('copy-text-to-clipboard', async (event, text) => {
  clipboard.writeText(text)
})

ipcMain.handle('read-text-from-clipboard', async () => {
  return clipboard.readText()
})

ipcMain.handle('update-window-title', async (event, title) => {
  const name = require('./package.json').name
  const version = require('./package.json').version
  if (title) {
    mainWindow.setTitle(name + ' ' + version + ' | ' + title)
  } else {
    mainWindow.setTitle(name + ' ' + version)
  }
})

ipcMain.handle('switch-fullscreen', async (event, arg) => {
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
})

ipcMain.on('get-path-sep', async (event, arg) => {
  event.returnValue = path.sep
})


const WEB_READER_HTML_PATH = path.join(__dirname, 'web', 'index.html')
const WEB_READER_HTML = fs.existsSync(WEB_READER_HTML_PATH)
  ? fs.readFileSync(WEB_READER_HTML_PATH, 'utf-8')
  : `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>exhentai-manga-manager Web Reader</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #1a1a1a;
      color: #eee;
      overflow: hidden;
    }

    #app { width: 100%; height: 100%; }

    .view {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .hidden { display: none !important; }

    /* Library */
    #library-view { padding: 16px; overflow-y: auto; }

    .toolbar {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
    }

    .toolbar input[type="text"], .toolbar select {
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid #444;
      background: #2a2a2a;
      color: #eee;
      font-size: 14px;
      outline: none;
    }

    .toolbar input[type="text"] { flex: 1; min-width: 200px; }

    .toolbar button {
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      background: #3b82f6;
      color: white;
      font-size: 14px;
      cursor: pointer;
    }

    .toolbar button:hover { background: #2563eb; }

    .book-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 16px;
    }

    .book-card {
      background: #252525;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
      display: flex;
      flex-direction: column;
    }

    .book-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.4);
    }

    .book-cover {
      width: 100%;
      aspect-ratio: 500 / 707;
      object-fit: cover;
      background: #111;
      display: block;
    }

    .book-info {
      padding: 10px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .book-title {
      font-size: 13px;
      line-height: 1.4;
      max-height: 2.8em;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      color: #fff;
    }

    .book-meta {
      font-size: 11px;
      color: #999;
    }

    .loading, .empty {
      text-align: center;
      padding: 40px;
      color: #888;
    }

    /* Reader */
    #reader-view { background: #000; position: relative; }

    #reader-image {
      flex: 1;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }

    #reader-image img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      user-select: none;
      -webkit-user-drag: none;
    }

    #waterfall-view {
      flex: 1;
      width: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 52px 0 60px 0;
      background: #111;
    }

    #waterfall-view img {
      max-width: 100%;
      width: auto;
      height: auto;
      display: block;
      background: #000;
      cursor: pointer;
    }

    .reader-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      z-index: 5;
    }

    .reader-overlay .tap-zone {
      flex: 1;
      height: 100%;
    }

    .reader-bar {
      position: absolute;
      left: 0;
      right: 0;
      padding: 10px 16px;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 10;
      backdrop-filter: blur(4px);
    }

    #reader-top-bar {
      top: 0;
      transition: transform 0.25s ease;
    }
    #reader-top-bar.scrolled-down { transform: translateY(-100%); }
    #reader-bottom-bar { bottom: 0; }

    .reader-bar button, .reader-bar select {
      padding: 6px 12px;
      border-radius: 4px;
      border: none;
      background: #444;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
    }

    .reader-bar select {
      appearance: auto;
      padding-right: 8px;
    }

    .reader-bar button:hover, .reader-bar select:hover { background: #555; }

    .reader-title {
      flex: 1;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin: 0;
    }

    .reader-bar input[type="range"] {
      flex: 1;
      min-width: 100px;
    }

    .page-input {
      width: 60px;
      text-align: center;
      padding: 4px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #222;
      color: #fff;
    }

    .error-toast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #ef4444;
      color: white;
      padding: 10px 20px;
      border-radius: 6px;
      z-index: 100;
      display: none;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="library-view" class="view">
      <div class="toolbar">
        <input type="text" id="search-input" placeholder="搜索标题、标签、文件名..." />
        <select id="sort-select">
          <option value="date_added">添加时间</option>
          <option value="date_modified">修改时间</option>
          <option value="date_posted">发布时间</option>
          <option value="size">大小</option>
          <option value="rating">评分</option>
          <option value="read_count">阅读次数</option>
          <option value="random">随机</option>
        </select>
        <button id="search-btn">搜索</button>
        <button id="refresh-btn">刷新</button>
      </div>
      <div id="book-list" class="book-grid"></div>
      <div id="library-status" class="loading">正在加载书库...</div>
    </div>

    <div id="reader-view" class="view hidden">
      <div id="reader-top-bar" class="reader-bar">
        <button id="back-btn">返回</button>
        <h2 id="reader-title" class="reader-title"></h2>
        <select id="reader-mode" title="阅读模式">
          <option value="waterfall">瀑布流</option>
          <option value="page">翻页</option>
        </select>
      </div>
      <div id="reader-image">
        <img id="page-img" src="" alt="page" />
        <div class="reader-overlay">
          <div class="tap-zone" id="tap-prev"></div>
          <div class="tap-zone" id="tap-next"></div>
        </div>
      </div>
      <div id="waterfall-view" class="hidden"></div>
      <div id="reader-bottom-bar" class="reader-bar">
        <button id="prev-btn">上一页</button>
        <input type="range" id="page-slider" min="1" max="1" value="1" />
        <input type="number" id="page-input" class="page-input" min="1" value="1" />
        <span id="page-count">/ 1</span>
        <button id="next-btn">下一页</button>
      </div>
    </div>
  </div>

  <div id="error-toast" class="error-toast"></div>

  <script>
    const $ = id => document.getElementById(id)

    let currentBook = null
    let currentPages = []
    let currentPage = 1
    let readerMode = 'waterfall'
    let preloadedImages = new Map()
    let waterfallObserver = null

    function showError(msg) {
      const toast = $('error-toast')
      toast.textContent = msg
      toast.style.display = 'block'
      setTimeout(() => { toast.style.display = 'none' }, 3000)
    }

    async function fetchJSON(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`)
      return res.json()
    }

    async function loadLibrary() {
      const listEl = $('book-list')
      const statusEl = $('library-status')
      const filter = $('search-input').value.trim()
      const sortby = $('sort-select').value

      listEl.innerHTML = ''
      statusEl.textContent = '正在加载...'
      statusEl.style.display = 'block'

      try {
        const query = new URLSearchParams({ start: '0', length: '200', sortby })
        if (filter) query.set('filter', filter)
        query.set('_t', Date.now().toString())
        const data = await fetchJSON(\`/api/search?\${query.toString()}\`)
        const books = data.data || []

        if (books.length === 0) {
          statusEl.textContent = filter ? '没有搜索到结果' : '书库为空'
          return
        }

        statusEl.style.display = 'none'
        for (const book of books) {
          const card = document.createElement('div')
          card.className = 'book-card'
          card.innerHTML = \`
            <img class="book-cover" src="/api/archives/\${encodeURIComponent(book.arcid)}/thumbnail" loading="lazy" alt="cover" />
            <div class="book-info">
              <div class="book-title">\${escapeHtml(book.title)}</div>
              <div class="book-meta">\${book.pagecount || '?'} 页 · \${formatSize(book.size)}</div>
            </div>
          \`
          card.addEventListener('click', () => openBook(book))
          listEl.appendChild(card)
        }
      } catch (err) {
        statusEl.textContent = '加载失败: ' + err.message
        showError('加载书库失败: ' + err.message)
      }
    }

    async function openBook(book) {
      try {
        const data = await fetchJSON(\`/api/archives/\${encodeURIComponent(book.arcid)}/files\`)
        currentBook = book
        currentPages = data.pages || []
        currentPage = 1

        $('reader-title').textContent = book.title
        $('page-count').textContent = \`/ \${currentPages.length}\`
        $('page-slider').max = currentPages.length
        $('page-slider').value = 1
        $('page-input').max = currentPages.length
        $('page-input').value = 1
        $('reader-mode').value = readerMode

        $('library-view').classList.add('hidden')
        $('reader-view').classList.remove('hidden')

        renderReader()
      } catch (err) {
        showError('打开漫画失败: ' + err.message)
      }
    }

    function closeReader() {
      $('reader-view').classList.add('hidden')
      $('library-view').classList.remove('hidden')
      currentBook = null
      currentPages = []
      currentPage = 1
      preloadedImages.clear()
      if (waterfallObserver) {
        waterfallObserver.disconnect()
        waterfallObserver = null
      }
    }

    function renderReader() {
      if (readerMode === 'waterfall') {
        $('reader-image').classList.add('hidden')
        $('reader-bottom-bar').classList.add('hidden')
        $('waterfall-view').classList.remove('hidden')
        renderWaterfall()
      } else {
        $('waterfall-view').classList.add('hidden')
        $('reader-image').classList.remove('hidden')
        $('reader-bottom-bar').classList.remove('hidden')
        updatePage()
      }
    }

    function renderWaterfall() {
      const container = $('waterfall-view')
      container.innerHTML = ''
      $('reader-top-bar').classList.remove('scrolled-down')

      let lastScrollTop = 0
      container.onscroll = () => {
        const st = container.scrollTop
        if (st > lastScrollTop && st > 60) {
          $('reader-top-bar').classList.add('scrolled-down')
        } else {
          $('reader-top-bar').classList.remove('scrolled-down')
        }
        lastScrollTop = st <= 0 ? 0 : st
      }

      waterfallObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const img = entry.target
          if (entry.isIntersecting) {
            const src = img.dataset.src
            if (src && img.src !== src) img.src = src
          }
        })
      }, { root: container, rootMargin: '1000px' })

      currentPages.forEach((url, index) => {
        const img = document.createElement('img')
        img.dataset.src = url
        img.alt = \`page \${index + 1}\`
        img.loading = 'lazy'
        waterfallObserver.observe(img)
        container.appendChild(img)
      })

      container.scrollTop = 0
    }

    function updatePage() {
      if (!currentBook || currentPages.length === 0) return
      const pageUrl = currentPages[currentPage - 1]
      $('page-img').src = pageUrl
      $('page-slider').value = currentPage
      $('page-input').value = currentPage
      preloadNeighbors()
    }

    function preloadNeighbors() {
      const urls = []
      if (currentPage > 1) urls.push(currentPages[currentPage - 2])
      if (currentPage < currentPages.length) urls.push(currentPages[currentPage])

      for (const url of urls) {
        if (!preloadedImages.has(url)) {
          const img = new Image()
          img.src = url
          preloadedImages.set(url, img)
        }
      }
    }

    function prevPage() {
      if (currentPage > 1) {
        currentPage--
        updatePage()
      }
    }

    function nextPage() {
      if (currentPage < currentPages.length) {
        currentPage++
        updatePage()
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div')
      div.textContent = text
      return div.innerHTML
    }

    function formatSize(bytes) {
      if (!bytes || isNaN(bytes)) return '?'
      const units = ['B', 'KB', 'MB', 'GB']
      let i = 0
      let size = Number(bytes)
      while (size >= 1024 && i < units.length - 1) {
        size /= 1024
        i++
      }
      return size.toFixed(1) + ' ' + units[i]
    }

    // Events
    $('search-btn').addEventListener('click', loadLibrary)
    $('refresh-btn').addEventListener('click', loadLibrary)
    $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadLibrary() })

    $('back-btn').addEventListener('click', closeReader)
    $('prev-btn').addEventListener('click', prevPage)
    $('next-btn').addEventListener('click', nextPage)
    $('tap-prev').addEventListener('click', prevPage)
    $('tap-next').addEventListener('click', nextPage)

    $('reader-mode').addEventListener('change', e => {
      readerMode = e.target.value
      renderReader()
    })

    $('page-slider').addEventListener('input', e => {
      currentPage = parseInt(e.target.value, 10)
      updatePage()
    })

    $('page-input').addEventListener('change', e => {
      let p = parseInt(e.target.value, 10)
      if (isNaN(p)) p = 1
      p = Math.max(1, Math.min(currentPages.length, p))
      currentPage = p
      updatePage()
    })

    document.addEventListener('keydown', e => {
      if ($('reader-view').classList.contains('hidden')) return
      if (readerMode !== 'page') return
      switch (e.key) {
        case 'ArrowLeft': case 'PageUp': prevPage(); break
        case 'ArrowRight': case 'PageDown': case ' ': nextPage(); break
        case 'Escape': closeReader(); break
        case 'Home': currentPage = 1; updatePage(); break
        case 'End': currentPage = currentPages.length; updatePage(); break
      }
    })

    // Init
    loadLibrary()
  </script>
</body>
</html>
`
const LANBrowsing = express()
LANBrowsing.use(express.json({ limit: '10mb' }))
const port = 23786
const sortkey_map = {
  "date_added": {
    key: "date",
    type: "number"
  },
  "date_modified": {
    key: "mtime",
    type: "date"
  },
  "date_posted": {
    key: "posted",
    type: "number"
  },
  "size": {
    key: "bundleSize",
    type: "number"
  },
  "rating": {
    key: "rating",
    type: "number"
  },
  "read_count": {
    key: "readCount",
    type: "number"
  },
  "lastread": {
    key: "lastReadAt",
    type: "number"
  },
  "random": {}
}

// 设置静态文件夹
const staticFilePath = path.resolve(STORE_PATH, 'public')
fs.mkdirSync(staticFilePath, { recursive: true })
LANBrowsing.use('/static', express.static(staticFilePath))

// 禁止浏览器缓存 API 响应，确保网页数据实时
LANBrowsing.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  next()
})

// Web 浏览器阅读器
LANBrowsing.get('/web', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(WEB_READER_HTML)
})
LANBrowsing.get('/web/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(WEB_READER_HTML)
})

LANBrowsing.get('/icon.ico', (req, res) => {
  const iconPath = path.join(__dirname, 'public/icon.ico')
  if (fs.existsSync(iconPath)) {
    res.set('Content-Type', 'image/x-icon')
    res.sendFile(iconPath)
  } else {
    res.status(404).send()
  }
})

let tagTranslation = undefined

// sort
function compareItems(a, b, sortKey, ascending = false) {
  const sortConfig = sortkey_map[sortKey]
  if (!sortConfig) {
    throw new Error(`Invalid sort key: ${sortKey}`)
  }

  const { key, type } = sortConfig

  let valA = a[key]
  let valB = b[key]

  if (type === "number") {
    valA = Number(valA) || 0
    valB = Number(valB) || 0
  } else if (type === "date") {
    valA = new Date(valA).getTime() || 0
    valB = new Date(valB).getTime() || 0
  } else {
    valA = String(valA || "")
    valB = String(valB || "")
  }

  if (valA < valB) return ascending ? -1 : 1
  if (valA > valB) return ascending ? 1 : -1
  return 0
}

// 格式化标签
const formatTags = (tags) => {
  return Object.entries(tags)
    .map(([key, values]) => values.map(value => setting.showTranslation ? `${tagTranslation?.[key]?.name || key}:${tagTranslation?.[key]?.[value]?.name || value}` : `${key}:${value}`).join(', '))
    .join(', ')
}

ipcMain.handle('update-tag-translation', async (event, _tagTranslation) => {
  tagTranslation = _tagTranslation
})

LANBrowsing.get('/api/search', async (req, res) => {
  try {
    const filter = req.query.filter || ''
    const start = parseInt(req.query.start, 10) || 0
    const length = parseInt(req.query.length, 10) || 200
    // 默认使用最近阅读排序
    let sortKey = req.query.sortby || 'lastread'
    let showAll = false
    if (sortKey.includes("_all")) {
      sortKey = sortKey.replace("_all", "")
      showAll = true
    }

    // 读取并搜索数据库
    const mangas = (await loadBookListFromDatabase()).filter(manga => manga.status !== 'missing')
    let filterMangas
    if (filter) {
      filterMangas = mangas.filter(manga => {
        return JSON.stringify(_.pick(manga, ['title', 'title_jpn', 'status', 'category', 'filepath', 'url'])).toLowerCase().includes(filter.toLowerCase())
        || formatTags(manga.tags).toLowerCase().includes(filter.toLowerCase())
      })
    } else {
      filterMangas = mangas
    }

    if (sortKey !== 'random') {
      filterMangas = filterMangas.sort((a, b) => compareItems(a, b, sortKey))
    } else {
      filterMangas = _.shuffle(filterMangas)
    }
    filterMangas = showAll ? filterMangas : filterMangas.slice(start, start + length)

    // 格式化响应数据
    const responseData = filterMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
      url: manga.url
    }))
    const hash = createHash('md5').update(JSON.stringify(responseData)).digest('hex')
    res.json({
      data: responseData,
      hash,
      draw: 0,
      recordsFiltered: responseData.length,
      recordsTotal: filterMangas.length
    })
  } catch (error) {
    res.status(500).send(error.message)
  }
})

LANBrowsing.get('/api/search/random', async (req, res) => {
  try {
    // 从数据库中随机获取指定数量的 Manga 记录
    const count = parseInt(req.query.count, 10) || 1
    const randomMangas = _.sampleSize(await loadBookListFromDatabase(), count)

    const responseData = randomMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
    }))

    res.json({
      data: responseData
    })
  } catch (error) {
    console.error('Failed to fetch random Manga:', error)
    res.status(500).send('Internal Server Error')
  }
})

LANBrowsing.get('/api/archives/:hash/metadata', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    const mangas = await loadBookListFromDatabase()
    const manga = mangas.find(manga => manga.hash === mangaHash)

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    // 构造响应数据
    const responseMetadata = {
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
    }

    res.json(responseMetadata)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理封面图片请求
LANBrowsing.get('/api/archives/:hash/thumbnail', async (req, res) => {
  try {
    const hash = req.params.hash
    const manga = await Manga.findOne({where: {hash: hash}})
    if (!manga || !manga.coverPath) {
      return res.status(404).send('Cover not found')
    }
    const coverFilePath = manga.coverPath
    if (fs.existsSync(coverFilePath)) {
      res.sendFile(coverFilePath)
    } else {
      res.status(404).send('Cover file not found')
    }
  } catch (e) {
    console.error('Thumbnail error:', e)
    res.status(500).send('Thumbnail error')
  }
})

let existBook = {
  hash: null,
  imageList: []
}

// 处理章节列表请求
LANBrowsing.get('/api/archives/:hash/files', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    const manga = await Manga.findOne({where: {hash: mangaHash}})

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    await clearFolder(VIEWER_PATH)
    await clearFolder(staticFilePath)
    const imageList = await getImageListByBook(manga.filepath, manga.type)

    existBook = {
      hash: manga.hash,
      imageList: imageList.map(p => p.absolutePath)
    }
    // 构造响应数据
    const responseFiles = {
      job: Date.now(), // 示例中的 job 可以是一个随机数或时间戳
      pages: imageList.map((file, index) => `/api/archives/${manga.hash}/page?path=${index + 1}`)
    }

    res.json(responseFiles)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理章节图片请求
LANBrowsing.get('/api/archives/:hash/page', async (req, res) => {
  const hash = req.params.hash
  const page = parseInt(req.query.path, 10)
  if (isNaN(page) || page < 1) {
    return res.status(400).send('Invalid page number')
  }

  const manga = await Manga.findOne({where: {hash: hash}})
  if (!manga || !manga.filepath) {
    return res.status(404).send('File not found')
  }

  // 获取章节图片列表
  try {
    let imageList
    if (manga.hash === existBook.hash) {
      imageList = existBook.imageList
    } else {
      await clearFolder(VIEWER_PATH)
      await clearFolder(staticFilePath)
      imageList = await getImageListByBook(manga.filepath, manga.type)
      imageList = imageList.map(p => p.absolutePath)
      existBook.hash = manga.hash
      existBook.imageList = imageList
    }
    const imageFilePath = imageList[page - 1]
    if (!imageFilePath) {
      return res.status(404).send('Image not found')
    }

    // 重命名并复制图片文件到静态文件夹
    const imageFileName = `${manga.hash}_${page}${path.extname(imageFilePath)}`
    const imageFile = path.join(staticFilePath, imageFileName)
    await fs.promises.copyFile(imageFilePath, imageFile)

    // 发送图片文件
    if (fs.existsSync(imageFile)) {
      res.sendFile(imageFile)
    } else {
      res.status(404).send('Image file not found')
    }
  } catch (err) {
    console.error(err)
    res.status(500).send('Error processing file')
  }
})

// 处理webview请求
LANBrowsing.get('/reader', async (req, res) => {
  const id = req.query.id
  const manga = await Manga.findOne({where: {hash: id}})

  // 重定向至manga.url
  if (manga && manga.url) {
    res.redirect(manga.url.replace('exhentai', 'e-hentai'))
  } else {
    res.status(404).send('Manga not found')
  }
})

// ==================== reading progress LAN API ====================
LANBrowsing.get('/api/progress/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params
    if (type === 'novel') {
      if (!setting.enableNovel || !Novel) {
        return res.json(null)
      }
      const novel = await Novel.findByPk(id)
      if (!novel) return res.json(null)
      const progress = typeof novel.readProgress === 'string' ? JSON.parse(novel.readProgress) : novel.readProgress || null
      return res.json({
        progress,
        lastReadAt: novel.lastReadAt
      })
    } else if (type === 'manga') {
      const manga = await Manga.findByPk(id)
      if (!manga) return res.json(null)
      const progress = manga.readProgress ? JSON.parse(manga.readProgress) : null
      return res.json({
        progress,
        lastReadAt: manga.lastReadAt
      })
    }
    res.status(400).json({ error: 'Invalid type' })
  } catch (e) {
    console.error('Get progress error:', e)
    res.status(500).json({ error: e.message })
  }
})

LANBrowsing.post('/api/progress/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params
    const { progress } = req.body
    if (!progress) {
      return res.status(400).json({ error: 'Progress is required' })
    }
    if (type === 'novel') {
      if (!setting.enableNovel || !Novel) {
        return res.status(404).json({ error: 'Novel disabled' })
      }
      await Novel.update({
        readProgress: JSON.stringify(progress),
        lastReadAt: Date.now()
      }, { where: { id } })
      res.json({ success: true })
    } else if (type === 'manga') {
      await Manga.update({
        readProgress: JSON.stringify(progress),
        lastReadAt: Date.now()
      }, { where: { id } })
      res.json({ success: true })
    } else {
      res.status(400).json({ error: 'Invalid type' })
    }
  } catch (e) {
    console.error('Save progress error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ==================== novel LAN API ====================

const _chapterTitleCache = new WeakMap()
const _isChapterTitleLine = (line) => {
  const trimmed = line.trim()
  if (!trimmed) return false
  let cache = _chapterTitleCache.get(CHAPTER_RULES)
  if (!cache) {
    cache = CHAPTER_RULES.map(r => new RegExp(r.pattern.source, r.pattern.flags.replace('g', '')))
    _chapterTitleCache.set(CHAPTER_RULES, cache)
  }
  for (const re of cache) {
    re.lastIndex = 0
    if (re.test(trimmed)) return true
  }
  return false
}

const stripChapterTextEdges = (text, chapterTitle) => {
  if (!text) return text
  let result = text

  if (chapterTitle) {
    const titleLower = chapterTitle.toLowerCase()
    const resultLower = result.trimStart().toLowerCase()
    if (resultLower.startsWith(titleLower)) {
      let offset = chapterTitle.length
      const trimmedStart = result.trimStart()
      let lineEnd = offset
      while (lineEnd < trimmedStart.length && trimmedStart[lineEnd] !== '\n' && trimmedStart[lineEnd] !== '\r') {
        lineEnd++
      }
      const remainingOnLine = trimmedStart.slice(offset, lineEnd).trim()
      if (remainingOnLine.length <= 30) {
        offset = lineEnd
      }
      while (offset < trimmedStart.length && /\s/.test(trimmedStart[offset])) offset++
      result = trimmedStart.slice(offset)
    }
  }

  const lines = result.split('\n')

  if (lines.length > 0 && chapterTitle) {
    const firstLine = lines[0].trim()
    if (firstLine.length > 0 && firstLine.length <= 10 && chapterTitle.endsWith(firstLine)) {
      lines.shift()
    }
  }

  if (lines.length > 0) {
    const firstLine = lines[0].trim()
    if (_isChapterTitleLine(firstLine)) {
      lines.shift()
    }
  }

  while (lines.length > 0) {
    const lastIdx = lines.length - 1
    const lastLine = lines[lastIdx].trim()
    if (!lastLine) {
      lines.pop()
      continue
    }
    if (_isChapterTitleLine(lastLine)) {
      lines.pop()
      continue
    }
    break
  }

  return lines.join('\n').trim()
}

LANBrowsing.get('/api/novel/list', async (req, res) => {
  try {
    if (!setting.enableNovel || !Novel) {
      return res.json({ data: [], recordsTotal: 0, recordsFiltered: 0 })
    }
    const filter = (req.query.filter || '').toLowerCase()
    const sortBy = req.query.sortby || 'recentRead'
    
    const order = []
    switch (sortBy) {
      case 'recentRead': order.push(['lastReadAt', 'DESC'], ['date', 'DESC']); break
      case 'readCount': order.push(['readCount', 'DESC']); break
      case 'title': order.push(['title', 'ASC']); break
      case 'dateAsc': order.push(['date', 'ASC']); break
      default: order.push(['date', 'DESC'])
    }
    
    let novels = await Novel.findAll({ order, raw: true })
    if (filter) {
      novels = novels.filter(n => 
        (n.title || '').toLowerCase().includes(filter) ||
        (n.author || '').toLowerCase().includes(filter) ||
        (n.filename || '').toLowerCase().includes(filter)
      )
    }
    
    const data = novels.map(n => ({
      id: n.id,
      title: n.title,
      author: n.author,
      type: n.type,
      chapterCount: n.chapterCount,
      filesize: n.filesize,
      date: n.date,
      lastReadAt: n.lastReadAt,
      readCount: n.readCount,
      hasCover: !!n.coverPath
    }))
    
    res.json({
      data,
      recordsTotal: novels.length,
      recordsFiltered: novels.length
    })
  } catch (e) {
    console.error('[LAN] novel list error:', e)
    res.status(500).json({ error: e.message })
  }
})

LANBrowsing.get('/api/novel/:id/cover', async (req, res) => {
  try {
    if (!Novel) return res.status(404).send('Novel not found')
    const novel = await Novel.findByPk(req.params.id)
    if (!novel || !novel.coverPath) {
      return res.status(404).send('Cover not found')
    }
    res.set('Content-Type', 'image/webp')
    res.sendFile(novel.coverPath)
  } catch (e) {
    res.status(500).send(e.message)
  }
})

LANBrowsing.get('/api/novel/:id/chapters', async (req, res) => {
  try {
    if (!NovelChapter) return res.json([])
    const chapters = await NovelChapter.findAll({
      where: { novelId: req.params.id },
      order: [['index', 'ASC']],
      raw: true
    })
    res.json(chapters.map(c => ({
      index: c.index,
      title: c.title,
      charCount: c.charCount,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      byteStartOffset: c.byteStartOffset,
      byteEndOffset: c.byteEndOffset
    })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

LANBrowsing.get('/api/novel/:id/chapter/:chapterIdx/text', async (req, res) => {
  try {
    if (!Novel || !NovelChapter) return res.status(404).send('Not found')
    const novel = await Novel.findByPk(req.params.id)
    if (!novel) return res.status(404).send('Novel not found')

    const chapterIdx = parseInt(req.params.chapterIdx, 10)
    const chapter = await NovelChapter.findOne({
      where: { novelId: req.params.id, index: chapterIdx },
      raw: true
    })
    if (!chapter) return res.status(404).send('Chapter not found')

    let text = ''
    if (novel.type === 'epub') {
      text = await readEpubChapter(novel, chapter)
    } else {
      text = await readTxtChapter(novel, chapter)
    }

    text = stripChapterTextEdges(text, chapter.title)

    res.json({ text })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

LANBrowsing.get('/api/novel/:id/text', async (req, res) => {
  try {
    if (!Novel) return res.status(404).send('Novel not found')
    const novel = await Novel.findByPk(req.params.id)
    if (!novel) return res.status(404).send('Novel not found')
    
    const filepath = novel.filepath
    if (!filepath || !fs.existsSync(filepath)) {
      return res.status(404).send('File not found')
    }
    
    const ext = path.extname(filepath).toLowerCase()
    res.set('Content-Type', 'text/plain; charset=utf-8')
    
    if (ext === '.txt' || filepath.endsWith('.epub.txt')) {
      const content = fs.readFileSync(filepath, 'utf-8')
      res.send(content)
    } else {
      res.status(400).send('Unsupported format')
    }
  } catch (e) {
    res.status(500).send(e.message)
  }
})

// Edge TTS 音色列表
LANBrowsing.get('/api/novel/tts/voices', async (req, res) => {
  try {
    res.json(EDGE_TTS_ZH_VOICES)
  } catch (e) {
    res.status(500).send(e.message)
  }
})

// Edge TTS 合成语音
LANBrowsing.post('/api/novel/tts/speak', async (req, res) => {
  try {
    const { text, voice, rate, pitch } = req.body || {}
    if (!text || !text.trim()) {
      return res.status(400).send('Text is required')
    }

    const mp3Buffer = await synthesizeEdgeTtsMp3({
      text: text.trim(),
      voice: voice || 'zh-CN-YunxiNeural',
      rate: Number.isFinite(rate) ? rate : 1,
      pitch: Number.isFinite(pitch) ? pitch : 1
    })

    res.set('Content-Type', 'audio/mpeg')
    res.set('Content-Disposition', 'inline')
    res.send(Buffer.from(mp3Buffer))
  } catch (e) {
    res.status(500).send(e.message)
  }
})

LANBrowsing.get('/', (req, res) => {
  switch (setting.language) {
    case 'en-US':
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/LAN-Browsing')
      break
    case 'zh-CN':
    case 'zh-TW':
    default:
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/%E5%B1%80%E5%9F%9F%E7%BD%91%E6%B5%8F%E8%A7%88')
      break
  }
})

let LANBrowsingInstance
// 启动Express服务器
const enableLANBrowsing = () => {
  const lanIP = getLanIP()
  const sendLANMessage = (prefix) => {
    sendMessageToWebContents(`${prefix} http://${lanIP}:${port}\nWeb reader: http://${lanIP}:${port}/web`)
  }
  if (LANBrowsingInstance?.listening) {
    LANBrowsingInstance.close(() => {
      LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
        sendLANMessage('LAN browsing restart and listening at')
      })
    })
  } else {
    LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
      sendLANMessage('LAN browsing listening at')
    })
  }
}

// ==================== novel ====================
if (setting.enableNovel) {
  ipcMain.handle('novel:list', async (_e, opts = {}) => {
    try {
      const order = []
      switch (opts.sortBy) {
        case 'recentRead':
          order.push(['lastReadAt', 'DESC'], ['date', 'DESC'])
          break
        case 'readCount':
          order.push(['readCount', 'DESC'])
          break
        case 'title':
          order.push(['title', 'ASC'])
          break
        case 'dateAsc':
          order.push(['date', 'ASC'])
          break
        default:
          order.push(['lastReadAt', 'DESC'], ['date', 'DESC'])
      }
      const list = await Novel.findAll({ order })
      return list.map(n => {
        const obj = n.toJSON()
        obj.readProgress = obj.readProgress || { chapterIdx: 0, scrollTop: 0 }
        return obj
      })
    } catch (e) {
      console.error('[novel:list] error:', e)
      return []
    }
  })

  const scanNovelLibraryInternal = async (event, progressBase = 0) => {
    sendMessageToWebContents('开始扫描小说库')
  const libraries = Array.isArray(setting.novelLibraries) ? setting.novelLibraries.filter(Boolean) : []
    if (!libraries.length) {
      sendMessageToWebContents('未配置小说库目录')
      return { added: 0, total: 0 }
    }

    try { event.sender.send('novel:import-progress', { phase: 'scanning', current: progressBase, total: 100, message: '正在加载已有记录...' }) } catch (e) {}
    const dbNovels = await Novel.findAll({ raw: true })
    const byFilepath = new Map(dbNovels.map(n => [n.filepath, n]))
    for (const n of dbNovels) n.exist = false

    try { event.sender.send('novel:import-progress', { phase: 'scanning', current: progressBase + 5, total: 100, message: '正在扫描文件列表...' }) } catch (e) {}
    let list = await scanNovelFiles(libraries)
    const pattern = (setting.excludeFile || '').trim()
    if (pattern) {
      const excludeRe = new RegExp(pattern)
      list = list.filter(item => !excludeRe.test(item.filepath))
    }

    const totalFiles = list.length
    const progressRange = 95 - progressBase

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
    const forceGc = () => {
      if (typeof gc === 'function') {
        try { gc() } catch (e) {}
      }
    }

    let added = 0
    for (let i = 0; i < list.length; i++) {
      try {
        const item = list[i]
        const progress = progressBase + 10 + Math.round((i / totalFiles) * progressRange)
        try {
          event.sender.send('novel:import-progress', { phase: 'scanning', current: progress, total: 100, message: `正在处理: ${path.basename(item.filepath)} (${i + 1}/${totalFiles})` })
        } catch (e) {
          console.error(`[scan] send progress failed: ${e.message}`)
        }

        if (i % 3 === 0 && i > 0) {
          await delay(30)
          forceGc()
        }

        let existing = byFilepath.get(item.filepath)
        if (!existing && item.type === 'epub') {
          const txtPath = item.filepath + '.epub.txt'
          existing = byFilepath.get(txtPath)
        }
        if (existing) {
          existing.exist = true
          let epubNeedsReimport = false
          if (item.type === 'epub') {
            const cachePath = item.filepath + '.epub.txt'
            const cacheExists = fs.existsSync(cachePath)
            if (!cacheExists) {
              sendMessageToWebContents(`检测到 epub 缓存丢失，重新导入: ${existing.title}`)
              epubNeedsReimport = true
            } else {
              const firstChapter = await NovelChapter.findOne({ where: { novelId: existing.id }, order: [['index', 'ASC']], raw: true })
              if (!firstChapter || firstChapter.charCount < 10) {
                sendMessageToWebContents(`检测到 epub 章节为空，重新导入: ${existing.title}`)
                epubNeedsReimport = true
              }
            }
            if (epubNeedsReimport) {
              try {
                try { await fs.promises.unlink(cachePath) } catch (e) {}
                const onProgress = (p) => {
                  try { event.sender.send('novel:import-progress', { ...p, filepath: item.filepath }) } catch (e) {}
                }
                const imported = await importNovel(item.filepath, onProgress, COVER_PATH)
                await NovelChapter.destroy({ where: { novelId: existing.id } })
                if (imported.chapters.length > 0) {
                  await NovelChapter.bulkCreate(imported.chapters.map(c => novelChapterRow(c, existing.id)))
                }
                const updateData = { chapterCount: imported.chapters.length, type: 'txt', filepath: imported.filepath }
                if (imported.coverPath) updateData.coverPath = imported.coverPath
                await Novel.update(updateData, { where: { id: existing.id } })
                sendMessageToWebContents(`重新导入完成: ${existing.title} (${imported.chapters.length} 章)`)
                forceGc()
              } catch (e) {
                console.error(`[epub] 扫描重新导入失败: ${existing.title}`, e)
                sendMessageToWebContents(`重新导入失败: ${existing.title} - ${e.message}`)
              }
            }
          }
          if (existing.status === 'missing') {
            await Novel.update({ exist: true, status: 'non-tag' }, { where: { id: existing.id } })
          } else {
            await Novel.update({ exist: true }, { where: { id: existing.id } })
          }
          continue
        }
        const onProgress = (p) => {
          try { event.sender.send('novel:import-progress', { ...p, filepath: item.filepath }) } catch (e) {}
        }
        const imported = await importNovel(item.filepath, onProgress, COVER_PATH)
        const existingItem = await findExistingNovel(imported.filepath, imported.hash)
        const novelId = existingItem ? existingItem.id : imported.id
        const novelRow = {
          id: novelId, hash: imported.hash, filepath: imported.filepath,
          filename: imported.filename, type: imported.type, filesize: imported.filesize,
          encoding: imported.encoding, title: imported.title, author: imported.author,
          status: 'non-tag', chapterCount: imported.chapters.length,
          exist: true, date: Date.now()
        }
        if (imported.coverPath) {
          novelRow.coverPath = imported.coverPath
        } else if (imported.coverBuffer) {
          const sharp = require('sharp')
          const coverPath = path.join(COVER_PATH, novelId + '.webp')
          await sharp(imported.coverBuffer).resize(500, 707, { fit: 'contain', background: '#303133' }).toFile(coverPath)
          novelRow.coverPath = coverPath
        }
        await Novel.upsert(novelRow)
        await NovelChapter.destroy({ where: { novelId } })
        await NovelChapter.bulkCreate(imported.chapters.map(c => novelChapterRow(c, novelId)))
        added++
        forceGc()
      } catch (e) {
        console.error(`[novel] 处理文件失败: ${item.filepath}`, e)
        sendMessageToWebContents(`导入失败: ${path.basename(item.filepath)} - ${e.message}`)
      }
    }

    forceGc()

    try { event.sender.send('novel:import-progress', { phase: 'scanning', current: 95, total: 100, message: '正在更新数据库状态...' }) } catch (e) {}
    await Novel.update({ status: 'missing' }, { where: { exist: false } })

    try { event.sender.send('novel:import-progress', { phase: 'done', current: 100, total: 100, message: `扫描完成: 新增 ${added} 本，共 ${list.length} 本` }) } catch (e) {}
    sendMessageToWebContents(`扫描完成: 新增 ${added} 本，共 ${list.length} 本`)
    return { added, total: list.length }
  }
  ipcMain.handle('novel:scan-library', scanNovelLibraryInternal)

  // 根据文件路径或 hash 查找已有记录，避免重复导入
  const findExistingNovel = async (filepath, hash) => {
    let existing = await Novel.findOne({ where: { filepath } })
    if (!existing && hash) existing = await Novel.findOne({ where: { hash } })
    return existing
  }

  const novelChapterRow = (c, novelId) => ({
    id: c.id,
    novelId,
    index: c.index,
    title: c.title,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    byteStartOffset: c.byteStartOffset,
    byteEndOffset: c.byteEndOffset,
    charCount: c.charCount
  })

  ipcMain.handle('novel:import-dialog', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入小说',
      properties: ['openFile'],
      filters: [{ name: '小说', extensions: ['txt', 'epub'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    const filepath = result.filePaths[0]
    // 进度回调：转发给渲染层用于显示加载条
    const onProgress = (p) => {
      try { event.sender.send('novel:import-progress', { ...p, filepath }) } catch (e) {}
    }
    try {
      const imported = await importNovel(filepath, onProgress, COVER_PATH)
      // 查找已有记录（按 filepath 或 hash），避免重复生成 novel id
      const existing = await findExistingNovel(imported.filepath, imported.hash)
      const novelId = existing ? existing.id : imported.id
      const novelRow = {
        id: novelId,
        hash: imported.hash,
        filepath: imported.filepath,
        filename: imported.filename,
        type: imported.type,
        filesize: imported.filesize,
        encoding: imported.encoding,
        title: imported.title,
        author: imported.author,
        status: 'non-tag',
        chapterCount: imported.chapters.length,
        exist: true,
        date: Date.now()
      }
      if (imported.coverPath) {
        novelRow.coverPath = imported.coverPath
      } else if (imported.coverBuffer) {
        const sharp = require('sharp')
        const coverPath = path.join(COVER_PATH, novelId + '.webp')
        await sharp(imported.coverBuffer).resize(500, 707, { fit: 'contain', background: '#303133' }).toFile(coverPath)
        novelRow.coverPath = coverPath
      }
      await Novel.upsert(novelRow)
      await NovelChapter.destroy({ where: { novelId } })
      await NovelChapter.bulkCreate(imported.chapters.map(c => novelChapterRow(c, novelId)))
      sendMessageToWebContents(`Imported novel: ${imported.title} (${imported.chapters.length} chapters)`)
      return novelId
    } catch (e) {
      sendMessageToWebContents(`Import novel failed: ${e.message}`)
      return null
    } finally {
      try { event.sender.send('novel:import-progress', { phase: 'done', current: 100, total: 100, message: '完成', filepath }) } catch (e) {}
    }
  })

  ipcMain.handle('novel:chapters', async (event, novelId) => {
    return await NovelChapter.findAll({ where: { novelId }, order: [['index', 'ASC']], raw: true })
  })

  // 清空所有小说记录（保留设置）
  ipcMain.handle('novel:clear-all', async () => {
    await NovelChapter.destroy({ where: {}, truncate: true })
    await Novel.destroy({ where: {}, truncate: true })
    sendMessageToWebContents('已清空所有小说记录')
    return true
  })

  const sendRebuildProgress = (event, phase, current, total, message) => {
    try { event.sender.send('novel:import-progress', { phase, current, total, message }) } catch (e) {}
  }

  // 重建小说数据：仅删除小说相关记录与缓存（保留漫画），然后重新扫描小说目录
  ipcMain.handle('novel:rebuild-cache', async (event) => {
    sendMessageToWebContents('开始重建小说数据')
    const libraries = Array.isArray(setting.novelLibraries) ? setting.novelLibraries.filter(Boolean) : []
    if (!libraries.length) {
      sendMessageToWebContents('未配置小说库目录')
      return { added: 0, total: 0 }
    }

    try {
      sendRebuildProgress(event, 'rebuilding', 0, 100, '正在收集缓存文件...')

      // 1. 清空前先收集所有小说记录对应的缓存/封面路径，然后删除磁盘缓存
      const dbNovels = await Novel.findAll({ attributes: ['filepath', 'coverPath'], raw: true })
      const deletePromises = []
      for (const n of dbNovels) {
        if (n.filepath) {
          if (n.filepath.endsWith('.epub.txt')) {
            deletePromises.push(fs.promises.unlink(n.filepath).catch(() => {}))
          }
          const derivedTxt = n.filepath.endsWith('.epub') ? n.filepath + '.epub.txt' : n.filepath + '.epub.txt'
          deletePromises.push(fs.promises.unlink(derivedTxt).catch(() => {}))
        }
        if (n.coverPath) {
          deletePromises.push(fs.promises.unlink(n.coverPath).catch(() => {}))
        }
      }

      sendRebuildProgress(event, 'rebuilding', 10, 100, '正在删除缓存文件...')
      await Promise.all(deletePromises)

      // 2. 再扫描一次文件列表，删除库中所有 epub 对应的缓存（防止有缓存但无 DB 记录的情况）
      sendRebuildProgress(event, 'rebuilding', 20, 100, '正在扫描文件列表...')
      let list = await scanNovelFiles(libraries)

      const epubCachePromises = []
      for (const item of list) {
        if (item.type === 'epub') {
          epubCachePromises.push(fs.promises.unlink(item.filepath + '.epub.txt').catch(() => {}))
        }
      }
      await Promise.all(epubCachePromises)

      // 3. 清空小说数据库（仅 Novel 相关表，保留 Manga/Metadata 等漫画表）
      sendRebuildProgress(event, 'rebuilding', 30, 100, '正在清空数据库...')
      await NovelBookmark.destroy({ where: {}, truncate: true })
      await NovelChapter.destroy({ where: {}, truncate: true })
      await Novel.destroy({ where: {}, truncate: true })

      sendRebuildProgress(event, 'rebuilding', 40, 100, '已清空记录和缓存，开始重新扫描')
      // 4. 重新扫描（复用 scan-library 逻辑），传递进度基数 40
      const result = await scanNovelLibraryInternal(event, 40)
      return result
    } catch (e) {
      const mem = process.memoryUsage()
      console.error(`[${new Date().toISOString()}] [novel] rebuild-cache failed`, e)
      console.error(`[${new Date().toISOString()}] [novel] Error stack:`, e.stack)
      console.error(`[${new Date().toISOString()}] [novel] Memory: RSS=${(mem.rss/1024/1024).toFixed(2)}MB, Heap=${(mem.heapUsed/1024/1024).toFixed(2)}MB`)
      sendMessageToWebContents(`重建失败: ${e.message}`)
      return { added: 0, total: 0 }
    }
  })

  // epub 旧数据重新导入为 txt 格式

  const reimportEpub = async (novel, event) => {
    const novelId = novel.id
    // 如果 novel.filepath 已经是 .epub.txt 缓存路径，还原原始 epub 路径
    let epubPath = (novel.filepath || '').replace(/\/$/, '')
    if (epubPath.endsWith('.epub.txt')) {
      epubPath = epubPath.slice(0, -8) // 去掉 '.epub.txt' 后缀
    }
    if (!epubPath || !fs.existsSync(epubPath)) {
      // 有时盘符/反斜杠导致检测失败，尝试用 path.resolve 标准化
      const resolved = epubPath ? require('path').resolve(epubPath) : ''
      if (!resolved || !fs.existsSync(resolved)) {
        const msg = `原始 epub 文件不存在: ${epubPath}`
        console.error(`[epub] ${msg}`)
        throw new Error(msg)
      }
      epubPath = resolved
    }
    sendMessageToWebContents(`正在转换 epub: ${novel.title}`)
    try { event.sender.send('novel:import-progress', { phase: 'parsing', current: 0, total: 100, message: '正在转换 epub...', filepath: epubPath }) } catch (e) {}
    try {
      // 使用 importNovel（现在会对 epub 做 txt 转换）
      const imported = await importNovel(epubPath, (p) => {
        try { event.sender.send('novel:import-progress', { ...p, filepath: epubPath }) } catch (e) {}
      }, COVER_PATH)
      // 清除旧章节，写入新章节（txt 格式，含 startOffset/endOffset）
      await NovelChapter.destroy({ where: { novelId } })
      if (imported.chapters.length > 0) {
        await NovelChapter.bulkCreate(imported.chapters.map(c => novelChapterRow(c, novelId)))
      }
      const updateData = { chapterCount: imported.chapters.length, type: 'txt', filepath: imported.filepath }
      if (imported.coverPath) updateData.coverPath = imported.coverPath
      await Novel.update(updateData, { where: { id: novelId } })
      try { event.sender.send('novel:epub-reimported', novelId) } catch (e) {}
      try { event.sender.send('novel:import-progress', { phase: 'done', current: 100, total: 100, message: '完成', filepath: novel.filepath }) } catch (e) {}
      // 返回章节数据（用于 readTxtChapter）
      return imported.chapters
    } catch (e) {
      console.error(`[epub] 转换失败: ${novel.title}`, e)
      try { event.sender.send('novel:import-progress', { phase: 'done', current: 100, total: 100, message: '完成', filepath: novel.filepath }) } catch (e) {}
      throw e
    }
  }

  // ColorTxt 风格：一次性读取整本小说全文（返回 UTF-8 ArrayBuffer，避免 IPC 大字符串序列化）
  ipcMain.handle('novel:read-full-text', async (event, novelId) => {
    const novel = await Novel.findByPk(novelId)
    if (!novel) throw new Error('Novel not found')
    const novelCacheDir = path.join(STORE_PATH, 'novel_cache')
    const { buffer, encoding } = await readFullText(novel, novelCacheDir)
    const chapters = await NovelChapter.findAll({ where: { novelId }, order: [['index', 'ASC']], raw: true })
    // 主进程解码后重新编码为 UTF-8 ArrayBuffer，渲染进程直接用 TextDecoder('utf-8') 解码即可
    return { buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), encoding, chapters }
  })

  ipcMain.handle('novel:read-chapter', async (event, novelId, chapterIdx) => {
    let novel = await Novel.findByPk(novelId)
    if (!novel) throw new Error('Novel not found')
    if (novel.type === 'txt') {
      // 如果 filepath 指向 epub 转换的缓存文件
      if (novel.filepath && novel.filepath.endsWith('.epub.txt')) {
        const fs = require('fs')
        let needsReimport = false
        // 缓存文件不存在，重新导入
        if (!fs.existsSync(novel.filepath)) {
          needsReimport = true
        } else {
          // 缓存文件存在但内容可能为空（旧版解析失败），检查章节内容
          const chapter = await NovelChapter.findOne({ where: { novelId, index: chapterIdx } })
          if (chapter) {
            const text = await readTxtChapter(novel, chapter)
            // 如果正文只有章节标题+空白（换行符），说明旧版解析失败，强制重新导入
            const bodyText = text.replace(/^[^\n]*\n/, '').trim()
            if (!bodyText && text.trim().length < 50) {
              try { fs.unlinkSync(novel.filepath) } catch (e) {}
              needsReimport = true
            }
          }
        }
        if (needsReimport) {
          await reimportEpub(novel, event)
          // 重新查询，获取更新后的 filepath
          novel = await Novel.findByPk(novelId)
          if (!novel) throw new Error('Novel not found after reimport')
        }
      }
      const chapter = await NovelChapter.findOne({ where: { novelId, index: chapterIdx } })
      if (!chapter) throw new Error('Chapter not found')
      return await readTxtChapter(novel, chapter)
    }
    // epub: 旧数据，重新导入为 txt 格式
    if (novel.type === 'epub') {
      await reimportEpub(novel, event)
      novel = await Novel.findByPk(novelId)
      const chapter = await NovelChapter.findOne({ where: { novelId, index: chapterIdx } })
      if (!chapter || !novel) return ''
      return await readTxtChapter(novel, chapter)
    }
    return ''
  })

  ipcMain.handle('novel:save-progress', async (event, novelId, progress) => {
    await Novel.update({ readProgress: JSON.stringify(progress), lastReadAt: Date.now() }, { where: { id: novelId } })
  })

  ipcMain.handle('novel:get-progress', async (event, novelId) => {
    const row = await Novel.findByPk(novelId)
    if (!row) return { chapterIdx: 0, scrollTop: 0 }
    const p = typeof row.readProgress === 'string' ? JSON.parse(row.readProgress) : row.readProgress
    return p || { chapterIdx: 0, scrollTop: 0 }
  })

  ipcMain.handle('novel:system-fonts', async () => {
    try {
      return await fontList.getFonts()
    } catch (e) {
      console.log('get system fonts failed', e)
      return []
    }
  })

  ipcMain.handle('novel:imported-fonts', async () => {
    try {
      const files = await fs.promises.readdir(NOVEL_FONT_PATH)
      return files
        .filter(f => /\.(ttf|otf|woff2?|ttf)$/i.test(f))
        .map(f => f.replace(/\.(ttf|otf|woff2?|ttf)$/i, ''))
    } catch {
      return []
    }
  })

  ipcMain.handle('novel:import-font-dialog', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入字体',
      properties: ['openFile'],
      filters: [{ name: '字体', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    const src = result.filePaths[0]
    const dst = path.join(NOVEL_FONT_PATH, path.basename(src))
    await fs.promises.copyFile(src, dst)
    return dst
  })

  // Edge TTS 合成（返回 mp3 ArrayBuffer）
  ipcMain.handle('novel:edge-tts', async (event, req) => {
    try {
      const mp3 = await synthesizeEdgeTtsMp3(req)
      return { ok: true, mp3 }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Edge TTS 中文音色列表
  ipcMain.handle('novel:edge-tts-voices', async () => {
    return EDGE_TTS_ZH_VOICES
  })
}

ipcMain.handle('enable-LAN-browsing', async (event, arg) => {
  enableLANBrowsing()
})
