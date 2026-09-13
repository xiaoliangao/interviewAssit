-- 网申过程中发现「档案里没有这个信息」（DESIGN §5.2 / §7.2）。
--
-- 中文网申表单会问一堆我们 schema 里压根没有的字段：政治面貌、籍贯、
-- 紧急联系人、婚育状况、有无犯罪记录……穷举不完，也不该穷举 ——
-- 那等于假装自己知道所有招聘系统会问什么。
--
-- 正确做法是**让表单来告诉档案缺什么**：填表时遇到一个填不上的字段，
-- 就在这里记一笔，档案页把它显示成「待填写」。下次同一个字段就有值了。
--
-- 这张表是那条反馈边的载体。没有它，你会在第 8 个网申表单上第 8 次
-- 手打「政治面貌：群众」。
CREATE TABLE profile_field_requests (
  -- 归一化后的档案 key。新字段直接进 profile.fields，那是个开放的 record
  key            TEXT PRIMARY KEY,
  -- 网站上写的字段名，原样保留 —— 它是你判断「这问的是什么」的唯一线索
  label          TEXT NOT NULL,
  -- registry / decision / narrative。decision 类永远不预填，只提醒
  field_class    TEXT NOT NULL DEFAULT 'registry',
  first_domain   TEXT,
  last_domain    TEXT,
  -- 被问过几次。问得多的排前面 —— 那是最值得补的
  seen_count     INTEGER NOT NULL DEFAULT 1,
  -- 网站上的 placeholder 或说明文字，帮你想起来该填什么
  example        TEXT,
  -- pending | filled | ignored。ignored 是「这个我不打算填」，
  -- 和「还没填」必须能区分，否则它会永远排在待办里
  status         TEXT NOT NULL DEFAULT 'pending',
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_field_requests_status ON profile_field_requests(status, seen_count DESC);
