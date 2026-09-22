import { expect, test } from "@playwright/test";

test.skip(
  process.env.GRAPH_E2E_FIXTURE !== "1",
  "Mutations only run in the disposable fixture, never against a live project.",
);

test("proposal acceptance, repository sharing, and plan creation persist through the real API", async ({
  page,
}, testInfo) => {
  await page.goto(
    `/#token=${encodeURIComponent(process.env.GRAPH_E2E_TOKEN!)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Start with the right context." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "Add memory" }).click();
  const note = `Browser ${testInfo.project.name}: preserve source references when retrieving context.`;
  await page
    .getByRole("textbox", { name: "What should this project remember?" })
    .fill(note);
  await page.getByRole("button", { name: "Save proposal" }).click();
  const record = page.locator("article.memory-card").filter({ hasText: note });
  await expect(record.getByText("proposed", { exact: true })).toBeVisible();
  await record.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(record.getByText("accepted", { exact: true })).toBeVisible();
  await record.getByRole("button", { name: "Share to repository" }).click();
  await expect(record.getByText("shared", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Shared knowledge written to",
  );

  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Objective", exact: true })
    .fill("Inspect context retrieval behavior");
  await page
    .getByRole("textbox", { name: "Acceptance criteria" })
    .fill("Preserve existing source references");
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page.locator(".plan-preview")).toContainText("fixture-local");
  await expect(
    page.getByRole("button", { name: "Start isolated run" }),
  ).toBeVisible();
  // Creating a plan must not begin paid/local inference or create a run.
  await expect(
    page.getByRole("heading", { name: "No runs yet" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
