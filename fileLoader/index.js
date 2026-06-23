const fs = require('fs')
const path = require('node:path')
const { nanoid } = require('nanoid')
const { createHash } = require('crypto')
const sharp = require('sharp')
const { getFolderlist, solveBookTypeFolder, getImageListFromFolder, deleteImageFromFolder, solveBookTypeFolderInMem } = require('./folder.js')
const { getArchivelist, solveBookTypeArchive, getImageListFromArchive, getImageListFromArchiveFast, extractArchiveImageToFile, deleteImageFromArchive, solveBookTypeArchiveInMem, geneCoverSharp } = require('./archive.js')
const { getZipFilelist, solveBookTypeZip, getImageListFromZipFast, extractZipImageToFile } = require('./zip.js')
const { TEMP_PATH, COVER_PATH, VIEWER_PATH } = require('../modules/init_folder_setting.js')
const { makeShardedPath } = require('./utils.js')

const getBookFilelist = async (library) => {
  const folderList = await getFolderlist(library)
  const archiveList = await getArchivelist(library)
  const zipList = await getZipFilelist(library)
  return [
    ...folderList.map(filepath => ({ filepath, type: 'folder' })),
    ...archiveList.map(filepath => ({ filepath, type: 'archive' })),
    ...zipList.map(filepath => ({ filepath, type: 'zip' })),
  ]
}

const geneCover = async (filepath, type) => {
  let targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime
  switch (type) {
    case 'folder':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeFolder(filepath, TEMP_PATH, COVER_PATH))
      break
    case 'zip':
      try {
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, TEMP_PATH, COVER_PATH))
      } catch (e) {
        console.log(e)
        console.log(`reload ${filepath} use adm-zip`)
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeZip(filepath, TEMP_PATH, COVER_PATH))
      }
      break
    case 'archive':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, TEMP_PATH, COVER_PATH))
      break
  }

  const coverHash = createHash('sha1').update(fs.readFileSync(tempCoverPath)).digest('hex')
  const shardedCoverPath = makeShardedPath(COVER_PATH, coverHash + '.webp')
  await fs.promises.mkdir(path.dirname(shardedCoverPath), { recursive: true })
  const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(tempCoverPath))
  await fs.promises.copyFile(tempCoverPath, copyTempCoverPath)
  await sharp(copyTempCoverPath, { failOnError: false })
    .resize(500, 707, {
      fit: 'contain',
      background: '#303133'
    })
    .toFile(shardedCoverPath)
  return { targetFilePath, coverPath: shardedCoverPath, pageCount, bundleSize, mtime, coverHash }
}

const getImageListByBook = async (filepath, type) => {
  switch (type) {
    case 'folder':
      return await getImageListFromFolder(filepath, VIEWER_PATH)
    case 'zip':
    case 'archive':
      return await getImageListFromArchive(filepath, VIEWER_PATH)
    default:
      return await getImageListFromArchive(filepath, VIEWER_PATH)
  }
}

const getImageListByBookFast = async (filepath, type) => {
  switch (type) {
    case 'folder':
      return await getImageListFromFolder(filepath, VIEWER_PATH)
    case 'zip':
      return await getImageListFromZipFast(filepath)
    case 'archive':
      return await getImageListFromArchiveFast(filepath)
    default:
      return await getImageListFromArchiveFast(filepath)
  }
}

const extractImageByBook = async (filepath, type, innerPath) => {
  switch (type) {
    case 'zip':
      return await extractZipImageToFile(filepath, innerPath, VIEWER_PATH)
    case 'archive':
      return await extractArchiveImageToFile(filepath, innerPath, VIEWER_PATH)
    default:
      return await extractArchiveImageToFile(filepath, innerPath, VIEWER_PATH)
  }
}

const deleteImageFromBook = async (filename, filepath, type) => {
  switch (type) {
    case 'folder':
      return await deleteImageFromFolder(filename, filepath)
    case 'zip':
    case 'archive':
      return await deleteImageFromArchive(filename, filepath)
    default:
      return await deleteImageFromArchive(filename, filepath)
  }
}

const geneCoverFromBuffer = async (filepath, type, opts = {}) => {
  let targetBuffer, coverBuffer, pageCount, bundleSize, mtime, useBuffer, targetFilePath, tempCoverPath, hash, coverHash, coverSharp, coverPath
  if (type === 'folder') {
    ({ targetBuffer, coverBuffer, pageCount, bundleSize, mtime } = await solveBookTypeFolderInMem(filepath))
    useBuffer = true
  } else {
    try {
      ({ targetBuffer, coverBuffer, pageCount, bundleSize, mtime } = await solveBookTypeArchiveInMem(filepath, opts))
      useBuffer = true
    } catch (e1) {
      console.log(`reload ${filepath} by 7z`)
      try {
        ({ targetFilePath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, TEMP_PATH, COVER_PATH, opts))
        useBuffer = false
      } catch (e2) {
        console.log(`reload ${filepath} use adm-zip`)
        ;({ targetFilePath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeZip(filepath, TEMP_PATH, COVER_PATH))
        useBuffer = false
      }
    }
  }
  if (useBuffer) {
    hash = createHash('sha1').update(targetBuffer).digest('hex')
    coverHash = createHash('sha256').update(coverBuffer).digest('hex')
    coverSharp = await geneCoverSharp(coverBuffer)
    coverPath = makeShardedPath(COVER_PATH, coverHash + '.webp')
  } else {
    hash = createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
    coverHash = createHash('sha256').update(fs.readFileSync(tempCoverPath)).digest('hex')
    const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(tempCoverPath))
    await fs.promises.copyFile(tempCoverPath, copyTempCoverPath)
    coverPath = makeShardedPath(COVER_PATH, coverHash + '.webp')
    coverSharp = await sharp(copyTempCoverPath, { failOnError: false })
      .resize(500, 707, { fit: 'contain', background: '#303133' })
  }
  return { hash, coverPath, pageCount, bundleSize, mtime, coverHash, coverSharp }
}

module.exports = {
  getBookFilelist,
  geneCover,
  geneCoverFromBuffer,
  getImageListByBook,
  getImageListByBookFast,
  extractImageByBook,
  deleteImageFromBook
}