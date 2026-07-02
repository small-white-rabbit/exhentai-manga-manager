/**
 * 行首缩进：每段前加 N 个全角空格。
 * @param {string} text
 * @param {number} indent 字符数（0 或 2）
 */
const applyIndent = (text, indent) => {
  if (!indent) return text
  const indentStr = '\u3000'.repeat(indent) // 全角空格
  return text.split('\n').map(line => {
    const trimmed = line.replace(/^\s+/, '')
    if (!trimmed) return ''
    return indentStr + trimmed
  }).join('\n')
}

/**
 * 空行压缩（参照 ColorTxt compressBlankLines）：
 * - 去除所有空行（连续换行压缩为单个换行），段落靠首行缩进或连续排版区分
 * - 去除首尾空白
 */
const collapseBlankLines = (text) => {
  return text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\s+|\s+$/g, '')
}

export { applyIndent, collapseBlankLines }
