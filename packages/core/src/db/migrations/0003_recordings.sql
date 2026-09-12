-- 面试录音（DESIGN §8.5 / §13.3）。
--
-- 三个字段是这张表存在的理由，不是装饰：
--
-- 1. consent_confirmed_at —— 知情同意**逐场确认**，不是一个记得住的全局开关。
--    对方每场都不一样，上一场同意了不代表这一场。没有这个时间戳就不允许开录。
-- 2. purge_after —— 录音默认过期自动删。面试录音是这个系统里最敏感的数据，
--    默认永久保留是错的；要留得手动标 keep。
-- 3. sha256 —— 录完才有，因为内容寻址要整份内容。录制期间文件在 staging，
--    停止时才入库。所以这一列可空，可空本身就表达了「这份还在录 / 录崩了」。
CREATE TABLE interview_recordings (
  id                  TEXT PRIMARY KEY,
  -- 关联到哪个岗位。可空：面试完才想起来录的、或者练习录音，都合法
  job_id              TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  label               TEXT NOT NULL,
  -- recording | stopped | failed。recording 状态的行在下次启动时要被收拾
  status              TEXT NOT NULL DEFAULT 'recording',
  -- system | microphone | mixed，记下实际拿到的音源（请求的和拿到的可能不同）
  sources             TEXT NOT NULL DEFAULT '',
  consent_confirmed_at TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  stopped_at          TEXT,
  duration_sec        REAL NOT NULL DEFAULT 0,
  bytes               INTEGER NOT NULL DEFAULT 0,
  sample_rate         INTEGER NOT NULL,
  sha256              TEXT,
  -- staging 期间的绝对路径；入库后指向 artifacts 里那份
  file                TEXT,
  purge_after         TEXT,
  -- 手动标记「这份要留着」，清理时跳过
  keep                INTEGER NOT NULL DEFAULT 0,
  transcript_sha256   TEXT,
  note                TEXT,
  error               TEXT
);

CREATE INDEX idx_recordings_job ON interview_recordings(job_id);
CREATE INDEX idx_recordings_started ON interview_recordings(started_at DESC);
