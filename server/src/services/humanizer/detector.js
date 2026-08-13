/**
 * Mechanical detection of AI writing tells.
 *
 * Roughly a third of the patterns in the humanizer spec are countable: em
 * dashes, curly quotes, emoji, boldface, title-case headings, specific
 * vocabulary. The rest — inflated significance, superficial analysis, missing
 * voice — are judgement calls that only the model can make.
 *
 * This module does the countable third, and is deliberately honest about that
 * being what it is. The score it produces is a partial signal, never a verdict
 * on quality: text can score zero here and still read like a press release.
 * The UI says so, because a number that looks authoritative while measuring a
 * third of the problem is worse than no number at all.
 */

/** Patterns that are simply counted. */
const REGEX_RULES = [
  {
    id: "em-dash",
    label: "Em dashes",
    severity: "medium",
    note: "Usually a comma, period or parentheses reads more naturally.",
    pattern: /—/g,
  },
  {
    id: "curly-quotes",
    label: "Curly quotation marks",
    severity: "low",
    note: "ChatGPT emits these; most editors and codebases use straight quotes.",
    pattern: /[“”‘’]/g,
  },
  {
    id: "emoji",
    label: "Emoji",
    severity: "medium",
    note: "Decorative emoji in headings and bullets is a strong tell.",
    // U+FE0F (the variation selector) is matched separately: inside the class
    // it combines with the preceding range and trips no-misleading-character-class,
    // which is the rule correctly pointing out that the intent is ambiguous there.
    pattern:
      /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}/gu,
  },
  {
    id: "bold-inline-header",
    label: "Bolded inline list headers",
    severity: "high",
    note: 'Lines like "- **Thing:** description" are a signature LLM list shape.',
    // The colon lands inside the bold as often as outside it:
    //   - **Thing:** text     and     - **Thing**: text
    pattern:
      /^[ \t]*[-*][ \t]*\*\*[^*\n]*?:[ \t]*\*\*|^[ \t]*[-*][ \t]*\*\*[^*\n]+\*\*[ \t]*:/gm,
  },
  {
    id: "negative-parallelism",
    label: "Negative parallelisms",
    severity: "high",
    note: "\"It's not just X, it's Y\" — say the thing directly instead.",
    pattern: /\b(?:it(?:'|’)?s|this is|that(?:'|’)?s)\s+not\s+(?:just|merely|only)\b/gi,
  },
  {
    id: "signposting",
    label: "Signposting",
    severity: "high",
    note: "Announcing what you are about to say instead of saying it.",
    pattern:
      /\b(?:let(?:'|’)?s\s+(?:dive|explore|break\s+this\s+down|look\s+at)|here(?:'|’)?s\s+what\s+you\s+need\s+to\s+know|without\s+further\s+ado)\b/gi,
  },
  {
    id: "authority-trope",
    label: "Persuasive authority tropes",
    severity: "medium",
    note: 'Phrases like "the real question is" promise depth the sentence rarely delivers.',
    pattern:
      /\b(?:the\s+real\s+question\s+is|at\s+its\s+core|what\s+really\s+matters|the\s+deeper\s+issue|the\s+heart\s+of\s+the\s+matter)\b/gi,
  },
  {
    id: "chatbot-artifact",
    label: "Chatbot artifacts",
    severity: "high",
    note: "Correspondence with an assistant that got pasted into the text.",
    pattern:
      /\b(?:i\s+hope\s+this\s+helps|let\s+me\s+know\s+if|would\s+you\s+like\s+me\s+to|great\s+question|certainly!|of\s+course!|you(?:'|’)?re\s+absolutely\s+right)\b/gi,
  },
  {
    id: "knowledge-cutoff",
    label: "Knowledge-cutoff hedging",
    severity: "high",
    note: "Disclaimers about the model's own limitations, left in the prose.",
    pattern:
      /\b(?:as\s+of\s+my\s+last|up\s+to\s+my\s+last\s+training|while\s+specific\s+details\s+are\s+(?:limited|scarce)|based\s+on\s+available\s+information)\b/gi,
  },
  {
    id: "filler",
    label: "Filler phrases",
    severity: "low",
    note: "Long wind-ups that a shorter phrase replaces exactly.",
    pattern:
      /\b(?:in\s+order\s+to|due\s+to\s+the\s+fact\s+that|at\s+this\s+point\s+in\s+time|in\s+the\s+event\s+that|has\s+the\s+ability\s+to|it\s+is\s+important\s+to\s+note\s+that)\b/gi,
  },
  {
    id: "copula-avoidance",
    label: "Avoiding is/are",
    severity: "medium",
    note: 'Elaborate substitutes for "is" — "serves as", "stands as", "boasts".',
    pattern: /\b(?:serves?\s+as|stands?\s+as|boasts?\s+a|functions?\s+as|represents?\s+a)\b/gi,
  },
  {
    id: "superficial-ing",
    label: "Superficial -ing analysis",
    severity: "medium",
    note: "Participle phrases tacked on to simulate depth.",
    pattern:
      /,\s+(?:highlighting|underscoring|emphasizing|emphasising|showcasing|reflecting|symbolizing|symbolising|ensuring|fostering|cultivating|contributing\s+to|encompassing)\b/gi,
  },
  {
    id: "significance-inflation",
    label: "Inflated significance",
    severity: "high",
    note: "Claims that something marks an era or represents a broader shift.",
    pattern:
      /\b(?:a\s+testament\s+to|pivotal\s+moment|key\s+turning\s+point|marking\s+a|represents\s+a\s+shift|evolving\s+landscape|indelible\s+mark|deeply\s+rooted|setting\s+the\s+stage)\b/gi,
  },
  {
    id: "vague-attribution",
    label: "Vague attributions",
    severity: "medium",
    note: "Opinions credited to unnamed authorities.",
    pattern:
      /\b(?:industry\s+(?:reports|observers)|observers\s+have\s+(?:cited|noted)|experts\s+(?:argue|believe|say)|some\s+critics\s+argue|several\s+sources)\b/gi,
  },
];

/**
 * The AI vocabulary list. Counted as one finding with a term breakdown, since
 * any single one of these is fine and it is the density that gives it away.
 */
const AI_VOCABULARY = [
  "delve",
  "tapestry",
  "testament",
  "underscore",
  "underscores",
  "showcase",
  "showcases",
  "pivotal",
  "intricate",
  "intricacies",
  "interplay",
  "foster",
  "fostering",
  "garner",
  "garnered",
  "vibrant",
  "crucial",
  "enduring",
  "seamless",
  "seamlessly",
  "groundbreaking",
  "realm",
  "landscape",
  "nestled",
  "boasts",
  "myriad",
  "plethora",
  "leverage",
  "leveraging",
  "robust",
  "holistic",
  "nuanced",
  "profound",
  "compelling",
  "meticulous",
  "meticulously",
  "navigate",
  "navigating",
  "elevate",
  "unlock",
  "seamless",
  "transformative",
  "seismic",
  "paradigm",
];

/** Words per occurrence below which the vocabulary density is worth flagging. */
const VOCAB_DENSITY_THRESHOLD = 150;

function countWords(text) {
  return (String(text).trim().match(/\S+/g) ?? []).length;
}

/** Title Case In Headings — every significant word capitalised. */
function findTitleCaseHeadings(text) {
  const matches = [];
  for (const line of String(text).split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const words = heading[1].trim().split(/\s+/).filter(Boolean);
    if (words.length < 3) continue;

    // Ignore short connectives; the tell is capitalising the substantive words.
    const significant = words.filter((w) => w.length > 3);
    if (significant.length < 2) continue;
    if (significant.every((w) => /^[A-Z]/.test(w))) matches.push(line.trim());
  }
  return matches;
}

/** Three comma-separated items ending in "and X" — the rule of three. */
function findRuleOfThree(text) {
  const pattern = /\b[\w-]+(?:\s+[\w-]+){0,2},\s+[\w-]+(?:\s+[\w-]+){0,2},\s+and\s+[\w-]+/gi;
  return String(text).match(pattern) ?? [];
}

/** Vocabulary hits, with a per-term breakdown. */
function findVocabulary(text) {
  const counts = {};
  let total = 0;
  for (const term of new Set(AI_VOCABULARY)) {
    const matches = String(text).match(new RegExp(`\\b${term}\\b`, "gi"));
    if (matches?.length) {
      counts[term] = matches.length;
      total += matches.length;
    }
  }
  return { counts, total };
}

/**
 * Analyse text for mechanically detectable AI tells.
 *
 * @param {string} text
 * @returns {{
 *   findings: Array<{id: string, label: string, count: number, severity: string, note: string, examples: string[]}>,
 *   total: number,
 *   wordCount: number,
 *   per1000Words: number,
 * }}
 */
export function detectPatterns(text) {
  const input = String(text ?? "");
  const wordCount = countWords(input);
  const findings = [];

  for (const rule of REGEX_RULES) {
    const matches = input.match(rule.pattern) ?? [];
    if (matches.length === 0) continue;
    findings.push({
      id: rule.id,
      label: rule.label,
      count: matches.length,
      severity: rule.severity,
      note: rule.note,
      // A few concrete instances beat a bare number when a human reads this.
      examples: Array.from(new Set(matches.map((m) => m.trim()))).slice(0, 3),
    });
  }

  const headings = findTitleCaseHeadings(input);
  if (headings.length) {
    findings.push({
      id: "title-case-heading",
      label: "Title Case headings",
      count: headings.length,
      severity: "low",
      note: "Sentence case reads less like a press release.",
      examples: headings.slice(0, 3),
    });
  }

  const threes = findRuleOfThree(input);
  if (threes.length) {
    findings.push({
      id: "rule-of-three",
      label: "Rule of three",
      count: threes.length,
      severity: "medium",
      note: "Ideas forced into groups of three to sound comprehensive.",
      examples: threes.slice(0, 3),
    });
  }

  const vocab = findVocabulary(input);
  // Density, not presence: one "crucial" is ordinary English, six is a tell.
  const dense = wordCount > 0 && vocab.total / wordCount > 1 / VOCAB_DENSITY_THRESHOLD;
  if (vocab.total > 0 && (dense || vocab.total >= 3)) {
    findings.push({
      id: "ai-vocabulary",
      label: "AI vocabulary",
      count: vocab.total,
      severity: vocab.total >= 5 ? "high" : "medium",
      note: "Words that spike in post-2023 text. Any one is fine; the density is the tell.",
      examples: Object.entries(vocab.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([term, n]) => (n > 1 ? `${term} (${n}×)` : term)),
    });
  }

  const total = findings.reduce((sum, f) => sum + f.count, 0);

  return {
    findings: findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    total,
    wordCount,
    per1000Words: wordCount ? Math.round((total / wordCount) * 1000 * 10) / 10 : 0,
  };
}

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1 }[severity] ?? 0;
}

/**
 * Compare two analyses.
 * Reports what was removed, what survived, and what the rewrite introduced —
 * that last one matters, because a rewrite can trade one tell for another.
 */
export function comparePatterns(before, after) {
  const beforeById = new Map(before.findings.map((f) => [f.id, f]));
  const afterById = new Map(after.findings.map((f) => [f.id, f]));

  const removed = [];
  const remaining = [];
  const introduced = [];

  for (const [id, finding] of beforeById) {
    const post = afterById.get(id);
    if (!post) removed.push({ id, label: finding.label, count: finding.count });
    else {
      remaining.push({
        id,
        label: finding.label,
        before: finding.count,
        after: post.count,
      });
    }
  }
  for (const [id, finding] of afterById) {
    if (!beforeById.has(id)) {
      introduced.push({ id, label: finding.label, count: finding.count });
    }
  }

  return {
    before: before.total,
    after: after.total,
    removed,
    remaining,
    introduced,
    /** Negative means the rewrite added tells. */
    delta: before.total - after.total,
  };
}

/** Exported for tests and documentation. */
export const DETECTABLE_RULE_IDS = [
  ...REGEX_RULES.map((r) => r.id),
  "title-case-heading",
  "rule-of-three",
  "ai-vocabulary",
];
