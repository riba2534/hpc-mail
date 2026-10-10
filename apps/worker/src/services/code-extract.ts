import { htmlToText } from '../lib/text.js';
import type { Env } from '../types.js';

/** 验证码上下文关键词 */
const KEYWORD_REGEX =
  /(one[-\s]?time\s+(?:password|passcode)|passcode|pass\s?code|security\s?code|otp|access\s?code|login\s?code|authentication\s?code|\bcode\b|\bpin\b|验证码|校验码|动态码|动态密码|确认码|验证代码|口令)/gi;

/** 明确表示“点击链接/按钮完成验证”的文案，不应把 URL token 当作验证码。 */
const LINK_ONLY_REGEX =
  /(?:(?:one[-\s]?time|single[-\s]?use|magic|verification)\s+link|\b(?:click|follow|open|tap)\b[^\n]{0,60}\b(?:link|button)\b|\blink\s+below\b|点击[^\n]{0,30}(?:链接|按钮)|(?:链接|按钮)[^\n]{0,30}(?:验证|继续))/i;

const EXPLICIT_CODE_REGEX =
  /(one[-\s]?time\s+(?:password|passcode)|passcode|pass\s?code|security\s?code|otp|access\s?code|login\s?code|authentication\s?code|\bcode\b|\bpin\b|验证码|校验码|动态码|动态密码|确认码|验证代码|口令)/i;

const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

const NEIGHBORHOOD = 120;

/** 提码只看正文前 16KB：验证码总在开头附近，超长营销邮件不必全文扫描 */
export const CODE_SCAN_BODY_CHARS = 16 * 1024;

/** 已下线模型的替代默认值；实际以 wrangler.toml 的 ai_model 为准 */
export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/**
 * 5 位短码（Steam Guard 一类）只在紧贴关键词时成立：关键词与码之间只允许空白、冒号、
 * 等号、连字符或 is/为/是；或码紧跟在冒号后、冒号前 80 字符内有关键词
 * （如「…code you need to login to account foo:\n\nF7GHT」）。
 */
const SHORT_CODE_GAP = /^[\s:：=\-]*(?:is|为|是)?[\s:：=\-]*$/i;
const SHORT_CODE_COLON_WINDOW = 80;
/** 纯字母的 5 位码只接受 Steam Guard 字母表（无元音及易混字符），普通英文单词几乎都含元音 */
const SHORT_CODE_LETTERS = /^[BCDFGHJKMNPQRTVWXY]{5}$/;

interface Candidate {
  value: string;
  index: number;
}

interface Range {
  start: number;
  end: number;
}

interface KeywordHit {
  index: number;
  end: number;
}

function urlRanges(text: string): Range[] {
  const ranges: Range[] = [];
  URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_REGEX.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/**
 * URL 区间判定游标：区间按起点递增且互不重叠，调用方按位置递增查询，
 * 整体线性（原先每个候选都遍历全部区间，长正文是平方复杂度）。
 */
function rangeCursor(ranges: Range[]): (index: number) => boolean {
  let i = 0;
  return (index) => {
    while (i < ranges.length && ranges[i]!.end <= index) i++;
    return i < ranges.length && ranges[i]!.start <= index;
  };
}

function withoutUrls(text: string): string {
  URL_REGEX.lastIndex = 0;
  return text.replace(URL_REGEX, ' ');
}

function corpusOf(subject: string, body: string): string {
  return `${subject || ''}\n${(body || '').slice(0, CODE_SCAN_BODY_CHARS)}`;
}

/** 有序数组中离 index 最近的关键词距离（二分） */
function nearestKeywordDistance(keywords: KeywordHit[], index: number): number {
  let lo = 0;
  let hi = keywords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keywords[mid]!.index < index) lo = mid + 1;
    else hi = mid;
  }
  let best = Infinity;
  if (lo < keywords.length) best = keywords[lo]!.index - index;
  if (lo > 0) best = Math.min(best, index - keywords[lo - 1]!.index);
  return best;
}

/** 码前面最近的关键词（结束位置不晚于码起点）；无则 null */
function keywordBefore(keywords: KeywordHit[], index: number): KeywordHit | null {
  let lo = 0;
  let hi = keywords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keywords[mid]!.end <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? keywords[lo - 1]! : null;
}

function isShortCodeShape(value: string): boolean {
  if (!/[A-Z]/.test(value)) return false;
  return /\d/.test(value) || SHORT_CODE_LETTERS.test(value);
}

function shortCodeNextToKeyword(text: string, keywords: KeywordHit[], index: number): boolean {
  const before = keywordBefore(keywords, index);
  if (!before) return false;
  if (index - before.end <= 12 && SHORT_CODE_GAP.test(text.slice(before.end, index))) return true;
  const colon = /[:：]\s*$/.exec(text.slice(Math.max(0, index - 16), index));
  if (!colon) return false;
  const colonAt = Math.max(0, index - 16) + colon.index;
  return colonAt - before.end >= 0 && colonAt - before.index <= SHORT_CODE_COLON_WINDOW;
}

/**
 * 收集候选：4-8 位纯数字，6-8 位大写字母数字混合（至少含一位数字与一位字母），
 * 以及紧贴关键词的 5 位大写短码。
 */
function collectCandidates(text: string, excluded: Range[], keywords: KeywordHit[]): Candidate[] {
  const out: Candidate[] = [];
  let inUrl = rangeCursor(excluded);
  const digit = /(?<![\w])(\d{4,8})(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = digit.exec(text)) !== null) {
    if (inUrl(m.index)) continue;
    out.push({ value: m[1]!, index: m.index });
  }
  inUrl = rangeCursor(excluded);
  const alnum = /(?<![\w])([A-Z0-9]{5,8})(?![\w])/g;
  while ((m = alnum.exec(text)) !== null) {
    if (inUrl(m.index)) continue;
    const v = m[1]!;
    if (v.length === 5) {
      if (isShortCodeShape(v) && shortCodeNextToKeyword(text, keywords, m.index)) out.push({ value: v, index: m.index });
    } else if (/\d/.test(v) && /[A-Z]/.test(v)) {
      out.push({ value: v, index: m.index });
    }
  }
  return out;
}

/**
 * 纯正则提码：关键词 ±120 字符内的候选，多候选取距关键词最近者。
 * 只看主题 + 正文前 16KB；URL 区间用单调游标、关键词距离用二分，整体线性。
 * 导出为纯函数便于单测。
 */
export function extractCodeByRegex(subject: string, body: string): string {
  const corpus = corpusOf(subject, body);
  const excluded = urlRanges(corpus);
  const inUrl = rangeCursor(excluded);
  const keywords: KeywordHit[] = [];
  let km: RegExpExecArray | null;
  KEYWORD_REGEX.lastIndex = 0;
  while ((km = KEYWORD_REGEX.exec(corpus)) !== null) {
    if (inUrl(km.index)) continue;
    keywords.push({ index: km.index, end: km.index + km[0].length });
  }
  if (keywords.length === 0) return '';

  let best: { value: string; distance: number } | null = null;
  for (const cand of collectCandidates(corpus, excluded, keywords)) {
    const distance = nearestKeywordDistance(keywords, cand.index);
    if (distance <= NEIGHBORHOOD && (best === null || distance < best.distance)) {
      best = { value: cand.value, distance };
    }
  }
  return best ? best.value : '';
}

/**
 * 读取历史数据时重新校验已存验证码：新规则能提取时以新结果为准；明确的 link-only
 * 邮件则清掉旧版误识别值。其他邮件保留 AI/旧规则结果，避免破坏无法被正则覆盖的真验证码。
 */
export function resolveVerificationCode(subject: string, body: string, storedCode: string): string {
  const corpus = corpusOf(subject, body);
  if (LINK_ONLY_REGEX.test(corpus) && !EXPLICIT_CODE_REGEX.test(withoutUrls(corpus))) return '';
  const extracted = extractCodeByRegex(subject, body);
  if (extracted) return extracted;
  if (!storedCode) return '';
  return storedCode;
}

/** Workers AI 兜底提码：3s 超时，JSON-only，≤8 字符 */
export async function extractCodeByAi(
  env: Env,
  input: { subject: string; text: string; html: string },
): Promise<string> {
  const subject = input.subject || '';
  const body = (input.text || htmlToText(input.html)).slice(0, 6000);
  if (!subject && !body) return '';
  const corpus = `${subject}\n${body}`;
  if (LINK_ONLY_REGEX.test(corpus) && !EXPLICIT_CODE_REGEX.test(withoutUrls(corpus))) return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const result = (await env.ai.run(
      env.ai_model || DEFAULT_AI_MODEL,
      {
        messages: [
          {
            role: 'system',
            content:
              'You extract verification codes from emails. Return only JSON like {"code":"12345678"} or {"code":""}. A magic link, one-time link, verification link, URL path, or URL token is not a verification code. If the email only asks the user to click a link or button and does not explicitly present a code, return {"code":""}. The code must be 8 characters or fewer and must not contain spaces. If the code is longer than 8 characters or contains spaces, return {"code":""}. Do not explain.',
          },
          { role: 'user', content: `Subject: ${subject}\n\n${body}` },
        ],
        temperature: 0,
        max_tokens: 32,
      },
      { signal: controller.signal } as never,
    )) as { response?: string } | string;

    const content = typeof result === 'string' ? result : result?.response || '';
    const match = content.match(/\{[^}]*\}/);
    if (!match) return '';
    const json = JSON.parse(match[0]) as { code?: unknown };
    if (typeof json.code !== 'string') return '';
    if (json.code.length > 8 || /\s/.test(json.code)) return '';
    if (!/^(?:\d{4,8}|(?=[A-Z0-9]{6,8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6,8})$/.test(json.code) &&
      !(json.code.length === 5 && /^[A-Z0-9]{5}$/.test(json.code) && isShortCodeShape(json.code))) return '';
    // 回验：AI 返回的码必须在模型所见的原文（主题 + 正文）中真实出现，
    // 否则丢弃——邮件正文是攻击者可控输入，防止 prompt injection / 幻觉写入验证码字段
    if (json.code && !withoutUrls(`${subject}\n${body}`).toLowerCase().includes(json.code.toLowerCase())) {
      return '';
    }
    return json.code;
  } catch (error) {
    // 只记录错误类型与平台返回的错误信息（如 5028 模型下线），不记邮件内容
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('AI 提码调用失败:', controller.signal.aborted ? '请求超时' : detail.slice(0, 300));
    return '';
  } finally {
    clearTimeout(timeout);
  }
}
