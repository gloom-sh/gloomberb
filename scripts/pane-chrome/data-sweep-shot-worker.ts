import { installShotPageFactory } from "../../src/cli/desktop-pane-shot-browser";

if (!process.send || !process.connected) throw new Error("Sweep shots require a private IPC channel to their browser owner.");

let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
process.on("message", (reply: { id: number; error?: string; value?: unknown }) => {
  const call = pending.get(reply.id);
  if (!call) return;
  pending.delete(reply.id);
  if (pending.size === 0) process.channel?.unref();
  if (reply.error !== undefined) call.reject(new Error(reply.error));
  else call.resolve(reply.value);
});
process.on("disconnect", () => {
  for (const call of pending.values()) call.reject(new Error("Sweep browser owner disconnected."));
  pending.clear();
});
process.channel?.unref();

function request(body: object): Promise<unknown> {
  if (!process.connected) return Promise.reject(new Error("Sweep browser owner disconnected."));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    process.channel?.ref();
    pending.set(id, { resolve, reject });
    process.send!({ id, ...body }, (error: Error | null) => {
      if (!error) return;
      pending.delete(id);
      if (pending.size === 0) process.channel?.unref();
      reject(error);
    });
  });
}

installShotPageFactory(async () => ({
  page: { send: (method, params) => request({ method, params }) },
  async open(url) { await request({ method: "open", url }); },
  async close() {},
}));
