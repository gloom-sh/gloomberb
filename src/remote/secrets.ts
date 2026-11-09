/**
 * Words that name a credential wherever they appear in a name: a password or
 * passphrase, a secret, a token, an API or private key, a cookie.
 */
const SECRET_PART = /(pass(word|phrase)?|secret|token|api[-_ ]?key|private[-_ ]?key|credential|cookie)/i;

/**
 * Short words that name a credential only on their own: a PIN, a one-time
 * code, a bearer token or JWT, a wallet's mnemonic or seed phrase. Inside a
 * longer word or a camelCase name they mean something else ("pinned",
 * "spinner", "pinTicker", "seedSymbols"), so only a whole word between
 * separators counts: "PIN", "Trading PIN", "otp_code", "Seed phrase".
 */
const SECRET_WORD = /(?:^|[^a-z0-9])(?:pin|otp|bearer|jwt|mnemonic|seed)(?:[^a-z0-9]|$)/i;

/**
 * Whether a name names a credential. Matched against the keys of free-form
 * maps and against a form field's id, label and placeholder, so what such a
 * field holds is withheld wherever remote control lists it.
 */
function isSecretName(name: string): boolean {
  return SECRET_PART.test(name) || SECRET_WORD.test(name);
}

/** Whether any of these texts names a credential. */
export function namesSecret(...texts: unknown[]): boolean {
  return texts.some((text) => typeof text === "string" && isSecretName(text));
}
