import test from 'node:test';
import assert from 'node:assert/strict';
import {isSshNetworkFailure, sameSshRecovery, sshRecoveryCanIssueTicket,
  sshRecoveryProbeDelay, SSH_RECOVERY_WINDOW_MS} from '../src/lib/ssh-recovery.ts';

class HttpFailure extends Error {
  constructor(status,code){super(code);this.status=status;this.code=code;}
}

test('only recognized network transport failures qualify for bounded exact-session recovery',()=>{
  const original={hostId:'host-A',hostRevision:4,session:{id:'$6',server:'a'.repeat(64)}};
  assert.equal(sameSshRecovery(original,{...original,session:{...original.session}}),true);
  assert.equal(sameSshRecovery(original,{...original,hostRevision:5}),false);
  assert.equal(sameSshRecovery(original,{...original,session:{...original.session,id:'$7'}}),false);
  assert.equal(sameSshRecovery(original,{...original,session:{...original.session,server:'b'.repeat(64)}}),false);
  assert.equal(isSshNetworkFailure(new TypeError('Failed to fetch')),true);
  assert.equal(isSshNetworkFailure(new TypeError('Network request failed')),true);
  assert.equal(isSshNetworkFailure(new HttpFailure(401,'SSH_UNAUTHORIZED')),false);
  assert.equal(isSshNetworkFailure(new HttpFailure(409,'SSH_CONFLICT')),false);
  assert.equal(isSshNetworkFailure(new Error('连接状态待确认')),false);
  assert.equal(isSshNetworkFailure(new Error('桌面服务未能完成请求')),false);
  assert.equal(sshRecoveryCanIssueTicket(0,1000,1000),true);
  assert.equal(sshRecoveryCanIssueTicket(2,1000,1000),true);
  assert.equal(sshRecoveryCanIssueTicket(3,1000,1000),false);
  assert.equal(sshRecoveryCanIssueTicket(1,1000,1000+SSH_RECOVERY_WINDOW_MS),false);
  assert.deepEqual([0,1,2,9].map(sshRecoveryProbeDelay),[10000,20000,30000,30000]);
});
