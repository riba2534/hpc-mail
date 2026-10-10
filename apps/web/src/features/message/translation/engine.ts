import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { MessageTranslation, TranslateMessageRequest } from '@hpc-mail/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import type { MailView } from '@/features/inbox/mail-view';

// 本模块只依赖入口 chunk 已有的模块：与详情页共用的模块（语言判定、引用拆分）由调用方传入，
// 否则打包器会为它们单独拆出一个公共 chunk，详情页首屏多一个请求。

/** 判定片段是否需要翻译（见 detect.ts 的 isTranslatableSegment） */
export type SegmentFilter = (segment: string) => boolean;

/**
 * 与 @hpc-mail/shared 的 MAX_TRANSLATE_SEGMENTS / _SEGMENT_CHARS / _BATCH_CHARS 一致（engine.test.ts 校验）。
 * 本地定义是为了不把 shared 的 zod 运行时拉进翻译 chunk。
 */
export const TRANSLATE_LIMITS = { segments: 60, segmentChars: 2000, batchChars: 6000 } as const;
const CONCURRENCY = 3;
/** 单批最多 6000 字符交给模型，比普通接口的 30 秒默认超时宽松 */
const REQUEST_TIMEOUT_MS = 90_000;

// ---- 切段 ----

/** 一段原文的无损切分：raw 依次拼接即原文；key 是 trim 后的片段（纯空白没有 key），也是译文映射的键 */
export interface TextPiece {
  raw: string;
  key?: string;
}

/** 句末（含其后的引号、括号与空白）或换行：超长文本只在这些位置切开 */
const SENTENCE_END = /[.!?;]+["'”’)\]]*\s+|[。！？；…]+["'”’」』)\]]*\s*|\n+/g;
/** 空行分段；捕获分隔符，split 后奇数位是分隔符 */
const PARAGRAPH_BREAK = /(\n[ \t]*\n\s*)/;

/** 从 start 起不超过 limit 的切点：优先句末，其次空白，都没有时硬切（不切开代理对） */
function cutPoint(text: string, start: number, limit: number): number {
  const boundary = new RegExp(SENTENCE_END.source, 'g');
  boundary.lastIndex = start;
  let cut = -1;
  for (let match = boundary.exec(text); match && match.index + match[0].length <= limit; match = boundary.exec(text)) {
    cut = match.index + match[0].length;
  }
  if (cut > start) return cut;
  const space = Math.max(text.lastIndexOf(' ', limit - 1), text.lastIndexOf('\t', limit - 1));
  if (space > start) return space + 1;
  return /[\uDC00-\uDFFF]/.test(text[limit] ?? '') ? limit - 1 : limit;
}

function splitLong(text: string): string[] {
  const max = TRANSLATE_LIMITS.segmentChars;
  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > max) {
    const cut = cutPoint(text, start, start + max);
    chunks.push(text.slice(start, cut));
    start = cut;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/** 单个文字单元（文字节点或段落）→ 片段；超过单段上限时按句子再切 */
export function textPieces(text: string): TextPiece[] {
  return splitLong(text).map((raw) => {
    const key = raw.trim();
    return key ? { raw, key } : { raw };
  });
}

/** 纯文本块 → 片段：先按空行分段，段落过长再按句子切 */
export function plainTextPieces(text: string): TextPiece[] {
  return text.split(PARAGRAPH_BREAK).flatMap((part, index) => (index % 2 === 1 ? [{ raw: part }] : textPieces(part)));
}

/** 用译文替换片段，保留原有首尾空白；没有译文的片段（含未送翻的）保持原文 */
function render(pieces: TextPiece[], translations: ReadonlyMap<string, string>): string {
  return pieces
    .map(({ raw, key }) => {
      const translated = key && translations.get(key);
      if (!key || !translated) return raw;
      const start = raw.indexOf(key);
      return raw.slice(0, start) + translated + raw.slice(start + key.length);
    })
    .join('');
}

/** PlainTextBody 的文字块渲染：切段规则与 collectPlainTextSegments 相同，key 才能对上 */
export function translatePlainText(text: string, translations: ReadonlyMap<string, string>): string {
  return render(plainTextPieces(text), translations);
}

/** 按文档顺序去重并过滤：同一封邮件里相同文本只请求一次 */
function pick(keys: Iterable<string | undefined>, accept: SegmentFilter): string[] {
  return [...new Set(keys)].filter((key): key is string => Boolean(key) && accept(key!));
}

/** 纯文本正文的待译片段。blocks 是 PlainTextBody 渲染的非引用文字块（引用块不翻） */
export function collectPlainTextSegments(blocks: string[], accept: SegmentFilter): string[] {
  return pick(blocks.flatMap((block) => plainTextPieces(block).map((piece) => piece.key)), accept);
}

/** 主题作为第一个片段；正文里与主题相同的片段不重复请求 */
export function withSubject(subject: string, bodySegments: string[], accept: SegmentFilter): string[] {
  const key = subject.trim();
  return key.length <= TRANSLATE_LIMITS.segmentChars && accept(key) ? [key, ...bodySegments.filter((segment) => segment !== key)] : bodySegments;
}

// ---- HTML 文字节点 ----

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP']);

function skipsSubtree(element: Element): boolean {
  return (
    SKIP_TAGS.has(element.tagName.toUpperCase()) ||
    element.getAttribute('translate')?.toLowerCase() === 'no' ||
    element.classList.contains('notranslate') ||
    // 被拦截远程图片的占位框，文字是 alt，不是正文
    element.classList.contains('remote-image-blocked')
  );
}

function eachTextNode(root: Element, visit: (node: Text) => void): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
      return skipsSubtree(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) visit(node as Text);
}

/** 被替换过的文字节点 → 原文。节点随 iframe 文档一起回收 */
const originalTexts = new WeakMap<Text, string>();

/** 邮件 HTML 中的待译片段（以原文为准，已替换的节点取回原文） */
export function collectHtmlSegments(root: Element, accept: SegmentFilter): string[] {
  const keys: (string | undefined)[] = [];
  eachTextNode(root, (node) => {
    for (const piece of textPieces(originalTexts.get(node) ?? node.nodeValue ?? '')) keys.push(piece.key);
  });
  return pick(keys, accept);
}

/** 原位替换文字节点（只写 nodeValue，译文永远是纯文本）。iframe 重新渲染后对新文档再调用一次即可套用 */
export function applyHtmlTranslations(root: Element, translations: ReadonlyMap<string, string>): void {
  eachTextNode(root, (node) => {
    const original = originalTexts.get(node) ?? node.nodeValue ?? '';
    const next = render(textPieces(original), translations);
    if (next === node.nodeValue) return;
    originalTexts.set(node, original);
    node.nodeValue = next;
  });
}

export function restoreHtmlTranslations(root: Element): void {
  eachTextNode(root, (node) => {
    const original = originalTexts.get(node);
    if (original !== undefined && node.nodeValue !== original) node.nodeValue = original;
  });
}

// ---- 分批与请求 ----

/** 按顺序装批：每批不超过片段数与总字符数上限（单个片段已不超过单段上限，必能装下） */
export function planBatches(segments: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const segment of segments) {
    if (current.length >= TRANSLATE_LIMITS.segments || (current.length > 0 && chars + segment.length > TRANSLATE_LIMITS.batchChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += segment.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** cyrb53：同步的 53 位字符串哈希，只用于区分批次内容 */
export function hashSegments(segments: readonly string[]): string {
  const text = `${segments.length}\u0000${segments.join('\u0000')}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 单批译文缓存：挂在 messages 前缀下（邮箱归属变化时随邮件缓存一起清掉），内容不变就不再请求。
 * 请求不放进 api/resources.ts：那里属于入口 chunk，翻译代码只在点击时加载。
 */
export function translationBatchQueryOptions(messageId: number, view: MailView | undefined, segments: string[]) {
  return queryOptions({
    queryKey: [...queryKeys.messages.root, 'translation', messageId, view, hashSegments(segments)] as const,
    queryFn: async ({ signal }) => {
      const result = await api.post<MessageTranslation, TranslateMessageRequest>(
        `/messages/${messageId}/translate`,
        { segments },
        { query: { scope: view?.scope, userId: view?.userId }, signal, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (!Array.isArray(result?.translations) || result.translations.length !== segments.length) {
        throw new ApiError('翻译结果与原文对不上，请重试', { code: 'malformed' });
      }
      return result.translations;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

export function translationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '翻译失败，请重试';
  if (error.httpStatus === 403) return '管理员未启用 AI 翻译';
  if (error.httpStatus === 429) return /额度/.test(error.message) ? '今日翻译额度已用完' : '翻译请求过于频繁，请稍后再试';
  // 网络错误的文案已由 toApiError 统一（「网络连接失败…」）
  if (error.code === 'network' || error.code === 'malformed') return error.message;
  if (error.code === 'timeout') return '翻译超时，请重试';
  return '翻译服务暂时不可用，请稍后重试';
}

/** 未启用、额度用完或被限流：后面的批次也会失败，停止派发 */
const stopsRemaining = (error: unknown) => error instanceof ApiError && (error.httpStatus === 403 || error.httpStatus === 429);

export interface TranslationSnapshot {
  /** 原文片段 → 译文 */
  translations: ReadonlyMap<string, string>;
  total: number;
  done: number;
  failed: number;
  running: boolean;
  error: string | null;
}

export interface TranslationRun {
  /** 只重试失败的批次 */
  retry(): void;
  /** 停止派发剩余批次并不再回调；在途请求照常写入缓存 */
  cancel(): void;
}

/** 收集本封邮件的待译片段（主题在前）并开始翻译；没有可译内容时返回 null */
export function translateMessage(options: {
  queryClient: QueryClient;
  messageId: number;
  view: MailView | undefined;
  subject: string;
  /** HTML 正文的根节点；纯文本邮件为 null，改用 textBlocks */
  root: Element | null;
  /** 纯文本正文的非引用文字块，拆法与 PlainTextBody 相同 */
  textBlocks: string[];
  accept: SegmentFilter;
  onChange: (snapshot: TranslationSnapshot) => void;
}): TranslationRun | null {
  const { root, textBlocks, accept, subject, ...run } = options;
  const body = root ? collectHtmlSegments(root, accept) : collectPlainTextSegments(textBlocks, accept);
  const segments = withSubject(subject, body, accept);
  return segments.length > 0 ? startTranslation({ ...run, segments }) : null;
}

export function startTranslation(options: {
  queryClient: QueryClient;
  messageId: number;
  view: MailView | undefined;
  segments: string[];
  onChange: (snapshot: TranslationSnapshot) => void;
}): TranslationRun {
  const batches = planBatches(options.segments);
  const states = batches.map((): 'pending' | 'done' | 'failed' => 'pending');
  const translations = new Map<string, string>();
  let error: string | null = null;
  let running = false;
  let halted = false;
  let cancelled = false;

  const emit = () => {
    if (cancelled) return;
    options.onChange({
      translations: new Map(translations),
      total: batches.length,
      done: states.filter((state) => state === 'done').length,
      failed: states.filter((state) => state === 'failed').length,
      running,
      error,
    });
  };

  const translateBatch = async (index: number) => {
    const segments = batches[index]!;
    try {
      const result = await options.queryClient.ensureQueryData(
        translationBatchQueryOptions(options.messageId, options.view, segments),
      );
      segments.forEach((segment, i) => {
        const translated = result[i]?.trim();
        if (translated) translations.set(segment, translated);
      });
      states[index] = 'done';
    } catch (err) {
      states[index] = 'failed';
      error = translationErrorMessage(err);
      if (stopsRemaining(err)) halted = true;
    }
    emit();
  };

  const run = async (indices: number[]) => {
    running = true;
    halted = false;
    error = null;
    indices.forEach((index) => (states[index] = 'pending'));
    emit();
    let next = 0;
    const lane = async () => {
      while (next < indices.length && !halted && !cancelled) await translateBatch(indices[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, indices.length) }, lane));
    // 因停止派发而没发出的批次记为失败，重试时一起补
    for (const index of indices) if (states[index] === 'pending') states[index] = 'failed';
    running = false;
    emit();
  };

  void run(batches.map((_, index) => index));
  return {
    retry: () => {
      if (running || cancelled) return;
      const failed = states.flatMap((state, index) => (state === 'failed' ? [index] : []));
      if (failed.length > 0) void run(failed);
    },
    cancel: () => {
      cancelled = true;
    },
  };
}
