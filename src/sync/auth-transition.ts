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
  onAccountChange: () => void,
): () => void {
  let accountId = session.getCurrentUser()?.id ?? null;
  let wasVerified = session.getVerifiedSessionIdentity() !== null;
  return session.subscribeCurrentUser(() => {
    // A native session check may temporarily return no user while its retained
    // token is validated. That is not a sign-out or a different account.
    const nextAccountId = session.getCurrentUser()?.id ?? (session.isSignedIn() ? accountId : null);
    const accountChanged = nextAccountId !== accountId;
    const resetAccount = accountChanged && accountId !== null;
    const isVerified = session.getVerifiedSessionIdentity() !== null;
    const becameVerified = isVerified && (!wasVerified || accountChanged);
    accountId = nextAccountId;
    wasVerified = isVerified;
    // Clear the old account before a new one can pull or push, including a
    // direct switch between two verified sessions without a sign-out event.
    // The initial session restore keeps the baseline needed by offline edits.
    if (resetAccount) onAccountChange();
    if (becameVerified) onVerified();
  });
}
