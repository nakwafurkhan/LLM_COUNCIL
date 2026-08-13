import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import DiffViewer from "../src/components/DiffViewer.jsx";

const SAMPLE_DIFF = `--- a/file.js
+++ b/file.js
@@ -1,4 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
 console.log(x);
`;

describe("DiffViewer", () => {
  it("marks addition lines distinctly", () => {
    const { container } = render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="awaiting_approval"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    const additions = container.querySelectorAll(".diff-line--addition");
    expect(additions.length).toBeGreaterThan(0);
    // Addition lines should contain the added text
    expect(additions[0].textContent).toContain("const y = 3");
  });

  it("marks deletion lines distinctly", () => {
    const { container } = render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="awaiting_approval"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    const deletions = container.querySelectorAll(".diff-line--deletion");
    expect(deletions.length).toBeGreaterThan(0);
    expect(deletions[0].textContent).toContain("const y = 2");
  });

  it("Approve button is ENABLED when status is awaiting_approval", () => {
    render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="awaiting_approval"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).not.toBeDisabled();
  });

  it("Approve button is DISABLED when status is not awaiting_approval", () => {
    render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="generating"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
  });

  it("Approve button is DISABLED when status is completed", () => {
    render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="completed"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
  });

  it("calls onApprove when Approve button clicked and status is awaiting_approval", async () => {
    const onApprove = vi.fn();
    render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="awaiting_approval"
        onApprove={onApprove}
        onReject={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("calls onReject when Reject button clicked", async () => {
    const onReject = vi.fn();
    render(
      <DiffViewer
        diff={SAMPLE_DIFF}
        status="awaiting_approval"
        onApprove={() => {}}
        onReject={onReject}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("shows empty state when no diff provided", () => {
    render(<DiffViewer diff="" status="queued" onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText(/No diff available/)).toBeInTheDocument();
  });
});
