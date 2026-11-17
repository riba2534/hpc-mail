import { beforeEach, describe, expect, it } from 'vitest';
import { draftKeyForUser, legacyDraftKeyForUser } from './compose-draft';
import { DRAFT_MAX_AGE_MS, purgeExpiredDrafts, userDraftKeys } from './draft-retention';

const NOW = Date.UTC(2026, 10, 17);
const draft = (savedAt?: unknown) => JSON.stringify({ to: [], cc: [], bcc: [], subject: 's', body: 'b', isHtml: false, ...(savedAt === undefined ? {} : { savedAt }) });

beforeEach(() => localStorage.clear());

describe('userDraftKeys', () => {
  it('只列出该账户的草稿（含旧版单 key），不含 uid 前缀相同的其他账户', () => {
    localStorage.setItem(draftKeyForUser(1), draft(NOW));
    localStorage.setItem(draftKeyForUser(1, 'reply:5'), draft(NOW));
    localStorage.setItem(legacyDraftKeyForUser(1), draft(NOW));
    localStorage.setItem(draftKeyForUser(11), draft(NOW));
    localStorage.setItem('hpc-compose-send-attempt:1', '{}');
    expect(userDraftKeys(1).sort()).toEqual(['hpc-compose-draft:1', 'hpc-compose-draft:1:new', 'hpc-compose-draft:1:reply:5']);
    expect(userDraftKeys(2)).toEqual([]);
  });
});

describe('purgeExpiredDrafts', () => {
  it('删除最后保存超过 30 天或已损坏的草稿，保留近期的；没有 savedAt 的从现在起计时', () => {
    localStorage.setItem(draftKeyForUser(1, 'reply:1'), draft(NOW - DRAFT_MAX_AGE_MS - 1));
    localStorage.setItem(draftKeyForUser(2), draft(NOW - DRAFT_MAX_AGE_MS + 60_000));
    localStorage.setItem(draftKeyForUser(3), draft());
    localStorage.setItem(draftKeyForUser(4), '{broken');
    localStorage.setItem(draftKeyForUser(5), draft('yesterday'));
    localStorage.setItem('hpc-compose-send-attempt:1', '{"key":"k"}');
    expect(purgeExpiredDrafts(NOW)).toBe(3);
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:1'))).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(2))).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(draftKeyForUser(3))!)).toMatchObject({ subject: 's', savedAt: NOW });
    expect(localStorage.getItem(draftKeyForUser(4))).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(5))).toBeNull();
    // 只管草稿
    expect(localStorage.getItem('hpc-compose-send-attempt:1')).toBe('{"key":"k"}');
    // 补写的 savedAt 让旧版草稿 30 天后同样被回收
    expect(purgeExpiredDrafts(NOW + DRAFT_MAX_AGE_MS + 1)).toBe(2);
    expect(localStorage.length).toBe(1);
  });
});
