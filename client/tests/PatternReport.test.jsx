import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import PatternReport from "../src/components/PatternReport.jsx";

const sampleAnalysis = {
  total: 5,
  wordCount: 200,
  per1000Words: 25,
  findings: [
    {
      id: "em-dash",
      label: "Em dash",
      count: 3,
      severity: "high",
      note: "Overused in AI text",
      examples: ["word — word"],
    },
    {
      id: "hedge",
      label: "Hedge phrases",
      count: 2,
      severity: "medium",
      note: "Phrases like 'it is worth noting'",
      examples: [],
    },
  ],
};

const cleanAnalysis = {
  total: 0,
  wordCount: 150,
  per1000Words: 0,
  findings: [],
};

describe("PatternReport", () => {
  it("renders findings with counts and severities", () => {
    render(<PatternReport analysis={sampleAnalysis} label="Test analysis" />);
    expect(screen.getByText("Em dash")).toBeInTheDocument();
    expect(screen.getByText("3×")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Hedge phrases")).toBeInTheDocument();
    expect(screen.getByText("2×")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

  it("shows the scope caveat near the score", () => {
    render(<PatternReport analysis={sampleAnalysis} />);
    const caveat = screen.getByRole("note");
    expect(caveat).toBeInTheDocument();
    // Caveat must mention scope limitations
    expect(caveat.textContent).toMatch(/mechanically detectable/i);
    expect(caveat.textContent).toMatch(/does not/i);
  });

  it("renders finding notes and examples", () => {
    render(<PatternReport analysis={sampleAnalysis} />);
    expect(screen.getByText("Overused in AI text")).toBeInTheDocument();
    expect(screen.getByText(/word — word/)).toBeInTheDocument();
  });

  it("handles clean analysis (total 0) without implying perfect", () => {
    render(<PatternReport analysis={cleanAnalysis} label="Clean analysis" />);
    // Should say zero patterns were found
    expect(screen.getByText(/No mechanical patterns detected/i)).toBeInTheDocument();
    // Must NOT say "perfect" or anything that implies fully human-written
    const text = document.body.textContent;
    expect(text).not.toMatch(/perfect/i);
    // Caveat about scope must still appear
    const caveat = screen.getByRole("note");
    expect(caveat.textContent).toMatch(/does not guarantee/i);
  });

  it("renders null gracefully when no analysis provided", () => {
    const { container } = render(<PatternReport analysis={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows per-1000-words rate", () => {
    render(<PatternReport analysis={sampleAnalysis} />);
    expect(screen.getByText(/25\.0 per 1 000 words/)).toBeInTheDocument();
  });
});
