import { beforeEach, describe, expect, it } from 'vitest';
import { draftKeyForUser, identityKeyForUser, lastIdentityKeyForUser, legacyDraftKeyForUser } from '@/features/compose/compose-draft';
import { sendAttemptKeyForUser } from '@/features/compose/send-attempt';
import { trustSender } from '@/lib/trusted-senders';
import { queryCacheStorageKey } from './query-persistence';
import { clearUserLocalData } from './user-local-data';

beforeEach(() => localStorage.clear());

function seedUser(userId: number) {
  localStorage.setItem(draftKeyForUser(userId), '{}');
  localStorage.setItem(draftKeyForUser(userId, 'reply:42'), '{}');
  localStorage.setItem(legacyDraftKeyForUser(userId), '{}');
  localStorage.setItem(sendAttemptKeyForUser(userId), '{}');
  localStorage.setItem(identityKeyForUser(userId), '{}');
  localStorage.setItem(lastIdentityKeyForUser(userId), '{}');
  localStorage.setItem(queryCacheStorageKey(userId), '{}');
  trustSender('friend@example.com', userId);
}

describe('clearUserLocalData', () => {
  it('删除该账户在本机的全部 hpc-* 数据，其他账户（含 uid 前缀相同的）与无关的键不动', () => {
    seedUser(1);
    seedUser(11);
    seedUser(2);
    localStorage.setItem('token', 'jwt');
    localStorage.setItem('other-app', 'x');
    const before = localStorage.length;

    clearUserLocalData(1);
    const left = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!);
    expect(left.some((key) => /^hpc-[a-z-]+:(?:v\d+:)?1(?::|$)/.test(key))).toBe(false);
    expect(left).toHaveLength(before - 8);
    expect(left).toContain(draftKeyForUser(11));
    expect(left).toContain('hpc-trusted-image-senders:11');
    expect(left).toContain(queryCacheStorageKey(2));
    expect(left).toEqual(expect.arrayContaining(['token', 'other-app']));
  });
});
