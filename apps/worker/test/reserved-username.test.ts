import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { register } from '../src/services/auth.js';
import { updateSettings } from '../src/services/setting.js';
import { createUser } from '../src/services/user.js';

describe('系统保留用户名', () => {
  it('开放注册时 ci-smoke 按已存在处理', async () => {
    await updateSettings(env, { register_mode: 'open' });
    const error = await register(env, { username: 'ci-smoke', password: 'password12345' }, '203.0.113.9').catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('conflict');
  });

  it('管理员也不能创建保留用户名', async () => {
    const error = await createUser(env, { username: 'ci-smoke', password: 'password12345', role: 'user' }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).message).toContain('系统保留');
  });

  it('非保留用户名照常注册', async () => {
    await updateSettings(env, { register_mode: 'open' });
    const res = await register(env, { username: 'reserved-check-ok', password: 'password12345' }, '203.0.113.10');
    expect(res.user.username).toBe('reserved-check-ok');
  });
});
