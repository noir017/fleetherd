/**
 * The page's body mount root.
 *
 * The login gate (`#gate` / `#login`) is rendered by `page.ts`; once authenticated, the client
 * entrypoint (`client/main.ts`) mounts `WorkbenchShell` and all 12 built-in plugins into
 * `#workbench-root`.
 */
export const PAGE_BODY = `<div id="workbench-root" hidden></div>
`;
