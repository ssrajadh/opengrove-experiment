export const GEMINI_MODELS: Record<string, string> = {
  "gemini-2.0-flash": "gemini-2.0-flash",
  "gemini-2.0-flash-lite": "gemini-2.0-flash-lite",
  "gemini-3-flash-preview": "gemini-3-flash-preview",
  "gemini-3-pro-preview": "gemini-3-pro-preview",
};

export const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];

/**
 * Per-token pricing in USD per 1 token.
 * Prices sourced from provider pricing pages (per 1M tokens divided by 1e6).
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  "gpt-4o":        { input: 2.50  / 1e6, output: 10.00 / 1e6 },
  "gpt-4o-mini":   { input: 0.15  / 1e6, output: 0.60  / 1e6 },
  "gpt-4.1":       { input: 2.00  / 1e6, output: 8.00  / 1e6 },
  "gpt-4.1-mini":  { input: 0.40  / 1e6, output: 1.60  / 1e6 },
  // Gemini
  "gemini-2.0-flash":       { input: 0.10  / 1e6, output: 0.40  / 1e6 },
  "gemini-2.0-flash-lite":  { input: 0.075 / 1e6, output: 0.30  / 1e6 },
  "gemini-3-flash-preview": { input: 0.15  / 1e6, output: 0.60  / 1e6 },
  "gemini-3-pro-preview":   { input: 1.25  / 1e6, output: 10.00 / 1e6 },
};

/** Calculate cost in USD for a given model and token counts. Returns 0 for unknown/local models. */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return inputTokens * pricing.input + outputTokens * pricing.output;
}
