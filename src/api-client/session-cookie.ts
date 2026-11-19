/**
 * The cloud session cookie, under the `__Secure-` name the API sets over HTTPS
 * and the plain one. Kept free of imports so the web worker and the browser
 * bundles can share it without pulling in the API client.
 */
export const SESSION_COOKIE_NAMES = ["__Secure-gloomberb.session_token", "gloomberb.session_token"] as const;

export const SESSION_BINDING_HEADER = "x-gloom-session-binding";
export const SESSION_BINDING_META = "gloom-session-binding";
export const NO_SESSION_COOKIE = "absent";
