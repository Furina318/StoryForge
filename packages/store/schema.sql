-- StoryForge v0.1.0 原型存储层（SQLite / better-sqlite3）
--
-- 设计取舍（与 docs/v0.1-技术基线.md 的差异，必须显式记录）：
--  * block.text 在基线里是"永不 UPDATE"，改动走派生 block + superseded_by + patch。
--    原型阶段编辑器仍是"段落就地编辑"，因此这里 block_text 会被 UPDATE，
--    由 repo 层用一个事务"删旧插新"实现。等编辑器升级到 patch 模型时，
--    只需给 block 加 superseded_by / rev 两列，表结构不用重来。
--  * 没有 patch / run / issue 表：生成与审查在原型里是模拟的，落库没有意义。
--  * v2 起支持多项目：project / chapter / entity / world_rule / foreshadow /
--    entity_state / waiver / kv 都带 project_id，删项目走 ON DELETE CASCADE。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  genre         TEXT,
  logline       TEXT,
  sell_point    TEXT,
  desire        TEXT,
  conflict      TEXT,
  target_words  INTEGER,
  chapter_count INTEGER,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  card_json     TEXT NOT NULL DEFAULT '{}',   -- 风格卡 / 参与度模式等暂存
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('planned', 'draft', 'done')),
  card_json   TEXT NOT NULL DEFAULT '{}',
  current_rev INTEGER NOT NULL DEFAULT 1,   -- 当前生效的 block 快照版本（v3）
  summary     TEXT,                          -- 章节摘要（v3，summary 槽位写入）
  summary_rev INTEGER,                       -- 摘要对应哪一版正文
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chapter_project ON chapter(project_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chapter_pid_idx ON chapter(project_id, idx);

-- v3：block 不可变。text 一旦写下就不再 UPDATE，改字 = 派生新行 + 老行写 superseded_by。
CREATE TABLE IF NOT EXISTS block (
  id            TEXT PRIMARY KEY,
  chapter_id    TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  project_id    TEXT,
  ord           REAL NOT NULL,                 -- 最近一次出现的位置（权威顺序在 block_rev）
  text          TEXT NOT NULL,
  src           TEXT NOT NULL DEFAULT 'human' CHECK (src IN ('human', 'ai', 'import')),
  meta_json     TEXT NOT NULL DEFAULT '{}',
  superseded_by TEXT,                          -- 被哪个新 block 取代
  deleted_at    TEXT,                          -- 被删掉的时间（不物理删除，便于回滚）
  created_at    TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_block_chapter ON block(chapter_id, ord);
CREATE INDEX IF NOT EXISTS ix_block_superseded ON block(superseded_by);

-- 版本快照：某一版正文由哪些 block 按什么顺序组成
CREATE TABLE IF NOT EXISTS block_rev (
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL,
  block_id   TEXT NOT NULL,
  ord        REAL NOT NULL,
  PRIMARY KEY (chapter_id, rev, block_id)
);
CREATE INDEX IF NOT EXISTS ix_block_rev ON block_rev(chapter_id, rev, ord);

-- patch：一次"应用"就是一条或几条 patch，保留 before/after 才能给逐段 diff 与回滚
CREATE TABLE IF NOT EXISTS patch (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id   TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  base_rev     INTEGER NOT NULL,
  applied_rev  INTEGER,
  target_block TEXT,
  op           TEXT NOT NULL CHECK (op IN ('replace', 'insert', 'delete', 'append')),
  before_text  TEXT,
  after_text   TEXT,
  rationale    TEXT,
  source       TEXT,
  status       TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_patch_chapter ON patch(chapter_id, applied_rev);

-- 资料卡：角色（kind=主角/配角/反派）
CREATE TABLE IF NOT EXISTS entity (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT '配角',
  name       TEXT NOT NULL,
  role       TEXT,
  desire     TEXT,
  wound      TEXT,
  voice      TEXT,
  secret     TEXT,
  note       TEXT,
  arc_json   TEXT,
  ord        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entity_project ON entity(project_id, ord);

-- 资料卡：世界观（kind=规则/地点/势力/物品/能力）
CREATE TABLE IF NOT EXISTS world_rule (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT '规则',
  name       TEXT NOT NULL,
  text       TEXT,
  ord        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_world_project ON world_rule(project_id, ord);

-- 状态卡：proposed（等待用户确认）与 confirmed（已进上下文）共用一张表，用 kind 区分
CREATE TABLE IF NOT EXISTS entity_state (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'demo',
  entity     TEXT NOT NULL,
  field      TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  chapter    INTEGER,
  block_id   TEXT,
  quote      TEXT,
  confidence REAL,
  checked    INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'proposed' CHECK (kind IN ('proposed', 'confirmed')),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_state_project ON entity_state(project_id, kind);

CREATE TABLE IF NOT EXISTS foreshadow (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL DEFAULT 'demo',
  title           TEXT NOT NULL,
  planted_chapter INTEGER,
  planted_block   TEXT,
  quote           TEXT,
  due_chapter     INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('planted', 'touched', 'resolved', 'abandoned')),
  related_json    TEXT NOT NULL DEFAULT '[]',
  note            TEXT,
  ord             INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_foreshadow_project ON foreshadow(project_id, ord);

CREATE TABLE IF NOT EXISTS waiver (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'demo',
  rule_id    TEXT NOT NULL,
  key        TEXT,
  block_id   TEXT,
  expired    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_waiver_rule ON waiver(project_id, rule_id, key);

CREATE TABLE IF NOT EXISTS kv (
  project_id TEXT NOT NULL DEFAULT 'demo',
  k          TEXT NOT NULL,
  v          TEXT,
  PRIMARY KEY (project_id, k)
);
-- 注意：kv 没有外键（历史原因），所以 deleteProject 里要显式删它的行。

-- ═══════════════════════════════════════════════════════════════════
-- v5：书库（阅读器模式）
--
-- 刻意**不挂 project 外键**：书架和项目是两个平行的收藏，
-- 同一本书可以给多个项目当素材，删项目不该把书一起删掉。
-- 正文不在这几张表里：落 <userData>/library/books/<id>/sec/<n>.json，
-- 这里只存索引、目录、进度、标记（理由见 packages/library/sections.js）。
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS book (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  cover         TEXT,                           -- 封面：data URL / 本地路径 / 远端 URL
  format        TEXT NOT NULL DEFAULT 'txt',    -- txt / md / pdf / text / external / web
  render        TEXT NOT NULL DEFAULT 'text',   -- text / richtext / paged / launch
  encoding      TEXT,
  src_path      TEXT,                           -- 源文件绝对路径（网页书为空）
  src_name      TEXT,
  src_size      INTEGER,
  src_hash      TEXT,                           -- 内容指纹：用来探"源文件被换过"
  src_url       TEXT,                           -- 书源预留
  source_id     TEXT,                           -- 书源预留
  section_count INTEGER NOT NULL DEFAULT 0,
  char_count    INTEGER NOT NULL DEFAULT 0,
  toc_source    TEXT,                           -- txt-regex / md-heading / auto / null
  note          TEXT,                           -- 降级说明，直接显示给用户
  prefs_json    TEXT NOT NULL DEFAULT '{}',     -- 字号/行距/主题/栏宽
  progress_ord  INTEGER NOT NULL DEFAULT 0,     -- 读到第几节
  progress_blk  INTEGER NOT NULL DEFAULT 0,     -- 节内第几块
  last_read_at  TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_book_read ON book(last_read_at);

CREATE TABLE IF NOT EXISTS book_toc (
  book_id TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  anchor  TEXT,                                 -- 节内锚点（md 用）
  page    INTEGER,                              -- paged 格式用
  url     TEXT,                                 -- 书源预留
  PRIMARY KEY (book_id, ord)
);

-- 摘录 / 笔记。P0 只写不读（阅读器里选中→"收进本章"要等 B 阶段），
-- 但表先建好，免得以后迁移。
CREATE TABLE IF NOT EXISTS book_mark (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'excerpt' CHECK (kind IN ('excerpt', 'note')),
  section_ord INTEGER,
  ord         INTEGER,
  quote       TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mark_book ON book_mark(book_id, section_ord);

-- 书源接口（P2 才实现搜索/抓取）。规格是**声明式 JSON**：
-- { search:{url,list,title,detail}, toc:{list,title,href}, chapter:{content,remove}, delayMs }
-- 绝不存可执行 JS —— 别人的书源规格不该能在本机跑代码。
CREATE TABLE IF NOT EXISTS book_source (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  spec_json  TEXT NOT NULL DEFAULT '{}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT NOT NULL
);


