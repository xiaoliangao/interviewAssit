-- 采集源健康度。
--
-- 「某个平台今天失效了」是常态，不是意外。把它当正常状态设计：
-- 单源失败不影响其他源、连续失败次数要能一眼看到、
-- 页面结构不认识就停下来报警而不是硬猜。
--
-- 这张表放在岗位池面板里展示，不藏进设置页 —— 它是运营数据不是配置。
CREATE TABLE collector_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id      TEXT NOT NULL,
  platform       TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  ok             INTEGER NOT NULL DEFAULT 0,
  fetched        INTEGER NOT NULL DEFAULT 0,
  ingested       INTEGER NOT NULL DEFAULT 0,
  new_jobs       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  duration_ms    INTEGER
);
CREATE INDEX idx_collector_runs_source ON collector_runs(source_id, started_at DESC);
