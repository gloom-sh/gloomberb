import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pixelChange, type Command, type CommandResult } from "./ui-audit-compare";

/** A fake ImageMagick: `identify` answers per file, `compare` once. */
function fake(identify: Record<string, CommandResult>, compare: CommandResult): Command {
  return (argv) => argv[0] === "identify" ? identify[argv.at(-1)!]! : compare;
}

const ok = (stdout: string, stderr = ""): CommandResult => ({ exitCode: 0, stdout, stderr });
const SIZE = { "a.jpg": ok("1280 800\n"), "b.jpg": ok("1280 800\n") };

describe("pixelChange reads ImageMagick's answers strictly", () => {
  test("exit 1 with a count is a difference, exit 0 is none", () => {
    expect(pixelChange("a.jpg", "b.jpg", fake(SIZE, { exitCode: 1, stdout: "", stderr: "10240" }))).toEqual({ status: "compared", change: 0.01 });
    expect(pixelChange("a.jpg", "b.jpg", fake(SIZE, { exitCode: 0, stdout: "", stderr: "0" }))).toEqual({ status: "compared", change: 0 });
  });

  test("a failed compare, a count with warnings or no count is an error, never 0", () => {
    expect(pixelChange("a.jpg", "b.jpg", fake(SIZE, { exitCode: 2, stdout: "", stderr: "compare: insufficient image data" })).status).toBe("error");
    expect(pixelChange("a.jpg", "b.jpg", fake(SIZE, { exitCode: 1, stdout: "", stderr: "876128compare: Premature end of JPEG file" })).status).toBe("error");
    expect(pixelChange("a.jpg", "b.jpg", fake(SIZE, { exitCode: 1, stdout: "", stderr: "" })).status).toBe("error");
  });

  test("a picture identify cannot read, or reads without a size, is an error", () => {
    const compare = { exitCode: 0, stdout: "", stderr: "0" };
    expect(pixelChange("a.jpg", "b.jpg", fake({ ...SIZE, "b.jpg": { exitCode: 1, stdout: "1280 800\n", stderr: "identify: Premature end of JPEG file" } }, compare)).status).toBe("error");
    expect(pixelChange("a.jpg", "b.jpg", fake({ ...SIZE, "b.jpg": ok("garbage") }, compare)).status).toBe("error");
    expect(pixelChange("a.jpg", "b.jpg", fake({ ...SIZE, "b.jpg": ok("0 800\n") }, compare)).status).toBe("error");
  });

  test("pictures of different sizes are resized, not a pixel count", () => {
    expect(pixelChange("a.jpg", "b.jpg", fake({ ...SIZE, "b.jpg": ok("1280 820\n") }, { exitCode: 2, stdout: "", stderr: "" }))).toEqual({ status: "resized", before: "1280x800", after: "1280x820" });
  });
});

const imageMagick = Bun.which("compare") !== null && Bun.which("identify") !== null && Bun.which("convert") !== null;

test.skipIf(!imageMagick)("with ImageMagick, a truncated after picture is an error and a changed one moves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ui-audit-compare-"));
  try {
    const before = join(dir, "before.jpg"), after = join(dir, "after.jpg"), truncated = join(dir, "truncated.jpg");
    for (const argv of [
      ["convert", "-size", "64x32", "xc:white", before],
      ["convert", "-size", "64x32", "xc:white", "-fill", "black", "-draw", "rectangle 0,0 31,31", after],
    ]) expect(Bun.spawnSync(argv).exitCode).toBe(0);
    const bytes = new Uint8Array(await Bun.file(after).arrayBuffer());
    await Bun.write(truncated, bytes.slice(0, Math.floor(bytes.length / 2)));
    expect(pixelChange(before, before)).toEqual({ status: "compared", change: 0 });
    const moved = pixelChange(before, after);
    expect(moved.status === "compared" && moved.change > 0.4).toBe(true);
    expect(pixelChange(before, truncated).status).toBe("error");
    expect(pixelChange(before, join(dir, "missing.jpg")).status).toBe("error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
