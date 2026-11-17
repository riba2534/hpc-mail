import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@hpc-mail/shared';
import { IdentityPicker, type IdentityPickerProps } from './identity-picker';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

const box = (id: number, address: string) => ({ id, address }) as Mailbox;
const MAILBOXES = [box(1, 'zed@b.test'), box(2, 'amy@c.test'), box(3, 'bob@a.test')];

function show(patch: Partial<IdentityPickerProps> = {}) {
  const props: IdentityPickerProps = {
    isAdmin: false,
    mailboxes: MAILBOXES,
    domains: ['c.test', 'a.test', 'b.test'],
    mailboxId: null,
    onMailboxId: vi.fn(),
    localPart: '',
    onLocalPart: vi.fn(),
    domain: 'c.test',
    onDomain: vi.fn(),
    id: 'from',
    ...patch,
  };
  render(<IdentityPicker {...props} />);
  return props;
}

const optionNames = () => within(screen.getByRole('listbox')).getAllByRole('option').map((option) => option.textContent);

describe('IdentityPicker', () => {
  it('普通用户的发件地址按字典序排列，可搜索后选择', () => {
    const props = show();
    fireEvent.click(screen.getByRole('combobox', { name: /发件地址/ }));
    expect(optionNames()).toEqual(['amy@c.test', 'bob@a.test', 'zed@b.test']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'b.test' } });
    expect(optionNames()).toEqual(['zed@b.test']);
    fireEvent.click(screen.getByRole('option', { name: 'zed@b.test' }));
    expect(props.onMailboxId).toHaveBeenCalledWith(1);
  });

  it('管理员：「自定义发件地址」置顶，其后的邮箱与发件域名都按字典序', () => {
    const props = show({ isAdmin: true });
    fireEvent.click(screen.getByRole('combobox', { name: /发件身份/ }));
    expect(optionNames()).toEqual(['自定义发件地址', 'amy@c.test', 'bob@a.test', 'zed@b.test']);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('combobox', { name: '发件域名' }));
    expect(optionNames()).toEqual(['a.test', 'b.test', 'c.test']);
    fireEvent.click(screen.getByRole('option', { name: 'a.test' }));
    expect(props.onDomain).toHaveBeenCalledWith('a.test');
  });

  it('普通用户没有托管域名时只有已认领邮箱，没有自定义前缀', () => {
    show({ hostedDomains: [] });
    expect(screen.queryByRole('combobox', { name: /发件身份/ })).toBeNull();
    expect(screen.queryByText(/任意前缀/)).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: /发件地址/ }));
    expect(optionNames()).toEqual(['amy@c.test', 'bob@a.test', 'zed@b.test']);
  });

  it('托管域名所有者：任意前缀一项置顶，域名只在自己的托管域名里选，并说明发出时自动认领', () => {
    const props = show({ domains: ['own.test'], hostedDomains: ['own.test'], domain: 'own.test' });
    expect(screen.getByText('用 own.test 的任意前缀发信（发出时自动认领）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: /发件身份/ }));
    expect(optionNames()).toEqual(['用 own.test 的任意前缀发信', 'amy@c.test', 'bob@a.test', 'zed@b.test']);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    fireEvent.change(screen.getByPlaceholderText('前缀'), { target: { value: ' Sales ' } });
    expect(props.onLocalPart).toHaveBeenCalledWith('sales');
    fireEvent.click(screen.getByRole('combobox', { name: '发件域名' }));
    expect(optionNames()).toEqual(['own.test']);
  });

  it('托管域名有多个且还没选域名时，提示先选域名', () => {
    show({ domains: ['two.test', 'one.test'], hostedDomains: ['two.test', 'one.test'], domain: '' });
    expect(screen.getByText('选择你托管的域名，前缀可任意填写（发出时自动认领）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: /发件身份/ }));
    expect(optionNames()[0]).toBe('用托管域名的任意前缀发信');
  });

  it('管理员有托管域名时仍是「自定义发件地址」，域名选项由调用方给出', () => {
    show({ isAdmin: true, domains: ['c.test', 'own.test'], hostedDomains: ['own.test'] });
    expect(screen.getByText('管理员可用任意前缀 + 系统域名或自己托管的域名发件。')).toBeInTheDocument();
    expect(screen.queryByText(/自动认领/)).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: /发件身份/ }));
    expect(optionNames()[0]).toBe('自定义发件地址');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('combobox', { name: '发件域名' }));
    expect(optionNames()).toEqual(['c.test', 'own.test']);
  });
});
