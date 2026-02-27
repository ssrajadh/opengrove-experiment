import nlp from "compromise";

// ---------------------------------------------------------------------------
// Regex-based PII patterns
// ---------------------------------------------------------------------------

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // SSN: 123-45-6789
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },

  // Credit card: 13-19 digits with optional spaces/dashes
  {
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g,
    replacement: "[CREDIT_CARD]",
  },

  // Email
  { pattern: /[\w.+-]+@[\w.-]+\.\w{2,}/g, replacement: "[EMAIL]" },

  // Phone: US formats — (555) 123-4567, 555-123-4567, +1 555 123 4567, etc.
  {
    pattern:
      /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    replacement: "[PHONE]",
  },

  // US street address: "123 Main St", "456 Oak Avenue, Apt 7", etc.
  {
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][a-zA-Z]*\s*){1,4}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Ct|Court|Pl(?:ace)?|Way|Cir(?:cle)?|Terr(?:ace)?|Pkwy|Parkway)\.?\b(?:[,\s]+(?:Apt|Suite|Ste|Unit|#)\s*\w+)?/gi,
    replacement: "[ADDRESS]",
  },
];

// ---------------------------------------------------------------------------
// NLP-based name detection
// ---------------------------------------------------------------------------

function redactNames(text: string): string {
  const doc = nlp(text);
  const people = doc.people().out("array") as string[];

  // Deduplicate and sort longest-first so longer names are replaced before
  // their substrings (e.g. "John Smith" before "John").
  const unique = Array.from(new Set(people)).sort((a, b) => b.length - a.length);

  let result = text;
  for (const name of unique) {
    if (name.length < 2) continue;
    // Replace all occurrences of this name, preserving word boundaries
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[NAME]");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan text for PII and replace detected instances with bracketed placeholders.
 * Runs entirely locally — no network calls.
 *
 * Detection covers: emails, phone numbers, SSNs, credit card numbers,
 * US street addresses, and person names (via NLP).
 */
export function redactPII(text: string): string {
  let result = text;

  // 1. Regex-based redaction first (structured PII)
  for (const { pattern, replacement } of PII_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  // 2. NLP-based name detection on the remaining text
  result = redactNames(result);

  return result;
}
