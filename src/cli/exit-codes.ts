/** What `gloom <command>` exits with, as `gloom help` lists them. */
export const CLI_EXIT_CODES = {
  ok: 0,
  /** Bad input, nothing found, a failed check, or an unexpected error. */
  error: 1,
  /** `shot --strict` saved its image, but the pane had no usable data to show. */
  unusableShot: 2,
} as const;
