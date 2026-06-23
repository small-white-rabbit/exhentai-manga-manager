const fs = require('fs')
const fsp = fs.promises
const zlib = require('zlib')
const { createHash } = require('crypto')
const { pack, unpack } = require('msgpackr')
const path = require('path')


const CACHE_FORMAT_VERSION = 1             // bump if structure changes
const BROTLI_Quality = 5


// ------------- Magic Numbers -------------
function makeLayout(spec, { alignU64 = true } = {}) {
  let off = 0
  const OFF = {}
  for (const f of spec) {
    const size = f.type === 'u32' ? 4
        : f.type === 'u64' ? 8
            : f.type === 'bytes' ? f.size
                : (() => { throw new Error('Unknown type ' + f.type) })()
    if (alignU64 && f.type === 'u64') {
      const pad = (8 - (off % 8)) & 7
      off += pad
    }
    OFF[f.name] = off
    off += size
  }
  return { OFF, SIZE: off }
}

const { OFF, SIZE: HEADER_SIZE } = makeLayout([
  { name: 'version', type: 'u32' },
  // dbSignature (6 x u32)
  { name: 'manga_rev', type: 'u32' },
  { name: 'manga_schema', type: 'u32' },
  { name: 'manga_user', type: 'u32' },
  { name: 'meta_rev', type: 'u32' },
  { name: 'meta_schema', type: 'u32' },
  { name: 'meta_user', type: 'u32' },

  // sizes + checksum
  { name: 'compressedSize', type: 'u64' },            // 8-byte aligned by helper
  { name: 'sha', type: 'bytes', size: 32 },
])


// ---------- Main functions ----------
async function saveAppCache(appCache, APP_CACHE_PATH, MangaSequelize, MetadataSequelize) {
  //appCache: {data: {}, dbSignature: {}}
  const dbSignature = {
    MangaDbSig: await readDbSignatureSequelize(MangaSequelize),
    MetadataDbSig: await readDbSignatureSequelize(MetadataSequelize),
  }
  if (appCache.dbSignature) {
    const sameCache = signaturesMatch(dbSignature.MangaDbSig, appCache.dbSignature.MangaDbSig) &&
        signaturesMatch(dbSignature.MetadataDbSig, appCache.dbSignature.MetadataDbSig)
    if (sameCache) {
      console.log('Skipping cache save, same as current')
      return
    }
    if (!dbSignature) throw new Error('dbSignature is null')
  }

  console.log('Saving new cache')

  const container = { data: appCache.data, dbSignature: dbSignature }

  // 1) serialize (MessagePack)
  const raw = pack(container) // Buffer

  // 2) compress (Brotli)
  const compressed = zlib.brotliCompressSync(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_Quality }
  })

  // 3) header
  const header = buildHeader({
    version: CACHE_FORMAT_VERSION,
    compressedPayload: compressed,
    dbSignature
  })

  // 4) concat and atomically write
  await atomicWrite(APP_CACHE_PATH, Buffer.concat([header, compressed]))
}


// ---- writer ----------------------------------------------------------------
function buildHeader({ version, compressedPayload, dbSignature }) {
  const header = Buffer.alloc(HEADER_SIZE)

  header.writeUInt32LE(version >>> 0, OFF.version)

  // dbSignature numbers
  header.writeUInt32LE(dbSignature.MangaDbSig.rev >>> 0, OFF.manga_rev)
  header.writeUInt32LE(dbSignature.MangaDbSig.schema_version >>> 0, OFF.manga_schema)
  header.writeUInt32LE(dbSignature.MangaDbSig.user_version >>> 0, OFF.manga_user)

  header.writeUInt32LE(dbSignature.MetadataDbSig.rev >>> 0, OFF.meta_rev)
  header.writeUInt32LE(dbSignature.MetadataDbSig.schema_version >>> 0, OFF.meta_schema)
  header.writeUInt32LE(dbSignature.MetadataDbSig.user_version >>> 0, OFF.meta_user)

  // size
  u64ToBufLE(compressedPayload.length).copy(header, OFF.compressedSize)

  // sha256 of compressed payload
  const sha = createHash('sha256').update(compressedPayload).digest() // 32 bytes
  sha.copy(header, OFF.sha)

  return header
}


// ---- reader / verifier ------------------------------------------------------
async function LoadVerifyCache(APP_CACHE_PATH, MangaSequelize, MetadataSequelize) {
  const buf = await fsp.readFile(APP_CACHE_PATH)
  if (buf.length < HEADER_SIZE) throw new Error('Cache header too small')

  const header = buf.subarray(0, HEADER_SIZE)

  const version = header.readUInt32LE(OFF.version)
  if (version !== CACHE_FORMAT_VERSION) throw new Error('Cache version mismatch')


  const compressedSize = bufToU64LE(header, OFF.compressedSize)
  if (buf.length !== HEADER_SIZE + compressedSize) throw new Error('Cache truncated/extra bytes')


  const payload = buf.subarray(HEADER_SIZE)
  const shaExpected = header.subarray(OFF.sha, OFF.sha + 32)
  const shaActual = createHash('sha256').update(payload).digest()
  if (!shaActual.equals(shaExpected)) throw new Error('Cache checksum mismatch')

  const cachedDbSig = {
    MangaDbSig: {
      rev: header.readUInt32LE(OFF.manga_rev),
      schema_version: header.readUInt32LE(OFF.manga_schema),
      user_version: header.readUInt32LE(OFF.manga_user),
    },
    MetadataDbSig: {
      rev: header.readUInt32LE(OFF.meta_rev),
      schema_version: header.readUInt32LE(OFF.meta_schema),
      user_version: header.readUInt32LE(OFF.meta_user),
    },
  }

  const dbSignature = {
    MangaDbSig: await readDbSignatureSequelize(MangaSequelize),
    MetadataDbSig: await readDbSignatureSequelize(MetadataSequelize),
  }


  const dbSigMatches =
      signaturesMatch(cachedDbSig.MangaDbSig, dbSignature.MangaDbSig) &&
      signaturesMatch(cachedDbSig.MetadataDbSig, dbSignature.MetadataDbSig)
  let appCache = null
  if (dbSignature) {
    appCache = uncompress(payload)
  }
  // {ok, {appCache:{data, dbSignature}}
  return { ok: dbSigMatches, appCache, }
}

// dbSignature helpers 
async function readDbSignatureSequelize(sequelize) {
  // expects a meta table with rows: ('rev', INTEGER), ('last_change_epoch_ms', INTEGER)
  const [revRow] = await sequelize.query(
      'SELECT CAST(value AS INTEGER) AS rev FROM meta WHERE key=\'rev\' LIMIT 1;',
      { type: sequelize.QueryTypes.SELECT }
  )
  const [sv] = await sequelize.query('PRAGMA schema_version;', { type: sequelize.QueryTypes.SELECT })
  const [uv] = await sequelize.query('PRAGMA user_version;', { type: sequelize.QueryTypes.SELECT })

  return {
    rev: Number(revRow?.rev || 0),
    schema_version: Number(sv?.schema_version || 0),
    user_version: Number(uv?.user_version || 0),
  }
}

function signaturesMatch(cached, live) {
  return (
      Number(cached?.rev) === Number(live?.rev) &&
      Number(cached?.schema_version) === Number(live?.schema_version) &&
      Number(cached?.user_version) === Number(live?.user_version)
  )
}

// --- write cache to disk
async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `${path.basename(filePath)}.tmp`)
  await fsp.mkdir(dir, { recursive: true })
  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()                 // fsync file
  } finally {
    await fh.close()
  }
  // fsync directory to ensure rename durability (best effort)
  try {
    const dh = await fsp.opendir(dir)
    // Node doesn't expose fsync on dir via promises; best effort by stat
    await fsp.stat(dir)
    await dh.close()
  } catch {}
  await fsp.rename(tmp, filePath)
}

// --- uncompress
function uncompress(buf) {
  const raw = zlib.brotliDecompressSync(buf)
  // { data, dbSignature }
  return unpack(raw)
}


//  --- helpers for the byte magics ------

function u64ToBufLE(n) {
  // n can be up to Number.MAX_SAFE_INTEGER
  const b = Buffer.allocUnsafe(8)
  let lo = n >>> 0
  let hi = Math.floor(n / 2 ** 32) >>> 0
  b.writeUInt32LE(lo, 0)
  b.writeUInt32LE(hi, 4)
  return b
}

function bufToU64LE(b, off) {
  const lo = b.readUInt32LE(off)
  const hi = b.readUInt32LE(off + 4)
  return hi * 2 ** 32 + lo
}


module.exports = {
  saveAppCache,
  LoadVerifyCache
}
