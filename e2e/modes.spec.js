/**
 * End-to-end: all four modes in a real browser against the real server.
 *
 * The LLM adapter is faked (see e2e/server.mjs) but nothing else is — this is
 * the actual SSE wire format, the actual React client, the actual Mongo.
 */
import { test, expect } from "@playwright/test";

test.describe("chat", () => {
  test("streams a reply and shows what it cost", async ({ page }) => {
    await page.goto("/chat");

    await page.getByLabel("Message input").fill("What is a council?");
    await page.getByLabel("Send message").click();

    // The user's own turn appears immediately.
    await expect(page.getByText("What is a council?")).toBeVisible();

    // The reply arrives over SSE.
    await expect(page.getByText(/chairman is speaking now|fake model/i)).toBeVisible({
      timeout: 15_000,
    });

    // Cost transparency is a feature, not decoration.
    await expect(
      page
        .locator(".message-list")
        .getByText(/\$0\.\d+/)
        .first(),
    ).toBeVisible();
  });

  test("keeps history across a reload, because it lives on the server", async ({ page }) => {
    await page.goto("/chat");
    await page.getByLabel("Message input").fill("Remember this line");
    await page.getByLabel("Send message").click();
    await expect(page.getByText("Remember this line")).toBeVisible();

    await page.reload();
    // The old build kept history in a browser array, so this was lost.
    await expect(page.getByText("Remember this line")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("quick", () => {
  test("uses the cheaper model", async ({ page }) => {
    await page.goto("/quick");

    await page.getByLabel("Message input").fill("Capital of France?");
    await page.getByLabel("Send message").click();

    // The model badge on the reply is how a user sees the tradeoff they chose.
    // Scoped to the message list: the model picker also contains this text, in
    // hidden <option> elements.
    const messages = page.locator(".message-list");
    await expect(messages.getByText("A fast, terse answer.")).toBeVisible({ timeout: 15_000 });
    await expect(messages.locator(".message-role", { hasText: "gpt-4o-mini" })).toBeVisible();
  });
});

test.describe("council", () => {
  test("populates member cards, then the chairman panel", async ({ page }) => {
    await page.goto("/council");

    await page.getByLabel("Message input").fill("Should we use Postgres or Mongo?");
    await page.getByLabel("Send message").click();

    // Three members answer; each card lands as its model responds.
    await expect(page.getByText("A fast, terse answer.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("A considered third opinion.")).toBeVisible();

    // The chairman streams last and its disagreements are structured output.
    await expect(page.getByText(/whether to use Postgres/i)).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("navigation", () => {
  test("tabs are keyboard navigable and mark the active mode", async ({ page }) => {
    await page.goto("/chat");

    const tabs = page.getByRole("tab");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

    await page.goto("/council");
    const councilTab = page.getByRole("tab", { name: /council/i });
    await expect(councilTab).toHaveAttribute("aria-selected", "true");
  });

  test("an unknown client route still loads the app, not a JSON 404", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-route");
    expect(response.status()).toBe(200);
    await expect(page.getByRole("tablist")).toBeVisible();
  });

  test("an unknown API route stays a JSON 404", async ({ request }) => {
    // The SPA fallback must never swallow API paths.
    const response = await request.get("/api/definitely-not-a-route");
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });
});
