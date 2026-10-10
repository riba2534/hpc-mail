import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './avatar';

describe('Avatar', () => {
  it('有 avatarUrl 时渲染图片', () => {
    render(<Avatar avatarUrl="https://cdn.test/a.png" name="alice" />);
    const img = screen.getByRole('img', { name: 'alice' });
    expect(img).toHaveAttribute('src', 'https://cdn.test/a.png');
  });

  it('无 avatarUrl 时回退到用户名首字母，并以 img 角色朗读用户名', () => {
    render(<Avatar avatarUrl={null} name="alice" />);
    const placeholder = screen.getByRole('img', { name: 'alice' });
    expect(placeholder.tagName).toBe('SPAN');
    expect(placeholder).toHaveTextContent('al');
  });
});
