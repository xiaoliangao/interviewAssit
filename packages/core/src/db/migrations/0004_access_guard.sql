-- 平台访问闸门（DESIGN §4.4）。
--
-- 0001 里的 platform_safety_state 是**单行全局锁**。改成按平台。
--
-- 理由：BOSS 把你限流了，说明不了 51job 的任何事。一个「BOSS 一响、所有平台全停」
-- 的锁，用两天就会被人关掉 —— 而一个被关掉的安全闸门等于没有。
-- 全局仍然保留，用 platform='*' 那一行表示：有些信号（比如整个网络被标记）
-- 确实是跨平台的，那时候就该全停。
DROP TABLE platform_safety_state;

CREATE TABLE platform_safety_state (
  -- '*' 表示全局
  platform     TEXT PRIMARY KEY,
  locked       INTEGER NOT NULL DEFAULT 0,
  lock_reason  TEXT,
  -- code_37 / captcha / login_wall / rate_limited / unknown_page / manual
  lock_kind    TEXT,
  locked_at    TEXT,
  -- 到这个时间自动解锁。NULL = 只能手动解 —— 风控命中默认就是手动解，
  -- 「等一小时自动重试」正是最该避免的行为
  unlock_after TEXT,
  hits         INTEGER NOT NULL DEFAULT 0
);
INSERT INTO platform_safety_state (platform, locked) VALUES ('*', 0);

-- 逐次记账。**记账发生在开页之前**，不是之后 ——
-- 崩在半路的那次也必须算进预算里，否则「崩溃-重试」循环能绕开整个预算。
ALTER TABLE platform_access_events ADD COLUMN outcome TEXT;
ALTER TABLE platform_access_events ADD COLUMN detail TEXT;

CREATE INDEX idx_access_events_day ON platform_access_events(platform, occurred_at);
