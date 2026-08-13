import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import CouncilCard from "../src/components/CouncilCard.jsx";

describe("CouncilCard", () => {
  it("renders fulfilled content with model name and status", () => {
    const answer = {
      model: "gpt-4o",
      status: "fulfilled",
      content: "The answer is 42.",
      latencyMs: 500,
      promptTokens: 10,
      completionTokens: 20,
      costUsd: 0.001,
    };
    render(<CouncilCard answer={answer} loading={false} />);
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("fulfilled")).toBeInTheDocument();
    expect(screen.getByText(/The answer is 42/)).toBeInTheDocument();
  });

  it("shows error text for rejected status", () => {
    const answer = {
      model: "claude-3",
      status: "rejected",
      content: null,
      error: "Rate limit exceeded",
    };
    render(<CouncilCard answer={answer} loading={false} />);
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(screen.getByText(/Rate limit exceeded/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows error text for timeout status", () => {
    const answer = {
      model: "gemini-pro",
      status: "timeout",
      content: null,
      error: "Request timed out after 30s",
    };
    render(<CouncilCard answer={answer} loading={false} />);
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.getByText(/Request timed out/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows skeleton when loading with no answer", () => {
    const { container } = render(<CouncilCard answer={null} loading={true} />);
    expect(container.querySelector(".skeleton")).toBeInTheDocument();
  });

  it("shows cost and latency metadata for fulfilled answers", () => {
    const answer = {
      model: "gpt-4o",
      status: "fulfilled",
      content: "Done.",
      latencyMs: 1200,
      promptTokens: 50,
      completionTokens: 100,
      costUsd: 0.005,
    };
    render(<CouncilCard answer={answer} loading={false} />);
    expect(screen.getByText(/1200ms/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0050/)).toBeInTheDocument();
  });
});
