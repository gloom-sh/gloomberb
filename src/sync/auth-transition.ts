export interface CloudSessionLifecycle {
  getCurrentUser(): { id: string } | null;
  isSignedIn(): boolean;
  getVerifiedSessionIdentity(): object | null;
  subscribeCurrentUser(listener: () => void): () => void;
}

/** Starts a first merge for a newly verified account, ignoring ordinary user and entitlement refreshes. */
export function subscribeToCloudVerification(
  session: CloudSessionLifecycle,
  onVerified: () => void,
  onAccountChange: (accountId: string) => void,
  onSuspended?: () => void,
): () => void {
  let accountId = session.getCurrentUser()?.id ?? null;
  let wasVerified = session.getVerifiedSessionIdentity() !== null;
  return session.subscribeCurrentUser(() => {
    const isVerified = session.getVerifiedSessionIdentity() !== null;
    const nextAccountId = isVerified ? session.getCurrentUser()?.id ?? null : null;
    const accountChanged = nextAccountId !== null && nextAccountId !== accountId;
    const becameVerified = isVerified && (!wasVerified || accountChanged);
    const becameSuspended = wasVerified && !isVerified;
    const resetAccount = accountChanged && accountId !== null;
    // Sign-out and failed validation retire pending work, but keep the last
    // account's merge history until a different account is confirmed.
    if (nextAccountId !== null) accountId = nextAccountId;
    wasVerified = isVerified;
    if (becameSuspended) onSuspended?.();
    if (resetAccount) onAccountChange(nextAccountId!);
    if (becameVerified) onVerified();
  });
}
