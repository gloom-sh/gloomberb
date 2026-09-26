import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "../cli/options";
import type { CliResult, CliResultRenderOptions } from "../cli/result";
import type { CliCommandContext } from "../types/plugin";

export interface PrintedCliResult {
  result: CliResult<any>;
  options?: CliResultRenderOptions<any, any>;
}

/**
 * A command context whose `initMarketData` resolves to `market` (config, store, dataProvider, ...).
 * `fail` throws, every printResult call is kept in `printed`, and `closeCount` reports how many
 * times the command closed its persistence.
 */
export function createTestCliContext(
  market: Record<string, unknown> = {},
  cliOptions: Partial<CliGlobalOptions> = {},
): { context: CliCommandContext; printed: PrintedCliResult[]; closeCount: () => number } {
  const printed: PrintedCliResult[] = [];
  let closed = 0;
  const context = {
    cliOptions: { ...DEFAULT_CLI_OPTIONS, ...cliOptions },
    initMarketData: async () => ({ persistence: { close: () => { closed += 1; } }, ...market }),
    printResult: (result: CliResult<any>, options?: CliResultRenderOptions<any, any>) => { printed.push({ result, options }); },
    fail: (message: string): never => { throw new Error(message); },
  } as unknown as CliCommandContext;
  return { context, printed, closeCount: () => closed };
}
