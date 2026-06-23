# 最近变更摘要

> 生成时间：2026-06-23
> 基于仓库当前工作区未提交改动整理，未执行 commit / push。

## 一、主要更新亮点

1. **启动加速：应用级缓存（App Cache）**
   - 新增 `src/services/appCache.js`，在关闭时把 `bookList` 快照序列化为 MessagePack + Brotli 压缩文件，并记录数据库签名（revision / schema_version / user_version）。
   - 启动时若数据库未发生变化，则直接加载缓存，不再全量扫描。
   - 数据库层新增 `meta` 表与 INSERT/UPDATE/DELETE 触发器，用于自动维护 `rev` 版本号，实现缓存失效判断。

2. **扫描性能大幅重构**
   - `index.js` / `fileLoader/archive.js` / `fileLoader/folder.js` / `fileLoader/zip.js` 全面改用“内存中生成封面/哈希”流程，减少临时文件写入。
   - 新增并发限制器（`createLimiter`），支持设置 `concurrentScan`（默认 4）与 `concurrentWrite`（默认 2）。
   - 扫描过程可中断（`AbortController` + 子进程信号），重复扫描或关闭窗口时会取消旧任务。
   - 新增按批写入（`bulkCreate`，每批 50 条），并标记磁盘中不存在的书籍为 `missing` 状态。

3. **多库文件夹支持**
   - 配置项 `library` 改为数组 `libraries`，支持同时管理多个根目录。
   - 设置页可添加/删除库路径；扫描、目录树、删除/移动本地文件均已适配多库。
   - 旧版单库配置会自动迁移为数组。

4. **封面系统改进**
   - 封面路径改为按 `coverHash` 两级分片存储（`fileLoader/utils.js` 的 `makeShardedPath`），避免单目录文件过多。
   - 新增 `CoverCropDialog.vue`：替换封面时支持可视化裁剪（固定 500:707 比例）。
   - 阅读器右键新增“截图为封面”，可截取当前阅读区域作为封面。
   - 书籍详情页封面新增加载占位图。
   - 书籍卡片状态标签支持 `missing` 状态与 E-Hentai 分类配色。

5. **阅读器（InternalViewer）虚拟化与按需加载**
   - 滚动模式与侧边缩略图均实现虚拟滚动，只渲染视口附近图片。
   - 图片改为按范围请求（`load-manga-image-range`），打开漫画时先加载当前页附近，滚动/跳转时再预加载。
   - 压缩包/Zip 图片改为按需解压到临时文件，不再一次性全部解压。
   - 支持 `PageUp` / `PageDown` 翻页，新增“隐藏页码”开关。

6. **数据库与设置优化**
   - SQLite 启用 WAL 模式与 10 秒 busy timeout；`Mangas.hash` 增加索引。
   - 元数据合并改用 ATTACH + JOIN + COALESCE 的 SQL 方式，启动加载更快。
   - `save-setting` 改为串行合并写（last-write-wins），避免并发覆盖 `setting.json`。
   - 设置页新增“移除缺失记录”按钮，可清理数据库中文件已不存在的记录及未引用封面。

7. **其他**
   - 目录树生成从主进程移到渲染进程，使用 trie + 单链折叠 + 二分索引，提升筛选速度。
   - 鼠标侧键在首页/详情页/阅读器的行为细化（翻页、关闭详情、返回等）。
   - `preload.js` 增加 `ipcRenderer.send`；`src/main.js` 在开发模式下把 preload API 暴露为全局变量。

## 二、变更文件列表

| 文件 | 说明 |
|------|------|
| `index.js` | 主进程核心逻辑重写：并发扫描、缓存读写、数据库 JOIN 加载、按需解压、设置串行保存、多库适配等 |
| `fileLoader/archive.js` | 新增内存中列表/解压、sharp 封面生成、信号感知子进程封装、`-y` 覆盖参数等 |
| `fileLoader/folder.js` | 新增 `solveBookTypeFolderInMem`，支持内存读取文件夹图片生成封面 |
| `fileLoader/index.js` | 整合多库扫描、分片封面路径、内存封面生成、快速列表与按需解压接口 |
| `fileLoader/zip.js` | 新增 `getImageListFromZipFast`、`extractZipImageToFile` 用于按需读取 |
| `fileLoader/utils.js` | **新增** 两级分片路径工具 `makeShardedPath` |
| `modules/database.js` | 新增 `meta` 表、版本触发器、`Mangas.hash` 索引 |
| `modules/init_folder_setting.js` | `library` 改为 `libraries`，新增 `concurrentScan`/`concurrentWrite`/`excludeFile` 默认值与迁移逻辑 |
| `src/App.vue` | 启动加载缓存、缓存失效后回退扫描、鼠标侧键行为、推送缓存签名 |
| `src/components/BookCard.vue` | `missing` 状态与分类颜色标签 |
| `src/components/BookDetailDialog.vue` | 封面加载占位图 |
| `src/components/FolderTree.vue` | 渲染进程生成目录树、多库前缀处理、二分范围筛选 |
| `src/components/InternalViewer.vue` | 虚拟滚动、按需请求图片、截图封面、裁剪弹窗、页码隐藏开关 |
| `src/components/CoverCropDialog.vue` | **新增** 封面裁剪对话框 |
| `src/components/Setting.vue` | 多库管理、并发数设置、移除缺失记录按钮 |
| `src/locales/en-US.json` | 新增多库、缓存、并发、裁剪、移除缺失记录等文案 |
| `src/locales/zh-CN.json` | 同上 |
| `src/locales/zh-TW.json` | 同上 |
| `src/main.js` | 暴露全局 `ipcRenderer` / `electronFunction` 便于开发模式 |
| `src/services/appCache.js` | **新增** 应用缓存序列化/校验/加载逻辑 |
| `preload.js` | 暴露 `ipcRenderer.send` |
| `package.json` | 新增依赖 `msgpackr`；版本号升级到 `1.6.15` |
| `package-lock.json` | 同步依赖变化；`electron` 版本由 `26.6.10` 调整至 `26.2.3` |

## 三、新增文件

- `fileLoader/utils.js` — 封面分片路径工具
- `src/components/CoverCropDialog.vue` — 封面裁剪组件
- `src/services/appCache.js` — 应用启动缓存读写与校验

## 四、注意事项

- **配置迁移**：旧版 `setting.library` 字符串会在首次加载时自动转为 `setting.libraries` 数组，一般无需手动干预。
- **Electron 版本**：`package-lock.json` 中 `electron` 从 `26.6.10` 变更到 `26.2.3`，属于降级，建议确认是否是有意为之；如不需要可重新安装指定版本。
- **缓存文件**：关闭应用时会在 `STORE_PATH/cache/appCache.snap` 生成缓存文件，数据库变更后会自动失效并重新扫描。
- **缺失记录**：新增的“移除缺失记录”会永久删除数据库中文件已不存在的行并清理未引用封面，使用前会弹出确认框。
- **并发设置**：`concurrentScan` / `concurrentWrite` 可在设置中调整，默认分别为 4 和 2，过低会拖慢扫描，过高可能增加磁盘/CPU 压力。
