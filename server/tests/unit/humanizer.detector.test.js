/**
 * The pattern detector.
 *
 * The strongest available test material is the humanizer spec's own worked
 * examples: each "before" is text a human editor judged AI-sounding, and each
 * "after" is their fix. The detector should flag the first and stay quiet on
 * the second. Anything else means it is measuring something other than what
 * the spec means.
 */
import { describe, it, expect } from "vitest";

import {
  detectPatterns,
  comparePatterns,
  DETECTABLE_RULE_IDS,
} from "../../src/services/humanizer/detector.js";

/** Convenience: does the analysis include this rule? */
const flagged = (text, id) => detectPatterns(text).findings.some((f) => f.id === id);
const countOf = (text, id) =>
  detectPatterns(text).findings.find((f) => f.id === id)?.count ?? 0;

describe("punctuation and typography", () => {
  it("counts em dashes", () => {
    const text =
      "The term is promoted by institutions—not by the people—even in official documents.";
    expect(countOf(text, "em-dash")).toBe(2);
  });

  it("ignores hyphens and en dashes", () => {
    expect(flagged("A well-known case, pages 10–12.", "em-dash")).toBe(false);
  });

  it("counts curly quotes", () => {
    expect(
      countOf("He said “the project is on track” but others disagreed.", "curly-quotes"),
    ).toBe(2);
  });

  it("leaves straight quotes alone", () => {
    expect(flagged('He said "on track" and left.', "curly-quotes")).toBe(false);
  });

  it("finds emoji", () => {
    expect(flagged("🚀 **Launch Phase:** ships in Q3", "emoji")).toBe(true);
    expect(flagged("Ships in Q3.", "emoji")).toBe(false);
  });
});

describe("list and heading shapes", () => {
  it("catches bolded inline list headers", () => {
    const text = [
      "- **User Experience:** improved with a new interface.",
      "- **Performance:** enhanced through optimized algorithms.",
    ].join("\n");
    expect(countOf(text, "bold-inline-header")).toBe(2);
  });

  it("leaves ordinary bullets alone", () => {
    expect(flagged("- ships in Q3\n- costs less", "bold-inline-header")).toBe(false);
  });

  it("flags Title Case headings", () => {
    expect(
      flagged("## Strategic Negotiations And Global Partnerships", "title-case-heading"),
    ).toBe(true);
  });

  it("accepts sentence case headings", () => {
    expect(
      flagged("## Strategic negotiations and global partnerships", "title-case-heading"),
    ).toBe(false);
  });

  it("does not flag a short heading of proper nouns", () => {
    // "## New York" is title case only incidentally.
    expect(flagged("## New York", "title-case-heading")).toBe(false);
  });
});

describe("phrasing tells", () => {
  it("catches negative parallelism", () => {
    expect(flagged("It's not just a song, it's a statement.", "negative-parallelism")).toBe(
      true,
    );
    expect(flagged("This is not merely decorative.", "negative-parallelism")).toBe(true);
  });

  it("catches signposting", () => {
    expect(flagged("Let's dive into how caching works.", "signposting")).toBe(true);
    expect(flagged("Here's what you need to know.", "signposting")).toBe(true);
  });

  it("catches authority tropes", () => {
    expect(flagged("The real question is whether teams can adapt.", "authority-trope")).toBe(
      true,
    );
    expect(flagged("At its core, what really matters is readiness.", "authority-trope")).toBe(
      true,
    );
  });

  it("catches chatbot artifacts", () => {
    expect(
      flagged("I hope this helps! Let me know if you'd like more.", "chatbot-artifact"),
    ).toBe(true);
  });

  it("catches knowledge-cutoff hedging", () => {
    expect(
      flagged(
        "While specific details are limited, it appears to date from the 1990s.",
        "knowledge-cutoff",
      ),
    ).toBe(true);
  });

  it("catches filler", () => {
    expect(flagged("In order to achieve this goal, we acted.", "filler")).toBe(true);
    expect(flagged("Due to the fact that it was raining, we stayed.", "filler")).toBe(true);
  });

  it("catches copula avoidance", () => {
    expect(flagged("Gallery 825 serves as the exhibition space.", "copula-avoidance")).toBe(
      true,
    );
    expect(flagged("Gallery 825 is the exhibition space.", "copula-avoidance")).toBe(false);
  });

  it("catches superficial -ing analysis", () => {
    expect(
      flagged(
        "The palette references the coast, symbolizing the community's connection.",
        "superficial-ing",
      ),
    ).toBe(true);
  });

  it("does not flag an -ing clause that is doing real work", () => {
    // Not preceded by a comma, so not the tacked-on shape.
    expect(flagged("The team is symbolizing the data with colour.", "superficial-ing")).toBe(
      false,
    );
  });

  it("catches inflated significance", () => {
    expect(
      flagged(
        "Established in 1989, marking a pivotal moment in regional statistics.",
        "significance-inflation",
      ),
    ).toBe(true);
  });

  it("catches vague attribution", () => {
    expect(
      flagged("Experts argue the river is ecologically important.", "vague-attribution"),
    ).toBe(true);
  });

  it("catches the rule of three", () => {
    expect(
      flagged(
        "Attendees can expect innovation, inspiration, and industry insights.",
        "rule-of-three",
      ),
    ).toBe(true);
  });
});

describe("AI vocabulary", () => {
  it("flags a dense cluster", () => {
    const text =
      "This groundbreaking tapestry of intricate solutions leverages a robust, holistic paradigm to foster seamless outcomes.";
    expect(flagged(text, "ai-vocabulary")).toBe(true);
  });

  it("tolerates a single ordinary use in a long passage", () => {
    // "crucial" once in 200 words is just English.
    const text = `${"word ".repeat(200)} this step is crucial.`;
    expect(flagged(text, "ai-vocabulary")).toBe(false);
  });

  it("reports which terms it found", () => {
    const finding = detectPatterns(
      "A vibrant tapestry showcasing intricate delve into the landscape.",
    ).findings.find((f) => f.id === "ai-vocabulary");
    expect(finding.examples.join(" ")).toMatch(/tapestry|vibrant|intricate|delve|landscape/);
  });
});

describe("the spec's own worked examples", () => {
  // Each pair is [AI-sounding original, human rewrite] taken from the guide.
  const pairs = [
    [
      "The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain.",
      "The Statistical Institute of Catalonia was established in 1989 to collect and publish regional statistics independently from Spain's national statistics office.",
    ],
    [
      "Nestled within the breathtaking region of Gonder, Alamata Raya Kobo stands as a vibrant town with a rich cultural heritage and stunning natural beauty.",
      "Alamata Raya Kobo is a town in the Gonder region of Ethiopia, known for its weekly market and 18th-century church.",
    ],
    [
      "Gallery 825 serves as LAAA's exhibition space for contemporary art. The gallery features four separate spaces and boasts over 3,000 square feet.",
      "Gallery 825 is LAAA's exhibition space for contemporary art. The gallery has four rooms totaling 3,000 square feet.",
    ],
    [
      "Here is an overview of the French Revolution. I hope this helps! Let me know if you'd like me to expand on any section.",
      "The French Revolution began in 1789 when financial crisis and food shortages led to widespread unrest.",
    ],
  ];

  it.each(pairs)("flags the AI version more than the rewrite", (before, after) => {
    const b = detectPatterns(before);
    const a = detectPatterns(after);
    expect(b.total).toBeGreaterThan(0);
    expect(a.total).toBeLessThan(b.total);
  });

  it("clears the human rewrites entirely or nearly so", () => {
    for (const [, after] of pairs) {
      expect(detectPatterns(after).total).toBeLessThanOrEqual(1);
    }
  });
});

describe("reporting", () => {
  it("returns zero for empty input rather than throwing", () => {
    expect(detectPatterns("")).toMatchObject({ total: 0, wordCount: 0, per1000Words: 0 });
    expect(detectPatterns(null).total).toBe(0);
  });

  it("normalises by length, so a long clean document is not penalised", () => {
    const short = detectPatterns("It's not just X, it's Y.");
    const long = detectPatterns(
      `${"ordinary sentence here. ".repeat(200)} It's not just X, it's Y.`,
    );
    expect(long.total).toBe(short.total);
    expect(long.per1000Words).toBeLessThan(short.per1000Words);
  });

  it("orders findings by severity so the worst reads first", () => {
    const text = "It's not just a song—it's a statement, in order to make a point.";
    const severities = detectPatterns(text).findings.map((f) => f.severity);
    const rank = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i - 1]]).toBeGreaterThanOrEqual(rank[severities[i]]);
    }
  });

  it("gives concrete examples, not just counts", () => {
    const finding = detectPatterns("A—B—C").findings.find((f) => f.id === "em-dash");
    expect(finding.examples.length).toBeGreaterThan(0);
  });
});

describe("comparePatterns", () => {
  it("separates removed, remaining and newly introduced tells", () => {
    const before = detectPatterns("It's not just X—it's Y. In order to win, experts argue.");
    const after = detectPatterns("To win, we need Y. A 2019 survey found the same.");
    const diff = comparePatterns(before, after);

    expect(diff.before).toBeGreaterThan(diff.after);
    expect(diff.delta).toBeGreaterThan(0);
    expect(diff.removed.length).toBeGreaterThan(0);
  });

  it("reports a rewrite that traded one tell for another", () => {
    // The point of tracking `introduced`: a rewrite can make things worse in a
    // way a single before/after total would hide.
    const before = detectPatterns("The report—which was late—covers three areas.");
    const after = detectPatterns(
      "Let's dive in. The report covers innovation, inspiration, and insight.",
    );
    const diff = comparePatterns(before, after);
    expect(diff.introduced.map((i) => i.id)).toContain("signposting");
  });

  it("handles two clean texts", () => {
    const diff = comparePatterns(detectPatterns("Plain text."), detectPatterns("Also plain."));
    expect(diff).toMatchObject({ before: 0, after: 0, delta: 0 });
    expect(diff.removed).toEqual([]);
  });
});

describe("scope honesty", () => {
  it("exposes exactly which rules it can check", () => {
    // The detector covers the mechanical subset. This list is what the UI
    // shows so nobody reads a clean score as "this text is good".
    expect(DETECTABLE_RULE_IDS).toContain("em-dash");
    expect(DETECTABLE_RULE_IDS).toContain("ai-vocabulary");
    expect(DETECTABLE_RULE_IDS.length).toBeGreaterThan(10);
  });

  it("stays silent on text whose only problem is having no voice", () => {
    // Flat, lifeless, and mechanically clean. Only the model can catch this,
    // and the detector should not pretend otherwise.
    const soulless =
      "The experiment produced results. The agents generated code. Some developers were impressed. Others were skeptical.";
    expect(detectPatterns(soulless).total).toBe(0);
  });
});
