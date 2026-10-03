import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { ProWall, SignInWall } from "../cloud/auth-actions";

export interface ProFeatureWallCopy {
  /** The upgrade intent's placement id, e.g. "risk-wall". */
  placement: string;
  /** Finishes "Sign in to …", e.g. "read risk factors". */
  action: string;
  /** The upgrade headline, e.g. "Risk factors are part of Gloom Cloud Pro." */
  title: string;
  /** What Pro unlocks here. */
  message: string;
}

/** A pane's read, passed through so a refusal from the server becomes the wall. */
export type ReadGuard = <T>(read: Promise<T>) => Promise<T>;

/**
 * The wall a Pro-only pane shows in place of its content: sign in, verify,
 * then upgrade. The session's plan decides before anything loads. Reads go
 * through `guard`, so a refusal from the server (a plan that ended while the
 * app was open, an expired session) shows the same wall, not an error.
 */
export function useProFeatureWall(copy: ProFeatureWallCopy): {
  wall: ReactNode;
  guard: ReadGuard;
} {
  const access = usePlanAccess();
  const [refused, setRefused] = useState<number | null>(null);
  // A refusal is about the plan the account had then; a new plan asks again.
  useEffect(() => setRefused(null), [access.signedIn, access.emailVerified, access.hasProAccess]);
  const guard: ReadGuard = useCallback(<T,>(read: Promise<T>) => read.catch((error: unknown) => {
    const status = error instanceof ApiRequestError ? error.status : undefined;
    if (status === 401 || status === 402 || status === 403) setRefused(status);
    throw error;
  }), []);

  let wall: ReactNode = null;
  if (!access.signedIn || refused === 401) {
    wall = <SignInWall action={copy.action} />;
  } else if (!access.emailVerified || refused === 403) {
    wall = <SignInWall action={copy.action} needsVerification />;
  } else if (!access.hasProAccess || refused === 402) {
    wall = <ProWall placement={copy.placement} title={copy.title} message={copy.message} />;
  }
  return { wall, guard };
}
