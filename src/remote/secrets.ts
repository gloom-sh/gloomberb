/**
 * Words that name a credential: a password or passphrase, a secret, a token,
 * an API or private key, a cookie. Matched against the keys of free-form maps
 * and against a form field's id, label and placeholder, so what such a field
 * holds is withheld wherever remote control lists it.
 */
export const SECRET_NAME = /(pass(word|phrase)?|secret|token|api[-_ ]?key|private[-_ ]?key|credential|cookie)/i;

/** Whether any of these texts names a credential. */
export function namesSecret(...texts: unknown[]): boolean {
  return texts.some((text) => typeof text === "string" && SECRET_NAME.test(text));
}
