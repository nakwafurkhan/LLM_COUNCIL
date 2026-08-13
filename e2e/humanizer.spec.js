/**
 * End-to-end: the Humanizer tab in a real browser.
 *
 * All three passes have to reach the screen. The audit is the differentiator,
 * so its absence would be a silent regression that unit tests on the service
 * would not catch.
 */
import { test, expect } from "@playwright/test";

const AI_TEXT =
  "It's not just a tool—it's a testament to innovation. Let's dive in. " +
  "In order to leverage this vibrant landscape, experts argue teams must foster " +
  "seamless collaboration, showcasing speed, quality, and scale.";

test.describe("humanizer", () => {
  test("runs all three passes and shows the audit", async ({ page }) => {
    await page.goto("/humanize");

    await page.getByLabel("Text to humanize").fill(AI_TEXT);
    await page.getByRole("button", { name: /^Humanize$/ }).click();

    // Pass 1.
    await expect(page.getByText(/speeds up the boring parts/).first()).toBeVisible({
      timeout: 20_000,
    });

    // Pass 2 — the part worth having. The model's critique of its own draft.
    await expect(page.getByText("The second fragment is abrupt")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("No point of view anywhere")).toBeVisible();

    // Pass 3.
    await expect(page.getByText(/won't help with architecture/).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("reports the patterns it found before and after", async ({ page }) => {
    await page.goto("/humanize");
    await page.getByLabel("Text to humanize").fill(AI_TEXT);
    await page.getByRole("button", { name: /^Humanize$/ }).click();

    // The input has em dashes, a negative parallelism and signposting.
    await expect(page.getByText(/Em dashes/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Negative parallelisms|Signposting/).first()).toBeVisible();
  });

  test("says plainly that the score covers only part of the problem", async ({ page }) => {
    await page.goto("/humanize");
    await page.getByLabel("Text to humanize").fill(AI_TEXT);
    await page.getByRole("button", { name: /^Humanize$/ }).click();

    // A number that looks authoritative while measuring a third of the spec
    // would be worse than no number, so the caveat is part of the feature.
    await expect(page.getByRole("note").first()).toBeVisible({ timeout: 20_000 });
  });

  test("will not submit empty input", async ({ page }) => {
    await page.goto("/humanize");
    await expect(page.getByRole("button", { name: /^Humanize$/ })).toBeDisabled();
  });

  test("is reachable from the tab bar and marks itself active", async ({ page }) => {
    await page.goto("/chat");
    await page.getByRole("tab", { name: /humanizer/i }).click();
    await expect(page).toHaveURL(/\/humanize/);
    await expect(page.getByRole("tab", { name: /humanizer/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
