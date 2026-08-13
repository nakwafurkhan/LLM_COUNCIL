/**
 * The three prompts.
 *
 * Kept in their own module because they are the actual product here — the
 * orchestration around them is twenty lines. Editing a prompt should not mean
 * reading through streaming and persistence code to find it.
 */

/** The pattern catalogue, condensed from the humanizer spec. */
const PATTERNS = `Content patterns
- Inflated significance: "a testament to", "pivotal moment", "marking a", "represents a shift", "evolving landscape". Arbitrary facts do not represent broader movements.
- Inflated notability: listing outlets that covered something instead of saying what was said.
- Superficial -ing analysis: participle phrases bolted onto a sentence to fake depth ("..., highlighting the community's connection").
- Promotional tone: "nestled", "vibrant", "rich cultural heritage", "breathtaking", "must-visit", "boasts".
- Vague attribution: "experts argue", "industry observers", "some critics" with nobody named.
- Formulaic "Challenges and Future Prospects" sections.

Language patterns
- AI vocabulary: delve, tapestry, testament, underscore, showcase, pivotal, intricate, interplay, foster, garner, vibrant, crucial, enduring, seamless, groundbreaking, realm, landscape, myriad, leverage, robust, holistic, transformative.
- Copula avoidance: "serves as", "stands as", "functions as", "boasts a" where "is" or "has" would do.
- Negative parallelism: "It's not just X, it's Y". Also clipped tailing negations: "no guessing", "no wasted motion".
- Rule of three: forcing ideas into triads to sound comprehensive.
- Elegant variation: cycling synonyms for the same noun across consecutive sentences.
- False ranges: "from X to Y" where X and Y are not on any shared scale.
- Passive voice and subjectless fragments where an actor would be clearer.

Style patterns
- Em dash overuse. Commas, periods and parentheses usually read better.
- Mechanical boldface, and bulleted lists shaped as "**Header:** description".
- Title Case In Headings. Emoji decorating headings or bullets. Curly quotes.

Communication patterns
- Chatbot artifacts: "I hope this helps", "Certainly!", "Would you like...", "Let me know".
- Knowledge-cutoff disclaimers: "as of my last update", "while specific details are limited".
- Sycophancy: "Great question!", "You're absolutely right".

Filler and hedging
- "In order to", "due to the fact that", "at this point in time", "has the ability to", "it is important to note that".
- Stacked hedges: "could potentially possibly".
- Generic upbeat conclusions: "the future looks bright", "exciting times lie ahead".
- Uniform hyphenation of common pairs: data-driven, high-quality, decision-making.
- Authority tropes: "the real question is", "at its core", "what really matters".
- Signposting: "Let's dive in", "here's what you need to know".`;

/** What separates a clean rewrite from a good one. */
const SOUL = `Removing tells is only half of it. Text can be free of every pattern above and still read like it was assembled rather than written. The other half:

- Have a point of view. React to things rather than neutrally reporting them.
- Vary rhythm. Short sentences. Then longer ones that take their time getting where they are going.
- Allow mixed feelings. "Impressive but unsettling" beats "impressive".
- Use "I" where it fits. First person is honest, not unprofessional.
- Be specific about feeling. Not "this is concerning" but the concrete thing that is worrying.
- Let some mess in. Perfectly balanced structure reads algorithmic.

Do not overcorrect into forced quirkiness. The target is someone competent writing plainly, not someone performing personality.`;

const TONE_GUIDANCE = {
  neutral: "Keep the register the original was aiming for. Plain, direct, unfussy.",
  casual: "Conversational. Contractions, shorter sentences, the occasional aside.",
  professional: "Precise and measured, but not stiff. No corporate padding.",
  technical: "Precise and concrete. Assume a knowledgeable reader. No hand-holding.",
};

/**
 * Pass 1: the rewrite.
 */
export function draftPrompt({ text, tone, voiceSample, findings }) {
  const detected = findings.length
    ? `\nA mechanical scan flagged these in the original. It only catches the countable patterns, so treat it as a floor, not the full list:\n${findings
        .map(
          (f) =>
            `- ${f.label} (${f.count})${f.examples.length ? `: ${f.examples.join(", ")}` : ""}`,
        )
        .join("\n")}`
    : "";

  const voice = voiceSample
    ? `\n## Match this writing sample's voice\nStudy its sentence lengths, vocabulary level, punctuation habits and how it opens paragraphs. Rewrite in THAT voice, not a generic natural one. Do not copy its content.\n\n"""\n${voiceSample}\n"""`
    : "";

  return [
    {
      role: "system",
      content: `You are an editor who removes the signs of AI-generated writing.

${PATTERNS}

${SOUL}

Rules:
- Preserve the meaning and every fact. You are editing, not rewriting the argument.
- Preserve the format: if the input is markdown, return markdown; keep headings and lists where they earn their place.
- Do not add information that is not in the original.
- Return ONLY the rewritten text. No preamble, no commentary, no explanation of your changes.`,
    },
    {
      role: "user",
      content: `Tone: ${TONE_GUIDANCE[tone] ?? TONE_GUIDANCE.neutral}${voice}${detected}

## Text to rewrite

"""
${text}
"""`,
    },
  ];
}

/**
 * Pass 2: the audit.
 *
 * The spec's key move. Asking the model to critique its own draft catches
 * what the rewrite missed, and asking it in these words — "what makes this
 * obviously AI generated?" — gets sharper answers than "review your work".
 */
export function auditPrompt({ draft, findings }) {
  const stillFlagged = findings.length
    ? `\nA mechanical scan still flags: ${findings.map((f) => `${f.label} (${f.count})`).join(", ")}.`
    : "\nA mechanical scan found no countable tells, so anything left is a judgement call.";

  return [
    {
      role: "system",
      content: `You review text for remaining signs of AI authorship.

Be blunt and specific. Quote the exact phrases that give it away. If something reads fine, do not invent a criticism for the sake of having one — an empty list is a valid answer.

Ignore anything that is merely a stylistic preference. You are looking for what would make a reader think "a machine wrote this".

Respond with ONLY a JSON object:
{ "notes": ["specific tell, quoting the phrase", "..."] }

At most 6 notes, ordered by how badly each one gives the text away.`,
    },
    {
      role: "user",
      content: `What makes the text below so obviously AI generated?${stillFlagged}

"""
${draft}
"""`,
    },
  ];
}

/**
 * Pass 3: the revision, informed by the audit.
 */
export function finalPrompt({ draft, notes, tone, voiceSample }) {
  const criticism = notes.length
    ? `A reviewer found these tells still present:\n${notes.map((n) => `- ${n}`).join("\n")}\n\nFix each one.`
    : "A reviewer found no obvious remaining tells. Tighten anything that still reads flat, and otherwise leave it alone.";

  const voice = voiceSample
    ? "\nKeep matching the writing sample's voice from the previous step."
    : "";

  return [
    {
      role: "system",
      content: `You are revising text to remove the last signs of AI authorship.

${SOUL}

Rules:
- Fix what the reviewer identified. Do not relitigate their points.
- Preserve meaning, facts and format.
- Do not overcorrect into forced casualness or performative quirk.
- Return ONLY the revised text. No commentary.`,
    },
    {
      role: "user",
      content: `Tone: ${TONE_GUIDANCE[tone] ?? TONE_GUIDANCE.neutral}${voice}

${criticism}

## Text to revise

"""
${draft}
"""`,
    },
  ];
}

/**
 * Models wrap output in quotes or fences despite being told not to.
 * Strip that without touching legitimate internal formatting.
 */
export function cleanOutput(text) {
  let out = String(text ?? "").trim();

  const fenced = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced) out = fenced[1].trim();

  // Triple quotes, mirroring the delimiter used in the prompt.
  const tripled = out.match(/^"""\n?([\s\S]*?)\n?"""$/);
  if (tripled) out = tripled[1].trim();

  return out;
}
