const path = require('node:path')

function makeShardedPath(root, fileName, levels = 1) {
  /** shard cover folder to avoid too many files in one folder
   * 1 level (k=2) -> 256 folders -> ~1,950 files/folder if you reach 500k covers.
   * 2 levels (k=2 per level) -> 256x256=65,536 folders -> ~7-8 files/folder at 500k.
   */
  // assume the filename is the hex hash string
  const hex = path.parse(fileName).name
  const parts = []
  for (let i = 0; i < levels; i++) {
    parts.push(hex.slice(i * 2, i * 2 + 2)) // two hex chars per level
  }
  return path.join(root, ...parts, fileName)
}

module.exports = {
  makeShardedPath
}
