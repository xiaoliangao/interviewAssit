import type { RedactionLevel } from './types.js';

/**
 * 脱敏是一个有测试的函数，不是一句口号（plan §3.2）。
 *
 * 设计里多处写「只发脱敏摘要」，但没定义脱敏产出什么 —— 那样的约定
 * 在第一次赶工时就会失效。这里把它定义成确定性函数，并配一组断言测试。
 */

export interface RedactionReport {
  level: RedactionLevel;
  removed: string[];
  originalChars: number;
  outputChars: number;
}

export interface Redacted {
  text: string;
  report: RedactionReport;
}

/** 无论哪个 level 都会跑的一遍。凭据泄漏和 level 无关。 */
const SECRET_RULES: { name: string; re: RegExp; to: string }[] = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, to: '«AWS_KEY»' },
  { name: 'aws-secret', re: /\b(aws_secret_access_key|aws_secret)\s*[:=]\s*\S+/gi, to: '$1=«SECRET»' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, to: '«GH_TOKEN»' },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, to: '«API_KEY»' },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, to: '«SLACK_TOKEN»' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, to: '«JWT»' },
  {
    name: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: '«PRIVATE_KEY»',
  },
  {
    name: 'connection-string',
    re: /\b(?:jdbc:[a-z0-9]+|mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp|clickhouse)::?\/\/[^\s"'`,)\]]+/gi,
    to: '«CONN_STRING»',
  },
  {
    name: 'internal-ipv4',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/g,
    to: '«INTERNAL_IP»',
  },
  { name: 'internal-host', re: /\b[\w-]+\.(?:internal|intra|corp|local|lan)\b/gi, to: '«INTERNAL_HOST»' },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: '«EMAIL»' },
  { name: 'cn-phone', re: /\b1[3-9]\d{9}\b/g, to: '«PHONE»' },
  {
    name: 'secret-assignment',
    re: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*['"]?[^\s'";,]{4,}/gi,
    to: '$1=«REDACTED»',
  },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{10,}/gi, to: 'Bearer «REDACTED»' },
];

export function scrubSecrets(input: string): { text: string; removed: string[] } {
  let text = input;
  const removed: string[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.re.test(text)) {
      removed.push(rule.name);
      text = text.replace(rule.re, rule.to);
    }
    rule.re.lastIndex = 0;
  }
  return { text, removed };
}

/** 看起来像声明/签名的行。保留这些足以让模型理解结构。 */
const SIGNATURE_RE =
  /^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|@|#\[)?(?:func|function|def|class|interface|type|struct|impl|trait|enum|const|var|let|fn|module|package|import|from|use|namespace|abstract|record)\b/;
const CONTROL_RE = /^\s*(?:if|else|for|while|switch|case|try|catch|finally|return|break|continue|defer|go |select|match|with|yield|throw|raise)\b/;
const COMMENT_RE = /^\s*(?:\/\/|#|\*|\/\*|--)/;

function stripLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.){2,}"/g, '"…"')
    .replace(/'(?:[^'\\]|\\.){2,}'/g, "'…'")
    .replace(/`(?:[^`\\]|\\.){2,}`/g, '`…`')
    .replace(/\bhttps?:\/\/[^\s"'`)]+/g, '«URL»');
}

/**
 * signatures 级：保留函数/类签名、模块路径、控制流骨架、注释里的设计说明；
 * 去掉函数体、字符串常量、配置值、URL、密钥形态的 token。
 *
 * 目的是让模型能问出「这里为什么用分布式锁」，而拿不到可复制的业务实现。
 */
export function redactCode(source: string): { text: string; removed: string[] } {
  // 先清凭据再删行。反过来的话，`const key = "AKIA…"` 这种行会被当成签名保留下来，
  // 字符串打码顺带把密钥抹了 —— 结果是安全的，但审计报告里看不到「这个仓库源码里有 AWS key」。
  // 那条信息本身是有用的。
  const pre = scrubSecrets(source);
  const out: string[] = [];
  let dropped = 0;
  for (const raw of pre.text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const keep = SIGNATURE_RE.test(line) || CONTROL_RE.test(line) || COMMENT_RE.test(line) ||
      /^\s*[})\]]+\s*$/.test(line);
    if (keep) {
      if (dropped > 0) { out.push(`${' '.repeat(4)}… (${dropped} 行实现已省略)`); dropped = 0; }
      out.push(stripLiterals(line));
    } else {
      dropped++;
    }
  }
  if (dropped > 0) out.push(`    … (${dropped} 行实现已省略)`);
  // 再清一次：删行和打码之后可能露出新的拼接形态
  const post = scrubSecrets(out.join('\n'));
  return {
    text: post.text,
    removed: [...new Set(['function-bodies', 'string-literals', ...pre.removed, ...post.removed])],
  };
}

export function redact(payload: string, level: RedactionLevel): Redacted {
  const originalChars = payload.length;
  if (level === 'summary') {
    // summary 级的正文应由本地模型生成后传进来；这里只做兜底清洗，
    // 并且不允许任何代码形态的内容通过。
    const scrub = scrubSecrets(payload);
    const noCode = scrub.text
      .split('\n')
      .filter((l) => !SIGNATURE_RE.test(l) && !/[;{}]\s*$/.test(l))
      .join('\n');
    return {
      text: noCode,
      report: { level, removed: ['code-lines', ...scrub.removed], originalChars, outputChars: noCode.length },
    };
  }
  if (level === 'signatures') {
    const r = redactCode(payload);
    return {
      text: r.text,
      report: { level, removed: r.removed, originalChars, outputChars: r.text.length },
    };
  }
  const scrub = scrubSecrets(payload);
  return {
    text: scrub.text,
    report: { level, removed: scrub.removed, originalChars, outputChars: scrub.text.length },
  };
}
