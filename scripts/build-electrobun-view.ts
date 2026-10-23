import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  electrobunViewPath,
  writeElectrobunViewPage,
} from "../src/renderers/dom/build-assets";
import { BOOT_FRAME_ELEMENT_ID } from "../src/renderers/dom/boot-frame-page";
import { DESKTOP_BOOT_FRAME_GLOBAL } from "../src/renderers/electrobun/shared/boot-frame";

const outdir = join(process.cwd(), "dist", "electrobun-view");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await writeElectrobunViewPage({
  entrypoint: electrobunViewPath("main.tsx"),
  outdir,
  failureMessage: "Failed to build Electrobun view assets",
  missingEntryMessage: "Electrobun view build did not produce a JavaScript entrypoint",
  title: "Gloomberb",
  // The Bun process hands the main window its frame before the page loads; a
  // window holding a popped-out pane gets none and draws no frame.
  bootFrame: {
    source: `window.${DESKTOP_BOOT_FRAME_GLOBAL}`,
    skip: `window.${DESKTOP_BOOT_FRAME_GLOBAL} === undefined`,
  },
  bootstrapScript: `
      const bootstrapFatalHtml = [
        '<div class="gloom-fatal">',
        '<h1>Gloomberb failed to start</h1>',
        '<div class="gloom-fatal-actions">',
        '<button type="button" data-variant="primary" data-action="reload">Reload window</button>',
        '<button type="button" data-action="copy">Copy error</button>',
        '</div>',
        '<div class="gloom-fatal-status" aria-live="polite"></div>',
        '<pre></pre>',
        '</div>',
      ].join("");
      const resizeObserverLoop = (error, details) => {
        const message = error && typeof error === "object" && "message" in error ? error.message : String(error ?? "");
        return /resizeobserver loop/i.test([message, details].filter(Boolean).join(" "));
      };
      const renderBootstrapError = (error, details = "", source = "bootstrap-error") => {
        if (resizeObserverLoop(error, details)) return;
        if (typeof window.__gloomRenderFatalError === "function") {
          window.__gloomRenderFatalError(error, details, source);
          return;
        }
        const root = document.getElementById("root");
        if (!root) return;
        const message = error && typeof error === "object" && "message" in error ? error.message : String(error);
        const stack = error && typeof error === "object" && "stack" in error ? error.stack : "";
        const errorText = [message, details, stack].filter(Boolean).join("\\n");
        document.getElementById(${JSON.stringify(BOOT_FRAME_ELEMENT_ID)})?.remove();
        root.innerHTML = bootstrapFatalHtml;
        root.querySelector("pre").textContent = errorText;
        root.querySelector('[data-action="reload"]')?.addEventListener("click", () => window.location.reload());
        root.querySelector('[data-action="copy"]')?.addEventListener("click", async () => {
          const status = root.querySelector(".gloom-fatal-status");
          try {
            await navigator.clipboard.writeText(errorText);
            status.textContent = "Error copied.";
          } catch (copyError) {
            status.textContent = "Copy failed.";
          }
        });
      };
      window.addEventListener("error", (event) => {
        const details = [event.filename, event.lineno, event.colno].filter(Boolean).join(":");
        const error = event.error || event.message;
        if (resizeObserverLoop(error, details)) {
          event.preventDefault();
          return;
        }
        renderBootstrapError(error, details, "error");
      });
      window.addEventListener("unhandledrejection", (event) => renderBootstrapError(event.reason, "", "unhandledrejection"));
`,
});
