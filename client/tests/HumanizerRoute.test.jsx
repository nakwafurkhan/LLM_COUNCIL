import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

// Mock the hook so we never hit the network
vi.mock("../src/hooks/useHumanizerRun.js", () => ({
  useHumanizerRun: vi.fn(),
}));

import { useHumanizerRun } from "../src/hooks/useHumanizerRun.js";
import HumanizerRoute from "../src/routes/HumanizerRoute.jsx";

const defaultHook = {
  run: null,
  status: "idle",
  error: null,
  draftText: "",
  auditNotes: null,
  auditText: "",
  finalText: "",
  before: null,
  model: null,
  submitText: vi.fn(),
  abort: vi.fn(),
  reset: vi.fn(),
};

function renderRoute(hookOverrides = {}) {
  useHumanizerRun.mockReturnValue({ ...defaultHook, ...hookOverrides });
  return render(
    <MemoryRouter>
      <HumanizerRoute />
    </MemoryRouter>,
  );
}

describe("HumanizerRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables submit while in flight", () => {
    renderRoute({ status: "streaming" });
    const submitBtn = screen.getByRole("button", { name: /humaniz/i });
    expect(submitBtn).toBeDisabled();
  });

  it("does not submit empty input", async () => {
    const submitText = vi.fn();
    renderRoute({ submitText });

    // Input is empty — button should be disabled
    const submitBtn = screen.getByRole("button", { name: /humanize/i });
    expect(submitBtn).toBeDisabled();

    // Click anyway
    fireEvent.click(submitBtn);
    expect(submitText).not.toHaveBeenCalled();
  });

  it("calls submitText with typed text when form is submitted", async () => {
    const submitText = vi.fn();
    const user = userEvent.setup();
    renderRoute({ submitText });

    const textarea = screen.getByLabelText(/text to humanize/i);
    await user.type(textarea, "This is some AI text.");

    const submitBtn = screen.getByRole("button", { name: /humanize/i });
    await user.click(submitBtn);

    expect(submitText).toHaveBeenCalledWith("This is some AI text.", expect.any(Object));
  });

  it("surfaces diff.introduced when the rewrite adds new tells", () => {
    renderRoute({
      status: "done",
      run: {
        draft: "Draft text",
        audit: { notes: ["Some tell"] },
        final: "Final text",
        before: { total: 3, wordCount: 100, per1000Words: 30, findings: [] },
        after: { total: 2, wordCount: 100, per1000Words: 20, findings: [] },
        diff: {
          before: 3,
          after: 4,
          delta: 1,
          removed: [],
          remaining: [],
          introduced: [{ id: "em-dash", label: "Em dash", count: 2 }],
        },
      },
      draftText: "Draft text",
      auditNotes: ["Some tell"],
      finalText: "Final text",
      before: { total: 3, wordCount: 100, per1000Words: 30, findings: [] },
    });

    // Regression warning must be visible
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Regression/i)).toBeInTheDocument();
    expect(screen.getByText(/Em dash/)).toBeInTheDocument();
  });

  it("shows audit notes in the rendered output", () => {
    renderRoute({
      status: "done",
      draftText: "Draft pass text",
      auditNotes: ["Uses em dashes too often", "Hedge phrase: it is worth noting"],
      finalText: "Final pass text",
    });

    expect(screen.getByText("Uses em dashes too often")).toBeInTheDocument();
    expect(screen.getByText("Hedge phrase: it is worth noting")).toBeInTheDocument();
  });

  it("shows error banner with retry when status is error", () => {
    renderRoute({ status: "error", error: new Error("Server failed") });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Server failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("all form inputs have accessible labels", () => {
    renderRoute();
    expect(screen.getByLabelText(/text to humanize/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tone/i)).toBeInTheDocument();
  });
});

describe("HumanizerRoute — XSS sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders script payload in humanized output as inert", () => {
    const xssText = `Hello <script>alert('xss')</script> world`;
    renderRoute({ finalText: xssText, draftText: xssText, status: "streaming" });

    const { container } = render(
      <MemoryRouter>
        <HumanizerRoute />
      </MemoryRouter>,
    );
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders onerror attribute in humanized output as inert", () => {
    const xssText = `<img src=x onerror="alert('xss')">`;
    useHumanizerRun.mockReturnValue({
      ...defaultHook,
      finalText: xssText,
      draftText: xssText,
      status: "streaming",
    });

    const { container } = render(
      <MemoryRouter>
        <HumanizerRoute />
      </MemoryRouter>,
    );

    const imgs = container.querySelectorAll("img");
    imgs.forEach((img) => {
      expect(img.getAttribute("onerror")).toBeNull();
    });
  });
});
