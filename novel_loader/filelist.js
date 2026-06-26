const fs = require('fs')
const path = require('path')

/**
 * 扫描目录，收集所有 .txt 和 .epub 文件（递归）。
 * @param {string} library 库根目录
 * @returns {Promise<Array<{filepath: string, type: 'txt'|'epub'}>>}
 */
const getNovelFilelist = async (library) => {
  const result = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (ext === '.txt') result.push({ filepath: full, type: 'txt' })
        else if (ext === '.epub') result.push({ filepath: full, type: 'epub' })
      }
    }
  }
  await walk(library)
  return result
}

/**
 * 扫描多个库目录，去重，返回合并列表。
 * @param {string[]} libraries
 * @returns {Promise<Array<{filepath: string, type: 'txt'|'epub'}>>}
 */
const scanNovelFiles = async (libraries) => {
  const all = []
  for (const lib of libraries) {
    if (!lib) continue
    const list = await getNovelFilelist(lib)
    all.push(...list)
  }
  // 按 filepath 去重
  const seen = new Map()
  for (const item of all) seen.set(item.filepath, item)
  return Array.from(seen.values())
}

module.exports = { getNovelFilelist, scanNovelFiles }
