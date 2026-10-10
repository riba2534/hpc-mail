import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode, qrPath } from './qr-code';

describe('qrPath', () => {
  it('把每行连续深色模块合并成矩形', () => {
    // 3×2：第 0 行 ■■□，第 1 行 □□■
    const cells = [
      [true, true, false],
      [false, false, true],
    ];
    const matrix = { size: 3, get: (x: number, y: number) => Boolean(cells[y]?.[x]) };
    expect(qrPath(matrix)).toBe('M0 0h2v1h-2zM2 1h1v1h-1z');
  });
});

describe('QrCode', () => {
  it('本地生成 otpauth 二维码 SVG，含静区与可访问名称', async () => {
    const uri = 'otpauth://totp/HPC%20Mail:alice?secret=JBSWY3DPEHPK3PXP&issuer=HPC%20Mail';
    render(<QrCode value={uri} label="两步验证二维码" />);
    const svg = await screen.findByRole('img', { name: '两步验证二维码' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    const viewBox = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(viewBox[0]).toBe(-4);
    // 版本 ≥ 2 的二维码边长为 21 + 4k，再加两侧各 4 模块静区
    expect((viewBox[2]! - 8 - 21) % 4).toBe(0);
    expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
  });
});
