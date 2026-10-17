import { logFailure } from "../../utils/log-failure";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logFailure("data.sqlite.json", "Parsing stored JSON failed")(error);
    return null;
  }
}
