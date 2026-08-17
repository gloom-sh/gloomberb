export interface CloudSessionLifecycle {
  isVerified(): boolean;
  subscribeCurrentUser(listener: () => void): () => void;
}

/**
 * Runs exactly when a signed-in desktop session becomes verified. It deliberately
 * ignores ordinary account and entitlement refreshes so they cannot re-run the
 * initial sync pull and push.
 */
export function subscribeToCloudVerification(
  session: CloudSessionLifecycle,
  onVerified: () => void,
): () => void {
  let wasVerified = session.isVerified();
  return session.subscribeCurrentUser(() => {
    const isVerified = session.isVerified();
    const becameVerified = !wasVerified && isVerified;
    wasVerified = isVerified;
    if (becameVerified) onVerified();
  });
}
