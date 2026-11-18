/**
 * The bundle's entry — a loader, and nothing else.
 *
 * It must not import CodeMirror statically, and the reason is not size. esbuild keeps whatever an
 * entry chunk imports statically inside that chunk, and a dynamic chunk that imports the same
 * module gets a SECOND copy rather than sharing the entry's. Two copies of `@codemirror/state` are
 * two `Compartment` types, so `compartment.reconfigure(...)` from one copy is an effect the other
 * one's editor does not recognise — and CodeMirror ignores an unknown effect silently, which is
 * exactly how the editor rendered with no syntax colours and no error. Measured in Chromium on
 * 2026-11-18.
 *
 * With this file importing nothing but a dynamic chunk, `app.ts` and every language chunk are
 * siblings and esbuild factors their shared modules into one chunk, so there is one CodeMirror.
 * Top-level await is what lets `import()` still hand back a plain API object; every browser this
 * page targets (Safari 15, Chrome 100, Firefox 100) has it.
 */
const app = await import('./app.js');

export default app.default;
