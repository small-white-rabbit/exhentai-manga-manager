const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const { nanoid } = require('nanoid')
const { spawn } = require('child_process')
const _ = require('lodash')
const { getRootPath } = require('../modules/utils.js')
const sharp = require('sharp')

const _7z = path.join(getRootPath(), 'resources/extraResources/7z.exe')
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

const getArchivelist = async (libraryPath) => {
  const list = globSync('**/*.@(rar|7z|cb7|cbr)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const solveBookTypeArchive = async (filepath, TEMP_PATH, COVER_PATH, opts = {}) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })
  const output = await spawnBuffer(_7z, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'], opts)
  let pathlist = _.filter(String(output).split(/\r\n/), s => _.startsWith(s, 'Path') && !_.includes(s, '__MACOSX'))
  pathlist = pathlist.map(p => {
    const match = /(?<== ).*$/.exec(p)
    return match ? match[0] : ''
  })
  let imageList = _.filter(pathlist, p => IMAGE_EXTS.has(path.extname(p).toLowerCase()))
  imageList = imageList.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]
    await spawnBuffer(_7z, ['x', '-o'+tempFolder, '-p123456', '-y', '--', filepath, targetFile], opts)
    await spawnBuffer(_7z, ['x', '-o'+tempFolder, '-p123456', '-y', '--', filepath, coverFile], opts)
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    await spawnBuffer(_7z, ['x', '-o'+tempFolder, '-p123456', '-y', '--', filepath, targetFile], opts)
  } else {
    throw new Error('compression package isnot include image')
  }
  targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetFile))
  await fs.promises.copyFile(path.join(tempFolder, targetFile), targetFilePath)

  tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(coverFile))
  await fs.promises.copyFile(path.join(tempFolder, coverFile), tempCoverPath)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

const getImageListFromArchive = async (filepath, VIEWER_PATH, opts = {}) => {
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })
  await spawnBuffer(_7z, ['x', '-o' + tempFolder, '-p123456', '--', filepath], { ...opts, timeoutMs: 2 * 60 * 1000 })
  let list = globSync('**/*.@(jpg|jpeg|png|webp|avif|gif)', {
    cwd: tempFolder,
    nocase: true
  })
  list = _.filter(list, s => !_.includes(s, '__MACOSX'))
  list = list.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
  return list.map(f => ({
    relativePath: f,
    absolutePath: path.join(tempFolder, f)
  }))
}

const deleteImageFromArchive = async (filename, filepath, opts = {}) => {
  await spawnBuffer(_7z, ['d', '-p123456', '--', filepath, filename], opts)
  return true
}

// ---- signal-aware spawn wrapper (replaces spawnPromise) ----
const spawnBuffer = (command, args, opts = {}) => {
  const { signal, timeoutMs = 120_000, onChild } = opts
  if (signal?.aborted) {
    const e = new Error('Operation aborted')
    e.name = 'AbortError'
    return Promise.reject(e)
  }

  return new Promise((resolve, reject) => {
    const cp = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    onChild?.(cp)
    const chunks = []
    const errs = []
    let settled = false
    const done = (err, outBuf) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) try { signal.removeEventListener('abort', onAbort) } catch {}
      if (err) return reject(err)
      resolve(outBuf)
    }

    const onAbort = () => {
      try { if (!cp.killed) cp.kill('SIGTERM') } catch {}
      setTimeout(() => { try { if (!cp.killed) cp.kill('SIGKILL') } catch {} }, 3000)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      try { if (!cp.killed) cp.kill('SIGKILL') } catch {}
      done(new Error('7z timed out'))
    }, timeoutMs)

    cp.stdout.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
    cp.stderr.on('data', (d) => errs.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
    cp.on('error', (e) => done(e))
    cp.on('close', (code) => {
      if (signal?.aborted) {
        const e = new Error('Operation aborted')
        e.name = 'AbortError'
        return done(e)
      }
      if (code === 0) return done(null, Buffer.concat(chunks))
      const msg = Buffer.concat(errs).toString('utf8') || `7z exited with code ${code}`
      done(new Error(msg))
    })
  })
}

// ---- in-memory archive extraction (no disk I/O for listing/extraction) ----
function pickCoverAndTarget(imageList) {
  const pageCount = imageList.length
  if (pageCount === 0) return { pageCount, coverFile: null, targetFile: null }
  const coverFile = imageList[0]
  const targetFile = (pageCount > 8) ? imageList[7] : imageList[0]
  return { pageCount, coverFile, targetFile }
}

async function listImagesWith7z(filepath, opts = {}) {
  const listing = await spawnBuffer(_7z, ['l', filepath, '-slt', '-mmt=1', '-sccUTF-8', '-p123456'], opts)
  const lines = String(listing).split(/\r?\n/)
  const entries = []
  let cur = null
  for (const line of lines) {
    if (!line.trim()) {
      if (cur && cur.path) entries.push(cur)
      cur = null
      continue
    }
    if (!cur) cur = {}
    if (line.startsWith('Path = ')) {
      cur.path = line.slice(7)
    } else if (line.startsWith('Folder = ')) {
      const v = line.slice(9).trim()
      cur.isDir = v === '+' || v.toLowerCase() === 'true'
    }
  }
  if (cur && cur.path) entries.push(cur)

  let imgs = entries.filter(e => !e.isDir && typeof e.path === 'string' && !e.path.includes('__MACOSX')).
    map(e => e.path).filter(p => IMAGE_EXTS.has(path.extname(p).toLowerCase()))
  imgs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return imgs
}

async function extractFileToBuffer7z(filepath, innerPath, opts = {}) {
  const { signal, onChild } = opts
  const args = ['x', '-so', '-y', '-p123456', '-mmt=1', '-bso0', '-bsp0', '--', filepath, innerPath]
  return await spawnBuffer(_7z, args, { signal, timeoutMs: 300_000, onChild })
}

async function getBufferFrom7z(filepath, opts = {}) {
  const imageList = await listImagesWith7z(filepath, opts)
  const { pageCount, coverFile, targetFile } = pickCoverAndTarget(imageList)
  if (pageCount === 0) throw new Error('No images found inside archive')
  const coverBuffer = await extractFileToBuffer7z(filepath, coverFile, opts)
  const targetBuffer = (targetFile === coverFile) ? coverBuffer : await extractFileToBuffer7z(filepath, targetFile, opts)
  return { targetBuffer, coverBuffer, pageCount }
}

async function solveBookTypeArchiveInMem(filepath, opts = {}) {
  const fileStat = await fs.promises.stat(filepath)
  const bundleSize = fileStat.size
  const mtime = fileStat?.mtime
  const { targetBuffer, coverBuffer, pageCount } = await getBufferFrom7z(filepath, opts)
  return { targetBuffer, coverBuffer, pageCount, bundleSize, mtime }
}

// ---- fast listing / on-demand extraction for viewer ----
const getImageListFromArchiveFast = async (filepath, VIEWER_PATH) => {
  const imageList = await listImagesWith7z(filepath)
  if (imageList.length === 0) throw new Error('compression package isnot include image')
  return imageList.map((innerPath, i) => ({
    relativePath: innerPath,
    absolutePath: innerPath,
    archivePath: filepath,
    innerPath,
    index: i
  }))
}

const extractArchiveImageToFile = async (archivePath, innerPath, VIEWER_PATH, opts = {}) => {
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  await fs.promises.mkdir(tempFolder, { recursive: true })
  // Use 'e' to extract without paths so the file lands directly in tempFolder.
  await spawnBuffer(_7z, ['e', '-o' + tempFolder, '-p123456', '-y', '--', archivePath, innerPath], { ...opts, timeoutMs: 120_000 })
  const outputPath = path.join(tempFolder, path.basename(innerPath))
  return outputPath
}

// ---- sharp helpers ----
const JPEG_EOI = Buffer.from([0xFF, 0xD9])
const isJpeg = (buf) => buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
const hasEOI = (buf) => buf && buf.length > 1 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9

function openSharp(buf) {
  try {
    return sharp(buf, { failOn: 'none', sequentialRead: true, limitInputPixels: false })
  } catch {
    return sharp(buf, { failOnError: false, sequentialRead: true, limitInputPixels: false })
  }
}

async function geneCoverSharp(coverBuffer) {
  const build = (buf) =>
    openSharp(buf).rotate().resize(500, 707, {
      fit: 'contain',
      background: '#303133',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    })
  try {
    return build(coverBuffer)
  } catch (e1) {
    if (isJpeg(coverBuffer) && !hasEOI(coverBuffer)) {
      const patched = Buffer.concat([coverBuffer, JPEG_EOI])
      try { return build(patched) } catch (e2) { /* fallthrough */ }
    }
    return sharp({ create: { width: 500, height: 707, channels: 3, background: '#303133' } })
  }
}

module.exports = {
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  getImageListFromArchiveFast,
  extractArchiveImageToFile,
  deleteImageFromArchive,
  solveBookTypeArchiveInMem,
  geneCoverSharp
}