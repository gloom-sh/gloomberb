import { ProWall, SignInWall } from "../cloud/auth-actions";

/**
 * Options flow is the one scanner with no delayed tier to fall back to, so a
 * refusal is a call to action. Signed-out users need to sign in, not upgrade.
 */
export function ScannerDeniedState({ reason }: { reason: string | null }) {
  if (reason === "auth_required") {
    return <SignInWall action="stream the market scanners" />;
  }

  return (
    <ProWall
      title="Options flow is part of Gloom Cloud Pro."
      message="Real-time sweeps, blocks and large premium prints across US options exchanges."
    />
  );
}
