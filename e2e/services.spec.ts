import { expect, test } from "./fixtures.ts";

test("mutates the service, refreshes the loader, and persists across reloads", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const save = page.getByRole("button", { name: "Save note" });
  await expect(save).toBeEnabled();
  await page.getByLabel("Title", { exact: true }).fill("Saved by the browser");

  const rpc = page.waitForResponse(
    (response) =>
      response.url().includes("/_serverFn/") &&
      response.request().method() === "POST"
  );

  await save.click();
  const response = await rpc;
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain("Saved by the browser");
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved"
  );
  await expect(page.getByLabel("Saved title")).toHaveText(
    "Saved by the browser"
  );

  const document = await request.get("/");
  expect(document.ok()).toBe(true);
  expect(await document.text()).toContain("Saved by the browser");
  await page.reload();
  await expect(page.getByLabel("Saved title")).toHaveText(
    "Saved by the browser"
  );
});

test("catchTag turns a missing note into a successful skip and still allows mutations", async ({
  page,
}) => {
  await page.goto("/");
  const save = page.getByRole("button", { name: "Save note" });
  await expect(save).toBeEnabled();
  const before = await page.getByLabel("Saved title").textContent();
  expect(before).not.toBeNull();
  await page.getByLabel("Recover missing notes with catchTag").check();
  await page.getByLabel("Note ID").fill("missing");
  await page.getByLabel("Title", { exact: true }).fill("Saved after recovery");

  const rpc = page.waitForResponse(
    (response) =>
      response.url().includes("/_serverFn/") &&
      response.request().method() === "POST"
  );

  await save.click();
  const response = await rpc;
  expect(response.ok()).toBe(true);
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Skipped missing note"
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Saved title")).toHaveText(before ?? "");
  await page.reload();
  await expect(page.getByLabel("Saved title")).toHaveText(before ?? "");
  await expect(save).toBeEnabled();
  await page.getByLabel("Recover missing notes with catchTag").check();
  await page.getByLabel("Title", { exact: true }).fill("Saved after recovery");
  await save.click();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved"
  );
  await expect(page.getByLabel("Saved title")).toHaveText(
    "Saved after recovery"
  );
});

for (const scenario of [
  { message: "Invalid input", name: "Schema rejection", title: "" },
  { message: "Something went wrong", name: "defect", title: "crash" },
]) {
  test(`catchTag does not swallow a ${scenario.name}`, async ({ page }) => {
    await page.goto("/");
    const save = page.getByRole("button", { name: "Save note" });
    await expect(save).toBeEnabled();
    const before = await page.getByLabel("Saved title").textContent();
    expect(before).not.toBeNull();
    await page.getByLabel("Recover missing notes with catchTag").check();
    await page.getByLabel("Title", { exact: true }).fill(scenario.title);
    await save.click();
    await expect(page.getByRole("alert")).toHaveText(scenario.message);
    await expect(page.getByRole("status", { name: "Save status" })).toHaveCount(
      0
    );
    await page.reload();
    await expect(page.getByLabel("Saved title")).toHaveText(before ?? "");
  });
}

for (const scenario of [
  { id: "1", message: "Invalid input", name: "schema failure", title: "" },
  {
    id: "missing",
    message: "Note does not exist",
    name: "approved business error",
    title: "Hello",
  },
  {
    id: "1",
    message: "Something went wrong",
    name: "private defect",
    title: "crash",
  },
]) {
  test(`handles ${scenario.name} without leaking diagnostics or mutating state`, async ({
    page,
  }) => {
    await page.goto("/");
    const save = page.getByRole("button", { name: "Save note" });
    await expect(save).toBeEnabled();
    const before = await page.getByLabel("Saved title").textContent();
    expect(before).not.toBeNull();
    await page.getByLabel("Note ID").fill(scenario.id);
    await page.getByLabel("Title", { exact: true }).fill(scenario.title);

    const rpc = page.waitForResponse(
      (response) =>
        response.url().includes("/_serverFn/") &&
        response.request().method() === "POST"
    );

    await save.click();
    const response = await rpc;
    const body = await response.text();
    expect(body).not.toContain("services-private-diagnostic");

    if (scenario.name === "schema failure") {
      expect(response.status()).toBe(400);
      expect(body).toContain("INVALID_INPUT");
    }

    await expect(page.getByRole("alert")).toHaveText(scenario.message);
    await expect(page.getByLabel("Saved title")).toHaveText(before ?? "");
    await page.reload();
    await expect(page.getByLabel("Saved title")).toHaveText(before ?? "");
  });
}

test("keeps service implementation out of delivered browser JavaScript", async ({
  page,
}) => {
  const scripts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script" && response.ok()) {
      scripts.push(response.text());
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Save note" })).toBeEnabled();
  const sources = await Promise.all(scripts);
  const source = sources.join("\n");
  expect(scripts.length).toBeGreaterThan(0);
  expect(source).not.toContain("services-private-diagnostic");
  expect(source).not.toContain("example/Notes");
});
