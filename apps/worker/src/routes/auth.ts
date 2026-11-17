import {
  changePasswordRequestSchema,
  disableTwoFactorRequestSchema,
  enableTwoFactorRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  setupTwoFactorRequestSchema,
  uploadAvatarRequestSchema,
  type SessionUser,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { clientIp, execCtx, ok, parseBody } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { logAdminAction } from '../services/audit.js';
import { changePassword, login, loginRetryAfterSeconds, logout, register } from '../services/auth.js';
import { avatarUrl, deleteAvatar, uploadAvatar } from '../services/avatar.js';
import { disableTwoFactor, enableTwoFactor, setupTwoFactor } from '../services/twofa.js';
import type { AppContext, AuthUser } from '../types.js';

const app = new Hono<AppContext>();

function sessionUserOf(user: AuthUser, overrideAvatarUrl?: string | null): SessionUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    avatarUrl:
      overrideAvatarUrl !== undefined ? overrideAvatarUrl : avatarUrl(user.id, user.avatarKey),
    twoFactorEnabled: user.twoFactorEnabled,
  };
}

app.post('/login', async (c) => {
  const req = await parseBody(c, loginRequestSchema);
  try {
    return ok(c, await login(c.env, req, clientIp(c), execCtx(c)));
  } catch (error) {
    // 登录失败计数按固定 15 分钟窗口重置，告诉调用方要等多久
    if (error instanceof AppError && error.code === 'rate_limited') c.header('Retry-After', String(loginRetryAfterSeconds()));
    throw error;
  }
});

app.post('/register', async (c) => {
  const req = await parseBody(c, registerRequestSchema);
  const result = await register(c.env, req, clientIp(c));
  return ok(c, result, 201);
});

app.get('/me', requireAuth, (c) => {
  return ok(c, sessionUserOf(c.get('user')!));
});

/** 上传头像（base64 图片）→ R2，返回更新后的 SessionUser */
app.post('/avatar', requireAuth, async (c) => {
  const req = await parseBody(c, uploadAvatarRequestSchema);
  const url = await uploadAvatar(c.env, c.get('user')!.id, req);
  return ok(c, sessionUserOf(c.get('user')!, url));
});

/** 删除头像，返回更新后的 SessionUser（avatarUrl=null） */
app.delete('/avatar', requireAuth, async (c) => {
  await deleteAvatar(c.env, c.get('user')!.id);
  return ok(c, sessionUserOf(c.get('user')!, null));
});

app.put('/password', requireAuth, async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, changePasswordRequestSchema);
  const result = await changePassword(c.env, user, req);
  if (result.revokedApiKeys) {
    await logAdminAction(c.env, user, 'apikey.revoke_all', user.username, `修改密码时吊销 ${result.revokedApiKeys} 个 API Key`, clientIp(c));
  }
  return ok(c, result);
});

/** 两步验证：开始登记（需当前密码；返回密钥+otpauth URI） */
app.post('/2fa/setup', requireAuth, async (c) => {
  const req = await parseBody(c, setupTwoFactorRequestSchema);
  return ok(c, await setupTwoFactor(c.env, c.get('user')!.id, req.password));
});

/** 两步验证：校验一次性码并启用（返回一次性恢复码与替换当前会话的新令牌，其他会话失效） */
app.post('/2fa/enable', requireAuth, async (c) => {
  const req = await parseBody(c, enableTwoFactorRequestSchema);
  return ok(c, await enableTwoFactor(c.env, c.get('user')!.id, req.code), 201);
});

/** 两步验证：关闭（需当前密码；返回替换当前会话的新令牌，其他会话失效） */
app.post('/2fa/disable', requireAuth, async (c) => {
  const req = await parseBody(c, disableTwoFactorRequestSchema);
  return ok(c, await disableTwoFactor(c.env, c.get('user')!.id, req.password));
});

app.post('/logout', requireAuth, async (c) => {
  const sid = c.get('sessionId');
  if (!sid) throw new AppError('unauthorized', '会话不存在');
  await logout(c.env, sid);
  return ok(c, { success: true });
});

export default app;
