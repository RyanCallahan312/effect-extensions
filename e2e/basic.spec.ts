import { expect, test } from "./fixtures.ts";

for (const style of ["pipe", "flow", "fn", "do"]) {
  test(`${style} composes decoded input and recovers after a piped Schema rejection`, async ({
    page,
  }) => {
    await page.goto("/");
    const submit = page.getByRole("button", { exact: true, name: "Greet" });
    await expect(submit).toBeEnabled();
    await page.getByLabel("Composition").selectOption(style);
    await page.getByLabel("Name", { exact: true }).fill("Grace");
    await page.getByLabel("Count", { exact: true }).fill("41");

    const rpc = page.waitForResponse(
      (response) =>
        response.url().includes("/_serverFn/") &&
        response.request().method() === "GET"
    );

    await submit.click();
    const response = await rpc;
    expect(response.ok()).toBe(true);
    await expect(
      page.getByRole("status", { name: "Greeting result" })
    ).toHaveText("Hello, Grace! Count + 1 = 42");

    await page.getByLabel("Count", { exact: true }).fill("0");

    const rejected = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === new URL(response.url()).pathname
    );

    await submit.click();
    const invalid = await rejected;
    expect(invalid.status()).toBe(400);
    await expect(page.getByRole("alert")).toHaveText("Invalid input");
    await expect(
      page.getByRole("status", { name: "Greeting result" })
    ).toHaveText("Hello, Grace! Count + 1 = 42");

    await page.getByLabel("Count", { exact: true }).fill("7");
    await submit.click();
    await expect(
      page.getByRole("status", { name: "Greeting result" })
    ).toHaveText("Hello, Grace! Count + 1 = 8");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test.describe("SSR", () => {
  test.use({ javaScriptEnabled: false });

  test("renders Effect loader results without JavaScript", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText("Rendered on the server: Hello, SSR!")
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Greeting result" })
    ).toHaveText("Hello, SSR! Count + 1 = 2");
    await expect(
      page.getByRole("button", { exact: true, name: "Greet" })
    ).toBeDisabled();
  });
});

test("hydrates and decodes encoded GET input through a real RPC", async ({
  page,
}) => {
  await page.goto("/");
  const submit = page.getByRole("button", { exact: true, name: "Greet" });
  await expect(submit).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).fill("Ada");
  await page.getByLabel("Count", { exact: true }).fill("41");

  const rpc = page.waitForResponse(
    (response) =>
      response.url().includes("/_serverFn/") &&
      response.request().method() === "GET"
  );

  await submit.click();
  const response = await rpc;
  expect(response.ok()).toBe(true);
  await expect(
    page.getByRole("status", { name: "Greeting result" })
  ).toHaveText("Hello, Ada! Count + 1 = 42");
});

test("sanitizes invalid input and accepts a later valid request", async ({
  page,
}) => {
  await page.goto("/");
  const submit = page.getByRole("button", { exact: true, name: "Greet" });
  await expect(submit).toBeEnabled();
  await page.getByLabel("Count", { exact: true }).fill("private-invalid-count");

  const rpc = page.waitForResponse((response) =>
    response.url().includes("/_serverFn/")
  );

  await submit.click();
  const response = await rpc;
  expect(response.status()).toBe(400);
  const body = await response.text();
  expect(body).toContain("INVALID_INPUT");
  expect(body).not.toContain("private-invalid-count");
  await expect(page.getByRole("alert")).toHaveText("Invalid input");
  await page.getByLabel("Count", { exact: true }).fill("3");
  await submit.click();
  await expect(
    page.getByRole("status", { name: "Greeting result" })
  ).toHaveText("Hello, Ada! Count + 1 = 4");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("uses client-side navigation and native server redirects", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { exact: true, name: "Greet" })
  ).toBeEnabled();
  await page.locator("html").evaluate((element) => {
    element.dataset.navigation = "same-document";
  });
  await page.getByRole("link", { exact: true, name: "About" }).click();
  await expect(page).toHaveURL(/\/about$/u);
  await expect(
    page.getByRole("heading", { name: "About this example" })
  ).toBeVisible();
  await page.getByRole("link", { exact: true, name: "Greeting" }).click();
  await expect(
    page.getByText("Rendered on the server: Hello, SSR!")
  ).toBeVisible();
  await page.getByRole("button", { name: "Server redirect" }).click();
  await expect(page).toHaveURL(/\/about$/u);
  await expect(page.locator("html")).toHaveAttribute(
    "data-navigation",
    "same-document"
  );
});

test("runs client-only and isomorphic Effects in the browser", async ({
  page,
}) => {
  await page.goto("/");
  const check = page.getByRole("button", { name: "Check browser utilities" });
  await expect(check).toBeEnabled();
  const rpcCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/_serverFn/")) {
      rpcCalls.push(request.url());
    }
  });
  await check.click();
  await expect(page.getByLabel("Browser utilities")).toHaveText("browser /");
  expect(rpcCalls).toEqual([]);
});
