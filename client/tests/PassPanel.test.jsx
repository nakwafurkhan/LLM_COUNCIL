import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import PassPanel from "../src/components/PassPanel.jsx";

describe("PassPanel", () => {
  it("renders heading and streaming text", () => {
    render(<PassPanel heading="Pass 1 — Draft" text="Hello world" streaming={true} />);
    expect(screen.getByText("Pass 1 — Draft")).toBeInTheDocument();
    expect(screen.getByText(/Hello world/)).toBeInTheDocument();
  });

  it("can collapse and expand", async () => {
    const user = userEvent.setup();
    render(<PassPanel heading="Pass 2 — Audit" text="Some text" defaultOpen={true} />);
    // Initially open — text visible
    expect(screen.getByText(/Some text/)).toBeInTheDocument();

    // Collapse
    const toggle = screen.getByRole("button", { name: /Pass 2/i });
    await user.click(toggle);
    expect(screen.queryByText(/Some text/)).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Expand again
    await user.click(toggle);
    expect(screen.getByText(/Some text/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("starts collapsed when defaultOpen is false", () => {
    render(<PassPanel heading="Pass 1 — Draft" text="Hidden" defaultOpen={false} />);
    // Text should not be visible
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("renders audit notes as a list", () => {
    const notes = ["Uses em dashes frequently", "Hedge phrases detected"];
    render(<PassPanel heading="Pass 2 — Audit" notes={notes} defaultOpen={true} />);
    expect(screen.getByText("Uses em dashes frequently")).toBeInTheDocument();
    expect(screen.getByText("Hedge phrases detected")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /audit notes/i })).toBeInTheDocument();
  });

  it("has aria-live on text region", () => {
    const { container } = render(
      <PassPanel heading="Pass 3 — Final" text="Output text" defaultOpen={true} />,
    );
    const liveRegion = container.querySelector("[aria-live]");
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
  });

  it("returns null when no content and not streaming", () => {
    const { container } = render(<PassPanel heading="Empty" text="" streaming={false} />);
    expect(container.firstChild).toBeNull();
  });
});
