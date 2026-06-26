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
 * 空行压缩：连续 3+ 个换行压缩为 2 个（即一个空行）。
 */
const collapseBlankLines = (text) => {
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
}

export { applyIndent, collapseBlankLines }
