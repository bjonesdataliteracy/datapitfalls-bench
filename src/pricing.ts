// Prices in USD per million tokens, used for budget caps and cost reports.
// Checked 2026-11-03. Prices change: confirm against the provider's price
// list before trusting a cost figure, and add a row for any other model.

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

export const PRICES: Record<string, Price> = {
  'claude-fable-5-2': price(8, 40, 0.2),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-sonnet-5-5': price(2, 10, 0.1),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-sonnet-4-6': price(3, 15, 0.3),
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function priceFor(model: string): Price {
  const found = PRICES[model];
  if (!found) {
    throw new Error(
      `No price is recorded for model "${model}", so its cost cannot be capped. Add it to src/pricing.ts.`
    );
  }
  return found;
}

/** Cost of some usage on a model, in USD. */
export function costUsd(model: string, usage: Usage): number {
  const p = priceFor(model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
