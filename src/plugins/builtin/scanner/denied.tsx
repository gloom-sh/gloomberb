import { ProWall, SignInWall } from "../cloud/auth-actions";
import { FLOW_FREE, FLOW_PRO_NOTE } from "../shared/options-pro-copy";

/**
 * Options flow is the one scanner with no delayed tier to fall back to, so a
 * refusal is a call to action. Signed out, FLOW still asks for a sign-in
 * first, but says it is Pro: a free account would not stream it. The highs
 * and lows scanner has a delayed tier, so a sign-in is all it asks.
 */
export function ScannerDeniedState({ scanner, reason, placement, width, height }: {
  scanner: "flow" | "hilo";
  reason: string | null;
  placement: string;
  width: number;
  height: number;
}) {
  const flow = scanner === "flow";
  if (reason === "auth_required") {
    return <SignInWall placement={`${placement.replace(/-wall$/, "")}-signin`} width={width} height={height}
      action={flow ? "stream options flow with Gloom Cloud Pro" : "stream the market scanners"}
      hint={flow ? FLOW_PRO_NOTE : undefined} />;
  }

  return (
    <ProWall
      placement={placement}
      width={width} height={height}
      title="Options flow is part of Gloom Cloud Pro."
      message={`Real-time sweeps, blocks and large premium prints across US options exchanges.${flow ? ` ${FLOW_FREE}` : ""}`}
    />
  );
}
