type Arm = "control" | "teaser" | null;
type TeaserKind = "summary" | "sample" | "none";
const active = new Map<string, Set<object>>();

/** Keeps a short visit measurable even if its optional teaser never finishes loading. */
export function trackWallView({ identity, placement, exposure, currentIdentity, record }: {
  identity: string;
  placement: string;
  exposure: Promise<Arm>;
  currentIdentity(): string;
  record(placement: string, teaserKind?: TeaserKind): void;
}) {
  const key = `${identity}:${placement}`;
  const token = {};
  const copies = active.get(key) ?? new Set<object>();
  copies.add(token);
  active.set(key, copies);
  let released = false;
  let reported = false;
  const answer = exposure.catch(() => null);

  return {
    exposure: answer,
    report(teaserKind?: TeaserKind) {
      if (released || reported || currentIdentity() !== identity) return;
      reported = true;
      record(placement, teaserKind);
    },
    release() {
      if (released) return;
      released = true;
      copies.delete(token);
      if (copies.size === 0) active.delete(key);
      if (reported) return;
      void answer.then((arm) => {
        // A replacement or another copy will report what actually finishes
        // rendering. Do not let an older ticker/size request win with "none".
        if (active.has(key) || currentIdentity() !== identity) return;
        record(placement, arm === "teaser" ? "none" : undefined);
      });
    },
  };
}
