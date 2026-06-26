const { Sequelize, DataTypes } = require('sequelize')

/**
 * 准备 Novel 相关模型。复用现有 sqlite 文件（与 Manga 同库不同表），
 * 避免引入第二个 sequelize 实例和跨库 ATTACH 复杂度。
 * @param {string} databasePath 与 Manga 相同的 database.sqlite 路径
 */
const prepareNovelModels = (databasePath) => {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
    logging: false
  })

  const Novel = sequelize.define('Novel', {
    id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
    hash: DataTypes.TEXT,
    filepath: DataTypes.TEXT,
    filename: DataTypes.TEXT,
    type: DataTypes.TEXT,          // txt | epub
    filesize: DataTypes.INTEGER,
    encoding: DataTypes.TEXT,      // txt 的字符编码
    title: DataTypes.TEXT,
    author: DataTypes.TEXT,
    coverPath: DataTypes.TEXT,
    tags: { type: DataTypes.JSON, defaultValue: {} },
    status: { type: DataTypes.TEXT, defaultValue: 'non-tag' },
    chapterCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    readProgress: { type: DataTypes.JSON, defaultValue: { chapterIdx: 0, charOffset: 0 } },
    readCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    exist: { type: DataTypes.BOOLEAN, defaultValue: true },
    date: DataTypes.INTEGER
  }, {
    indexes: [{ name: 'novel_hash_index', unique: false, fields: ['hash'] }],
    tableName: 'Novels',
    freezeTableName: true
  })

  const NovelChapter = sequelize.define('NovelChapter', {
    id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
    novelId: { type: DataTypes.TEXT, allowNull: false },
    index: { type: DataTypes.INTEGER, allowNull: false },
    title: DataTypes.TEXT,
    startOffset: DataTypes.INTEGER,   // 字节偏移
    endOffset: DataTypes.INTEGER,
    charCount: DataTypes.INTEGER
  }, {
    indexes: [{ name: 'novel_chapter_novel_index', fields: ['novelId', 'index'] }],
    tableName: 'NovelChapters',
    freezeTableName: true
  })

  const NovelBookmark = sequelize.define('NovelBookmark', {
    id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
    novelId: { type: DataTypes.TEXT, allowNull: false },
    chapterIdx: { type: DataTypes.INTEGER, allowNull: false },
    charOffset: { type: DataTypes.INTEGER, defaultValue: 0 },
    note: DataTypes.TEXT,
    createdAt: DataTypes.INTEGER
  }, {
    indexes: [{ name: 'novel_bookmark_novel_index', fields: ['novelId'] }],
    tableName: 'NovelBookmarks',
    freezeTableName: true
  })

  // 外键级联：删 Novel 时自动删其 Chapter 和 Bookmark
  Novel.hasMany(NovelChapter, { foreignKey: 'novelId', onDelete: 'CASCADE', hooks: true })
  NovelChapter.belongsTo(Novel, { foreignKey: 'novelId' })
  Novel.hasMany(NovelBookmark, { foreignKey: 'novelId', onDelete: 'CASCADE', hooks: true })
  NovelBookmark.belongsTo(Novel, { foreignKey: 'novelId' })

  return { Novel, NovelChapter, NovelBookmark, sequelize }
}

module.exports = { prepareNovelModels }
