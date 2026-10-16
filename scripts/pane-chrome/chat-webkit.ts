import type { Page } from "playwright-core";
import type { Cdp } from "./browser";

/**
 * Translate only the page/input commands used by the existing chat lifecycle
 * and opening probes. Unsupported commands fail instead of simulating results.
 * Profiling and the file-chooser workload remain Chromium-only.
 */
class WebKitPage implements Pick<Cdp, "send" | "on" | "once"> {
  constructor(private readonly page: Page) {}

  async send<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    let result: unknown;
    switch (method) {
      case "Runtime.evaluate":
        result = { result: { value: await this.page.evaluate(params.expression) } };
        break;
      case "Page.addScriptToEvaluateOnNewDocument":
        await this.page.addInitScript({ content: params.source });
        break;
      case "Page.navigate":
        await this.page.goto(params.url, { waitUntil: "load" });
        break;
      case "Page.captureScreenshot":
        result = { data: (await this.page.screenshot()).toString("base64") };
        break;
      case "Emulation.setDeviceMetricsOverride":
        await this.page.setViewportSize({ width: params.width, height: params.height });
        break;
      case "Input.dispatchMouseEvent":
        await this.page.mouse.move(params.x, params.y);
        if (params.type === "mousePressed") await this.page.mouse.down();
        else if (params.type === "mouseReleased") await this.page.mouse.up();
        else if (params.type === "mouseWheel") await this.page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
        else if (params.type !== "mouseMoved") throw new Error(`Unsupported mouse event: ${params.type}`);
        break;
      case "Input.dispatchKeyEvent":
        if (params.type === "keyUp") await this.page.keyboard.up(params.key);
        else await this.page.keyboard.down(params.key);
        break;
      default:
        throw new Error(`Chat WebKit probe does not implement ${method}`);
    }
    return result as T;
  }

  on(method: string, listener: (params: any) => void): void {
    if (method === "Runtime.exceptionThrown") {
      this.page.on("pageerror", (error) => listener({ exceptionDetails: { text: error.message } }));
    } else if (method === "Runtime.consoleAPICalled") {
      this.page.on("console", (message) => listener({ type: message.type(), args: [{ value: message.text() }] }));
    } else throw new Error(`Chat WebKit probe does not implement event ${method}`);
  }

  once<T = any>(method: string): Promise<T> {
    return Promise.reject(new Error(`Chat WebKit probe does not implement event ${method}`));
  }
}

export async function launchChatWebKit(width: number, height: number) {
  const { webkit } = await import("playwright-core");
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    // The fixture has no remote services. Block accidental requests just as the
    // Chromium harness does, without changing WebKit layout or paint settings.
    await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    return { cdp: new WebKitPage(page), close: () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
