import { expect, test } from "bun:test";
import { subscribeCapability } from "./capability-subscription";

test("disposing mid-subscribe stops events at once and unsubscribes once the subscribe lands", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  const calls: string[] = [];
  let completeSubscribe!: () => void;
  let listener: ((event: unknown) => void) | null = null;

  const dispose = subscribeCapability({
    subscribe: ({ subscriptionId }) => {
      log.push(`subscribe ${subscriptionId}`);
      return new Promise<void>((resolve) => { completeSubscribe = resolve; });
    },
    unsubscribe: async (subscriptionId) => { log.push(`unsubscribe ${subscriptionId}`); },
    onEvent: (_subscriptionId, next) => {
      listener = next;
      return () => { listener = null; };
    },
  }, {
    subscriptionId: "connection-health",
    capabilityId: "connections",
    operationId: "subscribe",
    onEvent: (event) => events.push(event),
    onSubscribed: () => calls.push("subscribed"),
    onError: () => calls.push("error"),
  });

  listener!("first");
  dispose();
  expect(events).toEqual(["first"]);
  expect(listener).toBeNull();
  // Sent now, it would reach the backend before the subscription exists there.
  expect(log).toEqual(["subscribe connection-health"]);

  completeSubscribe();
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["subscribe connection-health", "unsubscribe connection-health"]);
  expect(calls).toEqual([]);
});
