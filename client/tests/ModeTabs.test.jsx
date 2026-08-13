import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ModeTabs from "../src/components/ModeTabs.jsx";

function renderWithRouter(initialPath = "/chat") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ModeTabs />
    </MemoryRouter>,
  );
}

describe("ModeTabs", () => {
  it("renders all tabs", () => {
    renderWithRouter();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Quick")).toBeInTheDocument();
    expect(screen.getByText("Council")).toBeInTheDocument();
    expect(screen.getByText("Humanizer")).toBeInTheDocument();
    expect(screen.getByText("Code + PR")).toBeInTheDocument();
  });

  it("marks the active tab with data-selected=true", () => {
    renderWithRouter("/chat");
    const chatSpan = screen.getByText("Chat");
    expect(chatSpan.getAttribute("data-selected")).toBe("true");

    const quickSpan = screen.getByText("Quick");
    expect(quickSpan.getAttribute("data-selected")).toBe("false");
  });

  it("tabs have role=tab", () => {
    renderWithRouter();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
  });

  it("tablist has role=tablist", () => {
    renderWithRouter();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("navigates with ArrowRight key", async () => {
    renderWithRouter("/chat");
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("navigates with ArrowLeft key (wraps around)", async () => {
    renderWithRouter("/chat");
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs[4]);
  });

  it("End key moves focus to last tab", async () => {
    renderWithRouter();
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[4]);
  });

  it("Home key moves focus to first tab", async () => {
    renderWithRouter();
    const tabs = screen.getAllByRole("tab");
    tabs[2].focus();
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
  });
});
