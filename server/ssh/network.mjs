import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { fail } from './store.mjs';

// BlockList treats IPv4 as mapped IPv6 when matching an IPv6 subnet. Keep the
// families separate so denying ::ffff:0:0/96 does not deny all native IPv4.
const privateIPv4 = new BlockList(), privateIPv6 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) privateIPv4.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privateIPv6.addSubnet(ip, prefix, 'ipv6');

export async function resolveSshTarget(host, allowPrivateTargets = false) {
  let deadline;
  const ips = isIP(host) ? [{ address: host, family: isIP(host) }] :
    await Promise.race([lookup(host, { all: true, verbatim: false }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('SSH DNS timeout')), 8000); deadline.unref?.(); })])
      .finally(() => clearTimeout(deadline));
  const allowed = ips.find(ip => allowPrivateTargets || !(ip.family === 6
    ? privateIPv6.check(ip.address, 'ipv6') : privateIPv4.check(ip.address, 'ipv4')));
  if (!allowed) fail('此服务不允许访问内网地址。请使用电脑直连，或由服务管理员配置专用内网网关。', 'SSH_NETWORK_DENIED', 403);
  return allowed.address; // Pin the resolved address; never resolve again during connect.
}
