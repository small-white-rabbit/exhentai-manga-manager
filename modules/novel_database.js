const { Sequelize, DataTypes } = require('sequelize')

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
    type: DataTypes.TEXT,
    filesize: DataTypes.INTEGER,
    encoding: DataTypes.TEXT,
    title: DataTypes.TEXT,
    author: DataTypes.TEXT,
    coverPath: DataTypes.TEXT,
    tags: { type: DataTypes.JSON, defaultValue: {} },
    status: { type: DataTypes.TEXT, defaultValue: 'non-tag' },
    chapterCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    readProgress: { type: DataTypes.JSON, defaultValue: { chapterIdx: 0, charOffset: 0 } },
    readCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    exist: { type: DataTypes.BOOLEAN, defaultValue: true },
    date: DataTypes.INTEGER,
    lastReadAt: DataTypes.INTEGER
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
    startOffset: DataTypes.INTEGER,
    endOffset: DataTypes.INTEGER,
    byteStartOffset: DataTypes.INTEGER,
    byteEndOffset: DataTypes.INTEGER,
    charCount: DataTypes.INTEGER,
    text: DataTypes.TEXT
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

  Novel.hasMany(NovelChapter, { foreignKey: 'novelId', onDelete: 'CASCADE', hooks: true })
  NovelChapter.belongsTo(Novel, { foreignKey: 'novelId' })
  Novel.hasMany(NovelBookmark, { foreignKey: 'novelId', onDelete: 'CASCADE', hooks: true })
  NovelBookmark.belongsTo(Novel, { foreignKey: 'novelId' })

  return { Novel, NovelChapter, NovelBookmark, sequelize }
}

module.exports = { prepareNovelModels }
