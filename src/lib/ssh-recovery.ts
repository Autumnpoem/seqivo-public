export type SshRecoveryIdentity = {hostId:string;hostRevision:number;session:{id:string;server:string}};

export const SSH_RECOVERY_MAX_TICKETS=3;
export const SSH_RECOVERY_WINDOW_MS=5*60*1000;

export function sameSshRecovery(a:SshRecoveryIdentity,b:SshRecoveryIdentity):boolean {
  return a.hostId===b.hostId&&a.hostRevision===b.hostRevision&&
    a.session.id===b.session.id&&a.session.server===b.session.server;
}

export function sshRecoveryProbeDelay(failedProbes:number):number {
  return failedProbes===0?10000:failedProbes===1?20000:30000;
}

export function sshRecoveryCanIssueTicket(ticketAttempts:number,startedAt:number,now:number):boolean {
  return ticketAttempts<SSH_RECOVERY_MAX_TICKETS&&now-startedAt<SSH_RECOVERY_WINDOW_MS;
}

export function isSshNetworkFailure(error:unknown):boolean {
  return error instanceof TypeError&&/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(error.message);
}
