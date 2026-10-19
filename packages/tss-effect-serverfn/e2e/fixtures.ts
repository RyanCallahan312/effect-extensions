import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          /hydrat|did not match/iu.test(message.text())
        ) {
          errors.push(message.text());
        }
      });
      await use(errors);
      expect(
        errors,
        "Unhandled browser errors or hydration mismatches"
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
