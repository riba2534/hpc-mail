/**
 * 零宽、软连字符、方向控制等不可见字符：渲染时不占位，却常被反爬插在验证码中间，
 * 换成空格会把码切成两段（`913472` → `91347 2`，提码只剩 5 位），只能直接去掉。
 */
const ZERO_WIDTH = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF\\u00AD\\u034F]",
  "g",
);

/** 不间断空格 / 全角空格渲染时真的占位，折叠为普通空格 */
const WIDE_SPACE = new RegExp("[\\u00A0\\u3000]", "g");

/**
 * 去掉不可见字符。text/plain 正文不经过 {@link htmlToText}，提码前要自己归一化，
 * 否则 6 位码被零宽空格分开后只会命中前 5 位。
 */
export function stripInvisible(text: string): string {
  return text.replace(ZERO_WIDTH, '');
}

/**
 * 行内文字格式标签不产生空白：验证码常被它们从中间切开
 * （`<b>913</b>472`、`9134<font>72</font>`、`<wbr>`），按空格剥离同样只剩一截。
 * 其余标签（含 td/table 这类结构标签）仍按空格处理，避免把相邻单元格粘成一个词。
 */
const INLINE_TAG =
  /<\/?(?:b|bdi|bdo|big|code|del|em|font|i|ins|kbd|mark|nobr|s|samp|small|span|strike|strong|sub|sup|tt|u|var|wbr)(?:\s[^>]*)?\/?>/gi;

/** 数字 / 十六进制实体：反爬常用 `&#8203;`（零宽空格）之类把验证码拆开 */
const NUMERIC_ENTITY = /&#x([0-9a-f]+);|&#(\d+);/gi;

/** 解码成字母数字的零宽命名实体，与 {@link ZERO_WIDTH} 同样直接去掉 */
const ZERO_WIDTH_ENTITY = /&(?:zwnj|zwj|shy|lrm|rlm);/gi;

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * htmlToText 只处理开头这么多字符。收件解析在 SMTP Ack 前同步转换，输入来自任意外部发件人；
 * 下游最多用到提码 16KB、通知 4000 字、验证链接 200KB 原文，512KB 绰绰有余。
 */
export const HTML_TO_TEXT_MAX_CHARS = 512 * 1024;

/** 标签内带引号的属性值超过这么长时整段清空（内嵌图片、巨型 style 等） */
const LONG_ATTRIBUTE_CHARS = 4096;
/** data: URI 的载荷超过这么长时去掉 */
const LONG_DATA_URI_CHARS = 1024;

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWordChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 95;
/** data: 载荷的终止字符：空白、引号、尖括号、CSS url() 的右括号 */
const endsDataUri = (c: number) => isSpace(c) || c === 34 || c === 39 || c === 60 || c === 62 || c === 41;

/**
 * 截断前要去掉的大块内容（返回按位置排序的 [start, end) 区间）：它们不产生文字，却会占满截断额度、把后面的正文
 * （验证码）挤出去。标签内超长的带引号属性值清空；标签内外超长的 data: URI（含 CSS url() 里的）去掉载荷。
 * 正文里的 `="` 不是属性值；引号里出现 `<` 说明引号没闭合、吞进了后面的正文，同样不当属性值。
 * 手写扫描，每个字符只看常数次：在未截断的全量输入上用正则量词会回溯栈溢出（约 600 万字符抛 RangeError）。
 * 前面保留的字符已超过上限时提前结束，后面的内容不会进入转换。
 */
function bulkyRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const n = html.length;
  let removed = 0;
  const drop = (start: number, end: number) => {
    ranges.push([start, end]);
    removed += end - start;
  };
  // 下一个 `<` 与下一个 data: 的位置缓存：查询位置只增不减，越过缓存才重新查找，整体线性
  let nextLt = -1;
  const findLt = (from: number) => {
    if (nextLt < from) {
      const at = html.indexOf('<', from);
      nextLt = at < 0 ? Infinity : at;
    }
    return nextLt;
  };
  const dataPattern = /data:/gi;
  let nextData = -1;
  const findData = (from: number) => {
    if (nextData < from) {
      dataPattern.lastIndex = from;
      nextData = dataPattern.exec(html)?.index ?? Infinity;
    }
    return nextData;
  };
  const dropDataUris = (from: number, to: number) => {
    for (let at = findData(from); at < to; at = findData(at)) {
      let end = at + 5;
      if (at === 0 || !isWordChar(html.charCodeAt(at - 1))) {
        while (end < to && !endsDataUri(html.charCodeAt(end))) end++;
        if (end - (at + 5) >= LONG_DATA_URI_CHARS) drop(at + 5, end);
      }
      // 载荷里再出现的 data: 终止于同一处、只会更短，直接跳到载荷末尾
      at = end;
    }
  };
  /** 从 `<` 开始扫一个标签，返回标签之后的位置；不像标签的 `<` 按正文处理 */
  const scanTag = (start: number): number => {
    const next = html.charCodeAt(start + 1);
    if (!isLetter(next) && next !== 47 && next !== 33 && next !== 63) return start + 1;
    let j = start + 1;
    while (j < n) {
      const c = html.charCodeAt(j);
      if (c === 62) return j + 1;
      if (c !== 61) {
        j++;
        continue;
      }
      let k = j + 1;
      while (k < n && isSpace(html.charCodeAt(k))) k++;
      const quote = html.charCodeAt(k);
      if (quote === 34 || quote === 39) {
        const close = html.indexOf(quote === 34 ? '"' : "'", k + 1);
        const end = close < 0 ? n : close;
        if (findLt(k + 1) < end) {
          j = k + 1;
          continue;
        }
        if (end - (k + 1) >= LONG_ATTRIBUTE_CHARS) drop(k + 1, end);
        else dropDataUris(k + 1, end);
        j = end + 1;
      } else {
        let end = k;
        while (end < n && !isSpace(html.charCodeAt(end)) && html.charCodeAt(end) !== 62) end++;
        dropDataUris(k, end);
        j = end;
      }
    }
    return n;
  };
  for (let i = 0; i < n && i - removed <= HTML_TO_TEXT_MAX_CHARS;) {
    const lt = findLt(i);
    dropDataUris(i, Math.min(lt, n));
    if (lt >= n) break;
    i = scanTag(lt);
  }
  return ranges;
}

/** 去掉大块内容后的开头部分；truncated 表示剩下的仍超过上限 */
function compactHtml(html: string): { source: string; truncated: boolean } {
  const parts: string[] = [];
  let kept = 0;
  let pos = 0;
  for (const [start, end] of [...bulkyRanges(html), [html.length, html.length]] as Array<[number, number]>) {
    const take = Math.min(start - pos, HTML_TO_TEXT_MAX_CHARS + 1 - kept);
    parts.push(html.slice(pos, pos + take));
    kept += take;
    if (kept > HTML_TO_TEXT_MAX_CHARS) break;
    pos = end;
  }
  const source = parts.join('').slice(0, HTML_TO_TEXT_MAX_CHARS);
  if (kept <= HTML_TO_TEXT_MAX_CHARS) return { source, truncated: false };
  // 截断点落在标签中间时丢掉这段残缺的标签，不把属性当正文
  const open = source.lastIndexOf('<');
  return { source: open > source.lastIndexOf('>') ? source.slice(0, open) : source, truncated: true };
}

/** 截断或实体解码留下的孤立代理字符 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 只处理最后一个 `>` 之前的部分：之后不可能有完整标签，`<[^>]+>` 这类正则在没有 `>` 的长串上
 * 会对每个 `<` 都扫到结尾，退化成平方耗时（64KB 的 `<a <a …` 约 0.7 秒，256KB 约 12 秒）。
 * 前一步替换可能删掉末尾的 `>`，所以每一步都重新切分。
 */
function withinMarkup(source: string, transform: (markup: string) => string): string {
  const end = source.lastIndexOf('>') + 1;
  return transform(source.slice(0, end)) + source.slice(end);
}

/**
 * 剥离 script/style/head/template 这类内容不算正文的元素（开闭标签之间整段丢弃），线性实现。
 * 等价的单条正则 `<(…)[^>]*>[\s\S]*?<\/\1\s*>` 遇到没有闭标签的开标签会从每个开标签扫到结尾，重复的 `<style>` 即可平方退化；
 * 这里某种标签找不到闭标签后，之后同名的开标签也不可能再闭合，直接跳过。
 */
function stripRawBlocks(source: string): string {
  const unclosed = new Set<string>();
  const open = /<(script|style|head|template)\b[^>]*>/gi;
  let out = '';
  let kept = 0;
  for (let match = open.exec(source); match; match = open.exec(source)) {
    const name = match[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, 'gi');
    close.lastIndex = open.lastIndex;
    const closed = close.exec(source);
    if (!closed) {
      unclosed.add(name);
      continue;
    }
    out += `${source.slice(kept, match.index)} `;
    kept = open.lastIndex = closed.index + closed[0].length;
  }
  return out + source.slice(kept);
}

/** htmlToText 依次执行的标签处理，每一步都经 withinMarkup 重新切分 */
const MARKUP_STEPS: Array<(markup: string) => string> = [
  stripRawBlocks,
  (markup) => markup.replace(/<br\s*\/?>/gi, '\n'),
  (markup) => markup.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n'),
  (markup) => markup.replace(INLINE_TAG, ''),
  (markup) => markup.replace(/<[^>]+>/g, ' '),
];

/** HTML 转换出的纯文本；truncated 表示去掉大块内容后仍超过上限，只转换了开头 */
export interface HtmlText {
  text: string;
  truncated: boolean;
}

/** 无依赖的 HTML → 纯文本（收件解析与摘要用，禁止引入 linkedom 等重依赖） */
export function convertHtmlToText(html: string | undefined | null): HtmlText {
  const { source, truncated } = compactHtml(String(html || ''));
  const text = MARKUP_STEPS.reduce((markup, step) => withinMarkup(markup, step), source)
    .replace(/&nbsp;/gi, ' ')
    .replace(ZERO_WIDTH_ENTITY, '')
    // 数字实体先于 &amp; 解码，避免把 `&amp;#8203;` 这种字面量当成零宽空格
    .replace(NUMERIC_ENTITY, (_m, hex: string | undefined, dec: string | undefined) =>
      safeChar(hex === undefined ? Number.parseInt(dec ?? '', 10) : Number.parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(ZERO_WIDTH, '')
    .replace(WIDE_SPACE, ' ')
    .replace(LONE_SURROGATE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, truncated };
}

export function htmlToText(html: string | undefined | null): string {
  return convertHtmlToText(html).text;
}

function previewOf(source: string, limit: number): string {
  // 纯文本正文里的零宽字符同样会切断验证码：摘要是列表接口重新校验提码的输入
  return source.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 摘要默认长度。列表接口拿摘要重新校验提码，取到这个长度就说明正文被截断过，
 * 末尾的候选可能已经少了几位，见 code-extract 的 bodyTruncated。
 */
export const PREVIEW_LIMIT = 160;

/** 正文纯文本摘要：优先纯文本，回落 html→text，截断到 limit 字符 */
export function makePreview(
  text: string | undefined | null,
  html: string | undefined | null,
  limit = PREVIEW_LIMIT,
): string {
  return previewOf((text && text.trim()) || htmlToText(html), limit);
}

/** 同一封信的正文文本视图，见 {@link mailText} */
export interface MailText {
  /** 纯文本优先、缺失时回落 HTML 转换结果（提码、AI 兜底、通知与转发正文的口径） */
  readonly plain: string;
  /** plain 来自 HTML 转换且超长只转换了开头 */
  readonly plainTruncated: boolean;
  /** HTML 转出的纯文本（与 plain 共用同一次转换） */
  readonly htmlText: string;
  /** 与 makePreview 相同的摘要 */
  preview(limit?: number): string;
}

/**
 * HTML → 纯文本惰性转换且最多一次：大 HTML 整段转换是收件链路最重的 CPU，
 * 提码、预览、AI 兜底、通知与中转转发共用这一份结果。
 */
export function mailText(text: string, html: string): MailText {
  let converted: HtmlText | undefined;
  const htmlText = () => (converted ??= convertHtmlToText(html));
  return {
    get plain() { return text || htmlText().text; },
    get plainTruncated() { return !text && htmlText().truncated; },
    get htmlText() { return htmlText().text; },
    preview: (limit = PREVIEW_LIMIT) => previewOf((text && text.trim()) || htmlText().text, limit),
  };
}
