import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatDocumentTitle, useDocumentTitle, useTitleOverride } from './use-document-title';

function Reader() {
  return <p data-testid="title">{useTitleOverride() ?? '（路由默认）'}</p>;
}

function Page({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

describe('formatDocumentTitle', () => {
  it('带未读数前缀，0 时省略，过大时截断', () => {
    expect(formatDocumentTitle('收件箱', 'HPC Mail', 45)).toBe('(45) 收件箱 · HPC Mail');
    expect(formatDocumentTitle('个人设置', 'HPC Mail', 0)).toBe('个人设置 · HPC Mail');
    expect(formatDocumentTitle(null, 'HPC Mail', 3)).toBe('(3) HPC Mail');
    expect(formatDocumentTitle('收件箱', 'HPC Mail', 1200)).toBe('(999+) 收件箱 · HPC Mail');
  });
});

describe('useDocumentTitle', () => {
  it('页面覆盖生效、空值不覆盖、卸载后恢复', () => {
    const view = render(
      <>
        <Reader />
        <Page title={null} />
      </>,
    );
    expect(screen.getByTestId('title')).toHaveTextContent('（路由默认）');
    view.rerender(
      <>
        <Reader />
        <Page title="  你的验证码  " />
      </>,
    );
    expect(screen.getByTestId('title')).toHaveTextContent('你的验证码');
    act(() =>
      view.rerender(
        <>
          <Reader />
        </>,
      ),
    );
    expect(screen.getByTestId('title')).toHaveTextContent('（路由默认）');
  });
});
