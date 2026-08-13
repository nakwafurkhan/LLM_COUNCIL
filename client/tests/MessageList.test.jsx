import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import MessageList from "../src/components/MessageList.jsx";

const userMsg = {
  id: "1",
  role: "user",
  content: "Hello there",
  createdAt: new Date().toISOString(),
};

const assistantMsg = {
  id: "2",
  role: "assistant",
  content: "**Bold reply** and `code`",
  model: "gpt-4o",
  promptTokens: 10,
  completionTokens: 20,
  costUsd: 0.0005,
  latencyMs: 300,
  createdAt: new Date().toISOString(),
};

describe("MessageList", () => {
  it("renders user and assistant messages with correct roles", () => {
    render(<MessageList messages={[userMsg, assistantMsg]} streamingText="" />);
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    // Renders markdown: bold tag
    expect(document.querySelector("strong")).toBeInTheDocument();
    // Role labels
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
  });

  it("renders markdown: bold, code, paragraph", () => {
    const msg = {
      id: "3",
      role: "assistant",
      content: "## Heading\n\n**bold** and `code`",
      createdAt: new Date().toISOString(),
    };
    render(<MessageList messages={[msg]} streamingText="" />);
    expect(document.querySelector("strong")).toBeInTheDocument();
    expect(document.querySelector("code")).toBeInTheDocument();
    expect(document.querySelector("h2")).toBeInTheDocument();
  });

  it("renders streaming text when provided", () => {
    render(<MessageList messages={[]} streamingText="Typing..." />);
    expect(screen.getByText(/Typing/)).toBeInTheDocument();
  });

  it("shows token and cost metadata for assistant messages", () => {
    render(<MessageList messages={[assistantMsg]} streamingText="" />);
    // tokens displayed (text is split across nodes, use container query)
    expect(screen.getByText(/10↑/)).toBeInTheDocument();
    // costUsd 0.0005 < 0.001, so displays as "<$0.001"
    expect(screen.getByText(/<\$0\.001/)).toBeInTheDocument();
    expect(screen.getByText(/300ms/)).toBeInTheDocument();
  });
});
