const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { nanoid } = require('nanoid')
const { readFull, readFullBuffer, readRange } = require('./txt')
const { parseEpub } = require('./epub')
const { detectChapters } = require('../src/novel/utils/chapter-detector')

const makeNovelHash = (filepath, stat) =>
  createHash('sha1').update(filepath + stat.size + stat.mtimeMs).digest('hex')

const extractTitleFromFilename = (filename) => {
  const matchChinese = filename.match(/《(.+?)》/)
  if (matchChinese) return matchChinese[1].trim()
  const matchAngle = filename.match(/<(.+?)>/)
  if (matchAngle) return matchAngle[1].trim()
  return filename.replace(/\.[^.]+$/, '').trim()
}

const isPrefaceTitle = (title) => {
  if (!title) return false
  return /^(序[言章诗]?|前言|引子|楔子|自序|原序|题序|小序|总序|代序|译序|后序|绪论|绪言|题记|题跋|附录|尾声|后记|跋)\s*.{0,40}$/u.test(title)
}

const chaptersFromText = (text) => {
  const detected = detectChapters(text)
  return detected.map((c, i) => ({
    id: nanoid(),
    index: i,
    title: c.title,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    charCount: c.charCount
  }))
}

const epubChaptersToText = (chapters) => {
  const bodyChapters = chapters.filter(ch => {
    if (isPrefaceTitle(ch.title)) return false
    return String(ch.text || '').trim().length > 0
  })
  return bodyChapters.map((ch, i) => {
    const title = ch.title || `章节 ${i + 1}`
    const body = String(ch.text || '')
    let text = body.trim()
    const titleLower = title.toLowerCase()
    const bodyLower = text.toLowerCase()
    if (bodyLower.startsWith(titleLower)) {
      let offset = title.length
      const lineEnd = text.indexOf('\n', offset)
      if (lineEnd !== -1) {
        const remainingOnLine = text.slice(offset, lineEnd).trim()
        if (remainingOnLine.length <= 30) {
          offset = lineEnd + 1
        }
      }
      while (offset < text.length && /\s/.test(text[offset])) offset++
      text = text.slice(offset).trim()
    }
    return `${title}\n\n${text}`
  }).join('\n\n')
}

const writeEpubTxtCache = async (epubPath, onProgress) => {
  const parsed = await parseEpub(epubPath, onProgress)
  const fullText = epubChaptersToText(parsed.chapters)
  const txtPath = epubPath + '.epub.txt'
  await fs.promises.writeFile(txtPath, fullText, 'utf-8')
  return {
    parsed,
    txtPath,
    fullText,
    chapters: chaptersFromText(fullText)
  }
}

const ensureEpubTxtCache = async (filepath) => {
  const cachedTxt = filepath.endsWith('.epub.txt') ? filepath : filepath + '.epub.txt'
  if (fs.existsSync(cachedTxt)) return cachedTxt
  const epubPath = filepath.endsWith('.epub.txt') ? filepath.slice(0, -8) : filepath
  await writeEpubTxtCache(epubPath)
  return cachedTxt
}

const importTxtNovel = async (filepath, stat, filename, hash) => {
  const { text, encoding } = await readFull(filepath)
  const chapters = chaptersFromText(text)
  return {
    id: nanoid(),
    hash,
    filepath,
    filename,
    type: 'txt',
    filesize: stat.size,
    encoding,
    title: extractTitleFromFilename(filename),
    author: '',
    coverBuffer: null,
    chapters
  }
}

const importEpubNovel = async (filepath, stat, filename, hash, onProgress, coverDir) => {
  const result = await writeEpubTxtCache(filepath, onProgress)
  const coverBuffer = result.parsed.coverBuffer || null
  let coverPath = null
  if (coverBuffer && coverDir) {
    try {
      const sharp = require('sharp')
      coverPath = path.join(coverDir, result.parsed.id + '.webp')
      await sharp(coverBuffer).resize(500, 707, { fit: 'contain', background: '#303133' }).toFile(coverPath)
    } catch (e) {
      console.warn('[importEpubNovel] 封面保存失败:', e.message)
      coverPath = null
    }
  }
  return {
    id: result.parsed.id || nanoid(),
    hash,
    filepath: result.txtPath,
    filename,
    type: 'epub',
    filesize: stat.size,
    encoding: 'UTF-8',
    title: result.parsed.title || extractTitleFromFilename(filename),
    author: result.parsed.author || '',
    coverBuffer,
    coverPath,
    chapters: result.chapters
  }
}

const importNovel = async (filepath, onProgress, coverDir) => {
  try {
    const stat = await fs.promises.stat(filepath)
    const filename = path.basename(filepath)
    const ext = path.extname(filepath).toLowerCase()
    const hash = makeNovelHash(filepath, stat)

    if (ext === '.txt') return importTxtNovel(filepath, stat, filename, hash)
    if (ext === '.epub') return importEpubNovel(filepath, stat, filename, hash, onProgress, coverDir)
    throw new Error(`Unsupported novel type: ${ext}`)
  } catch (e) {
    console.error(`[novel] import failed: ${filepath}`, e)
    throw e
  }
}

const readTxtChapter = async (novel, chapter) => {
  if (chapter.byteStartOffset != null && chapter.byteEndOffset != null) {
    return readRange(novel.filepath, chapter.byteStartOffset, chapter.byteEndOffset, novel.encoding)
  }
  const { text } = await readFull(novel.filepath)
  return text.slice(chapter.startOffset, chapter.endOffset)
}

const readEpubChapter = async (novel, chapter) => {
  let filepath = novel.filepath
  if (!filepath.endsWith('.epub.txt')) {
    filepath = await ensureEpubTxtCache(filepath)
  }
  if (chapter.byteStartOffset != null && chapter.byteEndOffset != null) {
    return readRange(filepath, chapter.byteStartOffset, chapter.byteEndOffset, 'UTF-8')
  }
  const { text } = await readFull(filepath)
  return text.slice(chapter.startOffset, chapter.endOffset)
}

const readFullText = async (novel, cacheDir) => {
  let filepath = novel.filepath
  if (!filepath) throw new Error('Novel filepath is empty')

  if (novel.type === 'epub') {
    if (!filepath.endsWith('.epub.txt')) {
      filepath = await ensureEpubTxtCache(filepath)
    }
    return readFullBuffer(filepath)
  }

  if (filepath.endsWith('.epub.txt')) {
    if (!fs.existsSync(filepath)) {
      const epubPath = filepath.slice(0, -8)
      if (fs.existsSync(epubPath)) {
        filepath = await ensureEpubTxtCache(epubPath)
      } else {
        throw new Error('EPUB file not found: ' + epubPath)
      }
    }
    return readFullBuffer(filepath)
  }

  return readFullBuffer(filepath)
}

module.exports = { importNovel, readTxtChapter, readEpubChapter, readFullText }
