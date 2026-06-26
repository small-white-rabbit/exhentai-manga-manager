const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { nanoid } = require('nanoid')
const { detectEncoding, readFull, readRange } = require('./txt')
const { parseEpub } = require('./epub')
const { detectChapters } = require('../src/novel/utils/chapter-detector')

/**
 * 导入一本小说，返回统一结构。
 * txt: 流式偏移索引（不存正文）
 * epub: 章节文本已抽取（epub 解析一次性，正文不存 DB，每次打开重新解析或缓存到临时 txt）
 * @param {string} filepath
 * @returns {Promise<{id, hash, filepath, filename, type, filesize, encoding, title, author, coverBuffer, chapters}>}
 */
const importNovel = async (filepath) => {
  const stat = await fs.promises.stat(filepath)
  const filename = path.basename(filepath)
  const ext = path.extname(filepath).toLowerCase()
  const hash = createHash('sha1').update(filepath + stat.size + stat.mtimeMs).digest('hex')

  if (ext === '.txt') {
    const { text, encoding } = await readFull(filepath)
    const rawChapters = detectChapters(text)
    // txt 章节存字符偏移（readFull 读全文后按字符切片）
    const chapters = rawChapters.map((c, i) => ({
      id: nanoid(),
      index: i,
      title: c.title,
      startOffset: c.startOffset,   // 字符偏移
      endOffset: c.endOffset,
      charCount: c.charCount
    }))
    return {
      id: nanoid(),
      hash,
      filepath,
      filename,
      type: 'txt',
      filesize: stat.size,
      encoding,
      title: filename.replace(/\.txt$/i, ''),
      author: '',
      coverBuffer: null,
      chapters
    }
  }

  if (ext === '.epub') {
    const parsed = await parseEpub(filepath)
    const chapters = parsed.chapters.map((c, i) => ({
      id: nanoid(),
      index: i,
      title: c.title,
      // epub 章节正文直接存内存（不落盘），startOffset/endOffset 不用
      text: c.text,
      charCount: c.text.length
    }))
    return {
      id: nanoid(),
      hash,
      filepath,
      filename,
      type: 'epub',
      filesize: stat.size,
      encoding: 'UTF-8',
      title: parsed.title,
      author: parsed.author,
      coverBuffer: parsed.coverBuffer,
      chapters
    }
  }

  throw new Error(`Unsupported novel type: ${ext}`)
}

/**
 * 读取 txt 指定章节正文（字符切片）。
 * @param {object} novel Novel 记录（含 encoding）
 * @param {object} chapter NovelChapter 记录（含 startOffset/endOffset 字符偏移）
 */
const readTxtChapter = async (novel, chapter) => {
  const { text } = await readFull(novel.filepath)
  return text.slice(chapter.startOffset, chapter.endOffset)
}

/**
 * 读取 epub 指定章节正文。epub 章节文本在导入时已抽取，但 DB 不存正文，
 * 所以这里重新解析 epub（或后续优化：缓存到临时 txt）。
 * MVP 阶段直接重新解析，性能可接受（单本 epub 通常 < 5MB）。
 */
const readEpubChapter = async (novel, chapterIndex) => {
  const parsed = await parseEpub(novel.filepath)
  return parsed.chapters[chapterIndex]?.text || ''
}

module.exports = { importNovel, readTxtChapter, readEpubChapter }
