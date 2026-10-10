import type { Settings } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';

/** 全站统一的 OpenAI 兼容 Chat Completions 模型（settings.ai_model 或管理员测试请求） */
export type AiModelConfig = Settings['ai_model'];

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** 三项都非空才算已配置；未配置时翻译不可用、验证码只走正则 */
export function isAiModelConfigured(config: AiModelConfig): boolean {
  return !!config.baseUrl && !!config.apiKey && !!config.model;
}

/** 可诊断的模型调用错误：message 只含状态码、超时等原因，不含 URL、Key 或响应正文 */
export class AiProviderError extends AppError {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super('internal', message);
    this.name = 'AiProviderError';
  }
}

/** 只有 DeepSeek 认识 thinking 参数（关闭思考可把延迟从数秒降到亚秒）；其他兼容服务可能因未知参数报错 */
function isDeepSeek(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === 'deepseek.com' || host.endsWith('.deepseek.com');
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AiProviderError('响应超过大小上限', response.status);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export interface ChatJsonRequest {
  /** 日志里区分用途，如 translate / code */
  purpose: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  /** 日志里的批次大小（如片段数），不记内容 */
  size?: number;
}

/**
 * 一次 JSON 模式的 Chat Completions 调用，返回 choices[0].message.content 解析出的 JSON；
 * 输出不是合法 JSON 时返回 null，由调用方决定是否重试。HTTP 错误、超时、网络错误抛 AiProviderError。
 *
 * 同一截止时间覆盖连接、响应头和响应体。workerd 不支持 redirect: 'error'（构造请求即抛 TypeError），
 * 用 manual 并把 3xx 当失败。日志只记用途、状态码、耗时和批次大小，绝不记录内容或 Key。
 */
export async function chatJson(config: AiModelConfig, request: ChatJsonRequest): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AiProviderError(`请求超时（${request.timeoutMs / 1000} 秒）`));
    }, request.timeoutMs);
  });
  const started = Date.now();
  let status = 0;
  let text: string;
  try {
    text = await Promise.race([
      (async () => {
        const response = await fetch(endpoint(config.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            temperature: request.temperature ?? 0,
            response_format: { type: 'json_object' },
            stream: false,
            max_tokens: request.maxTokens,
            ...(isDeepSeek(config.baseUrl) ? { thinking: { type: 'disabled' } } : {}),
          }),
          redirect: 'manual',
          signal: controller.signal,
        });
        status = response.status;
        const body = await readLimited(response);
        if (!response.ok) throw new AiProviderError(`HTTP ${response.status}`, response.status);
        return body;
      })(),
      expired,
    ]);
  } catch (error) {
    const failure = error instanceof AiProviderError ? error : new AiProviderError('网络请求失败');
    // fetch 的异常文本可能回显 URL，只记归一化后的原因
    console.error(JSON.stringify({ event: 'ai.provider', purpose: request.purpose, status, ms: Date.now() - started, size: request.size, error: failure.message }));
    throw failure;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  console.log(JSON.stringify({ event: 'ai.provider', purpose: request.purpose, status, ms: Date.now() - started, size: request.size }));
  return parseContent(text);
}

function parseContent(text: string): unknown {
  try {
    const content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) ?? null;
  } catch {
    return null;
  }
}
