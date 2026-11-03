/** One command-bar prefix described for `/assist/command`. */
export interface AssistCommandDescriptor {
  prefix: string;
  name: string;
  description?: string;
  arg?: {
    placeholder?: string;
    kind: "text" | "ticker" | "ticker-list";
    /** The command also runs with no argument at all. */
    optional?: boolean;
    /** Named values the argument accepts; a command may take others too (COT takes any CFTC code). */
    options?: { value: string; label: string }[];
  };
}

/** A command-bar line the assistant believes answers the query. */
export interface AssistCommandCandidate {
  /** Exact command-bar text to run, e.g. "G NVDA AMD". */
  input: string;
  title: string;
  prefix: string;
  confidence: number;
}

export interface AssistCommandResponse {
  candidates: AssistCommandCandidate[];
  /**
   * The server's record of this ask, for the command-search report to point
   * at. Only present when the ask was sent with `log: true`.
   */
  searchId?: string;
}
