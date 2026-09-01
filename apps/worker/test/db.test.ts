import { SECRET_MASK } from '@hpc-mail/shared';
import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { messages, settings as settingsTable, users } from '../src/db/schema.js';
import { AppError } from '../src/lib/errors.js';
import { getDomains, getPublicDomains, getRoutableDomains, getVisibleDomains } from '../src/services/domain.js';
import { claimMailbox } from '../src/services/mailbox.js';
import {
  countUnread,
  getMessageDetail,
  listMessages,
  markAllRead,
  markMessages,
  starMessages,
} from '../src/services/message.js';
import {
  getUserNotifyPrefs,
  maskUserNotifyPrefs,
  updateUserNotifyPrefs,
} from '../src/services/notify-prefs.js';
import { sendMail } from '../src/services/outbound.js';
import { updateSettings } from '../src/services/setting.js';

async function seedUser(username: string, role: 'admin' | 'user'): Promise<number> {
  const db = createDb(env);
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash: 'x', role, status: 'active' })
    .returning({ id: users.id });
  return row!.id;
}

async function seedInbound(address: string, subject: string, bodyText = ''): Promise<number> {
  const db = createDb(env);
  const [row] = await db
    .insert(messages)
    .values({
      direction: 'inbound',
      address,
      domain: address.split('@')[1]!,
      fromAddress: 'sender@example.com',
      fromName: 'Sender',
      subject,
      bodyText,
      status: 'received',
      createdAt: new Date(),
    })
    .returning({ id: messages.id });
  return row!.id;
}

// 域名不再来自 wrangler vars，认领/发件前需在 settings 里配置
const TEST_DOMAINS = [
  'hpc.email',
  'example.com',
  'example.net',
  'example.org',
  'mail.test',
  'inbox.test',
];
// 测试默认把域名标记为 public（普通用户可认领），以复用大量「user 认领」用例；
// 可见性/按域名上限的专项行为在独立 describe 里显式构造 entry。
async function setDomains(list: string[] = TEST_DOMAINS): Promise<void> {
  await updateSettings(env, {
    domains: { list: list.map((domain) => ({ domain, public: true, perUserLimit: 0 })) },
  });
}

describe('个人通知偏好脱敏与掩码写入', () => {
  it('feishu secret 掩码提交保留旧值', async () => {
    const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop';
    const uid = await seedUser('notify-mask-user', 'user');
    await updateUserNotifyPrefs(env, uid, {
      feishu: { enabled: true, webhookUrl, secret: 's3cr3t', contentLevel: 'summary' },
    });
    let prefs = await getUserNotifyPrefs(env, uid);
    expect(prefs.feishu.secret).toBe('s3cr3t');
    expect(maskUserNotifyPrefs(prefs).feishu.secret).toBe(SECRET_MASK);

    // 提交掩码值 → 保留旧 secret
    await updateUserNotifyPrefs(env, uid, {
      feishu: { enabled: true, webhookUrl, secret: SECRET_MASK, contentLevel: 'summary' },
    });
    prefs = await getUserNotifyPrefs(env, uid);
    expect(prefs.feishu.secret).toBe('s3cr3t');
  });

  it('管理员未配置个人偏好时继承旧全局通知设置', async () => {
    // 旧全局键已从系统设置移除，但历史数据仍在 settings 表；此处直接写库模拟历史值
    const db = createDb(env);
    await db
      .insert(settingsTable)
      .values({ key: 'gmail_forward', value: JSON.stringify({ enabled: true, addresses: ['legacy@gmail.com'] }) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify({ enabled: true, addresses: ['legacy@gmail.com'] }) } });
    const adminId = await seedUser('legacy-admin', 'admin');
    const prefs = await getUserNotifyPrefs(env, adminId);
    expect(prefs.forward.enabled).toBe(true);
    expect(prefs.forward.addresses).toContain('legacy@gmail.com');
    // 普通用户不继承全局
    const userId = await seedUser('legacy-user', 'user');
    const uprefs = await getUserNotifyPrefs(env, userId);
    expect(uprefs.forward.enabled).toBe(false);
  });
});

describe('mailbox 认领唯一冲突', () => {
  it('同地址二次认领被拒，跨域名被拒', async () => {
    await setDomains();
    const u1 = await seedUser('alice', 'user');
    const u2 = await seedUser('bob', 'user');
    const box = await claimMailbox(env, u1, 'user', { localPart: 'test1', domain: 'inbox.test' });
    expect(box.address).toBe('test1@inbox.test');

    await expect(
      claimMailbox(env, u2, 'user', { localPart: 'test1', domain: 'inbox.test' }),
    ).rejects.toThrow(AppError);

    await expect(
      claimMailbox(env, u1, 'user', { localPart: 'x', domain: 'not-a-system-domain.com' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('mailbox 认领策略', () => {
  it('普通用户禁止认领保留前缀，admin 豁免', async () => {
    await setDomains();
    const uid = await seedUser('dave', 'user');
    const adminId = await seedUser('root2', 'admin');
    await expect(
      claimMailbox(env, uid, 'user', { localPart: 'admin', domain: 'hpc.email' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const box = await claimMailbox(env, adminId, 'admin', {
      localPart: 'postmaster',
      domain: 'hpc.email',
    });
    expect(box.address).toBe('postmaster@hpc.email');
  });

  it('普通用户认领数达上限被拒', async () => {
    await updateSettings(env, { mailbox_policy: { perUserLimit: 2, reservedLocalParts: [] } });
    await setDomains();
    const uid = await seedUser('eve', 'user');
    await claimMailbox(env, uid, 'user', { localPart: 'eve1', domain: 'hpc.email' });
    await claimMailbox(env, uid, 'user', { localPart: 'eve2', domain: 'hpc.email' });
    await expect(
      claimMailbox(env, uid, 'user', { localPart: 'eve3', domain: 'hpc.email' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // 恢复宽松策略，避免污染同文件后续用例（共享存储）
    await updateSettings(env, { mailbox_policy: { perUserLimit: 50, reservedLocalParts: [] } });
  });
});

describe('message 可见性 user vs admin', () => {
  // 地址与「认领唯一冲突」用例错开——同文件共享存储，test1@ 已被 alice 占用
  beforeEach(async () => {
    await setDomains();
    await seedInbound('carol@inbox.test', 'claimed message');
    await seedInbound('other@hpc.email', 'unclaimed message');
  });

  it('user 只看自己认领地址', async () => {
    const uid = await seedUser('carol', 'user');
    await claimMailbox(env, uid, 'user', { localPart: 'carol', domain: 'inbox.test' });
    const page = await listMessages(
      env,
      { userId: uid, role: 'user' },
      { limit: 30 } as never,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.address).toBe('carol@inbox.test');
  });

  it('admin 默认只看自己认领，unclaimed 看未认领，user 看指定用户', async () => {
    const adminId = await seedUser('root', 'admin');
    const uid = await seedUser('vis-bob', 'user');
    await seedInbound('vis-bob@inbox.test', 'bob mail');
    await claimMailbox(env, uid, 'user', { localPart: 'vis-bob', domain: 'inbox.test' });

    const mine = await listMessages(env, { userId: adminId, role: 'admin' }, { limit: 30 } as never);
    expect(mine.items.every((m) => m.address !== 'vis-bob@inbox.test')).toBe(true);
    expect(mine.items.every((m) => m.address !== 'other@hpc.email')).toBe(true);

    const unclaimed = await listMessages(
      env,
      { userId: adminId, role: 'admin', scope: 'unclaimed' },
      { limit: 50 } as never,
    );
    expect(unclaimed.items.some((m) => m.address === 'other@hpc.email')).toBe(true);
    expect(unclaimed.items.some((m) => m.address === 'vis-bob@inbox.test')).toBe(false);

    const asUser = await listMessages(
      env,
      { userId: adminId, role: 'admin', scope: 'user', targetUserId: uid },
      { limit: 30 } as never,
    );
    expect(asUser.items.every((m) => m.address === 'vis-bob@inbox.test')).toBe(true);
    expect(asUser.items.length).toBeGreaterThanOrEqual(1);
  });

  it('admin 无上下文打不开他人已认领邮件', async () => {
    const adminId = await seedUser('detail-admin', 'admin');
    const uid = await seedUser('detail-bob', 'user');
    await seedInbound('detail-bob@inbox.test', 'claimed for detail');
    await claimMailbox(env, uid, 'user', { localPart: 'detail-bob', domain: 'inbox.test' });
    const claimedId = (
      await listMessages(env, { userId: uid, role: 'user' }, { limit: 5 } as never)
    ).items[0]!.id;
    const unclaimedId = (
      await listMessages(env, { userId: adminId, role: 'admin', scope: 'unclaimed' }, { limit: 50 } as never)
    ).items.find((m) => m.address === 'other@hpc.email')!.id;

    await expect(getMessageDetail(env, { userId: adminId, role: 'admin' }, claimedId)).rejects.toMatchObject({
      code: 'not_found',
    });
    const openUnclaimed = await getMessageDetail(env, { userId: adminId, role: 'admin' }, unclaimedId);
    expect(openUnclaimed.address).toBe('other@hpc.email');
    const asUser = await getMessageDetail(
      env,
      { userId: adminId, role: 'admin', scope: 'user', targetUserId: uid },
      claimedId,
    );
    expect(asUser.address).toBe('detail-bob@inbox.test');
  });

  it('普通用户不能使用 unclaimed/user 范围', async () => {
    const uid = await seedUser('scope-user', 'user');
    await expect(
      listMessages(env, { userId: uid, role: 'user', scope: 'unclaimed' }, { limit: 10 } as never),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      listMessages(
        env,
        { userId: uid, role: 'user', scope: 'user', targetUserId: uid },
        { limit: 10 } as never,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('验证码响应时重校验', () => {
  it('历史 link-only 误识别值不会继续出现在列表和详情', async () => {
    const adminId = await seedUser('otp-link-admin', 'admin');
    const body = [
      'Continue verifying your identity',
      'Please click the link below.',
      'https://withpersona.example/verify?code=VGHH62D',
      'This link will expire in 1 hour.',
    ].join('\n');
    const id = await seedInbound('otp-link-only@hpc.email', 'Anthropic one-time link', body);
    const db = createDb(env);
    await db.update(messages).set({ verificationCode: 'VGHH62D' }).where(eq(messages.id, id));

    const page = await listMessages(
      env,
      { userId: adminId, role: 'admin', scope: 'unclaimed' },
      { limit: 100 } as never,
    );
    expect(page.items.find((message) => message.id === id)?.verificationCode).toBe('');

    const detail = await getMessageDetail(
      env,
      { userId: adminId, role: 'admin', scope: 'unclaimed' },
      id,
    );
    expect(detail.verificationCode).toBe('');
  });
});

describe('星标与正文搜索', () => {
  it('星标为每用户独立，starred 过滤与 isStarred 标记生效', async () => {
    const admin = await seedUser('star-admin', 'admin');
    const other = await seedUser('star-other', 'admin');
    const mid = await seedInbound('star@hpc.email', 'hello star');

    const unclaimed = { scope: 'unclaimed' as const };
    await starMessages(env, { userId: admin, role: 'admin', ...unclaimed }, [mid], true);

    const adminList = await listMessages(
      env,
      { userId: admin, role: 'admin', ...unclaimed },
      { limit: 30 } as never,
    );
    const starredForAdmin = adminList.items.find((m) => m.id === mid);
    expect(starredForAdmin?.isStarred).toBe(true);

    // 另一个用户看到的同一封邮件未被星标
    const otherList = await listMessages(
      env,
      { userId: other, role: 'admin', ...unclaimed },
      { limit: 30 } as never,
    );
    expect(otherList.items.find((m) => m.id === mid)?.isStarred).toBe(false);

    // starred=true 过滤只返回星标邮件
    const onlyStarred = await listMessages(
      env,
      { userId: admin, role: 'admin', ...unclaimed },
      { limit: 30, starred: true } as never,
    );
    expect(onlyStarred.items.every((m) => m.isStarred)).toBe(true);
    expect(onlyStarred.items.some((m) => m.id === mid)).toBe(true);

    // 取消星标
    await starMessages(env, { userId: admin, role: 'admin', ...unclaimed }, [mid], false);
    const afterUnstar = await listMessages(
      env,
      { userId: admin, role: 'admin', ...unclaimed },
      { limit: 30, starred: true } as never,
    );
    expect(afterUnstar.items.some((m) => m.id === mid)).toBe(false);
  });

  it('q 搜索命中正文 bodyText', async () => {
    const admin = await seedUser('search-admin', 'admin');
    await seedInbound('s1@hpc.email', '普通主题', '这里有一个 UNIQUETOKEN9 在正文里');
    await seedInbound('s2@hpc.email', '另一封', '无关内容');

    const hit = await listMessages(
      env,
      { userId: admin, role: 'admin', scope: 'unclaimed' },
      { limit: 30, q: 'UNIQUETOKEN9' } as never,
    );
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0]!.address).toBe('s1@hpc.email');
  });
});

describe('动态域名 getDomains（纯 settings 驱动，无 fallback）', () => {
  it('未配置 domains 时返回空数组，任何域名都不能认领', async () => {
    // 同文件测试共享存储，显式清空覆盖前面用例设过的域名
    await updateSettings(env, { domains: { list: [] } });
    expect(await getDomains(env)).toEqual([]);

    const uid = await seedUser('empty-dom-user', 'user');
    await expect(
      claimMailbox(env, uid, 'user', { localPart: 'x', domain: 'hpc.email' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('settings.domains.list 决定可用域名：表内可认领、表外被拒', async () => {
    await updateSettings(env, {
      domains: {
        list: [
          { domain: 'custom-domain.io', public: true, perUserLimit: 0 },
          { domain: 'hpc.email', public: true, perUserLimit: 0 },
        ],
      },
    });
    expect(await getDomains(env)).toEqual(['custom-domain.io', 'hpc.email']);

    const uid = await seedUser('dom-user', 'user');
    const box = await claimMailbox(env, uid, 'user', { localPart: 'hi', domain: 'custom-domain.io' });
    expect(box.address).toBe('hi@custom-domain.io');

    // 不在 list 的域名被拒
    await expect(
      claimMailbox(env, uid, 'user', { localPart: 'x', domain: 'example.net' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('域名可见性与按域名认领上限', () => {
  it('普通用户不能认领「仅管理员」域名（public:false）', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: false, perUserLimit: 0 }] },
    });
    const uid = await seedUser('vis-user-1', 'user');
    await expect(
      claimMailbox(env, uid, 'user', { localPart: 'visa', domain: 'hpc.email' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('管理员豁免可见性：可认领「仅管理员」域名', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: false, perUserLimit: 0 }] },
    });
    const aid = await seedUser('vis-admin', 'admin');
    const box = await claimMailbox(env, aid, 'admin', { localPart: 'visroot', domain: 'hpc.email' });
    expect(box.address).toBe('visroot@hpc.email');
  });

  it('getPublicDomains/getVisibleDomains 按角色返回；公开域名普通用户可认领', async () => {
    await updateSettings(env, {
      domains: {
        list: [
          { domain: 'example.com', public: true, perUserLimit: 0 },
          { domain: 'hpc.email', public: false, perUserLimit: 0 },
        ],
      },
    });
    expect(await getPublicDomains(env)).toEqual(['example.com']);
    expect(await getVisibleDomains(env, false)).toEqual(['example.com']);
    expect(await getVisibleDomains(env, true)).toEqual(['example.com', 'hpc.email']);

    const uid = await seedUser('vis-user-2', 'user');
    const box = await claimMailbox(env, uid, 'user', { localPart: 'visme', domain: 'example.com' });
    expect(box.address).toBe('visme@example.com');
  });

  it('按域名上限 perUserLimit=1：同域第二个被拒，管理员豁免', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'example.com', public: true, perUserLimit: 1 }] },
    });
    const uid = await seedUser('limit-user', 'user');
    await claimMailbox(env, uid, 'user', { localPart: 'limone', domain: 'example.com' });
    await expect(
      claimMailbox(env, uid, 'user', { localPart: 'limtwo', domain: 'example.com' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // 管理员不受按域名上限约束
    const aid = await seedUser('limit-admin', 'admin');
    await claimMailbox(env, aid, 'admin', { localPart: 'lima1', domain: 'example.com' });
    const box = await claimMailbox(env, aid, 'admin', { localPart: 'lima2', domain: 'example.com' });
    expect(box.address).toBe('lima2@example.com');
  });

  it('从列表移除域名后，已认领地址仍按站内互投', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'kept.example', public: true, perUserLimit: 0 }] },
    });
    const uid = await seedUser('kept-route', 'user');
    const box = await claimMailbox(env, uid, 'user', { localPart: 'kept', domain: 'kept.example' });
    await updateSettings(env, { domains: { list: [] } });
    expect(await getDomains(env)).toEqual([]);
    expect(await getRoutableDomains(env)).toContain('kept.example');

    const ctx = { waitUntil: () => {} };
    await sendMail(
      env,
      ctx,
      { userId: uid, role: 'user' },
      {
        from: { mailboxId: box.id },
        to: ['kept@kept.example'],
        cc: [],
        bcc: [],
        subject: 'still internal',
        text: 'hi',
      } as never,
      [],
      'https://hpc.email',
    );

    const db = createDb(env);
    const inbound = await db
      .select()
      .from(messages)
      .where(and(eq(messages.address, 'kept@kept.example'), eq(messages.direction, 'inbound')))
      .get();
    expect(inbound?.sendChannel).toBe('internal');
  });
});

describe('收件箱未读数 countUnread', () => {
  it('user 只数自己认领地址的 inbound 未读，已读不计', async () => {
    await setDomains();
    const uid = await seedUser('unread-user', 'user');
    await claimMailbox(env, uid, 'user', { localPart: 'ur', domain: 'hpc.email' });

    // 认领地址下 2 封未读 inbound
    await seedInbound('ur@hpc.email', 'unread 1');
    await seedInbound('ur@hpc.email', 'unread 2');
    // 认领地址下 1 封已读 inbound（不计）
    const readId = await seedInbound('ur@hpc.email', 'read one');
    await markMessages(env, { userId: uid, role: 'user' }, [readId], true);
    // 未认领地址下的未读（不计）
    await seedInbound('someone-else@hpc.email', 'not mine');

    expect(await countUnread(env, uid, 'user')).toBe(2);
  });

  it('admin 也只数自己认领地址（scope=mine，非全站）', async () => {
    await setDomains();
    const adminId = await seedUser('unread-admin', 'admin');
    await claimMailbox(env, adminId, 'admin', { localPart: 'boss', domain: 'hpc.email' });

    await seedInbound('boss@hpc.email', 'mine unread'); // 计
    await seedInbound('elsewhere@hpc.email', 'site unread'); // 全站有未读但非自己认领 → 不计

    expect(await countUnread(env, adminId, 'admin')).toBe(1);
  });

  it('无认领地址时未读数为 0', async () => {
    const uid = await seedUser('no-mailbox-user', 'user');
    await seedInbound('random@hpc.email', 'x');
    expect(await countUnread(env, uid, 'user')).toBe(0);
  });
});

describe('一键全读 markAllRead', () => {
  it('user 只标自己认领地址的未读 inbound，他人邮件不动', async () => {
    await setDomains();
    const uid = await seedUser('readall-user', 'user');
    await claimMailbox(env, uid, 'user', { localPart: 'ra', domain: 'hpc.email' });

    await seedInbound('ra@hpc.email', 'ra unread 1');
    await seedInbound('ra@hpc.email', 'ra unread 2');
    const otherId = await seedInbound('ra-other@hpc.email', 'not mine');

    expect(await markAllRead(env, { userId: uid, role: 'user' })).toBe(2);
    expect(await countUnread(env, uid, 'user')).toBe(0);
    // 他人地址的邮件保持未读
    const db = createDb(env);
    const other = await db.select().from(messages).where(eq(messages.id, otherId)).get();
    expect(other!.isRead).toBe(false);
  });

  it('admin 默认只标自己，显式 scope=unclaimed 才标未认领', async () => {
    await setDomains();
    const adminId = await seedUser('readall-admin', 'admin');
    await claimMailbox(env, adminId, 'admin', { localPart: 'ra-boss', domain: 'hpc.email' });

    await seedInbound('ra-boss@hpc.email', 'mine unread');
    const elsewhereId = await seedInbound('ra-elsewhere@hpc.email', 'site unread');

    expect(await markAllRead(env, { userId: adminId, role: 'admin' })).toBe(1);
    const db = createDb(env);
    const before = await db.select().from(messages).where(eq(messages.id, elsewhereId)).get();
    expect(before!.isRead).toBe(false);
    await markAllRead(env, { userId: adminId, role: 'admin', scope: 'unclaimed' });
    const after = await db.select().from(messages).where(eq(messages.id, elsewhereId)).get();
    expect(after!.isRead).toBe(true);
  });
});

describe('回复头 replyToMessageId', () => {
  it('站内回复时 outbound 与 inbound 行写入原邮件 message_id 到 in_reply_to', async () => {
    await setDomains();
    const db = createDb(env);
    const uid = await seedUser('reply-user', 'user');
    await claimMailbox(env, uid, 'user', { localPart: 'me', domain: 'hpc.email' });
    const [orig] = await db
      .insert(messages)
      .values({
        direction: 'inbound',
        address: 'me@hpc.email',
        domain: 'hpc.email',
        fromAddress: 'ext@example.com',
        subject: 'Original',
        messageId: '<orig-abc@example.com>',
        status: 'received',
        createdAt: new Date(),
      })
      .returning({ id: messages.id });

    const ctx = { waitUntil: () => {} };
    await sendMail(
      env,
      ctx,
      { userId: uid, role: 'user' },
      {
        from: { localPart: 'me', domain: 'hpc.email' },
        to: ['friend@hpc.email'],
        cc: [],
        bcc: [],
        subject: 'Re: Original',
        text: '回复内容',
        replyToMessageId: orig!.id,
      } as never,
      [],
      'https://hpc.email',
    );

    const outbound = await db
      .select()
      .from(messages)
      .where(and(eq(messages.direction, 'outbound'), eq(messages.address, 'me@hpc.email')))
      .get();
    expect(outbound?.inReplyTo).toBe('<orig-abc@example.com>');

    const internal = await db
      .select()
      .from(messages)
      .where(and(eq(messages.direction, 'inbound'), eq(messages.address, 'friend@hpc.email')))
      .get();
    expect(internal?.inReplyTo).toBe('<orig-abc@example.com>');
  });
});
