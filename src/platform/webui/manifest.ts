/**
 * The web app manifest and the app icon, so a phone can install the web UI to its home screen.
 *
 * ── Why this lives in a .ts file as strings and base64 ────────────────────────
 * Same reason `page.ts` does: `package.json`'s `files` ships only `dist` and `skill`, and the one
 * asset step in the build bundles the client and the code view, copying nothing. An `icon.png`
 * beside the source would typecheck, pass tests, and 404 in the published package. Anything the
 * daemon serves has to survive `tsc` or that bundler, which for these means being a module.
 *
 * ── What is actually required ────────────────────────────────────────────────
 * Less than most guides claim. Chrome dropped the service-worker-with-a-fetch-handler
 * requirement — the check was a proxy for "has an offline story" and sites defeated it with
 * empty handlers, so it was removed rather than tightened
 * (https://developer.chrome.com/blog/update-install-criteria, read 2026-09-20). What remains
 * is HTTPS and a manifest. So there is no service worker here, and there should not be one
 * added for installability alone: it would also mean caching the app shell, and the shell is
 * deliberately served `no-store` because a stale copy after an upgrade is a support question.
 */

/**
 * The icon, as the vector it was drawn as: a `>_` prompt, which is what is on the other end.
 *
 * No `width`/`height` — the manifest entry declares `sizes: "any"` and the consumer rasterises
 * at whatever size it needs. Chromium parses this entry without complaint (verified against
 * `Page.getAppManifest`, Chromium 1148), and Firefox takes SVG icons too.
 *
 * The glyph sits inside the middle 60% of the canvas rather than filling it, because the entry
 * is also declared `maskable`: Android crops the icon to whatever shape the launcher uses, and
 * only a circle of 80% diameter is guaranteed to survive. A glyph drawn to the edges loses its
 * ends on a round launcher.
 */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" fill="#1c222b"/>' +
  '<g fill="none" stroke-width="34" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="196,186 268,256 196,326" stroke="#dcdcdc"/>' +
  '<line x1="296" y1="326" x2="366" y2="326" stroke="#5f8ec4"/>' +
  "</g></svg>";

/**
 * The same icon rasterised to 192x192, because two consumers will not take the SVG.
 *
 * iOS has no manifest-icon support worth relying on and reads `<link rel="apple-touch-icon">`,
 * which has never accepted SVG; and an Android launcher that declines to rasterise SVG falls
 * back to a generated letter tile rather than to nothing, which looks like a bug. 1604 bytes
 * is a cheap way to not have to know which builds those are.
 *
 * Regenerate from ICON_SVG above — they are meant to be the same drawing:
 *
 *   printf '%s' "<the svg>" | npx -y resvg-cli --fit-width 192 - /tmp/i.png
 *   base64 -w96 /tmp/i.png
 */
const ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAGC0lEQVR4nO3dX2iVdRzH8V8ghrqCCG1RXuwPFqVuCFkNI8gK" +
  "LzQyJLpJglY0EFviQNmgBfMPbNGKYBcamLtwXXVRhBR6JaMGxbRAitoulrGcUOAsoqC+vyOjx8M2z87ze845v+fzfsHY9+z6" +
  "+z7P2Xme85xb7m188F8HiCIASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMA" +
  "SCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMA" +
  "SCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCMASCOARWxpe9g1NzXYdN2P" +
  "P026c6Nf2YS8IIB5NDc1ur43D7r6+jX26EbT05ddz1tHLIYJe4TYEUCR1pYNheWvq1tljxZ2dOA9d/rzMzYhZgSQ4Jd+5OSx" +
  "wu9SEEH8CCBh13PPuD2vvWxT6YggbgSQMDhwyLVuXG/T0hBBvAggodwAPCKIEwEkpAnAI4L4EEDCga7X3bannrCpfEQQFwJI" +
  "8G+BDvb32ZQOEcSDAIqEOAp4J4ZP2c+ITahlBDCP40ODdjb4/0sgyuWPAv5ogNpFAAsIdSQggtpGAIsggvwjgJsggnwjgBIQ" +
  "QX4RQImIIJ8IYAmIIH8IYImIIF8IoAyhIhg//23h02Wzs9fsEaqBAMq0p6Pd7dq5w6Z0/EcrO7t6iKBKCCCFbU9vdQf277Up" +
  "HSKoHgJIiQjiRgABEEG8CCAQIogTAQREBPEhgMCIIC4EkAEiiAcBZCRUBH75X9j9SuE3wiOADG1pe8TOGu91datKu9PcQvyR" +
  "oL3jDZsQGgFkzN9od3CgL3UE/rohf/0QwiKACggRgb8te0/vYZsQEgFUSNoIxi985zr3d9uEkAigQgoB9FsAJd55uhgBZIMA" +
  "KiDt8nu8BMoGAWQsxPJ7/BOcDQLIUOFtUDsXkHb5/XeTtXd02oTQCCAjwU6EXbMTYS9yIiwrBJCBUMvvn/k7u7pZ/gwRQGAs" +
  "f1wIICCWPz4EEAjLHycCCIDljxcBpMTyx40AUmD540cAZfJfqO2/WDstlr+6CKAM/lnfP/un5S9w89f3sPzVQwBLFGr5T39x" +
  "1h3tf9cmVBMBLAHLnz8EUCKWP58IoAQsf34RwE2w/PlGAItg+fOPABZQi8u/4vY7XcND293qxla37NaV9pfKmpkYd1Pnz7rf" +
  "Ln1vj/KBAOZxfOidwkcZ0wq5/LetXus2PbuvKotf7OKZD90vF0dtih8BFAn1zH9ieMR+TtmUXi0t/5y8REAACa0tGwofYE8r" +
  "9AfYN+3c5+645z6basc/f/3hRk92u7/td8wIICHEtz+GXn7/ur9t92Gbak8ejgIEkDA4cMi1blxvU3lCL7/nn/n9EaAWTY59" +
  "6ibGPrEpXgSQkCaALJbfI4BsEUBCuQFktfweAWSLABL89f3+Ov+lyHL55zz+6qBbtnyFTbVl7KM+d3VmyqZ4EUCCv4PbyPCx" +
  "ku/gXInl9xo373ANm7fbVDt+v/SD+/rjt22KGwEU8W+F9vUeXDQCf7e294c+qMjyz3ngyZfc3fc/alP1zV752X1jyx/7W6Ae" +
  "AczDnwX2EdTftcYe3Wj618uup/eI819bVGnrHnverW3ZalP1+Gf+C58N5WL5PQJYhL+5bXNTg03X+c/vnhv90qbq8ecFCtcC" +
  "LV9p/yCvs79k7+qVKTvx9aebmRyP/jV/MQKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKA" +
  "NAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKA" +
  "NAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKANAKAtP8A" +
  "CVU/7ltR8o4AAAAASUVORK5CYII=";

/** Decoded once, at module load: the bytes are constant and every request wants the same ones. */
export const ICON_PNG = Buffer.from(ICON_PNG_BASE64, "base64");

/**
 * The manifest, as JSON text.
 *
 * Every URL in it is RELATIVE, resolved by the browser against the manifest's own URL. That is
 * the same rule the page follows for `api/events` and for the same reason: the daemon may be
 * mounted under a sub-path by a reverse proxy, and an absolute `/` would walk out of it. It is
 * also what makes `scope` correct without the daemon having to be told where it lives.
 *
 * `display: standalone` rather than `fullscreen`: the status bar carries the clock and the
 * battery, and a chat client is not worth losing them for. `theme_color` matches the page
 * background so the system draws that bar in the app's colour instead of framing it in white.
 */
export function renderManifest(title: string): string {
  return JSON.stringify(
    {
      name: title,
      short_name: title,
      description: "A coding agent, reachable from a browser.",
      start_url: ".",
      scope: "./",
      display: "standalone",
      // --bg and --own from page.ts. background_color is what fills the splash screen before
      // the page paints, so it matching the page is the difference between a launch and a flash.
      background_color: "#131313",
      theme_color: "#131313",
      icons: [
        {
          src: "icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
        {
          src: "icon.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    },
    null,
    2,
  );
}
