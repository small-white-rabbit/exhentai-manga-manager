const fs = require('fs')
const path = require('path')
const jschardet = require('jschardet')
const iconv = require('iconv-lite')

/**
 * 检测 txt 文件编码。读前 64KB 足够 jschardet 判断。
 * @param {string} filepath
 * @returns {Promise<string>} 编码名，如 'UTF-8' / 'GB18030'
 */
const detectEncoding = async (filepath) => {
  const fd = await fs.promises.open(filepath, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const { bytesRead } = await fd.read(buf, 0, 65536, 0)
    const detected = jschardet.detect(buf.slice(0, bytesRead))
    // jschardet 对中文 GB 系返回 GB2312/GB18030/GBKE 等，iconv-lite 都能解
    return detected && detected.encoding ? detected.encoding : 'UTF-8'
  } finally {
    await fd.close()
  }
}

/**
 * 读取文件指定字节区间并解码为字符串。
 * @param {string} filepath
 * @param {number} startOffset 起始字节偏移（含）
 * @param {number} endOffset 结束字节偏移（不含），undefined 表示读到末尾
 * @param {string} encoding
 * @returns {Promise<string>}
 */
const readRange = async (filepath, startOffset, endOffset, encoding) => {
  const length = endOffset != null ? endOffset - startOffset : undefined
  const buf = await fs.promises.readFile(filepath, { encoding: null })
  const slice = length != null ? buf.slice(startOffset, startOffset + length) : buf.slice(startOffset)
  // GB2312 是 GB18030 子集，iconv 用 GB18030 兼容
  const enc = encoding && encoding.toUpperCase().startsWith('GB') ? 'GB18030' : (encoding || 'UTF-8')
  return iconv.decode(slice, enc)
}

/**
 * 读取整个文件文本（用于章节解析）。大文件建议用 readRange 流式。
 * @param {string} filepath
 * @returns {Promise<{text: string, encoding: string}>}
 */
const readFull = async (filepath) => {
  const encoding = await detectEncoding(filepath)
  const text = await readRange(filepath, 0, null, encoding)
  return { text, encoding }
}

module.exports = { detectEncoding, readRange, readFull }
