import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <main
          style={{
            fontFamily: "system-ui",
            margin: "3rem auto",
            maxWidth: "42rem",
            padding: "1rem",
          }}
        >
          <nav>
            <Link to="/">Greeting</Link> · <Link to="/about">About</Link>
          </nav>
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
      { title: "Effect server functions — basic" },
    ],
  }),
});
