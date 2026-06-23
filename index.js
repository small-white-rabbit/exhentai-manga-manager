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

const { prepareMangaModel, prepareMetadataModel, ensureMetaTable, installRevTriggers } = require('./modules/database')
const { prepareTemplate } = require('./modules/prepare_menu.js')
const { getBookFilelist, geneCoverFromBuffer, getImageListByBook, getImageListByBookFast, extractImageByBook, deleteImageFromBook } = require('./fileLoader/index.js')
const { saveAppCache, LoadVerifyCache } = require('./src/services/appCache.js')
const {
  STORE_PATH, isPortable,
  TEMP_PATH, COVER_PATH, VIEWER_PATH,
  prepareSetting, prepareCollectionList, preparePath,
  _mange_reader
} = require('./modules/init_folder_setting.js')
const { findSameFile } = require('./fileLoader/folder.js')
const { makeShardedPath } = require('./fileLoader/utils.js')

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
const getColumns = async (sequelize, tableName) => {
  const query = `PRAGMA table_info(${tableName})`
  const [results] = await sequelize.query(query)
  return results.map(column => column.name)
}
;(async () => {
  await Manga.sequelize.query(`PRAGMA journal_mode=WAL;`)
  await Manga.sequelize.query(`PRAGMA busy_timeout=10000;`)
  await Metadata.sequelize.query(`PRAGMA journal_mode=WAL;`)
  await Metadata.sequelize.query(`PRAGMA busy_timeout=10000;`)

  const columns = await getColumns(Manga.sequelize, 'Mangas')
  if (['hiddenBook', 'readCount'].some(c => !columns.includes(c))) {
    await Manga.sync({ alter: true })
  } else {
    await Manga.sync()
  }
  await Metadata.sync()

  // add meta table and revision triggers for startup cache invalidation
  await ensureMetaTable(Manga.sequelize)
  await installRevTriggers(Manga.sequelize, 'Mangas', 'mm')
  await ensureMetaTable(Metadata.sequelize)
  await installRevTriggers(Metadata.sequelize, 'Metadata', 'mm')
})()

const logFile = fs.createWriteStream(path.join(STORE_PATH, 'log.txt'), { flags: 'w' })
const logStdout = process.stdout
const logStderr = process.stderr

console.log = (...message) => {
  logFile.write(format(...message) + '\n')
  logStdout.write(format(...message) + '\n')
}

console.error = (...message) => {
  logFile.write(format(...message) + '\n')
  logStderr.write(format(...message) + '\n')
}

process
  .on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason)
  })
  .on('uncaughtException', err => {
    console.log(err, 'Uncaught Exception thrown')
    process.exit(1)
  })

const sendMessageToWebContents = (message) => {
  console.log(message)
  mainWindow.webContents.send('send-message', message)
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
  if (app.isPackaged) {
    win.loadFile('dist/index.html')
  } else {
    win.loadURL('http://localhost:5374')
  }
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
      if (snap) {
        latestAppCache.data = latestAppCache.data || {}
        latestAppCache.data.bookList = snap
        console.log('snap close')
        await saveAppCache(latestAppCache, APP_CACHE_PATH, Manga.sequelize, Metadata.sequelize)
      }
      finish()
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
    b.tags = JSON.parse(b.tags || '{}')
  }
  setProgressBar(-1)
  return bookList
}

const saveBookListToDatabase = async (data) => {
  console.log('Empty Exist BookList and Saved New BookList')
  await Manga.destroy({ truncate: true })
  await Manga.bulkCreate(data)
}

const saveBookToDatabase = async (book) => {
  await Manga.update(book, { where: { id: book.id } })
  await Metadata.upsert(book)
  console.log(`Saved ${book.title}`)
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
const imageProcessLimiter = createLimiter(4)
const thumbnailProcessLimiter = createLimiter(2)

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


// 初始化Express
const LANBrowsing = express()
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
  "random": {}
}

// 设置静态文件夹
const staticFilePath = path.resolve(STORE_PATH, 'public')
fs.mkdirSync(staticFilePath, { recursive: true })
LANBrowsing.use('/static', express.static(staticFilePath))

let mangas = []
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
    // 默认使用阅读次数排序, 来匹配 mihon 热门不带 sortby
    let sortKey = req.query.sortby || 'read_count'
    let showAll = false
    if (sortKey.includes("_all")) {
      sortKey = sortKey.replace("_all", "")
      showAll = true
    }

    // 读取并搜索数据库
    mangas = await loadBookListFromDatabase()
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
    if (_.isEmpty(mangas)) mangas = await loadBookListFromDatabase()
    const manga = await mangas.find(manga => manga.hash === mangaHash)

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
  const hash = req.params.hash
  const manga = await Manga.findOne({where: {hash: hash}})
  if (!manga || !manga.coverPath) {
    return res.status(404).send('Cover not found')
  }
  const coverFilePath = path.join(staticFilePath, path.basename(manga.coverPath))
  await fs.promises.copyFile(manga.coverPath, coverFilePath)
  if (fs.existsSync(coverFilePath)) {
    res.sendFile(coverFilePath)
  } else {
    res.status(404).send('Cover file not found')
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
  if (LANBrowsingInstance?.listening) {
    LANBrowsingInstance.close(() => {
      LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
        sendMessageToWebContents(`LAN browsing restart and listening at http://0.0.0.0:${port}`)
      })
    })
  } else {
    LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
      sendMessageToWebContents(`LAN browsing listening at http://0.0.0.0:${port}`)
    })
  }
}

ipcMain.handle('enable-LAN-browsing', async (event, arg) => {
  enableLANBrowsing()
})