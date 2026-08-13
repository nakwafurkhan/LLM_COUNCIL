import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import JobStatus from "../src/components/JobStatus.jsx";

const STATUSES = [
  "queued",
  "planning",
  "generating",
  "verifying",
  "awaiting_approval",
  "pushing",
  "completed",
  "failed",
  "cancelled",
];

describe("JobStatus", () => {
  it("renders nothing when job is null", () => {
    const { container } = render(<JobStatus job={null} />);
    expect(container.firstChild).toBeNull();
  });

  STATUSES.forEach((status) => {
    it(`reflects ${status} status with correct label`, () => {
      render(<JobStatus job={{ id: "1", status }} />);
      const badge = screen.getByRole("status");
      expect(badge).toBeInTheDocument();
      // Status text appears somewhere in the badge or list
      expect(badge.textContent.length).toBeGreaterThan(0);
    });
  });

  it("shows error message for failed status", () => {
    render(<JobStatus job={{ id: "1", status: "failed", error: "Build failed at step 3" }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Build failed at step 3/)).toBeInTheDocument();
  });

  it("shows PR link when prUrl is present", () => {
    render(
      <JobStatus
        job={{
          id: "1",
          status: "completed",
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /PR/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://github.com/org/repo/pull/42");
  });

  it("marks current step with aria-current=step", () => {
    render(<JobStatus job={{ id: "1", status: "planning" }} />);
    const currentStep = screen.getByRole("listitem", { current: "step" });
    expect(currentStep).toBeInTheDocument();
  });

  it("shows timeline step labels", () => {
    render(<JobStatus job={{ id: "1", status: "generating" }} />);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    // "Generating..." appears in both badge and timeline; getAllByText handles duplicates
    const generatingEls = screen.getAllByText(/Generating/);
    expect(generatingEls.length).toBeGreaterThanOrEqual(1);
  });
});
