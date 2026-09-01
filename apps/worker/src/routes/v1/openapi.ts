/** /v1 的 OpenAPI 3.1 描述（公开，供工具/人类开发者导入）；server 地址按请求来源生成 */
export function buildOpenApiSpec(origin: string) {
  return { ...OPENAPI_SPEC, servers: [{ url: `${origin}/v1` }] };
}

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'HPC Mail Open API',
    version: '1.1.0',
    description: '多域名邮箱系统的开放 API。用 API Key（Bearer hpcm_...）鉴权。',
  },
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'hpcm_...' },
    },
    schemas: {
      Envelope: {
        type: 'object',
        properties: { data: {}, error: { type: 'object' }, requestId: { type: 'string' } },
      },
      MessageSummary: {
        type: 'object',
        required: ['id', 'direction', 'address', 'subject', 'preview', 'verificationCode', 'status', 'errorDetail', 'isRead', 'createdAt'],
        properties: {
          id: { type: 'integer' },
          direction: { type: 'string', enum: ['inbound', 'outbound'] },
          address: { type: 'string' },
          fromAddress: { type: 'string' },
          fromName: { type: 'string' },
          subject: { type: 'string' },
          preview: { type: 'string' },
          verificationCode: { type: 'string' },
          status: { type: 'string' },
          errorDetail: { type: 'string' },
          isRead: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SendMailRequest: {
        type: 'object',
        required: ['from', 'to', 'subject'],
        properties: {
          from: {
            type: 'object',
            properties: {
              mailboxId: { type: 'integer' },
              localPart: { type: 'string' },
              domain: { type: 'string' },
              displayName: { type: 'string' },
            },
          },
          to: { type: 'array', items: { type: 'string', format: 'email' } },
          cc: { type: 'array', items: { type: 'string', format: 'email' }, default: [] },
          bcc: { type: 'array', items: { type: 'string', format: 'email' }, default: [] },
          subject: { type: 'string' },
          text: { type: 'string' },
          html: { type: 'string' },
          replyToMessageId: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    '/status': { get: { summary: '探活', responses: { 200: { description: 'ok' } } } },
    '/domains': { get: { summary: '可用系统域名', responses: { 200: { description: 'ok' } } } },
    '/mailboxes': {
      get: { summary: '列出邮箱', responses: { 200: { description: 'ok' } } },
      post: { summary: '认领邮箱', responses: { 201: { description: 'created' } } },
    },
    '/messages': {
      get: {
        summary: '收发件列表',
        parameters: [
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['inbound', 'outbound'] } },
          { name: 'address', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'afterId', in: 'query', schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
        ],
        responses: { 200: { description: 'ok' } },
      },
      post: {
        summary: '发送/回复邮件（支持 Idempotency-Key 头）',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', minLength: 1, maxLength: 128 },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SendMailRequest' } } },
        },
        responses: { 201: { description: 'created' } },
      },
    },
    '/messages/wait': {
      get: {
        summary: '长轮询等新邮件（等验证码）',
        parameters: [
          { name: 'address', in: 'query', schema: { type: 'string' } },
          { name: 'afterId', in: 'query', schema: { type: 'integer' } },
          { name: 'timeout', in: 'query', schema: { type: 'integer', maximum: 50 } },
        ],
        responses: { 200: { description: '严格返回 afterId 后最早的一封新邮件，或 message:null' } },
      },
    },
    '/messages/{id}': { get: { summary: '邮件详情（含 verificationCode）', responses: { 200: { description: 'ok' } } } },
    '/messages/{id}/attachments/{attId}': { get: { summary: '下载附件', responses: { 200: { description: 'ok' } } } },
    '/messages/read': { post: { summary: '批量标记已读（mail.write）', responses: { 200: { description: 'ok' } } } },
    '/messages/delete': { post: { summary: '批量删除（mail.write）', responses: { 200: { description: 'ok' } } } },
  },
} as const;
