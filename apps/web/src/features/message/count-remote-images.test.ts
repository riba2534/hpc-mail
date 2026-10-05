import { describe, expect, it } from 'vitest';
import { countRemoteImages } from './count-remote-images';

describe('countRemoteImages', () => {
  it('只统计 http/https 远程图片，忽略 data:/cid:/相对路径', () => {
    const html = `
      <img src="https://cdn.example.com/a.png">
      <img src='http://track.example.com/pixel.gif'>
      <img src="data:image/png;base64,AAAA">
      <img src="cid:logo@x">
      <img src="/local/b.png">
    `;
    expect(countRemoteImages(html)).toBe(2);
  });

  it('空字符串或无图片返回 0', () => {
    expect(countRemoteImages('')).toBe(0);
    expect(countRemoteImages('<p>hello</p>')).toBe(0);
  });
  it('counts protocol-relative and srcset-only images once', () => {
    expect(countRemoteImages('<img src="//track.example.com/a"><img srcset="https://track.example.com/b 1x, https://track.example.com/c 2x"><img src="https://track.example.com/d" srcset="https://track.example.com/e 2x">')).toBe(3);
  });
});
