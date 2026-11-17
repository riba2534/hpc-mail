import { describe, expect, it } from 'vitest';
import { isBlockedHost, isForbiddenAddress, isInternalHostname } from '../src/lib/ssrf.js';

// URL 附件、Webhook 与 PushDeer 共用的判定：两边原有拒绝规则取并集
describe('isBlockedHost', () => {
  it.each([
    // IP 字面量（含 URL.hostname 的方括号形式）
    '127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[ff02::1]', '[::ffff:7f00:1]', '[::7f00:1]', '[64:ff9b::a00:1]',
    '[2002:a00:1::]', '[2001::1]', '[2001:db8::1]', '[fe80::1%25eth0]',
    // 内网主机名与通配 DNS 服务
    'localhost', 'LOCALHOST.', 'intranet', 'printer.local', 'db.internal', 'metadata.google.internal', 'nas.home', 'router.home.arpa',
    'box.lan', 'wiki.intranet', 'a.localhost', 'nip.io', '127.0.0.1.nip.io', '10.0.0.1.sslip.io', 'app.localtest.me', 'x.lvh.me', 'y.vcap.me',
  ])('拒绝 %s', (host) => expect(isBlockedHost(host)).toBe(true));

  it.each([
    'hooks.example.com', 'example.com.', 'home.example.com', 'local.example.com', '8.8.8.8', '93.184.216.34', '172.32.0.1',
    '100.128.0.1', '[2606:4700::1111]', '[::ffff:808:808]', '[2002:808:808::1]',
  ])('放行 %s', (host) => expect(isBlockedHost(host)).toBe(false));

  it('192.0.0.0/16 只拦 IANA 特殊用途的 192.0.0.0/24 与 192.0.2.0/24，其余是公网（如 wp.com 的 192.0.64.0/18）', () => {
    expect(isForbiddenAddress('192.0.78.9')).toBe(false);
    expect(isBlockedHost('192.0.78.9')).toBe(false);
    expect(isForbiddenAddress('::ffff:192.0.78.9')).toBe(false);
    for (const ip of ['192.0.0.8', '192.0.2.1', '::ffff:192.0.2.1']) expect(isForbiddenAddress(ip), ip).toBe(true);
    for (const ip of ['192.0.1.1', '192.0.3.1']) expect(isForbiddenAddress(ip), ip).toBe(false);
  });

  it('非 IP 的主机名只看名字规则；IP 字面量按地址判定、解析失败按禁止', () => {
    expect(isInternalHostname('files.example.com')).toBe(false);
    expect(isInternalHostname('files')).toBe(true);
    expect(isForbiddenAddress('not-an-ip')).toBe(true);
    expect(isBlockedHost('[not:an:ip:at:all]')).toBe(true);
  });
});
