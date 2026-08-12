/**
 * Token accounting and cost estimation.
 *
 * IMPORTANT — these are *estimates*, not billing data. MeshAPI does not return
 * a price with the completion, so cost is derived from the static table below.
 * Treat the numbers as an order-of-magnitude guide for the speed/cost tradeoff
 * the UI surfaces, not as an invoice. Prices are USD per 1M tokens and were
 * recorded from public list pricing; they drift, so keep them in one place.
 */

/** @type {Record<string, {input: number, output: number}>} USD per 1M tokens. */
export const PRICE_TABLE = {
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/gpt-4.1": { input: 2, output: 8 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "anthropic/claude-3-5-sonnet": { input: 3, output: 15 },
  "anthropic/claude-3-5-haiku": { input: 0.8, output: 4 },
  "anthropic/claude-3-opus": { input: 15, output: 75 },
  "google/gemini-1.5-pro": { input: 1.25, output: 5 },
  "google/gemini-1.5-flash": { input: 0.075, output: 0.3 },
};

/** Used when a model isn't in the table — mid-range, so estimates stay sane. */
export const FALLBACK_PRICE = { input: 1, output: 3 };

export function priceFor(model) {
  return PRICE_TABLE[model] ?? FALLBACK_PRICE;
}

/** True when the model's price is a guess rather than a table entry. */
export function isEstimatedPrice(model) {
  return !(model in PRICE_TABLE);
}

/**
 * Cost in USD for a completion.
 * Rounded to 6dp — sub-microdollar precision is noise.
 */
export function estimateCostUsd({ model, promptTokens = 0, completionTokens = 0 }) {
  const { input, output } = priceFor(model);
  const cost = (promptTokens / 1e6) * input + (completionTokens / 1e6) * output;
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * Rough token count for text.
 *
 * A real tokenizer (tiktoken) is a heavy native dep and would still be wrong
 * for non-OpenAI models on the router. ~4 chars/token is close enough for
 * budgeting a context pack and estimating cost when the API omits usage.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/** Sum usage across many calls, e.g. every member of a council run. */
export function sumUsage(entries = []) {
  return entries.reduce(
    (acc, e) => ({
      promptTokens: acc.promptTokens + (e.promptTokens || 0),
      completionTokens: acc.completionTokens + (e.completionTokens || 0),
      costUsd: Math.round((acc.costUsd + (e.costUsd || 0)) * 1e6) / 1e6,
    }),
    { promptTokens: 0, completionTokens: 0, costUsd: 0 },
  );
}

/**
 * Normalise the various usage shapes providers return.
 * Falls back to character-estimation when usage is absent (common when
 * streaming), so a cost is always recorded.
 */
export function normalizeUsage(usage, { model, promptText = "", completionText = "" } = {}) {
  const promptTokens =
    usage?.prompt_tokens ?? usage?.promptTokens ?? estimateTokens(promptText);
  const completionTokens =
    usage?.completion_tokens ?? usage?.completionTokens ?? estimateTokens(completionText);
  return {
    promptTokens,
    completionTokens,
    costUsd: estimateCostUsd({ model, promptTokens, completionTokens }),
    estimated: !usage,
  };
}
