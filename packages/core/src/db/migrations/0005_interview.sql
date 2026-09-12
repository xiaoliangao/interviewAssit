-- 面试训练（DESIGN §8）。
--
-- 这两张表存在的理由不是「记录问答」，是**那条反向边**：
-- 某条主张在真实面试里答砸了，账本里它就该降级。
-- 所以每一轮问答都必须能指回一条 claim —— 指不回去的问答只是聊天。
CREATE TABLE interview_sessions (
  id            TEXT PRIMARY KEY,
  -- mock（模拟）| real（真实面试复盘）| drill（日常刷题）
  kind          TEXT NOT NULL,
  job_id        TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  -- 复盘真实面试时关联录音
  recording_id  TEXT REFERENCES interview_recordings(id) ON DELETE SET NULL,
  label         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  note          TEXT
);

CREATE TABLE interview_turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  -- 追问指向哪条主张。可空：八股题不挂主张
  claim_id      TEXT REFERENCES claims(id) ON DELETE SET NULL,
  question      TEXT NOT NULL,
  -- 出题依据：哪个 commit / 哪个模块。**没有依据的追问不该被问出来**
  question_basis TEXT,
  answer        TEXT,
  -- solid | shaky | failed | skipped —— 由人自评，不是模型判的。
  -- 模型可以给意见，但「我到底答上来没有」只有你知道
  verdict       TEXT,
  model_feedback TEXT,
  answered_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_turns_session ON interview_turns(session_id, seq);
CREATE INDEX idx_turns_claim ON interview_turns(claim_id);
