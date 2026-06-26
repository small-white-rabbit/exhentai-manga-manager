const fs = require('fs')
const path = require('path')

/**
 * 解析 epub，返回 { title, author, coverBuffer, chapters }
 * chapters: [{ title, text }]
 * epub 是 zip，解压后读 META-INF/container.xml → OPF → spine → 逐 XHTML 抽文本
 * 复用项目已有的 adm-zip
 */
const parseEpub = async (filepath) => {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(filepath)

  // 1. container.xml → OPF 路径
  const containerXml = zip.getEntry('META-INF/container.xml').getData().toString('utf8')
  const opfPathMatch = containerXml.match(/full-path="([^"]+)"/)
  if (!opfPathMatch) throw new Error('Invalid epub: no OPF path in container.xml')
  const opfPath = opfPathMatch[1]
  const opfDir = path.posix.dirname(opfPath)

  // 2. 解析 OPF
  const opfXml = zip.getEntry(opfPath).getData().toString('utf8')

  // 元数据
  const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)
  const authorMatch = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)
  const title = titleMatch ? titleMatch[1].trim() : path.basename(filepath, '.epub')
  const author = authorMatch ? authorMatch[1].trim() : ''

  // 封面：找 meta name=cover 或 item id=cover 的 href
  let coverBuffer = null
  const coverMetaMatch = opfXml.match(/<meta\s+name="cover"\s+content="([^"]+)"/)
  const manifestItems = []
  const itemRegex = /<item\s+[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"[^>]*?media-type="([^"]+)"/g
  let im
  while ((im = itemRegex.exec(opfXml)) !== null) {
    manifestItems.push({ id: im[1], href: decodeURIComponent(im[2]), mediaType: im[3] })
  }
  const coverItemId = coverMetaMatch ? coverMetaMatch[1] : null
  const coverItem = manifestItems.find(it => it.id === coverItemId) ||
                    manifestItems.find(it => /cover/i.test(it.id) && it.mediaType.startsWith('image/'))
  if (coverItem) {
    const coverPath = path.posix.join(opfDir, coverItem.href)
    const entry = zip.getEntry(coverPath)
    if (entry) coverBuffer = entry.getData()
  }

  // 3. spine 顺序 → 章节
  const spineRegex = /<itemref\s+[^>]*?idref="([^"]+)"/g
  const spineIds = []
  let sm
  while ((sm = spineRegex.exec(opfXml)) !== null) {
    spineIds.push(sm[1])
  }

  // NCX 章节标题（epub2）或 nav（epub3），优先用 spine item 的自身标题
  const chapters = []
  for (const idref of spineIds) {
    const item = manifestItems.find(it => it.id === idref)
    if (!item || !item.mediaType.includes('xhtml')) continue
    const itemPath = path.posix.join(opfDir, item.href)
    const entry = zip.getEntry(itemPath)
    if (!entry) continue
    const xhtml = entry.getData().toString('utf8')
    // 抽取标题
    const hMatch = xhtml.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i)
    const chapterTitle = hMatch ? hMatch[1].trim() : `章节 ${chapters.length + 1}`
    // 抽取纯文本：去标签
    const text = extractTextFromXhtml(xhtml)
    if (text.trim().length > 0) {
      chapters.push({ title: chapterTitle, text })
    }
  }

  return { title, author, coverBuffer, chapters }
}

/**
 * 从 XHTML 抽取纯文本，保留段落换行。
 * <p> / <br> → 换行，其他标签剥离。
 */
const extractTextFromXhtml = (xhtml) => {
  // 去 head/script/style
  let s = xhtml.replace(/<head>[\s\S]*?<\/head>/gi, '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '')
  // 块级标签 → 换行
  s = s.replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // 剥离所有标签
  s = s.replace(/<[^>]+>/g, '')
  // 反转义常见实体
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  // 折叠多余空行
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s
}

module.exports = { parseEpub, extractTextFromXhtml }
