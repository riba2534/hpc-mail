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

interface Candidate {
  value: string;
  index: number;
}

interface Range {
  start: number;
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

function insideRange(index: number, ranges: Range[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function withoutUrls(text: string): string {
  URL_REGEX.lastIndex = 0;
  return text.replace(URL_REGEX, ' ');
}

/** 收集候选：4-8 位纯数字，或 6-8 位大写字母数字混合（至少含一位数字与一位字母） */
function collectCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const excluded = urlRanges(text);
  const digit = /(?<![\w])(\d{4,8})(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = digit.exec(text)) !== null) {
    if (insideRange(m.index, excluded)) continue;
    out.push({ value: m[1]!, index: m.index });
  }
  const alnum = /(?<![\w])([A-Z0-9]{6,8})(?![\w])/g;
  while ((m = alnum.exec(text)) !== null) {
    if (insideRange(m.index, excluded)) continue;
    const v = m[1]!;
    if (/\d/.test(v) && /[A-Z]/.test(v)) out.push({ value: v, index: m.index });
  }
  return out;
}

/**
 * 纯正则提码：关键词 ±120 字符内的候选，多候选取距关键词最近者。
 * 导出为纯函数便于单测。
 */
export function extractCodeByRegex(subject: string, body: string): string {
  const corpus = `${subject || ''}\n${body || ''}`;
  const excluded = urlRanges(corpus);
  const keywordPositions: number[] = [];
  let km: RegExpExecArray | null;
  KEYWORD_REGEX.lastIndex = 0;
  while ((km = KEYWORD_REGEX.exec(corpus)) !== null) {
    if (insideRange(km.index, excluded)) continue;
    keywordPositions.push(km.index);
  }
  if (keywordPositions.length === 0) return '';

  const candidates = collectCandidates(corpus);
  let best: { value: string; distance: number } | null = null;
  for (const cand of candidates) {
    let minDist = Infinity;
    for (const kp of keywordPositions) {
      const dist = Math.abs(cand.index - kp);
      if (dist < minDist) minDist = dist;
    }
    if (minDist <= NEIGHBORHOOD && (best === null || minDist < best.distance)) {
      best = { value: cand.value, distance: minDist };
    }
  }
  return best ? best.value : '';
}

/**
 * 读取历史数据时重新校验已存验证码：新规则能提取时以新结果为准；明确的 link-only
 * 邮件则清掉旧版误识别值。其他邮件保留 AI/旧规则结果，避免破坏无法被正则覆盖的真验证码。
 */
export function resolveVerificationCode(subject: string, body: string, storedCode: string): string {
  const corpus = `${subject || ''}\n${body || ''}`;
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
      env.ai_model || '@cf/meta/llama-3.1-8b-instruct',
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
    if (!/^(?:\d{4,8}|(?=[A-Z0-9]{6,8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6,8})$/.test(json.code)) return '';
    // 回验：AI 返回的码必须在模型所见的原文（主题 + 正文）中真实出现，
    // 否则丢弃——邮件正文是攻击者可控输入，防止 prompt injection / 幻觉写入验证码字段
    if (json.code && !withoutUrls(`${subject}\n${body}`).toLowerCase().includes(json.code.toLowerCase())) {
      return '';
    }
    return json.code;
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}
