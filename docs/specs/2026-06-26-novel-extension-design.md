# 小说阅读扩展包设计

**日期**：2026-06-26
**项目**：exhentai-manga-manager
**状态**：待实施
**参考项目**：[ssnangua/ColorTxt](https://github.com/ssnangua/ColorTxt) v2.8.3（抽取阅读核心、TTS 相关，去除 AI 相关）

## 背景

现有项目是 ExHentai 漫画管理器（Electron + Vue 3 + Sequelize + sqlite3），已具备完整的漫画书库、阅读、局域网网页阅读能力。用户希望以"功能开关"形式扩展小说阅读能力，开启后主界面出现"漫画 / 小说"切换，桌面端和 LAN 网页端均可阅读小说，网页端支持跨设备 TTS 朗读。

## 设计目标

1. **功能开关**：`setting.json` 加 `enableNovel: false`，关闭时零影响，开启时才加载小说模块
2. **独立书库**：Novel 表与 Manga 表完全独立，互不查询
3. **桌面端完整功能**：章节阅读、内容上色、字体/配色/排版设置、书签、摸鱼快捷键
4. **LAN 网页端精简功能**：阅读、章节跳转、配色/字体切换、TTS 朗读
5. **跨设备 TTS**：电脑端 edge-tts 合成语音，HTTP 流式传输到手机网页播放
6. **上游可维护**：核心算法文件（章节识别、上色）从 ColorTxt 抽取，保持单文件纯函数形式，便于未来手动同步上游更新

## 非目标（明确排除）

- 全文搜索（ColorTxt 有，工作量大，后续单独加）
- AI 功能（@huggingface/transformers、sqlite-vec 向量、jieba 分词）
- mobi / azw3 / pdf / chm 解析（先只做 txt + epub）
- 多窗口
- 繁简转换（opencc）
- monaco-editor / markmap / katex（ColorTxt 的 markdown/公式渲染，小说用不上）

---

## §1 · 整体架构

### 目录结构（新增，不动漫画部分）

```
exhentai-manga-manager/
├── src/
│   ├── components/          # 现有漫画组件，不动
│   ├── novel/               # 新增：小说模块
│   │   ├── components/      # NovelCard / NovelReader / ReaderSettings / TtsPanel / HighlightWords
│   │   ├── stores/          # novel store (pinia)
│   │   ├── utils/           # chapter-detector / colorizer / text-format / anti-boss-key
│   │   └── views/           # NovelLibrary / NovelReaderView
│   └── App.vue              # 顶层加 tab：漫画 | 小说
├── novel_loader/            # 新增：主进程小说文件加载（对应 fileLoader/）
│   ├── txt.js               # 流式读取 + jschardet + iconv-lite
│   ├── epub.js              # foliate-js 解析
│   ├── tts.js               # edge-tts spawn + 段落切片
│   └── index.js
├── modules/
│   └── database.js          # 新增 Novel / NovelChapters / NovelBookmarks 模型
└── index.js                 # 新增小说相关 IPC handler + LAN 路由
```

### 功能开关

`setting.json` 加 `enableNovel: false`。关闭时主界面不显示"小说"tab，IPC 不注册，零影响。开启时才加载 `novel/` 模块（懒加载，未启用时整个 novel chunk 不打包进首屏）。

### 数据隔离

Novel 表与 Manga 表完全独立，互不查询。共享的只有 `setting.json`、主题、语言等全局配置。

### 入口

`App.vue` 顶部加 `el-tabs`，"漫画"页放现有内容，"小说"页放 `<NovelLibrary />`。切换 tab 时按需懒加载 novel 子组件。

---

## §2 · LAN 网页端小说 + 跨设备 TTS

### 网页端路由

复用现有 `index.js` 里的 `LANBrowsing` express 实例，新增路由：

| 路由 | 作用 |
|---|---|
| `GET /web/novel` | 返回小说阅读 HTML 页（类似现有 `WEB_READER_HTML`） |
| `GET /api/novel/list` | 小说列表（标题、章节总数、阅读进度） |
| `GET /api/novel/:hash/chapters` | 章节目录 |
| `GET /api/novel/:hash/chapter/:idx` | 单章正文（按需加载，不一次性返回全书） |
| `GET /api/novel/:hash/tts/segment?chapter=X&seg=N` | TTS 单段音频流 |

网页端功能（精简版）：阅读、章节跳转、配色切换（亮/暗/护眼/自定义）、字体大小、TTS 播放控件。**不包含**：自定义高亮词、书签、摸鱼键等 ColorTxt 桌面端独有功能。

### 共用 vs 独立阅读器组件

桌面端 `NovelReader.vue` 功能完整（上色、书签、章节常驻等）；网页端 `/web/novel` 是独立的纯 HTML 页面，**不共用 Vue 组件**——和现有 `/web`（漫画网页阅读器）的做法一致，避免把整个 Vue runtime 打包进 LAN 页。

### TTS 架构

```
[手机浏览器]                    [电脑 Electron 主进程]
  <audio> ──HTTP GET──→  /api/novel/:hash/tts/segment
                              │
                              ↓
                         spawn Python 子进程
                              │
                              ↓
                         edge-tts --voice zh-CN-XiaoxiaoNeural
                              │
                              ↓ (stdout MP3 流)
                         pipe → res (chunked transfer)
                              │
                              ↓
  <audio> 边收边播 ←──── HTTP chunked MP3 流
```

---

## §3 · 数据模型

三张表（与 Manga 完全独立）。

### `Novels` 表（书库元数据，对应 `Mangas`）

```
id, hash, filepath, filename, type(txt|epub), filesize,
encoding,                    # txt 的字符编码（首次打开时检测存下）
title, author,               # epub 自带，txt 从文件名推断
coverPath,                   # epub 提取封面；txt 无则占位
tags(JSON), status,          # 复用漫画的 tag 体系（语言/分类等）
chapterCount,                # 章节数
readProgress,                # JSON: { chapterIdx, charOffset }
readCount, exist, createdAt, updatedAt
```

### `NovelChapters` 表（章节索引，首次打开时解析存入）

```
id, novelId, index, title,
startOffset, endOffset,      # 在原文件中的字节偏移（流式读取用）
charCount
```

### `NovelBookmarks` 表（书签）

```
id, novelId, chapterIdx, charOffset, note, createdAt
```

### 外键与级联

`NovelChapters.novelId` 和 `NovelBookmarks.novelId` 外键关联 `Novels.id`，`ON DELETE CASCADE`——删书时自动清掉对应的章节索引和书签。

### 章节内容不进数据库

章节正文**只存原文件**，DB 只存章节索引（标题 + 偏移）。打开章节时按 `startOffset/endOffset` 流式读取文件那一段，解码后渲染。

理由：
- txt 文件可能几十 MB，全文进 DB 浪费空间且查询用不上
- 章节索引很小（几百章节 × 几十字节 = 几 KB），索引进 DB 用于目录展示和跳转
- 偏移量索引让"跳到第 N 章"是 O(1) 文件 seek，无需重解析

epub 同理：解析后把章节文本抽取到一个临时 txt（或保留 epub 解析结果），DB 存章节元信息。

### 阅读进度

`Novels.readProgress` 存 `{ chapterIdx, charOffset }`，每次滚动/翻页时 debounce 写入。打开书时恢复到该位置。LAN 网页端阅读的进度也写回同一字段（手机看完一章，电脑端打开继续看）。

### 暂不做

- **全文搜索**：ColorTxt 有，工作量大，先不做。后续可加。
- **TTS 进度持久化**：朗读位置不单独存，跟随 `readProgress`。手机端开始朗读时从当前阅读位置开始。

---

## §4 · 从 ColorTxt 抽取的模块

### 抽取改写（要）

| ColorTxt 模块 | 移植到我们项目 | 改写工作量 |
|---|---|---|
| 章节识别（正则规则集 + 自定义规则） | `src/novel/utils/chapter-detector.js` | 低（纯算法，无依赖） |
| 流式读取（按块读 txt，避免大文件一次性加载） | `novel_loader/txt.js` | 低 |
| 编码检测（jschardet + iconv-lite，UTF-8/ANSI 自动识别） | `novel_loader/txt.js` | 低（直接复用依赖） |
| 内容上色（自定义高亮规则着色文本） | `src/novel/utils/colorizer.js` + `NovelReader.vue` 渲染 | 中（要适配 Vue 组件树） |
| 自定义高亮词（选词高亮，存 DB） | `src/novel/components/HighlightWords.vue` | 中 |
| 行首缩进 / 空行压缩 | `src/novel/utils/text-format.js` | 低 |
| epub 解析（参考 foliate-js） | `novel_loader/epub.js` | 中（foliate-js 是纯 JS 库，可直接引） |
| 阅读区设置（字体、字号、行高、配色） | `src/novel/components/ReaderSettings.vue` | 低 |
| 摸鱼快捷键（Ctrl+` 隐藏窗口） | `src/novel/utils/anti-boss-key.js` | 低（Electron globalShortcut） |

### 不抽取（不要）

| ColorTxt 功能 | 不做的原因 |
|---|---|
| AI 相关（@huggingface/transformers、sqlite-vec 向量） | 用户明确说去掉 |
| jieba 分词（@node-rs/jieba） | 主要服务于 AI 搜索，去掉 AI 后用不上 |
| 全文搜索（倒排索引） | 工作量大，先不做，后续可加 |
| opencc 繁简转换 | 非必需，先不做 |
| monaco-editor / markmap / katex | ColorTxt 的 markdown/公式渲染功能，小说用不上 |
| pdfjs-dist / libmspack(chm) | 格式小众，先只做 txt + epub |
| electron-updater | 项目有自己的更新机制 |
| 多窗口 | 单窗口足够，省事 |

### 新增（ColorTxt 没有）

| 新模块 | 来源 |
|---|---|
| 书库管理（扫描目录、批量导入、tag 编辑） | 参考现有漫画的 `BookCard` / `EditView` 改造 |
| LAN 网页端 | 现有 `WEB_READER_HTML` 模式套用到小说 |
| TTS 服务（edge-tts + HTTP 流） | §7 详述 |

### 依赖新增

`package.json` 新增：
```
"jschardet": "^3.1.4"     # 编码检测
"iconv-lite": "^0.7.2"    # 编码解码
"foliate-js": "^7.0.0"    # epub 解析（纯 JS，无原生编译）
"font-list": "^2.0.2"     # 系统字体扫描（ColorTxt 同款）
```
TTS 走 Python 子进程，不加 Node 依赖。**不加 better-sqlite3**（沿用现有 sequelize + sqlite3），不加 TS（沿用 JS）。

devDependencies 新增：
```
"ttf2woff2": "^3.0.0"     # 构建期字体格式转换
```

### 上游同步策略

- ColorTxt 升级章节规则/上色算法时，对应单文件 `chapter-detector.js` / `colorizer.js` 直接覆盖更新即可，因为它们是纯函数无副作用
- 整体功能差异会越来越大（我们加了书库/TTS/LAN，他们没有），所以**只追核心算法文件**，不追 UI 和数据层

---

## §5 · 字体方案

### 字体分类与来源

| 类别 | 字体 | 来源 | 版权处理 |
|---|---|---|---|
| 内置（随 app 打包） | 京華老宋体 | 从 ColorTxt `resources/` 抽取 | README 声明"仅供个人学习交流，商用需购买正版" |
| 内置 | 霞鹜文楷 | SIL OFL 1.1，免费可商用 | 安全 |
| 内置 | 浪漫雅圆 | 第三方付费字体 | 用户自用场景内置，README 声明"仅供个人学习使用，不分发商用" |
| 系统字体 | 微软雅黑 / 宋体 / 苹方 等 | 用户系统自带 | 通过 font-list 扫描本机字体列表 |
| 用户导入 | 任意 | 用户导入 `.ttf/.otf/.woff/.woff2` | 用户自负 |

### 字体导入功能（新增）

- 设置页加"导入字体"按钮，支持 `.ttf / .otf / .woff / .woff2`
- 导入的字体复制到 `STORE_PATH/fonts/` 目录
- 启动时扫描该目录，与内置字体合并成可用字体列表
- 阅读器字体下拉框：内置 3 款 + 导入字体 + 系统字体（font-list 扫描）
- 删除导入字体：在设置里管理，删除即从列表移除（内置不能删）

### 字体选择器 UI

```
字体：[ 京華老宋体 ▼ ]
       ├─ 内置：京華老宋体 / 霞鹜文楷 / 浪漫雅圆
       ├─ 导入：[用户导入的字体...]
       └─ 系统：[font-list 扫描的本机字体]
[+ 导入字体]  [管理字体]
```

### 技术实现

内置字体放 `resources/fonts/`，通过 `@font-face` 在阅读器 CSS 里声明：

```css
@font-face {
  font-family: 'JingHuaLaoSongTi';
  src: url('file:///resources/fonts/JingHuaLaoSongTi.woff2') format('woff2');
  font-display: swap;
}
```

字体格式用 woff2（比 ttf 小 30-50%）。如果 ColorTxt 只有 ttf，加一个 `ttf2woff2` 构建步骤转换。

系统字体列表用 ColorTxt 同款 `font-list` npm 包，调用后返回本机所有可用字体名。

---

## §6 · 个性化设置总览

### 阅读器设置项

`NovelReader` 的设置存 `setting.json` 的 `novel` 字段下，全局共享（不按书存）：

| 设置项 | 选项 | 默认 |
|---|---|---|
| 字体来源 + 字体名 | 内置/导入/系统 | 京華老宋体 |
| 字号 | 14-32px 滑块 | 18 |
| 行高 | 1.4-2.4 滑块 | 1.8 |
| 行首缩进 | 0/2 字符 | 2 |
| 空行压缩 | 开/关 | 开 |
| 配色主题 | 亮/暗/护眼/自定义 | 护眼 |
| 背景色（自定义时） | 颜色选择器 | #f5deb3 |
| 文字色（自定义时） | 颜色选择器 | #333 |
| 内容上色 | 开/关 | 开 |
| 高亮词列表 | 文本数组 | [] |
| 章节标题常驻顶部 | 开/关 | 开 |
| 阅读区宽度 | 600-1200px | 800 |

### 配色主题

内置 4 套：
- **亮色**：白底黑字 `#fff/#333`
- **暗色**：深灰底浅灰字 `#1a1a1a/#eee`（与 app 主色调一致）
- **护眼**：米黄底深棕字 `#f5deb3/#5b4636`
- **自定义**：用户选背景色 + 文字色

网页端同样支持这 4 套，存 `localStorage`（手机端独立于桌面端设置）。

### 设置存储分层

| 设置 | 存储位置 | 同步到 LAN |
|---|---|---|
| 字体来源/字体名、字号、行高、配色 | `setting.json`（全局） | 网页端用 localStorage 独立存 |
| 高亮词列表 | `setting.json` | 不传网页端（精简） |
| 阅读进度 | DB（Novels.readProgress） | 是（手机端读写同一字段） |
| 书签 | DB（NovelBookmarks） | 是 |

---

## §7 · TTS 跨设备朗读详细设计

### edge-tts 调用方式

不引入 Node TTS 库，直接 spawn Python 子进程。命令：

```bash
python -m edge_tts --voice zh-CN-XiaoxiaoNeural --rate "+0%" --text "<章节文本>" --write-media stdout
```

Node 端用 `child_process.spawn`，把子进程 stdout 直接 pipe 到 express 的 `res`：

```javascript
// novel_loader/tts.js 核心逻辑
const ttsProcess = spawn('python', [
  '-m', 'edge_tts',
  '--voice', voice,
  '--rate', rate,
  '--text', text,
  '--write-media', 'stdout'
])
res.setHeader('Content-Type', 'audio/mpeg')
res.setHeader('Transfer-Encoding', 'chunked')
ttsProcess.stdout.pipe(res)
ttsProcess.on('error', () => res.status(500).end())
```

### 文本切片策略

整章一次合成会有问题：长章节几十万字，edge-tts 单次合成慢、占内存、出错要重来。**按段落切片流式合成**：

1. 章节文本按段落（双换行）切分
2. 每个段落 spawn 一个 edge-tts 进程
3. 客户端 JS 维护播放队列，播完一段自动请求下一段，预加载下下段

**端点**：
```
GET /api/novel/:hash/tts/segment?chapter=X&seg=N   → 段落 N 的 MP3
```

优点：实现简单、断点续播容易、单段失败只重试那段。

### 控制接口

网页端 TTS 控件（精简）：

```
[▶ 播放]  [⏸ 暂停]  [⏹ 停止]  章节：第3章 ▼  音色：晓晓 ▼  语速：[──●──] +0%
```

- **播放/暂停**：客户端 `<audio>` 原生控制
- **停止**：清空播放队列，停止当前段
- **音色切换**：zh-CN-XiaoxiaoNeural（晓晓，女声）/ zh-CN-YunxiNeural（云希，男声）/ zh-CN-YunyangNeural（云扬，新闻男声）
- **语速**：edge-tts `--rate "+20%"` 参数，范围 -50% 到 +100%

### 进度跟踪

- 朗读位置不单独存 DB，跟随阅读进度 `readProgress`
- 客户端播放完一段，更新 `readProgress.charOffset` 到该段末尾
- 手机端开始朗读：从当前 `readProgress` 位置所在段落开始
- 桌面端继续阅读：从最新 `readProgress` 继续（朗读和阅读共用一个进度）

### 容错与降级

| 故障 | 处理 |
|---|---|
| Python 未装 / edge-tts 未装 | 首次启动 TTS 时检测，提示"请安装 Python 和 `pip install edge-tts`"，设置里加一键检测按钮 |
| 网络不通（edge-tts 依赖微软服务） | 端点返回 503，客户端自动 fallback 到浏览器 `SpeechSynthesis` API（手机本地 TTS） |
| 单段合成失败 | 重试 2 次，仍失败跳过该段继续下一段，toast 提示 |
| 章节无文本（空章节） | 跳过，自动进下一章 |

### 桌面端 vs 网页端

| 端 | TTS 实现 |
|---|---|
| 桌面端 | 同样走 Python edge-tts（本机发音），或直接调 Windows SAPI 作为可选 |
| 网页端 | 走 HTTP 流（电脑发音传手机），fallback 浏览器本地 TTS |

桌面端 TTS 控件和网页端一致，共享同一套 API。

### edge-tts 安装检测

设置页加"语音朗读"分区：
- 显示 Python 是否已安装、edge-tts 是否已安装
- 一键安装命令：`pip install edge-tts`（自动执行，需用户确认）
- 测试按钮：朗读一句话验证

---

## §8 · 实施阶段

### 阶段 1 · 桌面端最小可用（MVP）

**目标**：能在桌面端打开 txt/epub，分章节阅读，改字体配色。**不含 TTS、不含 LAN、不含书库管理。**

任务范围：
1. `Novels` / `NovelChapters` 表 + Sequelize 模型
2. `novel_loader/txt.js`（流式读取 + jschardet 编码检测 + iconv-lite 解码）
3. `novel_loader/epub.js`（foliate-js 解析）
4. 章节识别（`chapter-detector`，从 ColorTxt 抽取正则规则集）
5. 主进程 IPC：导入单本、读章节、存进度
6. `NovelLibrary.vue`：最小书架（列表 + 导入按钮，无 tag/搜索）
7. `NovelReader.vue`：阅读器（章节目录、正文渲染、章节切换、进度保存）
8. `ReaderSettings.vue`：字体（内置 3 款 + 导入 + 系统）、字号、行高、配色 4 套
9. 内容上色 + 行首缩进 + 空行压缩
10. `App.vue` 加漫画/小说 tab + `enableNovel` 开关

**验收**：导入一本 txt 和一本 epub，能分章节读，改字体配色生效，关掉重开进度恢复。

### 阶段 2 · 书库管理 + LAN 网页端

**目标**：完整的小说书库管理 + 手机能看。

任务范围：
1. 扫描目录批量导入（参考现有漫画的 `scanLibraryFiles` 模式）
2. NovelCard / EditView 改造（tag 编辑、封面、批量操作）
3. 书签功能（`NovelBookmarks` 表 + UI）
4. LAN 路由：`/web/novel` + `/api/novel/*`（章节按需加载）
5. 网页端 HTML 页：阅读、章节跳转、配色/字体切换、进度同步
6. 网页端阅读进度写回 DB（手机看完电脑继续看）

**验收**：指定一个小说目录批量导入；手机浏览器打开 LAN 网址能看书；手机端进度桌面端能继承。

### 阶段 3 · TTS 跨设备朗读

**目标**：手机端能听书。

任务范围：
1. `novel_loader/tts.js`（spawn edge-tts + 段落切片）
2. `/api/novel/:hash/tts/segment` 端点 + 容错降级
3. 网页端 TTS 控件（播放队列、音色/语速选择）
4. 设置页 Python/edge-tts 检测 + 一键安装
5. 桌面端 TTS（复用同一套 API）
6. 浏览器 SpeechSynthesis fallback

**验收**：手机端点播放能听到电脑合成的语音；切音色语速生效；断网时降级到手机本地 TTS。

### 风险点

| 风险 | 应对 |
|---|---|
| edge-tts API 被微软改动 | 浏览器 SpeechSynthesis 兜底；edge-tts 是开源社区维护，通常几天内出修复 |
| epub 格式各异（有的没 NCX、有的加密） | foliate-js 成熟，覆盖大部分；解析失败的 epub 提示用户并跳过 |
| 大 txt 文件（>50MB）首次解析慢 | 流式读取 + 章节索引缓存进 DB，二次打开直接用索引 |
| 内置浪漫雅圆版权 | README 声明"仅供个人学习使用"，不分发商用 |

---

## 技术栈对比

| 维度 | 现有项目 | ColorTxt | 决策 |
|---|---|---|---|
| 语言 | JS | TS | 沿用 JS |
| 构建 | vite | electron-vite | 沿用 vite |
| Electron | 26 | 35 | 沿用 26 |
| 数据库 | sequelize + sqlite3（异步 ORM） | better-sqlite3（同步） | 沿用 sequelize |
| ORM | Sequelize 模型 | 直接 SQL | 沿用 Sequelize |

**核心原则**：只抽 ColorTxt 的纯算法/纯渲染模块，不引入它的技术栈。数据层、构建、语言全部沿用现有项目，避免引入两套技术栈的维护成本。
