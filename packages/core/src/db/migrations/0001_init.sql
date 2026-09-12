-- Assit-interview 初始 schema
-- 对应 docs/DESIGN.md §11，含 docs/plan.md §2 的修订：
--   * identity_key 去掉薪资分桶（跨平台薪资写法不同会漏合）
--   * JD 变更历史进 artifacts + posting_jd_history
--   * 新增 claim_events / resume_bullets / model_cache / company_aliases
--   * applications.confirmed_by_user 用 CHECK 让「人工确认闸门」在 schema 层生效

------------------------------------------------------------------ 公司与岗位

CREATE TABLE companies (
  id                     TEXT PRIMARY KEY,
  canonical_name         TEXT NOT NULL,
  industry               TEXT,
  size_band              TEXT,               -- 三态 JSON
  outsourcing_signals    TEXT,               -- JSON 数组：命中的信号
  outsourcing_likelihood REAL,               -- 0–1；NULL = 无信号（未知），不是 0
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_companies_canonical ON companies(canonical_name);

-- 别名独立成表而不是 JSON 数组：要能按别名反查，且要记住哪些是人工确认过的
CREATE TABLE company_aliases (
  alias             TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  identity_key    TEXT NOT NULL,             -- sha256(公司 | 归一化职位 | 城市)，不含薪资
  title_norm      TEXT NOT NULL,
  title_raw       TEXT NOT NULL,
  role_family     TEXT,
  city            TEXT,
  salary_min_yuan INTEGER,
  salary_max_yuan INTEGER,
  salary_months   INTEGER,
  salary_raw      TEXT,
  attrs           TEXT NOT NULL DEFAULT '{}',-- 三态字段集合
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT
);
CREATE UNIQUE INDEX idx_jobs_identity ON jobs(identity_key);

CREATE TABLE postings (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  platform_job_id TEXT NOT NULL,
  url             TEXT,
  jd_sha256       TEXT,                      -- 指向 artifacts，不内联 JD 全文
  apply_channel   TEXT,
  recruiter_ref   TEXT,                      -- sha256(platform+hr_id+salt)，不存姓名
  collected_by    TEXT,
  collected_at    TEXT NOT NULL DEFAULT (datetime('now')),
  is_active       INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_postings_platform ON postings(platform, platform_job_id);

-- 「这个岗位两周内改了 3 次 JD」本身就是信号
CREATE TABLE posting_jd_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id TEXT NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  jd_sha256  TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jd_history_posting ON posting_jd_history(posting_id, seen_at);

CREATE TABLE job_scores (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  profile_version TEXT NOT NULL,
  rubric_version  TEXT NOT NULL,             -- rubric 文件内容 hash，不手写版本号
  final_score     INTEGER NOT NULL,
  raw_score       INTEGER,
  coverage        REAL,
  trace_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_scores_triple ON job_scores(job_id, profile_version, rubric_version);

-- 忽略原因要有消费方，否则记了白记（assit rubric-review）
CREATE TABLE jobs_ignored (
  job_id         TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  reason         TEXT NOT NULL,
  score_at_ignore INTEGER,
  ignored_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

------------------------------------------------------------------ 事实库：档案

-- 以下三张表的值永不经过改写模型
CREATE TABLE profile_fields (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_en    TEXT,
  verified_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profile_records (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('education','employment','certificate','language','award')),
  payload     TEXT NOT NULL,
  start_at    TEXT,
  end_at      TEXT,
  expires_at  TEXT,                          -- 过期即禁止进简历与表单
  is_current  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER,
  verified_at TEXT
);
CREATE INDEX idx_profile_records_kind ON profile_records(kind, sort_order);

CREATE TABLE preference_defaults (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

------------------------------------------------------------------ 事实库：主张与项目图谱

CREATE TABLE claims (
  id                   TEXT PRIMARY KEY,
  source_fact          TEXT NOT NULL,
  candidate_wording    TEXT,
  candidate_wording_en TEXT,
  responsibility_level TEXT NOT NULL CHECK (responsibility_level IN ('参与','负责模块','主导方案或交付','项目负责人')),
  verification_status  TEXT NOT NULL CHECK (verification_status IN ('已确认','待确认','已过期','不采用')),
  boundary             TEXT NOT NULL,
  visibility           TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private','nda')),
  code_evidence        TEXT,
  artifact_evidence    TEXT,
  interview_details    TEXT,
  metrics              TEXT,
  allowed_uses         TEXT,
  tags                 TEXT,
  risk_notes           TEXT,
  last_verified        TEXT,
  source_path          TEXT,                 -- 来自 data/facts 的哪个文件（文件是真源）
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 所有状态变更走事件：降级可追溯、可撤销
-- 「面试答不上来 → 自动降级 claim」如果没有这张表，就是不可逆的静默改写
CREATE TABLE claim_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id     TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  source       TEXT NOT NULL CHECK (source IN ('manual','sync','mock_interview','real_interview','expiry_job')),
  evidence_ref TEXT,
  note         TEXT,
  occurred_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_claim_events_claim ON claim_events(claim_id, occurred_at);

CREATE TABLE repos (
  id                  TEXT PRIMARY KEY,
  full_name           TEXT NOT NULL UNIQUE,
  local_path          TEXT,
  visibility          TEXT NOT NULL CHECK (visibility IN ('public','private','nda')),
  arch_json           TEXT,
  arch_html           TEXT,
  analyzed_at         TEXT,
  last_scanned_commit TEXT                   -- 增量扫描游标
);

CREATE TABLE repo_modules (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  role          TEXT,                        -- 解读层产物
  tech          TEXT,
  evidence_refs TEXT,                        -- NULL = AI 未能从代码推出结论 → 展示「未识别」，不许编
  my_commits    INTEGER NOT NULL DEFAULT 0,
  my_share      REAL,
  touched_by_me INTEGER NOT NULL DEFAULT 0   -- 结构层 × 归因层求交结果
);
CREATE INDEX idx_repo_modules_mine ON repo_modules(repo_id, touched_by_me);

------------------------------------------------------------------ 简历

CREATE TABLE resume_versions (
  id              TEXT PRIMARY KEY,          -- = profile_version
  label           TEXT NOT NULL,
  target_role     TEXT,
  format          TEXT NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf','boss_online')),
  jd_sha256       TEXT,                      -- 针对哪份 JD 定制的
  rendered_sha256 TEXT,
  prompt_version  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 真源。回答「我在 A 家的简历里，这条 claim 是怎么写的」
CREATE TABLE resume_bullets (
  id                TEXT PRIMARY KEY,
  resume_version_id TEXT NOT NULL REFERENCES resume_versions(id) ON DELETE CASCADE,
  claim_id          TEXT NOT NULL REFERENCES claims(id),
  section           TEXT NOT NULL,
  text              TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_bullets_version ON resume_bullets(resume_version_id, sort_order);
CREATE INDEX idx_bullets_claim ON resume_bullets(claim_id);

------------------------------------------------------------------ 投递

CREATE TABLE applications (
  id                TEXT PRIMARY KEY,
  posting_id        TEXT NOT NULL REFERENCES postings(id),
  company_id        TEXT NOT NULL REFERENCES companies(id),
  application_key   TEXT NOT NULL,
  channel           TEXT NOT NULL,
  resume_sha256     TEXT NOT NULL,
  jd_sha256         TEXT NOT NULL,
  greeting_sha256   TEXT,
  score_id          TEXT REFERENCES job_scores(id),
  prefs_override    TEXT,
  sent_at           TEXT NOT NULL,
  -- 人工确认闸门：不是默认值，是约束。没有人点过确认的投递写不进来。
  confirmed_by_user INTEGER NOT NULL DEFAULT 1 CHECK (confirmed_by_user = 1),
  status            TEXT NOT NULL DEFAULT 'sent'
);
CREATE INDEX idx_app_dedup ON applications(application_key, sent_at);

CREATE TABLE application_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  source            TEXT NOT NULL,
  evidence_ref      TEXT,
  -- 邮件/agent 解析出来的事件默认待确认，人确认后才改状态、才写日历
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  occurred_at       TEXT NOT NULL,
  detail            TEXT
);
CREATE INDEX idx_app_events ON application_events(application_id, occurred_at);

CREATE TABLE form_fills (
  id              TEXT PRIMARY KEY,
  application_id  TEXT REFERENCES applications(id) ON DELETE SET NULL,
  domain          TEXT NOT NULL,
  url             TEXT,
  snapshot_sha256 TEXT NOT NULL,
  claim_ids       TEXT,
  submitted_at    TEXT
);

CREATE TABLE form_field_map (
  domain            TEXT NOT NULL,
  selector          TEXT NOT NULL,
  profile_key       TEXT NOT NULL,
  field_class       TEXT NOT NULL CHECK (field_class IN ('registry','narrative','decision')),
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, selector)
);

------------------------------------------------------------------ 题库与复习

CREATE TABLE questions (
  id                    TEXT PRIMARY KEY,
  content               TEXT NOT NULL,
  topic                 TEXT,
  source_type           TEXT NOT NULL CHECK (source_type IN ('web_scrape','manual','real_interview','claim_derived','official_doc')),
  source_ref            TEXT NOT NULL,       -- 硬约束：没有来源的题不入库
  credibility           TEXT NOT NULL DEFAULT 'unverified' CHECK (credibility IN ('verified','secondhand','unverified')),
  informant             TEXT,
  claim_id              TEXT REFERENCES claims(id) ON DELETE SET NULL,
  answer_standard       TEXT,
  answer_standard_refs  TEXT,
  answer_mine           TEXT,
  answer_mine_claim_ids TEXT,
  collected_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reviews (
  question_id    TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  ease_factor    REAL NOT NULL DEFAULT 2.5,
  interval_days  INTEGER NOT NULL DEFAULT 0,
  repetitions    INTEGER NOT NULL DEFAULT 0,
  last_grade     INTEGER,
  origin         TEXT,                       -- real_interview 的错题权重最高
  next_review_at TEXT NOT NULL
);

------------------------------------------------------------------ 模型

CREATE TABLE model_providers (
  id               TEXT PRIMARY KEY,         -- api:anthropic / cli:claude / local:ollama
  kind             TEXT NOT NULL CHECK (kind IN ('api','cli','local')),
  -- 路由层据此强制拦截。cli:* 背后也是云端，所以和 api:* 一样封顶 public。
  max_visibility   TEXT NOT NULL CHECK (max_visibility IN ('public','private','nda')),
  model            TEXT,
  endpoint         TEXT,
  credential_ref   TEXT,                     -- keychain 引用名，不存密钥本身
  detected_version TEXT,
  is_available     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE model_routes (
  task       TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  fallback   TEXT,                           -- JSON 数组
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE model_cache (
  task          TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  model         TEXT NOT NULL,
  response      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task, prompt_sha256, model)
);

CREATE TABLE model_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT,
  redaction_level TEXT,
  visibility      TEXT,
  cache_hit       INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_cents      REAL,
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

------------------------------------------------------------------ 采集风控

CREATE TABLE platform_access_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL,
  stage       TEXT,
  action      TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_access_platform_day ON platform_access_events(platform, occurred_at);

CREATE TABLE platform_safety_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  locked        INTEGER NOT NULL DEFAULT 0,
  lock_reason   TEXT,
  locked_at     TEXT
);
INSERT INTO platform_safety_state (id, locked) VALUES (1, 0);

------------------------------------------------------------------ 内容寻址存档

CREATE TABLE artifacts (
  sha256     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                  -- resume_pdf | jd | greeting | form | resume_html
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
