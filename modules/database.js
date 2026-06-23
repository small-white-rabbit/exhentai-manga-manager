const { Sequelize, DataTypes } = require('sequelize')

const prepareMangaModel = (databasePath) => {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
    logging: false
  })
  const Manga = sequelize.define('Manga', {
    id: {
      type: DataTypes.TEXT,
      allowNull: false,
      primaryKey: true
    },
    title: DataTypes.TEXT,
    coverPath: DataTypes.TEXT,
    hash: DataTypes.TEXT,
    filepath: DataTypes.TEXT,
    type: DataTypes.TEXT,
    pageCount: DataTypes.INTEGER,
    bundleSize: DataTypes.INTEGER,
    mtime: DataTypes.TEXT,
    coverHash: DataTypes.TEXT,
    status: DataTypes.TEXT,
    date: DataTypes.INTEGER,
    rating: DataTypes.FLOAT,
    tags: {
      type: DataTypes.JSON,
      defaultValue: {}
    },
    title_jpn: DataTypes.TEXT,
    filecount: DataTypes.INTEGER,
    posted: DataTypes.INTEGER,
    filesize: DataTypes.INTEGER,
    category: DataTypes.TEXT,
    url: DataTypes.TEXT,
    mark: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    hiddenBook: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    readCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    exist: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    indexes: [{ name: 'manga_hash_index', unique: false, fields: ['hash'] }],
    tableName: 'Mangas',
    freezeTableName: true,
  })
  return Manga
}

const prepareMetadataModel = (databasePath) => {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
    logging: false
  })
  const Metadata = sequelize.define('Metadata', {
    hash: {
      type: DataTypes.TEXT,
      allowNull: false,
      primaryKey: true
    },
    title: DataTypes.TEXT,
    status: DataTypes.TEXT,
    rating: DataTypes.FLOAT,
    tags: {
      type: DataTypes.JSON,
      defaultValue: {}
    },
    title_jpn: DataTypes.TEXT,
    filecount: DataTypes.INTEGER,
    posted: DataTypes.INTEGER,
    filesize: DataTypes.INTEGER,
    category: DataTypes.TEXT,
    url: DataTypes.TEXT,
    mark: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
  })
  return Metadata
}

// for cache table
// shared SQL helpers
const EPOCH_MS_SQL = `
CAST(strftime('%s','now') AS INTEGER) * 1000
+ CAST(substr(strftime('%f','now'), instr(strftime('%f','now'),'.')+1, 3) AS INTEGER)
`

async function ensureMetaTable(sequelize) {
  // minimal, robust meta store
  await sequelize.query(`
      CREATE TABLE IF NOT EXISTS meta
      (
          key   TEXT PRIMARY KEY,
          value INTEGER NOT NULL
      );
  `)
  await sequelize.query(`
      INSERT OR IGNORE INTO meta(key, value)
      VALUES ('rev', 0),
             ('last_change_epoch_ms', 0);
  `)
}

async function installRevTriggers(sequelize, tableName, prefix) {
  // prefix lets you avoid trigger-name collisions across DBs if you reuse names
  const ai = `${prefix}_${tableName}_ai`
  const au = `${prefix}_${tableName}_au`
  const ad = `${prefix}_${tableName}_ad`

  await sequelize.query(`
    CREATE TRIGGER IF NOT EXISTS ${ai}
    AFTER INSERT ON ${tableName}
    BEGIN
      UPDATE meta SET value = value + 1 WHERE key='rev';
      UPDATE meta SET value = ${EPOCH_MS_SQL} WHERE key='last_change_epoch_ms';
    END;
  `)

  await sequelize.query(`
    CREATE TRIGGER IF NOT EXISTS ${au}
    AFTER UPDATE ON ${tableName}
    BEGIN
      UPDATE meta SET value = value + 1 WHERE key='rev';
      UPDATE meta SET value = ${EPOCH_MS_SQL} WHERE key='last_change_epoch_ms';
    END;
  `)

  await sequelize.query(`
    CREATE TRIGGER IF NOT EXISTS ${ad}
    AFTER DELETE ON ${tableName}
    BEGIN
      UPDATE meta SET value = value + 1 WHERE key='rev';
      UPDATE meta SET value = ${EPOCH_MS_SQL} WHERE key='last_change_epoch_ms';
    END;
  `)
}

module.exports = {
  prepareMangaModel,
  prepareMetadataModel,
  ensureMetaTable,
  installRevTriggers
}