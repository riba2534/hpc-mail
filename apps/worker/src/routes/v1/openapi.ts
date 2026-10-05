/** /v1 的 OpenAPI 3.1 描述（公开，供工具/人类开发者导入）；server 地址按请求来源生成 */
export function buildOpenApiSpec(origin: string) {
  const paths = Object.fromEntries(Object.entries(OPENAPI_SPEC.paths).map(([path, item]) => [path,
    Object.fromEntries(Object.entries(item).map(([method, value]) => {
      if (method === 'parameters') return [method, value];
      const operation = value as unknown as { summary: string; responses: Record<string, { description: string }> };
      return [method, { ...operation, description: operation.summary, tags: ['Mail'],
        operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
        responses: { ...Object.fromEntries(Object.entries(operation.responses).map(([code, response]) => [code, { ...response, content: path.includes('/attachments/') && code === '200' ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } : { 'application/json': { schema: { '$ref': '#/components/schemas/Envelope' } } } }])), 400: { description: 'Invalid request' }, 401: { description: 'Authentication required' }, 403: { description: 'Insufficient permission' }, 429: { description: 'Rate limit exceeded' }, 500: { description: 'Server error; keep the same Idempotency-Key when retrying a send' } },
      }];
    })),
  ]));
  return { ...OPENAPI_SPEC, paths, tags: [{ name: 'Mail', description: 'Mailbox and mail operations' }], servers: [{ url: `${origin}/v1` }] };
}

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'HPC Mail Open API',
    version: '1.2.0',
    license: { name: 'MIT', identifier: 'MIT' },
    contact: { name: 'HPC Mail', url: 'https://github.com/riba2534/hpc-mail' },
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
        properties: { data: { anyOf: [{ '$ref': '#/components/schemas/MessageSummary' }, { type: 'array', items: {} }, { type: 'object' }] }, error: { type: 'object' }, requestId: { type: 'string' } },
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
          recipientOutcomes: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, status: { type: 'string', enum: ['delivered', 'sent', 'failed'] }, error: { type: 'string' } } } },
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
      get: { summary: '列出已认领邮箱', responses: { 200: { description: 'ok' } } },
      post: { summary: '认领邮箱', responses: { 201: { description: 'created' } } },
    },
    '/mailboxes/shared': {
      get: { summary: '列出共享给我的邮箱（只读，不能作为发件人）', responses: { 200: { description: 'ok' } } },
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
    '/messages/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], get: { summary: '邮件详情（含 verificationCode）', responses: { 200: { description: 'ok' } } } },
    '/messages/{id}/attachments/{attId}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }, { name: 'attId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], get: { summary: '下载附件', responses: { 200: { description: 'ok' } } } },
    '/messages/read': { post: { summary: '批量标记已读（mail.write）', responses: { 200: { description: 'ok' } } } },
    '/messages/delete': { post: { summary: '批量删除（mail.write）', responses: { 200: { description: 'ok' } } } },
  },
} as const;
