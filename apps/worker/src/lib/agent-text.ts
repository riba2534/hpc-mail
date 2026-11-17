import { PROMPT_INJECTION_REASONS, type MessageRisk, type PromptInjectionReason } from '@hpc-mail/shared';
import { stripInvisible } from './text.js';

/**
 * 给 Agent 的收件预处理（详情读取时惰性计算，不在收件链路里做）：去掉引用历史的正文与 prompt injection 风险标签。
 * 输入来自任意外部发件人，可能有 MB 级：只看开头这么多字符，所有正则都是有界量词、按行或在折叠后的文本上匹配。
 */
export const AGENT_TEXT_MAX_CHARS = 64 * 1024;

/** 超过这个长度的行不可能是引用头，不跑正则 */
const MAX_HEADER_LINE = 500;

/** 回复引用头里通常带日期或地址；要求有数字或 @，避免「On the other hand, she wrote:」这类正文 */
const HAS_DATE_OR_ADDRESS = /[0-9@]/;
/** 英文：On <日期>, <发件人> wrote:（Gmail、Thunderbird、Apple Mail） */
const EN_WROTE = /^on\s.{1,400}\swrote:$/i;
/** 中文：在 <日期>，<发件人> 写道： / <发件人> 于 <日期> 写道：（含繁体） */
const ZH_WROTE = /^.{1,400}(?:写道|寫道)\s?[:：]$/;
/** Outlook / Foxmail / QQ 邮箱的原始邮件分隔行 */
const ORIGINAL_SEPARATOR = /^-{2,}\s?(?:original message|original|原始邮件|原始郵件|原邮件)\s?-{2,}$/i;
const UNDERSCORE_RULE = /^_{10,}$/;
const HEADER_FROM = /^\*{0,2}(?:from|发件人|寄件者|發件人)\*{0,2}\s?[:：]/i;
const HEADER_DATE = /^\*{0,2}(?:sent|date|发送时间|时间|日期|寄件日期|發送時間)\*{0,2}\s?[:：]/i;
const HEADER_OTHER = /^\*{0,2}(?:to|subject|cc|收件人|主题|主題|抄送|收件者)\*{0,2}\s?[:：]/i;
/** 转发标记：转发的原信是 Agent 要读的正文，遇到它就不再找引用头 */
const FORWARD_MARKER = /^(?:-{2,}\s?(?:forwarded message|转发的邮件|轉寄的郵件|转发邮件信息)\s?-{2,}|begin forwarded message:)$/i;

/** 从 index 起的若干行里有满足条件的行 */
function nearby(lines: string[], index: number, span: number, pattern: RegExp): boolean {
  for (let j = index; j < Math.min(lines.length, index + span); j++) {
    if (pattern.test(lines[j]!)) return true;
  }
  return false;
}

/** lines 已 trim；第 i 行是否开始了引用历史 */
function quoteStartsAt(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (!line || line.length > MAX_HEADER_LINE) return false;
  if (ORIGINAL_SEPARATOR.test(line)) return true;
  if (UNDERSCORE_RULE.test(line)) return nearby(lines, i + 1, 2, HEADER_FROM);
  // Outlook 头块：From 之后紧跟 Sent/Date，再往下有 To/Subject；单独一行 From: 不算
  if (HEADER_FROM.test(line)) return nearby(lines, i + 1, 2, HEADER_DATE) && nearby(lines, i + 1, 5, HEADER_OTHER);
  if (ZH_WROTE.test(line)) return HAS_DATE_OR_ADDRESS.test(line);
  if (!/^on\s/i.test(line)) return false;
  // Gmail 会把很长的引用头折成两行，`wrote:` 落在第二行
  const next = lines[i + 1] ?? '';
  const header = EN_WROTE.test(line) ? line : next.length <= MAX_HEADER_LINE ? `${line} ${next}` : '';
  return EN_WROTE.test(header) && HAS_DATE_OR_ADDRESS.test(header);
}

/**
 * 去掉引用历史，返回回复链里新写的部分：截掉第一处引用头（On … wrote:、写道：、Original Message、
 * Outlook 头块）及其后的全部内容，再去掉结尾的 `>` 引用块。内联回复的 `>` 行、转发的原信与签名都保留。
 * 认不出引用或去掉后为空时返回原文（trim 后）；只处理开头 {@link AGENT_TEXT_MAX_CHARS} 个字符。
 */
export function extractReplyText(plain: string): string {
  const source = plain.slice(0, AGENT_TEXT_MAX_CHARS).replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const trimmed = lines.map((line) => line.trim());
  let end = lines.length;
  for (let i = 0; i < trimmed.length; i++) {
    if (FORWARD_MARKER.test(trimmed[i]!)) break;
    if (quoteStartsAt(trimmed, i)) {
      end = i;
      break;
    }
  }
  while (end > 0 && (trimmed[end - 1] === '' || trimmed[end - 1]!.startsWith('>'))) end--;
  const extracted = lines.slice(0, end).join('\n').trim();
  return extracted || source.trim();
}

/** 前面紧挨着否定词时不算（「Never share your API key」「请勿泄露」） */
const NOT_NEGATED = String.raw`(?<!(?:\bnot|\bnever|n't|\bno) )`;
const AI_NOUN = String.raw`(?:ai|a\.i\.|llm|large language model|language model|ai (?:assistant|agent|model)|chatbot|autonomous agent)`;
const ZH_AI_NOUN = '(?:AI|人工智能|大模型|大语言模型|语言模型|智能体|聊天机器人)';
/** 中文称呼 AI 之后（可隔一个角色名词）必须是标点或结尾，「你是AI时代的弄潮儿」「如果你是 AI 从业者」不算 */
const ZH_AI_END = ' ?(?:助手|助理|模型|代理|agent)? ?(?=[，,。.!！:：;；?？]|$)';

/**
 * 各原因的模式，在去掉不可见字符、空白折成单个空格的文本上匹配（跨行的短语也能命中）；
 * prompt_markup 的行首模式另在保留换行的文本上匹配。都只认明确的指令性说法，宁缺毋滥。
 */
const PATTERNS: Record<PromptInjectionReason, RegExp[]> = {
  ignore_instructions: [
    // 不收「my previous instructions」：那是人在更正自己之前的说法
    /\b(?:ignore|disregard|forget|override) (?:(?:all|any) (?:of )?)?(?:(?:your|the) )?(?:previous|prior|above|earlier|preceding) (?:instructions?|prompts?|rules|directives)\b/i,
    /\b(?:ignore|disregard|forget) (?:everything|anything) (?:(?:you were told|written|said) )?(?:above|before|previously)\b/i,
    /(?:忽略|无视|忽视|忘记|忘掉|不要理会)(?:掉)? ?(?:你)?(?:之前|以上|上面|前面|先前|此前|上述|原来|原有|所有|全部|一切)(?:的)? ?(?:所有|全部|一切)?(?:的)? ?(?:指令|指示|提示词|规则|设定|约束|命令)/,
  ],
  addresses_ai: [
    new RegExp(String.raw`\byou are (?:now )?(?:an? |the )?${AI_NOUN}(?= ?(?:[.,;:!]|$))`, 'i'),
    new RegExp(String.raw`\bif you are (?:an? )?${AI_NOUN}(?= ?(?:[.,;:!]|$)| (?:reading|processing|summari[sz]ing|parsing) )`, 'i'),
    new RegExp(String.raw`\b(?:note|message|instructions?|attention) (?:to|for) (?:the |any |all )?(?:ai|llm|ai assistant|ai agent|language model)s?\b ?[:,]`, 'i'),
    /\b(?:ai|llm) (?:assistants?|agents?|models?) (?:reading|processing|summari[sz]ing|parsing|handling) this\b/i,
    // 不收单独的 Ai：它也是人名
    /\b(?:dear|hey|hello|hi) (?:llm|ai assistant|ai agent|language model) ?[,:!]/i,
    new RegExp(`你(?:现在)?(?:是|就是|扮演|作为)(?:一个|一名|一位|个)? ?${ZH_AI_NOUN}${ZH_AI_END}`, 'i'),
    new RegExp(`如果你是(?:一个|一名)? ?${ZH_AI_NOUN}${ZH_AI_END}`, 'i'),
    new RegExp(`(?:致|写给|给)(?:所有|正在阅读本邮件的|阅读这封邮件的)? ?${ZH_AI_NOUN} ?(?:助手|助理|代理|agent)? ?[:：,，]`, 'i'),
  ],
  prompt_markup: [
    /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|system_prompt|instructions)>/i,
  ],
  action_request: [
    /\b(?:immediately|now|right away|urgently) (?:forward|send|email|transfer|export) (?:(?:all|every|this|these|the|my|your|of) ){1,3}(?:emails?|messages?|mails?|inbox|conversations?|attachments?|contacts)\b/i,
    /\b(?:forward|send|export) (?:all|every) (?:(?:of|the|your|my) ){0,2}(?:emails?|messages?|mails?|conversations?) to\b/i,
    // 只认 tool：「call the main function」是普通编程话题
    /\b(?:call|invoke|execute) (?:the |your )?[\w.-]{1,40} tool\b/i,
    /(?:立即|立刻|马上)(?:把|将) ?(?:这封|此|该|所有|全部|你收到的|收件箱).{0,20}?(?:转发|发送|发给|导出)/,
    /(?:立即|立刻|马上) ?(?:调用|执行).{0,20}?(?:工具|函数|命令|指令)/,
    /(?:把|将) ?(?:所有|全部)(?:的)? ?(?:邮件|信件|消息)(?:都)? ?(?:转发|发送|发)给/,
  ],
  conceal_from_user: [
    /\b(?:do not|don't|never) (?:tell|inform|notify|alert|warn) (?:the|your) (?:user|human|owner|operator)\b/i,
    /\bwithout (?:telling|informing|notifying|alerting) (?:the|your) (?:user|human|owner|operator)\b/i,
    /(?:不要|别|切勿|不得|禁止) ?(?:告诉|告知|通知|提醒) ?(?:用户|你的主人|主人|人类|使用者)/,
  ],
  secret_request: [
    new RegExp(String.raw`${NOT_NEGATED}\b(?:reveal|print|output|repeat|disclose|leak|show me|send me|send us|give me|tell me) (?:your|the) (?:system prompt|initial prompt|hidden (?:prompt|instructions)|api keys?|access tokens?|secret keys?|credentials)\b`, 'i'),
    /\b(?:send|forward|give|tell) (?:me|us) (?:your|the) (?:verification|one-time|otp|2fa|login|security) codes?\b/i,
    /\breply with (?:your|the) (?:verification|one-time|otp|2fa|login|security) codes?\b/i,
    /(?:输出|打印|复述|透露|告诉我|发给我) ?(?:一下)? ?你的 ?(?:系统提示词?|系统指令|初始提示|隐藏指令)/,
    /(?:把|将) ?(?:你的|你收到的)? ?(?:验证码|密码|API ?Key|密钥|系统提示词?) ?(?:发给|发送给|告诉|回复给?) ?(?:我|我们)/i,
    /(?:告诉我|发给我|发送给我) ?(?:你的|你收到的)? ?(?:验证码|密码|API ?Key|密钥)/i,
  ],
};

/** 行首的伪造提示段落：System prompt: / Developer message: / 系统提示词：（「New instructions:」常见于活动通知，不收） */
const MARKUP_LINE = /(?:^|\n)[ \t]{0,8}(?:#{1,6}[ \t]{0,4})?(?:system prompt|system override|developer (?:message|instructions)|系统提示词?|系统指令|开发者指令)[ \t]{0,4}[:：]/i;

/**
 * 规则检测 prompt injection：在主题与正文开头 {@link AGENT_TEXT_MAX_CHARS} 个字符上找明确的指令性说法。
 * 只是给 Agent 的提示：命中不代表邮件一定恶意，未命中也不代表安全，邮件内容都不应被当作指令执行。
 */
export function detectPromptInjection(subject: string, plain: string): MessageRisk {
  const lined = stripInvisible(`${subject}\n${plain}`.slice(0, AGENT_TEXT_MAX_CHARS));
  const flat = lined.replace(/\s+/g, ' ');
  const reasons = PROMPT_INJECTION_REASONS.filter((reason) =>
    PATTERNS[reason].some((pattern) => pattern.test(flat)) || (reason === 'prompt_markup' && MARKUP_LINE.test(lined)));
  return { promptInjection: reasons.length > 0, reasons };
}
