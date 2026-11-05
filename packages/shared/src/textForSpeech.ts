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

/** A preferred spoken language. Absent means the voice follows the text. */
export type SpeechLanguageHint = "de" | "en";

export const SPEECH_LANGUAGE_HINTS: ReadonlyArray<SpeechLanguageHint> = ["de", "en"];

/**
 * Style direction for voice models that take one in the prompt (Gemini). It is a hint, not a
 * lock: passages clearly in another language keep their own pronunciation. The direction is
 * written in the hinted language, since an English lead tilts the voice toward English.
 */
export function speechLanguageDirection(hint: SpeechLanguageHint | undefined): string {
  if (hint === "de") {
    return "Lies den folgenden Text auf Deutsch vor. Passagen, die eindeutig in einer anderen Sprache sind, sprichst du in dieser Sprache:";
  }
  if (hint === "en") {
    return "Read the following text aloud in English. Speak passages that are clearly in another language in that language:";
  }
  return "";
}

/** Prepends the language direction, or returns `text` unchanged without a hint. */
export function withSpeechLanguageDirection(
  text: string,
  hint: SpeechLanguageHint | undefined,
): string {
  const direction = speechLanguageDirection(hint);
  return direction ? `${direction}\n\n${text}` : text;
}

/** Instructions for turning an agent reply into a short spoken status update. */
export function speechSummaryInstructions(hint: SpeechLanguageHint | undefined): string {
  const language =
    hint === "de"
      ? "Answer in German."
      : hint === "en"
        ? "Answer in English."
        : "Answer in the language the reply is written in.";
  return [
    "You turn a coding agent's reply into a short spoken status update for a developer who is listening, not reading.",
    "Use at most two short sentences. Say what was done or found and whether anything needs the developer's attention.",
    "Leave out code, file paths, commands, URLs, lists and formatting. Do not add a greeting or a preamble.",
    language,
  ].join(" ");
}
