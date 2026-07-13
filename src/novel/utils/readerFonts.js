export const BUILTIN_FONTS = [
  { label: '京華老宋体', value: 'JingHuaLaoSongTi', file: 'JingHuaLaoSongTi.ttf' },
  { label: '浪漫雅圆', value: 'Langmanyayuan', file: 'Langmanyayuan.ttf' },
  { label: '筑紫 B 丸', value: 'ZuZiBwan', file: 'ZuZiBwan.ttf' }
]

const builtinFontFiles = new Map(BUILTIN_FONTS.map(font => [font.value, font.file]))
const loadedFonts = new Set()

const toArrayBuffer = (data) => {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  if (data?.type === 'Buffer' && Array.isArray(data.data)) {
    return Uint8Array.from(data.data).buffer
  }
  throw new Error('Unsupported font data')
}

export const loadReaderFont = async (fontFamily, fontSource = 'builtin') => {
  if (!fontFamily || fontSource === 'system' || loadedFonts.has(fontFamily)) return

  let source
  if (fontSource === 'builtin') {
    const file = builtinFontFiles.get(fontFamily)
    if (!file) return
    const url = new URL(`./fonts/${file}`, window.location.href).href
    source = `url("${url}")`
  } else if (fontSource === 'import') {
    const data = await window.ipcRenderer.invoke('novel:imported-font-data', fontFamily)
    if (!data) throw new Error(`Imported font not found: ${fontFamily}`)
    source = toArrayBuffer(data)
  } else {
    return
  }

  const face = new FontFace(fontFamily, source, { display: 'swap' })
  await face.load()
  document.fonts.add(face)
  loadedFonts.add(fontFamily)
}
