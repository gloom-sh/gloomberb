/**
 * Whether ATTN is listed: in command-bar search, Help, `gloom catalog` and
 * search, the plugin directory and chat suggestions, and its two screener
 * fields (ATTN HRS, ATTN Z) in the EQS field and metric pickers.
 *
 * Research attention publishes an hour only once enough contributing users
 * researched in it, and it has published nothing for weeks, so ATTN stays
 * unlisted until it does. Typing ATTN still opens it, a screen that already
 * uses its fields keeps them, and the Attention Counts setting and its
 * collection are unchanged. Set it to true the day ATTN publishes again,
 * with the server's own switch, and refresh the docs snapshot
 * (`bun run docs:snapshot`) once the site lists ATTN.
 */
export const ATTENTION_LISTED = false;
