// This fixture deliberately exercises export-star resolution.
// oxlint-disable-next-line oxc/no-barrel-file
export * from "./factory.js";

export { createEffectServerFn as configured } from "./factory.js";

export { createServerFn as createEffectServerFn } from "@tanstack/react-start";
