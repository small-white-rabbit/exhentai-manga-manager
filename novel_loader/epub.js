const path = require('path')
const AdmZip = require('adm-zip')
const { DOMParser } = require('@xmldom/xmldom')

const XHTML_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'application/xml',
  'text/xml'
])

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
])

const SKIP_TAGS = new Set(['head', 'script', 'style', 'noscript', 'template'])

const decodeEntities = (text) => {
  if (!text) return ''
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)) } catch { return '' }
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&laquo;/g, '《')
    .replace(/&raquo;/g, '》')
}

const normalizeSpace = (text) => decodeEntities(text || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t\f\v]+/g, ' ')
  .replace(/\s*\n\s*/g, '\n')
  .trim()

const stripHash = (href) => (href || '').split('#')[0]

const resolveInZip = (baseDir, href) => {
  const raw = decodeURIComponent(stripHash(href)).replace(/\\/g, '/').replace(/^\/+/, '')
  const stack = (baseDir || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean)
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

const zipEntriesByLowerPath = (zip) => {
  const map = new Map()
  for (const entry of zip.getEntries()) {
    map.set(entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase(), entry)
  }
  return map
}

const getEntry = (entryMap, zipPath) => {
  if (!zipPath) return null
  return entryMap.get(zipPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()) || null
}

const parseXml = (xml, type = 'application/xml') => new DOMParser().parseFromString(xml, type)

const getElements = (root, tag) => Array.from(root.getElementsByTagName(tag) || [])

const getAttr = (el, name) => {
  if (!el || !el.getAttribute) return ''
  return el.getAttribute(name) || ''
}

const firstText = (doc, names) => {
  for (const name of names) {
    const els = getElements(doc, name)
    for (const el of els) {
      const text = normalizeSpace(el.textContent || '')
      if (text) return text
    }
  }
  return ''
}

const parseHtmlDocument = (html) => {
  const xhtmlDoc = parseXml(html, 'application/xhtml+xml')
  if (getElements(xhtmlDoc, 'parsererror').length > 0) {
    return parseXml(html, 'text/html')
  }
  return xhtmlDoc
}

const childNodes = (node) => Array.from(node?.childNodes || [])

const tagNameOf = (node) => String(node?.tagName || node?.nodeName || '').toLowerCase()

const appendText = (out, text) => {
  const line = normalizeSpace(text)
  if (line) out.push(line)
}

const collectInlineText = (node) => {
  if (!node) return ''
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || node.textContent || ''
  if (node.nodeType !== 1) return ''
  const tag = tagNameOf(node)
  if (SKIP_TAGS.has(tag)) return ''
  if (tag === 'br' || tag === 'hr') return '\n'
  if (tag === 'img' || tag === 'image') return getAttr(node, 'alt') || getAttr(node, 'title') || ''
  return childNodes(node).map(collectInlineText).join('')
}

const emitBlock = (node, out) => {
  if (!node) return
  if (node.nodeType === 3 || node.nodeType === 4) {
    appendText(out, node.nodeValue || node.textContent || '')
    return
  }
  if (node.nodeType !== 1) return

  const tag = tagNameOf(node)
  if (SKIP_TAGS.has(tag)) return
  if (tag === 'br' || tag === 'hr') {
    if (out.length && out[out.length - 1] !== '') out.push('')
    return
  }
  if (tag === 'img' || tag === 'image') {
    appendText(out, getAttr(node, 'alt') || getAttr(node, 'title'))
    return
  }

  if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'li' || tag === 'blockquote' || tag === 'pre') {
    appendText(out, collectInlineText(node))
    return
  }

  if (!BLOCK_TAGS.has(tag)) {
    appendText(out, collectInlineText(node))
    return
  }

  const children = childNodes(node)
  const hasBlockChild = children.some(child => child.nodeType === 1 && BLOCK_TAGS.has(tagNameOf(child)))
  if (!hasBlockChild && tag !== 'body' && tag !== 'html') {
    appendText(out, collectInlineText(node))
    return
  }
  for (const child of children) emitBlock(child, out)
}

const extractTextFromHtml = (html) => {
  const doc = parseHtmlDocument(html)
  const body = getElements(doc, 'body')[0] || doc.documentElement
  const out = []
  if (body) {
    for (const child of childNodes(body)) emitBlock(child, out)
  }
  if (!out.length && doc.documentElement?.textContent) {
    appendText(out, doc.documentElement.textContent)
  }
  return out
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const extractTitleFromHtml = (html, fallback) => {
  const doc = parseHtmlDocument(html)
  const heading = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
    .flatMap(tag => getElements(doc, tag))
    .map(el => normalizeSpace(el.textContent || ''))
    .find(Boolean)
  if (heading) return heading
  const title = firstText(doc, ['title'])
  return title || fallback
}

const parseManifest = (opfDoc) => {
  const items = new Map()
  for (const item of getElements(opfDoc, 'item')) {
    const id = getAttr(item, 'id')
    const href = getAttr(item, 'href')
    if (!id || !href) continue
    items.set(id, {
      id,
      href,
      mediaType: getAttr(item, 'media-type').toLowerCase(),
      properties: getAttr(item, 'properties').toLowerCase()
    })
  }
  return items
}

const parseSpineIds = (opfDoc) => getElements(opfDoc, 'itemref')
  .map(item => getAttr(item, 'idref'))
  .filter(Boolean)

const findCoverBuffer = (entryMap, opfDoc, opfDir, manifest) => {
  let coverId = ''
  for (const meta of getElements(opfDoc, 'meta')) {
    if (getAttr(meta, 'name').toLowerCase() === 'cover') {
      coverId = getAttr(meta, 'content')
      break
    }
  }
  const coverItem = (coverId && manifest.get(coverId)) ||
    Array.from(manifest.values()).find(it =>
      it.mediaType.startsWith('image/') && (/cover/i.test(it.id) || /cover/i.test(it.href) || it.properties.includes('cover-image')))
  if (!coverItem) return null
  const entry = getEntry(entryMap, resolveInZip(opfDir, coverItem.href))
  return entry ? entry.getData() : null
}

const extractNcxToc = (entryMap, opfDir, manifest) => {
  const toc = new Map()
  const ncxItem = Array.from(manifest.values()).find(it => it.mediaType === 'application/x-dtbncx+xml')
  if (!ncxItem) return toc
  const entry = getEntry(entryMap, resolveInZip(opfDir, ncxItem.href))
  if (!entry) return toc
  const doc = parseXml(entry.getData().toString('utf8'))
  for (const navPoint of getElements(doc, 'navPoint')) {
    const content = getElements(navPoint, 'content')[0]
    const textEl = getElements(navPoint, 'text')[0]
    const src = stripHash(getAttr(content, 'src'))
    const title = normalizeSpace(textEl?.textContent || '')
    if (src && title) toc.set(resolveInZip(opfDir, src).toLowerCase(), title)
  }
  return toc
}

const extractNavToc = (entryMap, opfDir, manifest) => {
  const toc = new Map()
  const navItem = Array.from(manifest.values()).find(it => it.properties.includes('nav'))
  if (!navItem) return toc
  const entry = getEntry(entryMap, resolveInZip(opfDir, navItem.href))
  if (!entry) return toc
  const doc = parseHtmlDocument(entry.getData().toString('utf8'))
  for (const a of getElements(doc, 'a')) {
    const href = stripHash(getAttr(a, 'href'))
    const title = normalizeSpace(a.textContent || '')
    if (href && title) toc.set(resolveInZip(path.posix.dirname(resolveInZip(opfDir, navItem.href)), href).toLowerCase(), title)
  }
  return toc
}

const isHtmlManifestItem = (item) => {
  if (!item) return false
  if (XHTML_TYPES.has(item.mediaType)) return true
  return /\.(xhtml?|html?)$/i.test(stripHash(item.href))
}

const parseEpub = async (filepath, onProgress) => {
  const report = (phase, current, total, message) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ phase, current, total, message }) } catch {}
    }
  }

  report('opening', 0, 100, `打开 ${path.basename(filepath)}`)
  let zip = null
  try {
    zip = new AdmZip(filepath)
    const entryMap = zipEntriesByLowerPath(zip)
    const containerEntry = getEntry(entryMap, 'META-INF/container.xml')
    if (!containerEntry) throw new Error('Invalid epub: META-INF/container.xml missing')

    const containerDoc = parseXml(containerEntry.getData().toString('utf8'))
    const rootFile = getElements(containerDoc, 'rootfile')[0]
    const opfPath = getAttr(rootFile, 'full-path').replace(/^\/+/, '')
    if (!opfPath) throw new Error('Invalid epub: no OPF path in container.xml')

    const opfEntry = getEntry(entryMap, opfPath)
    if (!opfEntry) throw new Error(`Invalid epub: OPF ${opfPath} missing`)
    const opfXml = opfEntry.getData().toString('utf8')
    const opfDoc = parseXml(opfXml)
    const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath)
    const manifest = parseManifest(opfDoc)
    const spineIds = parseSpineIds(opfDoc)
    const ncxToc = extractNcxToc(entryMap, opfDir, manifest)
    const navToc = extractNavToc(entryMap, opfDir, manifest)

    const title = firstText(opfDoc, ['dc:title', 'title']) || path.basename(filepath, path.extname(filepath))
    const author = firstText(opfDoc, ['dc:creator', 'creator'])
    const coverBuffer = findCoverBuffer(entryMap, opfDoc, opfDir, manifest)

    const chapters = []
    const total = spineIds.length
    for (let i = 0; i < spineIds.length; i++) {
      const item = manifest.get(spineIds[i])
      report('parsing', i + 1, total, `解析章节 ${i + 1}/${total}`)
      if (!isHtmlManifestItem(item)) continue

      const itemPath = resolveInZip(opfDir, item.href)
      const entry = getEntry(entryMap, itemPath)
      if (!entry) continue

      const html = entry.getData().toString('utf8')
      const tocTitle = navToc.get(itemPath.toLowerCase()) || ncxToc.get(itemPath.toLowerCase())
      const chapterTitle = tocTitle || extractTitleFromHtml(html, `章节 ${chapters.length + 1}`)
      const text = extractTextFromHtml(html)
      chapters.push({ title: chapterTitle, text })
      
      if (i > 0 && i % 10 === 0) {
        if (typeof gc === 'function') {
          try { gc() } catch (e) {}
        }
      }
    }

    report('done', total, total, `解析完成: ${chapters.length} 章`)
    return { title, author, coverBuffer, chapters }
  } finally {
    zip = null
    if (typeof gc === 'function') {
      try { gc() } catch (e) {}
    }
  }
}

module.exports = { parseEpub }
