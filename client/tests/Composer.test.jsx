import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Composer from "../src/components/Composer.jsx";

describe("Composer", () => {
  it("disables textarea and button while in-flight (disabled=true)", () => {
    render(<Composer onSubmit={() => {}} disabled={true} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("re-enables after in-flight completes (disabled=false)", () => {
    const { rerender } = render(<Composer onSubmit={() => {}} disabled={true} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    rerender(<Composer onSubmit={() => {}} disabled={false} />);
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });

  it("does not submit when input is empty", async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} disabled={false} />);
    const btn = screen.getByRole("button", { name: /send/i });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit whitespace-only input", async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} disabled={false} />);
    await userEvent.type(screen.getByRole("textbox"), "   ");
    const btn = screen.getByRole("button", { name: /send/i });
    // Button should remain disabled for whitespace-only
    expect(btn).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit with trimmed content when form submitted", async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} disabled={false} />);
    await userEvent.type(screen.getByRole("textbox"), "Hello!");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSubmit).toHaveBeenCalledWith("Hello!");
  });

  it("clears input after submission", async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} disabled={false} />);
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "Hello!");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(textarea).toHaveValue("");
  });

  it("submits on Enter key (without shift)", async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} disabled={false} />);
    await userEvent.type(screen.getByRole("textbox"), "Hello!{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Hello!");
  });
});
