import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

import "../../../playground.css";

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <main>
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  ),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Effect server functions — services" },
    ],
  }),
});
