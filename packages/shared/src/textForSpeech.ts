/**
 * Prepares and sanitizes Markdown and rich text for speech synthesis (TTS).
 *
 * Removes visual-only artifacts and delimiters that confuse TTS models or cause
 * early termination (such as Markdown horizontal rules `---`, which models like
 * Gemini interpret as end-of-turn / EOS boundaries, or raw image paths/URLs).
 */
export function cleanTextForSpeech(raw: string): string {
  if (!raw) return "";

  let text = raw;

  // 1. Remove HTML comments: <!-- ... -->
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 2. Remove HTML tags: <details>, <div>, etc. (preserve standalone `<` or `>` comparisons)
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // 3. Remove horizontal rules: lines with 3+ hyphens, asterisks, or underscores (e.g. `---`, `***`, `___`)
  // These cause Gemini TTS to hit premature EOS / finishReason: "STOP".
  text = text.replace(/^(\s*[-*_]\s*){3,}$/gm, "");

  // 4. Remove image tags, keeping alt text if present: ![alt](url) -> alt.
  text = text.replace(/!\[(.*?)\]\([^)]*\)/g, (_, alt) => {
    const trimmed = alt.trim();
    return trimmed ? `${trimmed}.\n` : "";
  });

  // 5. Clean Markdown links: [text](url) -> text
  text = text.replace(/\[(.*?)\]\([^)]*\)/g, "$1");

  // 6. Remove code block fences: ```ts or ```
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*$/gm, "");

  // 7. Clean header prefixes: `# Header` -> `Header`
  text = text.replace(/^#{1,6}\s+/gm, "");

  // 8. Clean blockquotes: `> text` -> `text`
  text = text.replace(/^>\s*/gm, "");

  // 9. Clean bold and double-underscore formatting: **word** -> word, __word__ -> word
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");

  // 10. Clean inline code backticks: `code` -> code
  text = text.replace(/`([^`]+)`/g, "$1");

  // 11. Clean LaTeX inline math: $2\text{ mm}$ -> 2 mm
  text = text.replace(/\$([^$]+)\$/g, (_, formula) => {
    return formula.replace(/\\text\{([^}]+)\}/g, "$1").replace(/\\/g, "");
  });

  // 12. Normalize whitespace: collapse 3+ consecutive newlines into 2
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
