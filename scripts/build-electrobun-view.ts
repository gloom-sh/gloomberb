import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  electrobunViewPath,
  writeElectrobunViewPage,
} from "../src/renderers/electrobun/view/build-assets";

const outdir = join(process.cwd(), "dist", "electrobun-view");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await writeElectrobunViewPage({
  entrypoint: electrobunViewPath("main.tsx"),
  outdir,
  pluginName: "electrobun-renderer-native-bridges",
  failureMessage: "Failed to build Electrobun view assets",
  missingEntryMessage: "Electrobun view build did not produce a JavaScript entrypoint",
  title: "Gloomberb",
  loadingText: "Loading Gloomberb...",
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
      const renderBootstrapError = (error, details = "", source = "bootstrap-error") => {
        if (typeof window.__gloomRenderFatalError === "function") {
          window.__gloomRenderFatalError(error, details, source);
          return;
        }
        const root = document.getElementById("root");
        if (!root) return;
        const message = error && typeof error === "object" && "message" in error ? error.message : String(error);
        const stack = error && typeof error === "object" && "stack" in error ? error.stack : "";
        const errorText = [message, details, stack].filter(Boolean).join("\\n");
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
      window.addEventListener("error", (event) => renderBootstrapError(
        event.error || event.message,
        [event.filename, event.lineno, event.colno].filter(Boolean).join(":"),
        "error",
      ));
      window.addEventListener("unhandledrejection", (event) => renderBootstrapError(event.reason, "", "unhandledrejection"));
      document.getElementById("root").innerHTML = '<div class="gloom-loading">Booting Gloomberb renderer...</div>';
`,
});
