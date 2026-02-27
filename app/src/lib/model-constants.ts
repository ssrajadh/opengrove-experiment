export const GEMINI_MODELS: Record<string, string> = {
  "gemini-2.0-flash": "gemini-2.0-flash",
  "gemini-2.0-flash-lite": "gemini-2.0-flash-lite",
  "gemini-3-flash-preview": "gemini-3-flash-preview",
  "gemini-3-pro-preview": "gemini-3-pro-preview",
};

export const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];

/** Cost per million tokens (USD). */
export type ModelPricing = {
  inputPerMToken: number;
  outputPerMToken: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o":        { inputPerMToken: 2.50,  outputPerMToken: 10.00 },
  "gpt-4o-mini":   { inputPerMToken: 0.15,  outputPerMToken: 0.60 },
  "gpt-4.1":       { inputPerMToken: 2.00,  outputPerMToken: 8.00 },
  "gpt-4.1-mini":  { inputPerMToken: 0.40,  outputPerMToken: 1.60 },
  // Gemini
  "gemini-2.0-flash":       { inputPerMToken: 0.10,  outputPerMToken: 0.40 },
  "gemini-2.0-flash-lite":  { inputPerMToken: 0.075, outputPerMToken: 0.30 },
  "gemini-3-flash-preview": { inputPerMToken: 0.15,  outputPerMToken: 0.60 },
  "gemini-3-pro-preview":   { inputPerMToken: 1.25,  outputPerMToken: 5.00 },
};

/** Calculate cost in USD for a given model and token counts. */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMToken +
    (outputTokens / 1_000_000) * pricing.outputPerMToken
  );
}
