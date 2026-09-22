import { expect, test } from "@playwright/test";

// These checks use a real running engine. No API interception or fabricated data.
// GRAPH_E2E_TOKEN comes from its terminal URL; no credentials are stored in source.
const token = process.env.GRAPH_E2E_TOKEN;
test.skip(
  !token,
  "Start a real engine and set GRAPH_E2E_TOKEN before running the browser smoke tests.",
);

test("unauthenticated browser has a clear connection screen", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "A local workspace. A private connection.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Your access token stays in this browser session."),
  ).toBeVisible();
});

test("live workspace renders all pages, retrieves context, and respects viewport", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/#token=${encodeURIComponent(token!)}`);
  await expect(
    page.getByRole("heading", { name: "Start with the right context." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.locator(".metric").first().locator("strong"),
  ).not.toHaveText("—");
  await page
    .getByRole("textbox", { name: "Context search" })
    .fill(process.env.GRAPH_E2E_QUERY ?? "context retrieval engine");
  await page.getByRole("button", { name: "Build context" }).click();
  await expect(page.getByText("CONTEXT PACKET", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("context.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Code graph", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Follow the connections." }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search code symbols" })
    .fill(process.env.GRAPH_E2E_SYMBOL ?? "GraphEngine");
  await expect(page.locator(".symbol-option").first()).toBeVisible();
  await page.locator(".symbol-option").first().click();
  await expect(
    page.getByRole("heading", { name: "Relationships", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".graph-canvas svg")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("graph.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Keep what matters." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add memory" }).click();
  await expect(
    page.getByRole("textbox", { name: "What should this project remember?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close editor" }).click();

  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "From intent to execution." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Objective", exact: true })
    .fill("Inspect the context pipeline");
  await page
    .getByRole("textbox", { name: "Acceptance criteria" })
    .fill("Document the source-backed findings");
  await expect(page.getByRole("button", { name: "Create plan" })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("runs.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Decisions & usage", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "See why a path was chosen." }),
  ).toBeVisible();
  await expect(
    page.getByText(/missing usage is never counted as zero/),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("decisions.png"),
    fullPage: true,
  });
  const dimensions = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
  expect(errors).toEqual([]);
});
