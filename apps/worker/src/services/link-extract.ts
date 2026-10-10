import { htmlToText } from '../lib/text.js';

/**
 * 验证/登录链接提取（纯函数，收件时调用一次，结果落 messages.verification_link）。
 *
 * 宁缺毋滥：先判定整封邮件确有验证/登录意图，再给候选链接打分，过阈值才输出。
 * 候选来自 HTML `<a href>`（结合按钮文字）与正文里的裸 URL；只收 http/https，
 * 退订/隐私/帮助/设置类链接、图片等静态资源、追踪像素、IP 主机与带凭据的 URL 一律排除。
 */

/** 输出上限：超长 URL 多为追踪参数堆叠 */
export const MAX_VERIFICATION_LINK_LENGTH = 2048;
/** 验证按钮总在邮件前部，超长营销邮件只扫前 200KB */
const SCAN_CHARS = 200 * 1024;
/** 意图判定只看正文前 20K 字符 */
const INTENT_SCAN_CHARS = 20_000;
const MAX_ANCHORS = 200;
/** 链接前多少字符内的意图短语算「邻近」 */
const NEAR_BEFORE = 120;
const FAR_BEFORE = 300;
const NEAR_AFTER = 40;
const FAR_AFTER = 80;
/** 文本 URL 同一行前多少字符视作它的标签（如 `Verify email: https://…`） */
const TEXT_LABEL_CHARS = 60;
const ACCEPT_SCORE = 5;

/** 按钮/链接文字里的动作词：按钮文字很短，单个动词即可表明意图。验证码/登录码不算链接动作 */
const ACTION_SOURCE =
  "\\b(?:verif(?:y|ication)(?!\\s*code)|confirm|activat(?:e|ion)|magic[\\s-]?link|sign[\\s-]?in(?!\\s*code)|log[\\s-]?in(?!\\s*code)|reset\\s+(?:your\\s+|my\\s+)?password|password\\s+reset)\\b|验证(?!码)|确认(?!码)|激活|登录(?!码)|登入|重置密码";
const ACTION = new RegExp(ACTION_SOURCE, 'i');

/** 正文里的强意图短语：动词必须带对象（confirm your email），避免订单「已确认」一类误判 */
const OBJECT = "(?:(?:your|this|the|my)\\s+(?:[\\w-]+\\s+)?|new\\s+)?(?:e-?mail|account|address|identity|sign[\\s-]?up|registration|subscription)";
const INTENT_SOURCE = [
  `\\bverify\\s+${OBJECT}`,
  '\\b(?:e-?mail|account)\\s+verification\\b(?!\\s*code)',
  '\\bverification\\s+(?:link|e-?mail)\\b',
  `\\bconfirm\\s+${OBJECT}`,
  '\\bconfirmation\\s+link\\b',
  `\\bactivate\\s+${OBJECT}`,
  '\\bactivation\\s+link\\b',
  '\\bmagic[\\s-]?link\\b',
  '\\b(?:sign|log)[\\s-]?in\\s+link\\b',
  '\\b(?:link|button)\\s+(?:below\\s+)?to\\s+(?:verify|confirm|activate|sign[\\s-]?in|log[\\s-]?in)\\b',
  '\\bone[\\s-]?time\\s+(?:sign|log)[\\s-]?in\\b',
  "\\b(?:verify|confirm)\\s+(?:that\\s+)?it'?s\\s+you\\b",
  '\\breset\\s+(?:your\\s+|my\\s+)?password\\b',
  '\\bpassword\\s+reset\\b',
  '验证(?:您|你)?的?(?:邮箱|邮件|电子邮件|账号|帐号|账户|身份|地址)',
  '(?:邮箱|账号|帐号|账户|身份)验证(?!码)',
  '(?:验证|确认|激活|登录|登入)链接',
  '激活(?:您|你)?的?(?:账号|帐号|账户|邮箱)',
  '(?:账号|帐号|账户)激活',
  '确认(?:您|你)?的?(?:邮箱|邮件|注册|订阅|账号|帐号|账户|身份)',
  '(?:点击|访问|打开)[^。\\n]{0,20}(?:链接|按钮)[^。\\n]{0,20}(?:验证|确认|激活|登录|登入)',
  '重置(?:您|你)?的?密码',
  '找回密码',
  '密码重置',
].join('|');
const INTENT = new RegExp(INTENT_SOURCE, 'i');

/** URL 路径/查询中的验证特征（不看主机名，避免 login.example.com 首页误判） */
const URL_KEYWORD = /verif|confirm|activat|magic|log-?in|sign-?in|auth|token|reset/i;
/** 长随机段：验证链接几乎都带一次性 token */
const TOKEN_SEGMENT = /[A-Za-z0-9_%=-]{20,}/;

/** 按钮文字里的非验证用途 */
const NEGATIVE_LABEL =
  /unsubscribe|opt[\s-]?out|preferences?|privacy|\bterms\b|\bhelp\b|support|contact|\bfaq\b|feedback|settings|view\s+(?:it\s+|this\s+(?:e-?mail|message)\s+)?(?:in\s+(?:your\s+|a\s+)?browser|online|as\s+a\s+web\s*page)|退订|取消订阅|隐私|条款|帮助|客服|联系我们|浏览器中查看|网页版|设置/i;
/** 路径分段里的非验证用途 */
const NEGATIVE_SEGMENTS = new Set([
  'unsubscribe', 'optout', 'opt-out', 'preferences', 'preference', 'privacy', 'terms', 'tos', 'help',
  'support', 'contact', 'faq', 'feedback', 'legal', 'policy', 'policies', 'settings', 'subscriptions',
]);
const NEGATIVE_HOST_LABELS = new Set(['help', 'support', 'unsubscribe', 'privacy']);
/** 静态资源：图片、样式、脚本、字体、音视频 */
const RESOURCE_PATH = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|tiff?|css|js|mjs|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg)$/i;
/** 打开追踪像素 */
const TRACKING_PIXEL_PATH = /(?:^|\/)(?:pixel|beacon)(?:\.\w+)?(?:\/|$)|\/(?:wf|track(?:ing)?|t)\/open\b|\/open\.(?:gif|png)$/i;

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const LABEL_ATTR = /\b(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** 文本 URL：遇到空白、引号、尖括号、中日文标点/汉字即止 */
const TEXT_URL = /https?:\/\/[^\s<>"'`\u0001-\u0003\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gi;
const MARKER = /\u0001(\d+)\u0002([^\u0003]*)\u0003/g;
const ANY_MARKER = /\u0001\d+\u0002|\u0003/g;

export interface LinkExtractInput {
  subject?: string;
  text?: string;
  html?: string;
  fromAddress?: string;
}

interface Occurrence {
  raw: string;
  label: string;
  /** 标签来自 HTML 按钮（更可信）还是文本 URL 前的同行文字 */
  labelKind: 'anchor' | 'text';
  before: string;
  after: string;
  order: number;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => safeChar(Number.parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function collapse(value: string): string {
  return value.replace(ANY_MARKER, ' ').replace(/\s+/g, ' ').trim();
}

function anchorLabel(attrs: string, inner: string): string {
  const parts = [htmlToText(inner)];
  for (const source of [attrs, inner]) {
    LABEL_ATTR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LABEL_ATTR.exec(source)) !== null) parts.push(decodeEntities(m[1] ?? m[2] ?? ''));
  }
  return collapse(parts.join(' ')).slice(0, 200);
}

/** HTML：把每个锚点替换成带编号的标记再整体转文本，一次得到每个链接的前后文 */
function htmlOccurrences(html: string, out: Occurrence[]): string {
  const source = html.slice(0, SCAN_CHARS).replace(/[\u0001-\u0003]/g, '');
  const anchors: { href: string; label: string }[] = [];
  const marked = source.replace(ANCHOR, (whole, attrs: string, inner: string) => {
    const href = HREF.exec(attrs);
    if (!href || anchors.length >= MAX_ANCHORS) return whole;
    anchors.push({ href: decodeEntities(href[1] ?? href[2] ?? href[3] ?? ''), label: anchorLabel(attrs, inner) });
    return ` \u0001${anchors.length - 1}\u0002${inner}\u0003 `;
  });
  const text = htmlToText(marked);
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text)) !== null) {
    const anchor = anchors[Number(m[1])];
    if (!anchor) continue;
    const end = m.index + m[0].length;
    out.push({
      raw: anchor.href,
      label: anchor.label,
      labelKind: 'anchor',
      before: collapse(text.slice(Math.max(0, m.index - FAR_BEFORE * 2), m.index)).slice(-FAR_BEFORE),
      after: collapse(text.slice(end, end + FAR_AFTER * 2)).slice(0, FAR_AFTER),
      order: out.length,
    });
  }
  return collapse(text.replace(MARKER, ' $2 '));
}

function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"*>\]}]+$/, '');
  // 只剥掉不配对的右括号（Markdown `[文字](url)` 或句末括号），保留 URL 自带的成对括号
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,;:!?'"*>\]}]+$/, '');
  }
  return url;
}

function textOccurrences(text: string, out: Occurrence[]): void {
  const source = text.slice(0, SCAN_CHARS);
  TEXT_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEXT_URL.exec(source)) !== null && out.length < MAX_ANCHORS * 2) {
    const raw = trimUrl(m[0]);
    const start = m.index;
    const end = start + raw.length;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    out.push({
      raw,
      label: collapse(source.slice(Math.max(lineStart, start - TEXT_LABEL_CHARS), start)),
      labelKind: 'text',
      before: collapse(source.slice(Math.max(0, start - FAR_BEFORE * 2), start)).slice(-FAR_BEFORE),
      after: collapse(source.slice(end, end + FAR_AFTER * 2)).slice(0, FAR_AFTER),
      order: out.length,
    });
  }
}

/** 规范化并过滤；不合格返回 null */
function acceptUrl(raw: string): URL | null {
  const cleaned = raw.replace(/[\t\n\r]/g, '').trim();
  if (!/^https?:\/\//i.test(cleaned)) return null;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  if (url.href.length > MAX_VERIFICATION_LINK_LENGTH) return null;
  const path = decodeSafe(url.pathname).toLowerCase();
  if (RESOURCE_PATH.test(path) || TRACKING_PIXEL_PATH.test(path)) return null;
  if (/unsubscribe|opt-?out/i.test(decodeSafe(url.href))) return null;
  if (path.split(/[/._-]+/).some((segment) => NEGATIVE_SEGMENTS.has(segment))) return null;
  if (NEGATIVE_HOST_LABELS.has(host.split('.')[0]!)) return null;
  return url;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 意图短语与链接的距离得分：前文看短语结束处，后文看短语开始处 */
function proximityScore(before: string, after: string): number {
  let best = 0;
  const pattern = new RegExp(INTENT_SOURCE, 'gi');
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(before)) !== null) {
    const gap = before.length - (m.index + m[0].length);
    best = Math.max(best, gap <= NEAR_BEFORE ? 4 : 2);
  }
  pattern.lastIndex = 0;
  const following = pattern.exec(after);
  if (following) best = Math.max(best, following.index <= NEAR_AFTER ? 4 : 2);
  return best;
}

function senderDomain(fromAddress: string | undefined): string {
  const domain = (fromAddress ?? '').split('@')[1]?.toLowerCase() ?? '';
  return domain.split('.').slice(-2).join('.');
}

function score(occurrence: Occurrence, url: URL, sender: string): number {
  if (NEGATIVE_LABEL.test(occurrence.label)) return 0;
  let total = 0;
  if (ACTION.test(occurrence.label)) total += occurrence.labelKind === 'anchor' ? 6 : 5;
  total += proximityScore(occurrence.before, occurrence.after);
  const pathAndQuery = decodeSafe(url.pathname + url.search);
  if (URL_KEYWORD.test(pathAndQuery)) total += 3;
  if (TOKEN_SEGMENT.test(url.pathname + url.search)) total += 1;
  const host = url.hostname.toLowerCase();
  if (sender.includes('.') && (host === sender || host.endsWith(`.${sender}`))) total += 1;
  return total;
}

/**
 * 从入站邮件中识别最可能的验证/登录链接；没有可信候选返回空串。
 * 整封邮件须先具备验证意图（主题含动作词，或正文含强意图短语），营销邮件导航栏的「登录」不会入选。
 */
export function extractVerificationLink(input: LinkExtractInput): string {
  const subject = input.subject ?? '';
  const text = input.text ?? '';
  const html = input.html ?? '';
  const occurrences: Occurrence[] = [];
  const htmlText = html ? htmlOccurrences(html, occurrences) : '';
  textOccurrences(text || htmlText, occurrences);
  if (occurrences.length === 0) return '';

  const body = (text || htmlText).slice(0, INTENT_SCAN_CHARS);
  if (!ACTION.test(subject) && !INTENT.test(subject) && !INTENT.test(body)) return '';

  const sender = senderDomain(input.fromAddress);
  let best: { href: string; score: number; order: number } | null = null;
  for (const occurrence of occurrences) {
    const url = acceptUrl(occurrence.raw);
    if (!url) continue;
    const value = score(occurrence, url, sender);
    if (value < ACCEPT_SCORE) continue;
    if (!best || value > best.score || (value === best.score && occurrence.order < best.order)) {
      best = { href: url.href, score: value, order: occurrence.order };
    }
  }
  return best?.href ?? '';
}
