/**
 * The page, as one HTML document with its CSS and JS inline.
 *
 * ── Why this is a TypeScript string and not an .html file ────────────────────
 * `npm run build` is exactly `tsc -p tsconfig.build.json` — no bundler, no asset pipeline, no
 * copy step anywhere in the repo — and `package.json`'s `files` ships only `dist` and `skill`.
 * A `.html` under `src/` is silently ignored by tsc: it would not reach `dist/`, would not
 * reach the npm tarball, and the daemon would 500 in production while working perfectly from
 * `tsx src/cli.ts` in development. Shipping it as a module makes dev and prod the same code
 * path and costs no build change at all.
 *
 * ── What that costs, and how it is contained ─────────────────────────────────
 * The script below is the one part of this repo the toolchain cannot see: not typechecked,
 * not linted, not unit-tested. So it is kept deliberately stupid. Every decision that could
 * live in TypeScript does: markdown becomes HTML in `web-markdown.ts`, the message shape is
 * fixed in `protocol.ts`, button ids are formed in `core/button-id.ts`. What is left here is
 * upsert-by-id, paint, and three fetches. If a change to this file needs a new *decision*,
 * that decision belongs on the other side of the wire.
 *
 * Two mechanical traps, since neither is visible until it bites:
 *   - A literal backtick or `${` in the script or the CSS would be read by TypeScript as
 *     part of THIS template, not as client code. The script therefore uses string
 *     concatenation throughout and contains neither.
 *   - `title` comes from config and is interpolated into `<title>`. It is escaped, because
 *     otherwise a `title:` in config.yaml is stored XSS on the operator's own page.
 *
 * ── The look ─────────────────────────────────────────────────────────────────
 * Dark, and only dark — no toggle, no light palette, no `prefers-color-scheme`. One palette
 * is the smallest thing that satisfies "dark by default", and a theme switch is exactly the
 * kind of feature that makes a page memorable. Nothing is loaded from anywhere: no fonts, no
 * CDN, no favicon request. The whole document is what the daemon serves.
 */
import { escapeHtml } from '../web-markdown.js';

/**
 * Fill in the configured title, whether the terminal pane exists, and whether a session can be
 * ended from it.
 *
 * All three are baked into the document rather than announced over the event stream because
 * they are properties of the daemon, not of a conversation: none can change while the page is
 * open, and a control that appears one sync later is a control that flickers into existence.
 */
export function renderPage(title: string, terminal: boolean, password = true, terminalEnd = false): string {
  return PAGE.replace(/__TITLE__/g, escapeHtml(title))
    .replace(/__TERM__/g, terminal ? 'true' : 'false')
    .replace(/__TERM_END__/g, terminalEnd ? 'true' : 'false')
    .replace(/__PASSWORD__/g, password ? 'true' : 'false')
    .replace('__GATE__', password ? PASSWORD_GATE : SSO_GATE);
}

/**
 * The two doors, and only ever one of them in the delivered page.
 *
 * Both are `#gate` wrapping `#login`, so every style rule and every reference in the script
 * below is blind to which one it got — the only code that has to know is the submit handler.
 * Rendering both and hiding one in script was the other option, and it flashes a password box
 * at someone who has no password on every load.
 *
 * The SSO one has no field on purpose. When the proxy in front is the only way in there is no
 * secret that works, so a box asking for one turns "your session with the identity provider
 * expired" into "wrong token" — the two states a locked-out operator most needs to tell apart.
 * Reloading is what re-triggers the provider's sign-in, so that is the button.
 */
const PASSWORD_GATE = `<form id="gate" autocomplete="off"><div id="login">
<input id="secret" type="password" placeholder="Token" autocomplete="current-password" autofocus>
<button type="submit">Enter</button>
<p id="err"></p>
</div></form>`;

const SSO_GATE = `<form id="gate" autocomplete="off"><div id="login">
<p id="err">Not signed in. Your access session may have expired.</p>
<button type="submit">Reload</button>
</div></form>`;

const STYLE = `
/* The three columns' header bars — topics, the topic title, the scheduled panel — are one line
   across the page and share one height; a bar taller than its neighbours makes the top edge read
   as ragged. min-height rather than height because the panel's bar grows to 49px for a finger
   under 640px, and because a bar's own content can only make it taller, never shorter: whatever
   goes inside one has to fit this number. */
:root{--bg:#131313;--fg:#dcdcdc;--dim:#7d7d7d;--line:#272727;--own:#1c222b;--own-edge:#3a5f86;--field:#1a1a1a;--headh:42px;color-scheme:dark}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#333 transparent}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#303030;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#484848}
::-webkit-scrollbar-corner{background:transparent}
/* An id rule with display: wins over the browser's own [hidden]{display:none}, so #app and
   #hints would both ignore the attribute and show anyway — the chat pane before login, the
   command list with nothing in it. This is the standard fix and it has to stay. */
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;display:flex;flex-direction:column}
#gate{flex:1;display:flex}
#login{margin:auto;padding:24px;width:100%;max-width:320px}
#login input{width:100%;padding:9px 11px;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;font:inherit}
#login button{margin-top:10px;width:100%}
#err{color:#c06a6a;min-height:1.6em;margin:8px 0 0;font-size:13px}

#app{display:flex;flex-direction:row;height:100%;width:100%;margin:0;overflow:hidden}

/* ── The two side panels ─────────────────────────────────────────────────────
   The topic list on the left and the scheduled work on the right are one component,
   not two. A panel is a header row, a scrolling body, a footer row and a drag handle
   on its inner edge; the edge decides only the border, which way it slides out, and
   which way the handle measures. Everything else — the width and its persistence, the
   open/close animation, the drawer it becomes when a column no longer fits, the
   backdrop, the inert state, the safe-area padding, the finger-sized targets — is
   written once, below, for both.

   Closed, a panel is moved off-screen with a negative margin rather than display:none:
   a hidden element has nothing to animate, and a column that vanished would re-wrap the
   transcript in one frame. The negative margin also hands its width back to the chat,
   so closing reads as the column folding away rather than sliding under it. */
.panel{position:relative;display:flex;flex-direction:column;height:100%;min-width:0;background:#171717;z-index:10;transition:margin .18s ease,transform .18s ease}
.panel-left{width:var(--pw,var(--pw-default));flex:0 0 var(--pw,var(--pw-default));border-right:1px solid var(--line)}
.panel-right{width:var(--pw,var(--pw-default));flex:0 0 var(--pw,var(--pw-default));border-left:1px solid var(--line)}
.panel-left.collapsed{margin-left:calc(-1 * var(--pw,var(--pw-default)))}
.panel-right.collapsed{margin-right:calc(-1 * var(--pw,var(--pw-default)))}
#sidebar{--pw-default:240px}
/* Straddles the inner border so it is easy to hit without covering the scrollbar.
   Not offered in the drawer rules below: there the screen decides the width. */
.panel-resize{position:absolute;top:0;bottom:0;width:8px;cursor:col-resize;z-index:11;touch-action:none}
.panel-left>.panel-resize{right:-4px}
.panel-right>.panel-resize{left:-4px}
.panel-resize:hover,.panel-resize.dragging{background:linear-gradient(90deg,transparent 3px,#3d3d3d 3px,#3d3d3d 5px,transparent 5px)}
.panel.collapsed>.panel-resize{display:none}
/* One backdrop for both drawers. It is displayed only where an edge really is a drawer
   (the media rules below), and only while that drawer is out (#app.sb-open /
   #app.sched-open). Tapping it puts away whichever drawer is open. */
#backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:19}
/* One bar, one height, one way out on both sides. The × is the panel's close button:
   the topic list and the task panel are both things a person opens and closes. */
.panel-head{display:flex;align-items:center;gap:6px;padding:0 8px 0 12px;border-bottom:1px solid var(--line);min-height:var(--headh);flex:0 0 auto}
.panel-title{flex:1;min-width:0;display:inline-flex;align-items:center;gap:2px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);white-space:nowrap}
.panel-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.btn-icon{background:none;border:0;padding:4px 7px;color:var(--dim);font:inherit;font-size:13px;cursor:pointer;border-radius:4px;line-height:1}
.btn-icon:hover{color:var(--fg);background:var(--field)}
.panel-head .add{font-size:15px;font-weight:600}

#topics{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px;padding:8px}
/* The row's colour is a variable because the hover buttons' fade (.topic-acts) has to end in exactly
   it: a fade into any other colour shows as a band across the title. #171717 is #sidebar's own. */
#topics .topic-item{--row-bg:#171717;display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:5px;background:var(--row-bg);text-align:left;font:inherit;font-size:13px;cursor:pointer;transition:background .15s;position:relative}
#topics .topic-item:hover{--row-bg:#222}
#topics .topic-item.on{--row-bg:#252525;border-color:var(--line)}
/* Four states, and the dot is the only thing that carries all four. Read as one sentence: the
   colour says whether the agent is there, the pulse says whether it is busy.
     grey     — nothing resident. History, or a topic that will have to resume from a session id.
     dim blue — an agent child is up and idle. Same blue, not doing anything.
     blue     — the agent is working: a turn, or background work reporting in after one.
     amber    — a question is on screen and nothing moves until it is answered. Wins over running,
                because during an ask the turn IS still open and would otherwise paint over it. */
.topic-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:#444}
.topic-dot.live{background:#2b6a8f}
.topic-dot.running{background:#38bdf8;box-shadow:0 0 6px rgba(56,189,248,.8);animation:pulse 1.5s infinite}
.topic-dot.asking{background:#fbbf24;box-shadow:0 0 6px rgba(251,191,36,.8);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
/* Two lines in one row, so the second can hold the directory. min-width:0 is what lets either
   line actually ellipsis — without it a flex item refuses to shrink below its content and a
   long title pushes the delete button out of the column instead of being cut. */
.topic-main{flex:1;min-width:0;display:flex;flex-direction:column}
.topic-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Which agent answers here, as formatLaneTitle puts it in front of the name. Dimmer than the
   title it opens: the subject is what you scan for, and the tag is metadata the row already half
   says one line down (the machine, when the agent is on a host). Dimmer by a step, not by a fixed
   grey: #6b7683 was tuned against an idle row and read as disabled next to the #dcdcdc/#fff of a
   running or selected title — the two states whose row is most worth reading. Inheriting the
   title's colour and fading it keeps the tag one step below whichever title it sits in, in every
   state the title rules below paint, and in the sessions panel, whose title has its own colour
   rule. It still takes its width — it is inside the one ellipsised line — so the page shortens it
   to the agent id where it can (splitTitle), rather than letting it eat the subject. */
.topic-tag{color:inherit;opacity:.85}
/* Which project this topic is in. Dimmer than an idle title on purpose: it is what you scan
   for when several topics are open, not what you read. */
.topic-dir{font-size:11px;line-height:1.35;color:#6b7683;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#topics .topic-item.on .topic-dir{color:#8b98a6}
#topics .topic-item.running .topic-title{color:var(--fg)}
#topics .topic-item.on.running .topic-title{color:#fff}
#topics .topic-item.idle .topic-title{color:var(--dim)}
#topics .topic-item.on.idle .topic-title{color:#a0a0a0}
/* Quiet but not finished: half a step back from a running title, half a step ahead of a topic
   with nothing behind it. The dot says which; this is so the eye finds the right row first. */
#topics .topic-item.idle.live .topic-title{color:#9a9a9a}
#topics .topic-item.on.idle.live .topic-title{color:#bcbcbc}
.topic-badge{background:#2563eb;color:#fff;border-radius:9px;padding:1px 6px;font-size:11px;font-weight:600;line-height:1.3;margin-left:4px;flex-shrink:0}
/* A terminal is attached to this topic. Deliberately not a fifth colour on .topic-dot: that dot
   is about the agent — whether one is resident, busy, or waiting on an answer — and a terminal is
   an unrelated state that can be true alongside any of them.
   A prompt-shaped glyph says which of the two it is without a legend. */
.topic-term{flex-shrink:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9.5px;line-height:1;color:#4ade80;border:1px solid rgba(74,222,128,.35);border-radius:3px;padding:2px 3px;margin-left:4px}
.topic-del{opacity:0;background:none;border:0;color:var(--dim);font:inherit;font-size:16px;line-height:1;padding:2px 5px;cursor:pointer;border-radius:3px;margin-left:auto;flex-shrink:0;transition:opacity .15s,color .15s,background .15s}
#topics .topic-item:hover .topic-del,#topics .topic-item:focus-within .topic-del{opacity:1}
.topic-del:hover{color:#f87171;background:rgba(248,113,113,.15)}
@media(hover:none){.topic-del{opacity:.7}}
/* The star sits beside the × and behaves like it until it is ON: then it stays lit on every row,
   because a starred row is the one thing in the list the operator asked to be able to find, and
   a marker that only appears under the pointer finds nothing. Amber like the waiting dot, but
   still — a star is a standing decision, not something happening. */
.topic-star{opacity:0;background:none;border:0;color:var(--dim);font:inherit;font-size:13px;line-height:1;padding:3px 4px;cursor:pointer;border-radius:3px;flex-shrink:0;transition:opacity .15s,color .15s,background .15s}
#topics .topic-item:hover .topic-star,#topics .topic-item:focus-within .topic-star{opacity:1}
.topic-star:hover{color:#fbbf24;background:rgba(251,191,36,.12)}
.topic-star.on,#topics .topic-item .topic-star.on{opacity:1;color:#fbbf24}
@media(hover:none){.topic-star{opacity:.45}}
/* The star and the × in one box, so they can leave the row's layout together.
   On a pointer device they are invisible until hovered — but opacity:0 hides a box without removing
   it, so they used to hold their place in the row anyway and every title stopped ~60px short of the
   column's edge, in front of two buttons nobody could see (reported 2026-10-30). There they now
   float over the row's right end, on a fade into the row's own colour that covers the title's tail
   rather than reflowing it. Two cases keep them in the row: a touch screen, which has no hover and
   shows them all the time, and a starred row at rest, whose lit star is content a title must not
   run under — its × is dropped from the layout there instead of being kept as a gap. */
.topic-acts{display:flex;align-items:center;gap:8px;flex-shrink:0}
@media(hover:hover){
  .topic-acts{position:absolute;top:0;bottom:0;right:9px;padding-left:22px;background:linear-gradient(90deg,transparent,var(--row-bg) 18px);opacity:0;pointer-events:none;transition:opacity .15s}
  #topics .topic-item:hover .topic-acts,#topics .topic-item:focus-within .topic-acts{opacity:1;pointer-events:auto}
  #topics .topic-item.starred:not(:hover):not(:focus-within) .topic-acts{position:static;padding-left:0;background:none;opacity:1;pointer-events:auto}
  #topics .topic-item.starred:not(:hover):not(:focus-within) .topic-del{display:none}
}
/* Where the group that needs the person ends. A pseudo-element on the first row after it rather
   than a node of its own, so #topics holds rows and nothing else. */
/* A topic another topic's agent opened (Topic.parent — daemon/delegation.ts), under the one that
   opened it. Classes rather than a --depth custom property in a style attribute, which the page's
   CSP would refuse; deeper than three is drawn at three, since a 240px column has no room for a
   staircase. The elbow is ::before, which is free on these rows: only a depth-0 row draws the
   after-needs rule. */
#topics .topic-item.sub{width:auto}
#topics .topic-item.d1{margin-left:14px}
#topics .topic-item.d2{margin-left:28px}
#topics .topic-item.d3{margin-left:42px}
#topics .topic-item.sub::before{content:'';position:absolute;left:-9px;top:50%;width:6px;border-top:1px solid #3a3a3a}
/* How many topics this one opened, and the switch that folds them away. Folded, it takes the colour
   of the most pressing state among them — a question, a failure, work — so folding hides the rows
   and not the fact that one of them wants you. At the START of the row's second line, before the
   directory: anywhere on the right, the star and × that float in on hover (.topic-acts) cover it,
   and a click meant to fold lands on delete — which the first end-to-end run did. */
.topic-line{display:flex;align-items:center;gap:6px;min-width:0}
.topic-fold{flex-shrink:0;border:1px solid var(--line);background:none;color:var(--dim);border-radius:9px;padding:0 5px;font:inherit;font-size:10px;line-height:1.4;cursor:pointer;transition:color .15s,border-color .15s}
.topic-fold:hover{color:var(--fg);border-color:#555}
.topic-fold.asking{color:#fbbf24;border-color:rgba(251,191,36,.6)}
.topic-fold.failed{color:#f87171;border-color:rgba(248,113,113,.6)}
.topic-fold.running{color:#38bdf8;border-color:rgba(56,189,248,.5)}
/* A failed last turn, when nothing else is going on: the one state that stays until something runs
   again, so the dot keeps saying it after the reply has been read. */
.topic-dot.failed{background:#f87171}
/* What needs the person — a question waiting, a failure, a reply not yet read — is the topic's own
   row, first in the list and green (page script: needsYou). The dot still says which of the three. */
#topics .topic-item.needs{--row-bg:#14231a}
#topics .topic-item.needs:hover{--row-bg:#1a2e21}
/* :not(.on) for the weight, not the meaning (a topic on screen is never one of these): the idle and
   live greys above are four classes deep, and a lighter rule lost to them on an idle agent. */
#topics .topic-item.needs:not(.on) .topic-title{color:#4ade80}
/* An unread reply, on a topic the person is expected to read. A sub-agent's row never takes this
   one: its finished turn is the news of the agent that opened it (see the dot class in
   paintTopics), so the row stays the ordinary idle/online grey. */
.topic-dot.review{background:#4ade80}
/* Low attention (the Menu, per device: calmBtn). With several agents working at once the
   list never stops moving — a pulsing dot per running topic, and an unread count in a bright pill
   that climbs with every message a running turn posts — and none of that is anything to act on.
   Here work is shown and not announced: the running dot keeps its colour and halo and stops
   pulsing, and the count goes grey. What needs the person is left exactly as it is — the amber
   dot still pulses, and a question, a failure and an unread reply still move up in green — so it
   is the only thing on the list that moves or stands out. */
#app.calm .topic-dot.running{animation:none}
#app.calm .topic-badge{background:#2a2a2a;color:#8a8a8a;font-weight:500}
#topics .topic-item.after-needs{margin-top:5px}
#topics .topic-item.after-needs::before{content:'';position:absolute;left:9px;right:9px;top:-5px;border-top:1px solid var(--line)}
/* The last row of a panel: the topic sidebar's two menus, the scheduled panel's two tabs.
   Same border, padding, type size and height on both sides, so the two columns end on the
   same line. A size container so the words can give way to their glyphs when the sidebar
   is dragged to its 180px minimum, rather than the row overflowing.
   It was a column of full-width buttons, one per control, and reached three rows with a
   fourth on the way (2026-11-03); it is two menus now. Menu holds what is set once per
   device (Notifications, Low attention) or visited rarely (All settings, Skills). Manage
   holds Close idle and keeps the idle count on its own face, so the count is still seen
   without opening anything. Clear all topics is an icon button beside the Topics title. */
.panel-foot{border-top:1px solid var(--line);padding:8px;display:flex;align-items:center;gap:4px;position:relative;flex:0 0 auto;container-type:inline-size}
.panel-foot>button{background:none;border:0;padding:7px 9px;border-radius:5px;color:var(--dim);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;transition:color .15s,background .15s}
.panel-foot>button:hover,.panel-foot>button[aria-expanded="true"],.panel-foot>button.on{color:var(--fg);background:var(--field)}
/* line-height:1 keeps the 13px glyph from setting a taller line box than the 12px text
   beside it — without it the sidebar footer was 52px against the task panel's 50px. */
.opts-gear{font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;vertical-align:-1px}
@container (max-width:200px){.opts-word{display:none}}
#manage-toggle{margin-left:auto}
/* The idle count stays on Manage's face when its word drops: it is the one number on
   this row worth seeing without opening anything. */
.foot-count{margin-left:4px;color:#a8a8a8}
/* Both footer menus: one box, one place, one way to dismiss it. Opened upward from the
   footer over the bottom of the list, dismissed by a click anywhere else or Escape
   (setMenu). A disclosure rather than an ARIA menu: role=menu promises arrow-key
   navigation, and these are reached with Tab like any other buttons. */
.panel-menu{position:absolute;left:8px;right:8px;bottom:100%;margin-bottom:4px;z-index:12;background:#1e1e1e;border:1px solid var(--line);border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.5);padding:4px}
.panel-menu button{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;background:none;border:0;padding:8px 10px;border-radius:4px;color:var(--fg);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;white-space:nowrap;transition:color .15s,background .15s}
.panel-menu button:hover{background:var(--field)}
.panel-menu button:disabled{color:var(--dim);cursor:default}
.panel-menu button:disabled:hover{background:none}
.opt-state{color:var(--dim);font-size:12px}
[aria-pressed="true"]>.opt-state{color:#4ade80}
.opts-sep{border-top:1px solid var(--line);margin:4px 2px}
/* Clear all topics sits in the panel title: quiet until the pointer is on it. Dim, then red. */
#clear-topics{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}
#clear-topics:hover{color:#f87171;background:rgba(248,113,113,.15)}
/* The confirmation for it: names every topic whose agent is about to go, because "close 7 agents"
   does not say whether the one you were about to come back to is among them. A dialog of the page's
   own rather than confirm(), which cannot hold a list a phone can scroll. The list scrolls inside
   the box, so a long one never pushes the buttons off screen. */
#idle-dialog{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}
#idle-box{background:var(--bg);border:1px solid var(--line);border-radius:8px;width:min(440px,100%);max-height:80vh;max-height:80dvh;display:flex;flex-direction:column;gap:10px;padding:16px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#idle-title{font-weight:600}
#idle-why{margin:0;color:var(--dim);font-size:12.5px}
#idle-list{list-style:none;margin:0;padding:0;overflow-y:auto;min-height:0;border-top:1px solid var(--line)}
#idle-list li{display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid var(--line)}
.idle-main{flex:1;min-width:0;display:flex;flex-direction:column}
.idle-name,.idle-dir{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idle-dir{color:var(--dim);font-size:12px}
.idle-out{flex:none;font-size:12px;color:var(--dim)}
.idle-out.kept{color:#fbbf24}
.idle-acts{display:flex;justify-content:flex-end;gap:8px}
#idle-go{color:#f87171;border-color:rgba(248,113,113,.4)}

#chat{flex:1;display:flex;flex-direction:column;height:100%;min-width:0;position:relative}
#chat-header{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--line);min-height:var(--headh);font-size:13px}
.chat-title{font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50ch}
.chat-status{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
.chat-status.running{color:#38bdf8}
.chat-status.asking{color:#fbbf24}
/* The process behind this topic, ended on a tap (/kill). Red only under the pointer, as #term-end
   is: at rest it is one of the header's quiet controls, and one that is red all the time reads as
   an alarm rather than as an option. flex-shrink:0 because the title beside it is the thing that
   gives way to a narrow header; the control must not be what gets squeezed out. */
#kill-agent{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;padding:4px 6px}
#kill-agent:hover{color:#f87171;background:rgba(248,113,113,.15)}
/* The terminal takes the place of the transcript and the composer, not of the whole view: the
   header stays, so the sidebar button, the topic name and the way back out are all still
   where they were a moment ago. One class on #chat swaps the two.

   It is a window rather than a mode, which is what the title bar below is for. Minimizing only
   hides it — the iframe stays mounted and its WebSocket stays up, which is both what makes
   coming back instant and what keeps the switcher's marker lit. So visibility is a class, never
   a teardown. */
#term-toggle{margin-left:0}
#term-toggle.on{color:#4ade80}
#term{display:none;flex:1;min-height:0;background:#000;flex-direction:column}
#chat.term #log,#chat.term #typing,#chat.term #note,#chat.term #bar{display:none}
#chat.term #term{display:flex}
#term-bar{display:flex;align-items:center;gap:4px;padding:4px 6px 4px 12px;background:#161616;border-bottom:1px solid var(--line);flex:0 0 auto}
.term-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
#term-end:hover{color:#f87171;background:rgba(248,113,113,.15)}
/* The side panel's toggle. It owns the auto margin the terminal used to: the clock is always in
   the header, so it is what pushes the right-hand group to the edge whether the terminal button
   is there or not. */
#schedules-toggle{position:relative;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;padding:4px 6px;margin-left:auto}
#schedules-toggle.on{color:#4ade80}
/* A scheduled run that is waiting on an answer has no row in the switcher any more, so without
   this the one state that needs a person would be behind two clicks. Same amber as the asking dot,
   and it disappears the moment the run is answered. */
.sched-alert{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:#fbbf24;box-shadow:0 0 5px rgba(251,191,36,.8)}

/* ── The side panel ──────────────────────────────────────────────────────────
   A panel of its own on the right, not a section of the topic list: a task is not a
   conversation, and the sidebar is where conversations live. It is the same component as
   the sidebar (.panel above), on the other edge; what it does not share is the width it
   starts at — deliberately narrower, because this is a glance at background work rather
   than a place to read a transcript — and the screen width below which it stops being a
   column (1023px, where a 240px list plus a 240–320px panel leave too little chat; the
   topic list itself is still usable as a column down to 640px).

   Closed on a first visit, then open until the operator closes it: the choice is kept in
   localStorage (aa_sched_open, like the sidebar's), so opening a session from the panel
   leaves the panel where it was. --pw is set inline by the drag handle; the clamp is both
   the default and the fallback when the operator has never dragged it. Keep the 20vw
   arithmetic in the panel's width() in step with this line. */
#schedules{--pw-default:clamp(240px,20vw,320px)}
/* The heading is two lines in the same bar the sidebar gives one: the title and the summary
   are what the panel says at a glance, and neither can go. The leading is tightened to 1.25
   so the pair still fits inside --headh. */
.sched-heading{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;line-height:1.25}
/* The shared title takes the row's free space on the left; here the heading around it does,
   and a flex:1 title inside a column would grow down over the summary instead. */
.sched-heading .panel-title{flex:none}
.sched-summary{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Three lists, one panel: a task is a definition, a session is one run of it, and a review is
   what the gateway learned afterwards. They are tabs rather than one merged column that would
   make every run look like a task and every review like either. The tabs sit at the foot of the
   panel, in the same .panel-foot row the sidebar keeps its menus in, so the two columns end on
   one line. */
/* Three tabs in a 240px panel: the shared 9px padding leaves "Sessions" too little at that width,
   so these are tighter and a hair smaller. They still take a third each, and the count stays
   beside its word rather than wrapping. */
.panel-foot>.sched-tab{flex:1;min-width:0;text-align:center;padding-left:5px;padding-right:5px;font-size:11.5px;overflow:hidden;text-overflow:ellipsis}
.sched-count{font-weight:500;color:#6b7683;margin-left:2px}
.sched-tab.on .sched-count{color:#8a8a8a}
#schedules-body{flex:1;min-height:0;overflow-y:auto;padding:8px}
#schedules-list{display:flex;flex-direction:column;gap:6px}
/* A scheduled run, as the Sessions tab draws it: one line per topic, because there can be many
   and the thing being scanned for is which one is still working or waiting. */
#sched-sessions{display:flex;flex-direction:column;gap:2px}
.sess-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 6px 8px 8px;border:1px solid transparent;border-radius:5px;text-align:left;font:inherit;cursor:pointer;position:relative}
.sess-item:hover{background:#202020}
.sess-item.on{background:#252525;border-color:var(--line)}
.sess-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sess-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess-item.on .sess-title{color:#fff}
.sess-meta{font-size:11.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess-del{opacity:.35;flex:none}
.sess-item:hover .sess-del,.sess-item:focus-within .sess-del{opacity:1}
.sess-del:hover{color:#f87171;background:rgba(248,113,113,.15)}
/* A task card, in the order a person asks about one: what is it, when does it run, when next,
   where does it post, how did last time go. The name and the schedule carry the weight; the
   countdown and the target are one quiet line under them, and the only colour is a state that is
   not the ordinary one or a run that did not end ok. */
.sched-item{border:1px solid var(--line);border-radius:6px;padding:10px;background:#1b1b1b;cursor:pointer;display:flex;flex-direction:column;gap:3px}
.sched-item:hover{background:#1e1e1e}
.sched-item.open{background:#202020;border-color:#3a3a3a}
.sched-row{display:flex;align-items:center;gap:8px}
.sched-dot{width:8px;height:8px;border-radius:50%;background:#555;flex:none}
.sched-item.active .sched-dot{background:#38bdf8}
.sched-item.paused .sched-dot{background:#fbbf24}
.sched-item.expired .sched-dot{background:#f87171}
.sched-item.done .sched-dot{background:#4ade80}
.sched-item.running .sched-dot{box-shadow:0 0 6px rgba(56,189,248,.8);animation:pulse 1.5s infinite}
#app.calm .sched-item.running .sched-dot{animation:none}
.sched-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
/* A word only for the states that are not the ordinary one: an ACTIVE tag on every card is a
   line of text that tells nobody anything. */
.sched-state{flex:none;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:999px;background:#262626}
.sched-state.running{color:#38bdf8;background:rgba(56,189,248,.12)}
.sched-state.paused{color:#fbbf24;background:rgba(251,191,36,.12)}
.sched-state.expired{color:#f87171;background:rgba(248,113,113,.12)}
.sched-state.done{color:#4ade80;background:rgba(74,222,128,.12)}
.sched-when{font-size:12px;color:#d0d0d0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.sched-sub{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px;color:var(--dim)}
.sched-next{flex:none;color:#a8a8a8}
/* Blue is the running signal; a countdown on every active card would spend it. */
.sched-item.running .sched-next{color:#38bdf8}
.sched-target{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sched-sep{flex:none;color:#4a4a4a}
.sched-last{font-size:11.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sched-last.bad{color:#f87171}
.sched-detail{margin-top:5px;padding-top:8px;border-top:1px solid var(--line)}
.sched-detail-label{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.sched-detail-body{margin-top:4px;max-height:220px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#c9c9c9}
.sched-detail-meta{margin-top:6px;font-size:11.5px;color:var(--dim);overflow-wrap:anywhere}
.sched-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.sched-acts button{background:var(--field);border:1px solid var(--line);border-radius:5px;color:var(--fg);font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}
.sched-acts button:hover:not(:disabled){border-color:#3a3a3a;background:#2a2a2a}
.sched-acts button:disabled{opacity:.45;cursor:default}
/* Delete is last and quiet until the pointer is on it: it is the one action here that cannot be
   undone, and it should not compete with Pause for the eye on every card. */
.sched-acts button:last-child{margin-left:auto}
.sched-acts button.danger{color:var(--dim);border-color:transparent;background:none}
.sched-acts button.danger:hover:not(:disabled){color:#f87171;border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.12)}
.sched-acts button.confirm{background:rgba(248,113,113,.16);border-color:#7f1d1d;color:#fca5a5}
#schedules-note{margin:0 2px 8px;font-size:12px;color:#fbbf24;overflow-wrap:anywhere}
.sched-empty{padding:8px 2px;font-size:12.5px;line-height:1.6;color:var(--dim)}
/* ── The Reviews tab ─────────────────────────────────────────────────────────
   A review is a background event, not a control: one line per review, and the rest behind a tap. */
#sched-reviews-list{display:flex;flex-direction:column;gap:6px}
.rev-item{border:1px solid var(--line);border-radius:6px;padding:9px 10px;background:#1b1b1b;cursor:pointer;display:flex;flex-direction:column;gap:3px}
.rev-item:hover{background:#1e1e1e}
.rev-item.open{background:#202020;border-color:#3a3a3a}
.rev-row{display:flex;align-items:center;gap:6px;min-width:0}
.rev-dot{width:8px;height:8px;border-radius:50%;background:#555;flex:none}
.rev-item.changed .rev-dot{background:#4ade80}
.rev-item.preferences .rev-dot{background:#38bdf8}
.rev-item.refused .rev-dot{background:#fbbf24}
.rev-item.proposed .rev-dot{background:#8a8a8a}
.rev-item.failed .rev-dot{background:#f87171}
.rev-topic{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.rev-when{flex:none;font-size:11px;color:var(--dim)}
.rev-badge{flex:none;font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.02em;padding:1px 4px;border-radius:999px;background:#2a2a2a;color:#a8a8a8}
.rev-result{font-size:11.5px;color:#c9c9c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rev-item.failed .rev-result{color:#f87171}
.rev-detail{margin-top:6px;padding-top:8px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.rev-label{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.rev-change{font-size:12px;color:#d0d0d0;line-height:1.5;overflow-wrap:anywhere}
.rev-change .rev-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#fff}
.rev-reason{color:var(--dim)}
.rev-status{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-left:5px}
.rev-status.ok{color:#4ade80}
.rev-status.bad{color:#fbbf24}
.rev-status.unknown{color:#8a8a8a}
.rev-undo{display:block;margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#8a8a8a;overflow-wrap:anywhere;user-select:all}
.rev-pref{font-size:12px;color:#d0d0d0;line-height:1.5;overflow-wrap:anywhere}
.rev-note{font-size:11.5px;color:var(--dim);line-height:1.5;overflow-wrap:anywhere}
.rev-note.bad{color:#f87171}
.rev-open{background:var(--field);border:1px solid var(--line);border-radius:5px;color:var(--fg);font:inherit;font-size:12px;padding:5px 10px;cursor:pointer;align-self:flex-start}
.rev-open:hover{border-color:#3a3a3a;background:#2a2a2a}
/* ── The skills page ─────────────────────────────────────────────────────────
   A window over the transcript rather than a column: an editor needs width, and a history row
   needs more than a sidebar's 240px. The backdrop dims the chat for the same reason the reader's
   does — this is a surface of its own, not a third column competing with the conversation. */
#skills{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:24px}
#skills[hidden]{display:none}
#skills-box{display:flex;flex-direction:column;width:min(980px,100%);max-height:100%;overflow:hidden;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#skills-bar{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 16px;border-bottom:1px solid var(--line);min-height:var(--headh);font-size:13px}
#skills-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
#skills-count{flex:none;font-size:11.5px;color:var(--dim)}
#skills-new{background:var(--field);border:1px solid var(--line);border-radius:5px;color:var(--fg);font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}
#skills-new:hover{border-color:#3a3a3a;background:#2a2a2a}
#skills-close{font-size:18px;padding:6px 10px}
#skills-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px calc(16px + env(safe-area-inset-bottom,0px))}
#skills-note{margin:0 0 10px;font-size:12.5px;color:#fbbf24;overflow-wrap:anywhere}
/* /setting as a page of its own, opened from the Menu or by typing the command, rather
   than a screen inserted into the transcript. A window over the conversation like the reader and
   the skills page, and drawn from the same message the daemon already sends (settingsScreen): the
   rows, the values, the validation and the write all stay on the daemon's side. The bar says where
   these settings live — config.yaml, so every topic — because the old one named the topic it was
   opened in, which read as though they were that topic's (2026-11-05). */
#settings-page{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:24px}
#settings-page[hidden]{display:none}
#settings-box{display:flex;flex-direction:column;width:min(720px,100%);max-height:100%;overflow:hidden;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#settings-bar{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 16px;border-bottom:1px solid var(--line);min-height:var(--headh)}
.set-heading{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;line-height:1.25}
#settings-title{font-size:13px;font-weight:600}
#settings-topic{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#settings-close{font-size:18px;padding:6px 10px}
#settings-body{flex:1;min-height:0;overflow-y:auto;padding:14px 18px calc(18px + env(safe-area-inset-bottom,0px))}
#settings-body .set-loading{padding:8px 2px;font-size:12.5px;color:var(--dim)}
.skills-empty{padding:10px 2px;font-size:12.5px;line-height:1.6;color:var(--dim)}
.skill-item{border:1px solid var(--line);border-radius:6px;padding:10px 12px;background:#1b1b1b;cursor:pointer;display:flex;flex-direction:column;gap:3px;margin-bottom:6px}
.skill-item:hover{background:#1e1e1e}
.skill-row{display:flex;align-items:center;gap:8px;min-width:0}
.skill-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.skill-state{flex:none;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:999px;background:#262626;color:#9a9a9a}
.skill-state.active{color:#4ade80;background:rgba(74,222,128,.12)}
.skill-state.expired{color:#fbbf24;background:rgba(251,191,36,.12)}
.skill-state.archived{color:#9ca3af;background:#262626}
.skill-pin{flex:none;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#fbbf24}
.skill-desc{font-size:12.5px;color:#d0d0d0;line-height:1.45;overflow-wrap:anywhere}
.skill-meta{font-size:11.5px;color:var(--dim);overflow-wrap:anywhere}
.skill-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.skill-head .skill-name{flex:1 1 220px;font-size:15px}
.skill-acts{display:flex;flex-wrap:wrap;gap:6px}
.skill-acts.editor{margin-top:8px}
.skill-acts button{background:var(--field);border:1px solid var(--line);border-radius:5px;color:var(--fg);font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}
.skill-acts button:hover:not(:disabled){border-color:#3a3a3a;background:#2a2a2a}
.skill-acts button:disabled{opacity:.45;cursor:default}
.skill-acts button.danger{color:var(--dim);border-color:transparent;background:none}
.skill-acts button.danger:hover:not(:disabled){color:#f87171;border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.12)}
.skill-acts button.confirm{background:rgba(248,113,113,.16);border-color:#7f1d1d;color:#fca5a5}
.skill-section{margin-top:16px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.skill-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.skill-file{background:var(--field);border:1px solid var(--line);border-radius:5px;color:var(--fg);font:inherit;font-size:12px;padding:5px 9px;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.skill-file.on{border-color:#3a6ea5;background:rgba(56,189,248,.12);color:#bae6fd}
.skill-file small{color:var(--dim);margin-left:6px}
.skill-field{display:block;width:100%;box-sizing:border-box;margin-top:8px;background:var(--field);border:1px solid var(--line);border-radius:5px;color:var(--fg);font:inherit;font-size:12.5px;padding:8px 10px}
.skill-field[readonly]{color:var(--dim)}
.skill-text{width:100%;box-sizing:border-box;margin-top:8px;min-height:280px;resize:vertical;background:#111;border:1px solid var(--line);border-radius:5px;color:var(--fg);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;padding:10px;white-space:pre;overflow-wrap:normal;overflow-x:auto}
.skill-new-form{cursor:default}
.skill-history{margin-top:6px;border-top:1px solid var(--line)}
.skill-hist{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap}
.skill-hist-main{flex:1 1 260px;min-width:0}
.skill-hist-action{font-weight:600}
.skill-hist-meta{font-size:11.5px;color:var(--dim);overflow-wrap:anywhere}
/* One host for every mounted terminal, of which exactly one is visible. Visibility is a class
   rather than the hidden attribute because the rule that sizes an iframe would have to fight
   it: display:block on the element beats hidden's user-agent display:none, and the loser of
   that fight is not obvious from reading either rule. */
#term-frames{flex:1;min-height:0}
#term-frames iframe{display:none;width:100%;height:100%;border:0}
#term-frames iframe.on{display:block}

#log{flex:1;overflow-y:auto;padding:20px 16px 8px;max-width:860px;width:100%;margin:0 auto}
.m{margin:0 0 18px;max-width:100%;overflow-wrap:anywhere;animation:fade .18s ease-out}
/* Only on the element's first appearance, which is the whole reason messages are now reconciled
   rather than rebuilt: an animation restarts every time a node is created, so under the old
   empty-and-repaint sync this would have flickered the entire transcript on every reconnect. */
@keyframes fade{from{opacity:0}to{opacity:1}}
/* Message-shaped placeholders, held in the transcript while a topic's first sync is in flight.
   Entering a topic was a blank panel followed by the whole conversation arriving in one frame;
   the point of these is that the panel already has the SHAPE of what is coming, so the real
   messages replace something instead of landing in an empty box. Widths are uneven on purpose —
   four identical bars read as a broken layout rather than as text that has not arrived. */
.sk{margin:0 0 18px}
.sk.own{background:var(--own);border-left:2px solid var(--own-edge);border-radius:0 6px 6px 0;padding:9px 12px}
.sk i{display:block;height:11px;margin-bottom:7px;border-radius:3px;background:#242424;animation:breathe 1.6s ease-in-out infinite}
/* Inside the tinted panel a neutral grey bar disappears, the same way --line borders do there. */
.sk.own i{background:#2b333e}
.sk i:last-child{margin-bottom:0}
/* Its own swing rather than the running-topic dot's pulse: that one fades to .3, which on a 6px
   dot reads as blinking and on an 11px bar over this background reads as gone. Half opacity is
   the point where the bar still breathes and never stops being a bar. */
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.45}}
/* The other half of the same wait, for a topic that came back out of the local cache. There the
   transcript is already on screen, so there is nothing to hold a place in FRONT of — what is
   still unknown is whether anything was said while you were elsewhere, and that lands at the
   bottom. Sized and centred like .divider rather than like a message, for the ordinary case
   where nothing was missed: a message-shaped placeholder would have promised one. */
.syncing{display:flex;align-items:center;justify-content:center;gap:7px;margin:2px auto 18px;font-size:11.5px;color:var(--dim)}
.syncing .dots{display:inline-flex;gap:3px}
.syncing i{width:5px;height:5px;border-radius:50%;background:var(--dim);animation:blip 1.2s ease-in-out infinite}
.syncing i:nth-child(2){animation-delay:.2s}
.syncing i:nth-child(3){animation-delay:.4s}
/* Never all the way out, for the reason breathe does not either: three dots that vanish in turn
   read as a rendering fault on a 5px circle, where three that dim read as a wait. */
@keyframes blip{0%,100%{opacity:.3}50%{opacity:1}}
/* All three of the above are decoration over content that is arriving anyway, which is exactly
   what this query is for: without motion the skeleton is still a placeholder, the dots still say
   the page is waiting on something, and a message still appears — instantly. */
@media(prefers-reduced-motion:reduce){.m,.sk i,.syncing i,.launch{animation:none}.agent-card,.agent-card:hover{transition:none;transform:none}}
/* Why an empty room is empty. A transcript lives in memory only while the topic LIST is
   persisted, so every restart leaves rows that open onto nothing — and an empty panel rendered
   faithfully is indistinguishable from a page that failed to load, which is how it was reported.
   Sized and centred like a system note rather than a message: it is about the room, not in it. */
.empty{margin:28px auto;max-width:46ch;text-align:center;font-size:12.5px;line-height:1.6;color:var(--dim)}
/* A new topic: every agent it could be given to, by machine, in place of a blank transcript (see
   paintLaunch). A choice laid out rather than a message, so it is not in the transcript and leaves
   the moment anything is — typing straight away is still an answer, and the card marked default is
   who it reaches. Cards rather than menu cells: each says what the agent IS (the harness, its model)
   as well as its id, which a one-line button cannot without truncating. The default is drawn in the
   blue of a menu's current choice, the one other place this page marks "this is what you get". */
.launch{max-width:720px;margin:7vh auto 24px;animation:fade .18s ease-out}
.launch-head{text-align:center;margin-bottom:26px}
.launch-title{font-size:19px;font-weight:600;color:var(--fg);letter-spacing:-.01em}
.launch-sub{margin-top:5px;font-size:13px;color:var(--dim)}
.launch-sub b{color:#a8a8a8;font-weight:600}
.launch-group+.launch-group{margin-top:20px}
/* The machine, as a rule with its name on it: the heading groups the cards without boxing them. */
.launch-host{display:flex;align-items:center;gap:10px;margin:0 2px 9px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--dim)}
.launch-host::after{content:'';flex:1;border-top:1px solid var(--line)}
.launch-host .n{font-weight:400;color:#5c5c5c;letter-spacing:0}
.launch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px}
.agent-card{display:flex;flex-direction:column;align-items:stretch;gap:3px;min-width:0;min-height:68px;padding:11px 13px 10px;background:#181818;border:1px solid var(--line);border-radius:8px;text-align:left;line-height:1.3;transition:background .12s,border-color .12s,transform .12s}
.agent-card:hover{background:#1e1e1e;border-color:#3a3a3a;transform:translateY(-1px)}
.agent-card:active{transform:none;background:#232323}
.agent-card:focus-visible{outline:2px solid #38bdf8;outline-offset:2px}
.agent-card.def{background:var(--own);border-color:var(--own-edge)}
.agent-card.def:hover{background:#212a35;border-color:#4b78a8}
.ac-top{display:flex;align-items:center;gap:8px}
.ac-id{flex:1;min-width:0;font-size:15px;font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-tag{flex:none;font-size:10.5px;line-height:1;padding:3px 6px;border-radius:9px;color:#8cc4ea;background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.28)}
.ac-kind{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#a3a3a3;overflow:hidden;white-space:nowrap}
.ac-kind span{overflow:hidden;text-overflow:ellipsis}
/* Which harness, at a glance, in a colour of its own: the eye finds "the Codex one" by colour
   before it has read a word. Keyed on the configured harness, not the label, which is prose. */
.ac-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#6b6b6b}
.ac-dot.h-claude{background:#d97757}
.ac-dot.h-codex{background:#10a37f}
.ac-dot.h-opencode{background:#e2e2e2}
.ac-dot.h-agy{background:#4f8ff7}
.ac-dot.h-gemini{background:#a78bfa}
.ac-dot.h-dsh{background:#5b7cfa}
/* The UI face rather than monospace, and 720px for the launcher rather than less: measured in
   Chromium, "deepseek-v4.1-flash-free" is 159px in 11px monospace and 143px here, and a desktop card
   at four to a row leaves 148px for it. A longer name still ends in an ellipsis, whole on hover. */
.ac-model{font-size:11.5px;color:#737373;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A rule and an indent were all that separated the two sides of the conversation, and at a
   glance down a long transcript that is not enough to find where your own question ended and
   the answer began. Own messages get a tinted panel instead — cool where the page is neutral,
   so it reads as "mine" without becoming a second theme. The agent's side stays flat on the
   background: one side marked is what makes the boundary visible, and marking both would just
   move the problem. */
.m.own{background:var(--own);border-left:2px solid var(--own-edge);border-radius:0 6px 6px 0;padding:9px 12px;color:#cdcdcd}
/* Inside the panel the neutral --line borders disappear into the tint, so the quote rail and
   any code block it carries are lifted a step. */
.m.own .q{border-left-color:#3d4a5a;color:#8b96a3}
.m.own .b pre,.m.own .b :not(pre)>code{background:#161b22;border-color:#2b3441}
/* A message that is on screen because it was typed here, not because the daemon sent it back.
   Dimmed while the request is in flight; edged red and given something to do about it once the
   request has failed, since the text in it is the only copy left. */
.m.pending{opacity:.6}
.m.failed{border-left-color:#a14a4a}
.m .warn{color:#e08a8a;font-size:12px;margin-top:7px}
.m .acts{margin-top:7px;display:flex;flex-wrap:wrap;gap:6px}
.m .acts button{font-size:12px;padding:4px 10px}
/* Cached from a daemon that is no longer running. Legible, just half a step back: it is real
   conversation, it is only no longer anything the process on the other end can be asked about. */
.m.hist{opacity:.9}
/* Says so, once, between the cached messages and the live ones. Sized like .empty rather than
   like a message, because it is about the room and not in it. */
.divider{margin:2px auto 20px;max-width:46ch;padding-top:10px;border-top:1px solid var(--line);text-align:center;font-size:11.5px;line-height:1.6;color:var(--dim)}
.b>:first-child{margin-top:0}
.b>:last-child{margin-bottom:0}
/* The operator's own message, which renderBody escapes and does not render (see room.ts).
   pre-wrap is what makes "not rendered" legible rather than a single run-on line: their
   newlines and indentation are the structure, since nothing turned them into tags. The break
   rules are for the other half of a pasted prompt — a URL or a path with no spaces in it,
   which would otherwise widen the bubble past the viewport. */
.b .raw{white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word}
.b p{margin:0 0 .6em}
.b pre{background:var(--field);border:1px solid var(--line);border-radius:4px;padding:10px;overflow-x:auto;margin:.6em 0}
.b code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.b pre code{font-size:12.5px}
.b :not(pre)>code{background:var(--field);padding:1px 4px;border-radius:3px}
.b h1,.b h2,.b h3,.b h4,.b h5,.b h6{font-size:1em;font-weight:600;margin:.9em 0 .4em}
.b blockquote{margin:.6em 0;padding-left:10px;border-left:2px solid var(--line);color:var(--dim)}
.b ul,.b ol{margin:.4em 0;padding-left:1.4em}
.b table{border-collapse:collapse;margin:.6em 0;font-size:13.5px;display:block;overflow-x:auto}
.b th,.b td{border:1px solid var(--line);padding:4px 8px;text-align:left}
.b hr{border:0;border-top:1px solid var(--line);margin:1em 0}
.b a{color:#8fa6c0}
.q{margin:0 0 6px;padding-left:10px;border-left:2px solid var(--line);color:var(--dim);font-size:13px;max-height:4.8em;overflow:hidden}
.t{color:var(--dim);font-size:11.5px;margin-top:4px}
/* A tool-progress bubble: one row per tool call, cut at the bubble's edge rather than at a
   character count, so a wide screen shows as much of each command as fits and a phone still
   reads one row per tool. Only the command (.tl-c) is cut: the ✓/✗ and duration after it (.tl-s)
   stay in view, since they are what says the tool is done. pre on the mark keeps its leading
   space, which a flex item would otherwise drop — and which a copied line needs. A click opens
   the row (toggleLine); open, it wraps anywhere, because to a browser a long command or path is
   one unbreakable word that would widen the bubble. */
.tl{display:flex;cursor:pointer}
.tl-c{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-s{flex:none;white-space:pre}
.tl.open{display:block;white-space:pre-wrap;overflow-wrap:anywhere}
.tl.open .tl-c{white-space:inherit}
/* "Show all" / "Collapse", sitting in the timestamp row: a control on every tool bubble, so it is
   dressed as dim text rather than as one of the message's buttons, which are things to answer. */
.t .tl-all{background:none;border:0;padding:0 2px;margin-left:10px;font-size:inherit;color:var(--dim);text-decoration:underline;cursor:pointer}
.t .tl-all:hover{color:var(--fg)}
/* A message's buttons, drawn as a menu — see menu() in the script for why a grid, and why sized
   from the widest label. The 50% term is the two-column floor, and it gives up a whole gap rather
   than half of one: two halves plus a gap is a pixel over the row, and the floor quietly becomes
   one column (it did, on the touch gap below). auto-fill rather than auto-fit, so a
   two-button question keeps two cells' width instead of being stretched across the bubble. 22px is
   a cell's padding and border, which --cw (the label alone) does not count. A label that does wrap
   is balanced, or a model id breaks at its last hyphen and leaves one character on a line. */
.btns{--gap:4px;margin-top:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(calc(var(--cw,8ch) + 22px),calc(50% - var(--gap))),1fr));gap:var(--gap);font-size:13px}
.btns button{min-width:0;padding:5px 10px;border-radius:5px;text-align:left;line-height:1.35;overflow-wrap:anywhere;text-wrap:balance;transition:background .12s,border-color .12s}
.btns button:not(.on):hover:not(:disabled){background:#202020}
/* The current choice, in the blue of the operator's own messages: it is the one they made. */
.btns button.on{background:var(--own);border-color:var(--own-edge)}
.btns .mk{color:var(--dim)}
.btns .on .mk{color:#38bdf8}
/* Pressed, then tapped and waiting on the daemon: full opacity over button:disabled's half, so the
   choice just made is the brightest thing in the menu rather than the faintest. */
.btns button:active:not(:disabled){background:#262626}
.btns button.busy{opacity:1;border-color:var(--own-edge);background:var(--own)}
/* Paging and the way back: under the items, spanning the grid, and quieter than they are. */
.btns .nav{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px}
.btns .nav button{background:none;color:var(--dim);padding:3px 10px}
.btns .nav button:hover:not(:disabled){color:var(--fg);background:var(--field)}
/* A finger, not a pointer: the cells keep roughly the height they had as loose buttons, and the
   gap between two choices is what a near miss lands in. */
@media(hover:none){.btns{--gap:6px}.btns button{padding:8px 10px}.btns .nav button{padding:7px 14px}}
/* The settings screen, drawn in the settings page (see settingsScreen()). A chat app can only offer
   buttons, so /setting arrives there as a grid of labels with the value squeezed into the same
   string. The page draws the same data the way a settings page is read: one column of sections,
   each a card of rows; a row is its name and one line on what it decides on the left, and the
   control on the right — a switch for on/off, a segmented control or a select for a short list,
   a value and a chevron for one with a screen of its own. The control kind comes from the daemon
   (SettingsScreenControl), so on/off, a short list and a model id no longer all look like the same
   blue text with a ›. One column at every width: the two-column grid this replaces read in a zig-
   zag, and nobody could tell which row came next (2026-11-05). Every control is at least 44px
   tall on a touch screen. */
.set-about{margin:0 0 14px;font-size:12.5px;line-height:1.5;color:var(--dim)}
.set-about code,.set-notice code,.set-gnote code,.set-desc code,.set-hintbox code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em;background:var(--field);padding:0 4px;border-radius:3px}
/* Sticky, because the control that caused it may be a screen further down: an answer at the top
   of a page scrolled past it was an answer nobody saw (Chromium, 2026-11-05). A good one fades
   after a few seconds — the control already shows the new state — and an error stays. */
.set-notice{position:sticky;top:-14px;z-index:1;margin:0 0 14px;padding:9px 12px;border-radius:6px;border:1px solid var(--line);border-left-width:3px;font-size:12.5px;line-height:1.5;white-space:pre-line;overflow-wrap:anywhere;box-shadow:0 4px 14px rgba(0,0,0,.45);transition:opacity .4s}
.set-notice.faded{opacity:0;pointer-events:none}
.set-notice.ok{border-color:rgba(74,222,128,.35);border-left-color:#4ade80;background:#15201a}
.set-notice.info{border-left-color:#7d7d7d;background:#1b1b1b}
.set-notice.error{border-color:rgba(248,113,113,.35);border-left-color:#f87171;background:#261616;color:#fecaca}
.set-sec{margin:0 0 18px}
.set-sec:last-child{margin-bottom:0}
.set-group{margin:0 2px 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9a9a9a}
.set-gnote{margin:-2px 2px 8px;font-size:12px;line-height:1.5;color:var(--dim)}
.set-card{border:1px solid var(--line);border-radius:8px;background:#181818;overflow:hidden}
.set-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 16px;min-height:48px;padding:9px 14px;border-bottom:1px solid var(--line)}
.set-item:last-child{border-bottom:0}
.set-item.sw{cursor:pointer}
.set-tx{min-width:0;display:flex;flex-direction:column;gap:2px}
.set-label{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:13.5px;line-height:1.35;color:var(--fg)}
.set-hint{font-size:12px;line-height:1.45;color:var(--dim)}
.set-kind{font-size:11.5px;color:var(--dim)}
.set-badge{display:inline-block;padding:0 7px;border-radius:999px;font-size:10.5px;font-weight:600;line-height:18px;letter-spacing:.02em}
.set-badge.restart{color:#fbbf24;background:rgba(251,191,36,.12)}
.set-badge.here{color:#7dd3fc;background:rgba(56,189,248,.12)}
.set-ctl{justify-self:end;display:flex;align-items:center;min-width:0}
/* The switch: a 36×20 track in a 44px-tall hit area. aria-checked is the state, so the page's
   optimistic flip and the daemon's answer are drawn by the same rule. */
.set-switch{position:relative;flex:none;width:44px;height:32px;padding:0;margin:-6px -4px;background:none;border:0;cursor:pointer}
.set-switch::before{content:"";position:absolute;left:4px;top:6px;width:36px;height:20px;border-radius:10px;background:#3a3a3a;transition:background .15s}
.set-switch::after{content:"";position:absolute;left:7px;top:9px;width:14px;height:14px;border-radius:50%;background:#bdbdbd;transition:transform .15s,background .15s}
.set-switch[aria-checked="true"]::before{background:#3a6ea5}
.set-switch[aria-checked="true"]::after{transform:translateX(16px);background:#fff}
.set-switch:focus-visible{outline:2px solid var(--own-edge);outline-offset:0;border-radius:12px}
.set-seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;background:var(--field);padding:2px;gap:2px}
.set-seg button{min-width:44px;min-height:30px;padding:3px 10px;border:0;border-radius:4px;background:none;color:var(--dim);font:inherit;font-size:12.5px;cursor:pointer;font-variant-numeric:tabular-nums}
.set-seg button:hover{color:var(--fg)}
.set-seg button[aria-checked="true"]{background:#2b3a4c;color:#fff;font-weight:600}
.set-select{max-width:260px;min-height:32px;padding:4px 28px 4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239a9a9a' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center;color:var(--fg);font:inherit;font-size:13px;text-overflow:ellipsis;-webkit-appearance:none;appearance:none;cursor:pointer}
.set-select:focus-visible,.set-seg button:focus-visible{outline:2px solid var(--own-edge);outline-offset:1px}
/* A row with a screen of its own (a model) or a way to another menu: the whole row is the target. */
.set-open{width:100%;border:0;border-radius:0;background:none;text-align:left;font:inherit;color:inherit;cursor:pointer;transition:background .12s}
.set-open:hover{background:#1f1f1f}
.set-open:focus-visible{outline:2px solid var(--own-edge);outline-offset:-2px}
.set-open{grid-template-columns:minmax(0,1fr) minmax(0,max-content) auto;gap:4px 12px}
.set-vv{display:flex;align-items:baseline;justify-content:flex-end;gap:6px;min-width:0;max-width:340px}
.set-vnote{flex:none;font-size:10.5px;color:var(--dim);border:1px solid #333;border-radius:999px;padding:0 6px;line-height:16px}
.set-v{min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:#c9d6e2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.set-v.unset{font-family:inherit;font-style:italic;color:var(--dim)}
.set-chev{flex:none;color:#666;font-size:17px;line-height:1}
/* The value level: which setting, what it holds, then its values. */
.set-back{display:inline-flex;align-items:center;gap:4px;margin:0 0 12px -6px;min-height:32px;padding:4px 8px;border:0;background:none;color:#8fb3d6;font:inherit;font-size:13px;cursor:pointer}
.set-back:hover{color:#b9d3ec}
.set-head{margin:0 0 14px}
.set-head h3{margin:0;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;font-size:15px;font-weight:600}
.set-head .set-tgt{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:500;color:#c9d6e2}
.set-now{margin:6px 0 0;font-size:12.5px;color:var(--dim)}
.set-now .set-v{display:inline;white-space:normal;overflow-wrap:anywhere}
.set-src{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:#a8a8a8}
.set-desc{margin:8px 0 0;font-size:12.5px;line-height:1.55;color:#a8a8a8}
.set-typed{display:flex;gap:6px;margin:0 0 10px}
.set-type{flex:1;min-width:0;min-height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--fg);font:inherit;font-size:13px}
.set-type:focus{outline:none;border-color:var(--own-edge)}
.set-use{flex:none;min-height:36px;padding:0 14px;border-radius:6px}
.set-nomatch{margin:8px 2px 0;font-size:12px;color:var(--dim)}
.set-hintbox.loading{display:flex;align-items:center;gap:8px;border-style:solid}
.set-spin{flex:none;width:12px;height:12px;border:2px solid #444;border-top-color:#8fb3d6;border-radius:50%;animation:set-spin .8s linear infinite}
@keyframes set-spin{to{transform:rotate(360deg)}}
.set-when{margin:4px 0 0;font-size:12px;color:var(--dim)}
.set-hintbox{margin:0 0 10px;padding:9px 12px;border:1px dashed #333;border-radius:6px;font-size:12.5px;line-height:1.5;color:#a8a8a8}
.set-opt{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:44px;padding:10px 14px;background:none;border:0;border-bottom:1px solid var(--line);border-radius:0;color:var(--fg);font:inherit;text-align:left;cursor:pointer;transition:background .12s}
.set-opt:last-child{border-bottom:0}
.set-opt[hidden]{display:none}
.set-opt:hover{background:#1f1f1f}
.set-opt.on{background:#1b2430}
.set-check{flex:none;width:16px;color:#38bdf8;font-size:14px;line-height:1.5;text-align:center}
.set-opt-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.set-opt-label{font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.set-opt-detail{font-size:12px;line-height:1.4;color:var(--dim)}
.set-opt.on .set-opt-label{color:#fff;font-weight:600}
.set-opt:focus-visible,.set-nav button:focus-visible{outline:2px solid var(--own-edge);outline-offset:-2px}
.set-nav{display:flex;align-items:center;gap:6px;margin-top:10px}
.set-nav button{min-height:44px;padding:6px 14px;background:var(--field);color:var(--dim);border:1px solid var(--line);border-radius:6px;font:inherit;font-size:12.5px;cursor:pointer}
.set-nav button:hover{color:var(--fg);border-color:#3a3a3a}
.set-page{flex:1;min-width:0;text-align:center;font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums}
/* Tapped and waiting on the daemon. A switch has already moved; the rest are lit, so the control
   just pressed is the brightest thing on the screen rather than the faintest. */
.set-open.busy,.set-opt.busy{opacity:1;background:var(--own);box-shadow:inset 2px 0 0 var(--own-edge)}
.set-seg button.busy{opacity:1;background:var(--own);color:#fff}
.set-switch.busy,.set-select.busy{opacity:.7}
button{background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px 11px;font:inherit;font-size:13px;cursor:pointer}
button:hover{border-color:#3a3a3a}
button:disabled{opacity:.5;cursor:default}
#typing{color:var(--dim);font-size:13px;padding:0 16px 6px;max-width:860px;width:100%;margin:0 auto}
#bar{position:relative;border-top:1px solid var(--line);padding:10px 16px 14px;max-width:860px;width:100%;margin:0 auto}
#hints{margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px}
#hints button{font-size:12px}
#hints .arg-hint{font-size:12px;color:var(--dim)}
#hints .arg-hint b{color:var(--fg);font-weight:600}
#chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{background:var(--field);border:1px solid var(--line);border-radius:3px;padding:1px 6px;font-size:12px;color:var(--dim)}
/* What is about to be sent, in the composer: a picture is shown, and anything can be taken back
   off. The thumbnail is a fixed square cropped to fit — a tall phone screenshot at its own aspect
   ratio would be a sliver too thin to recognise. */
#chips .chip{display:inline-flex;align-items:center;gap:6px;padding:2px 0 2px 6px}
#chips .thumb{display:block;width:56px;height:56px;object-fit:cover;margin-left:-4px;border-radius:2px;cursor:zoom-in}
.chip-x{background:none;border:0;padding:0 7px;font-size:15px;line-height:1;color:var(--dim)}
.chip-x:hover{color:var(--fg)}
.files{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}
/* A picture the agent sent, drawn in the bubble. Capped in both directions: a screenshot of a
   4K display would otherwise push the timestamp and everything after it off the fold, and the
   point of showing it here is to recognise it, not to read it — that is what tapping is for. */
.shot{display:block;margin-top:6px;max-width:100%;max-height:340px;border:1px solid var(--line);border-radius:4px;cursor:zoom-in}
/* The pictures in your own message: in a row and smaller than one the agent sent, because you saw
   them while pasting and they are here to say which pictures this message was about. A tap still
   opens one full-screen. flex-start, not the default stretch, or a short picture beside a tall one
   is stretched to its height and distorted; flex:none for the same reason across its width. A
   quote is text, so a reply quoting this message leaves the pictures out. */
.shots{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px}
.shots .shot{flex:none;max-height:160px}
.q .shots{display:none}
/* The tapped-open view. display:flex has to be restated under [hidden] or it beats the
   attribute's UA display:none and the overlay is never actually hidden. */
#lightbox{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out}
#lightbox[hidden]{display:none}
#lightbox img{max-width:100%;max-height:100%;object-fit:contain}
/* A file the agent sent, read where it was sent (openReader; the HTML is reading.ts's). A window
   over the transcript and not a new tab, for the lightbox's reason: installed as an app there is no
   tab bar to come back from. The backdrop is dimmed and the box opaque, because this is read, not
   glanced at; the box is capped in both directions so the conversation stays visible around it. */
#reader{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:24px}
#reader[hidden]{display:none}
#reader-box{display:flex;flex-direction:column;width:min(900px,100%);max-height:100%;overflow:hidden;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#reader-bar{display:flex;align-items:center;gap:12px;padding:6px 10px 6px 16px;border-bottom:1px solid var(--line);min-height:var(--headh);font-size:13px}
#reader-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
#reader-get{color:#8fa6c0}
#reader-close{font-size:18px;padding:6px 10px}
#reader-body{flex:1;min-height:0;overflow-y:auto;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));outline:none}
#reader-body>*{max-width:860px;margin-left:auto;margin-right:auto}
/* A text file wraps rather than scrolling sideways: a whole document wider than a phone is read a
   line at a time with a thumb, and a log's long lines are the usual reason it is wide. */
#reader .src{white-space:pre-wrap;overflow-wrap:anywhere}
.reader-note{color:var(--dim);font-size:12px;margin-bottom:12px}
/* The way to the bytes, beside the name that opens the reader. Smaller than a message's own
   buttons because it is about the file. An anchor rather than a button, so it still downloads
   with the script dead; dressed as a button to match the Preview it replaced. */
.files .view{display:inline-block;font-size:12px;padding:1px 8px;color:var(--fg);background:var(--field);border:1px solid var(--line);border-radius:4px;text-decoration:none}
.files .view:hover{border-color:#3a3a3a}
#row{display:flex;gap:8px;align-items:flex-end}
/* Red at rest, unlike #kill-agent: it only exists while a reply is streaming in, and in that
   moment it is the control being looked for. */
#stop-turn{color:#f87171;border-color:rgba(248,113,113,.4)}
#stop-turn:hover{border-color:#f87171}
/* Recording: red and counting, so it cannot be mistaken for idle while the microphone is open. */
#mic.rec{color:#f87171;border-color:#f87171;font-variant-numeric:tabular-nums}
#input{flex:1;resize:none;max-height:40vh;max-height:40dvh;padding:8px 10px;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;font:inherit;overflow-y:auto}
#input:focus,#login input:focus{outline:none;border-color:#3d3d3d}
#note{color:var(--dim);font-size:12px;padding:0 16px 8px;max-width:860px;width:100%;margin:0 auto}
/* The agent's live status, above the composer: what the footer says once per reply, kept current
   between replies. One line until tapped; the global [hidden] rule at the top is what lets this
   set display and still be hidden while there is nothing to show. */
#status{display:flex;align-items:center;margin:-3px 0 7px;font-size:11.5px;line-height:1.5;color:var(--dim);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums;cursor:pointer;user-select:none;-webkit-user-select:none}
#status.open{flex-wrap:wrap;white-space:normal;row-gap:1px;column-gap:14px}
.st{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px}
.st+.st::before{content:'\\00b7';margin:0 7px;color:#4a4a4a}
/* Open, the line wraps, and a separator belonging to the first segment of a wrapped line would
   lead it with a stray dot (seen in Chromium at 390px). Spacing does the separating instead. */
#status.open .st+.st::before{content:none}
.st-who{color:#a8a8a8}
/* The model in the status line is a switch: /model without typing it (openModelPop). Drawn as the
   text it was with a caret and a background on hover, so the line still reads as a status line;
   the caret is what says it opens. A pseudo-element, so the line's text is still the model's. */
.st-model{display:inline-flex;align-items:center;gap:3px;min-width:0;max-width:44ch;padding:0 4px;margin:0 -4px;border:0;border-radius:4px;background:none;color:#cfd8e2;font:inherit;cursor:pointer}
.st-model:hover,.st-model[aria-expanded="true"]{background:var(--field);color:#fff}
.st-model:focus-visible{outline:2px solid var(--own-edge);outline-offset:0}
.st-model .st-mtext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-model::after{content:'\\25be';flex:none;font-size:9px;opacity:.8}
/* The list it opens: above the composer, inside #bar so it moves with it, and closed by Escape, a
   click outside, a pick, or a topic switch. A filter field first — opencode offers ~90 models. */
#model-pop{position:absolute;left:16px;bottom:calc(100% - 6px);z-index:15;display:flex;flex-direction:column;width:min(440px,calc(100% - 32px));max-height:min(60vh,480px);background:#181818;border:1px solid #333;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);overflow:hidden}
.mp-head{display:flex;align-items:center;gap:8px;padding:8px 6px 6px 12px;border-bottom:1px solid var(--line)}
.mp-title{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3}
.mp-title b{font-size:13px;font-weight:600}
#mp-agent{font-size:11.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mp-close{font-size:17px;padding:4px 10px}
#mp-filter{margin:8px 10px 4px;min-height:32px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--fg);font:inherit;font-size:13px}
#mp-filter:focus{outline:none;border-color:var(--own-edge)}
#mp-list{flex:1;min-height:0;overflow-y:auto;padding:4px 0}
.mp-opt{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 12px;border:0;border-radius:0;background:none;color:var(--fg);font:inherit;text-align:left;cursor:pointer}
.mp-opt:hover,.mp-opt:focus-visible{background:#222;outline:none}
.mp-opt[hidden]{display:none}
.mp-opt.on{background:#1b2430}
.mp-check{flex:none;width:14px;color:#38bdf8;text-align:center}
.mp-main{flex:1;min-width:0;display:flex;flex-direction:column}
.mp-v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.mp-n{font-size:11.5px;color:var(--dim)}
.mp-tag{flex:none;font-size:10.5px;color:var(--dim);border:1px solid #333;border-radius:999px;padding:0 6px;line-height:16px}
.mp-opt.busy{background:var(--own);box-shadow:inset 2px 0 0 var(--own-edge)}
.mp-msg{padding:12px;font-size:12.5px;line-height:1.5;color:#a8a8a8;white-space:pre-line}
.mp-msg.err{color:#fecaca}
.mp-msg code,.mp-foot code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em;background:var(--field);padding:0 4px;border-radius:3px}
.mp-wait{display:flex;align-items:center;gap:8px}
.mp-foot{margin:0;padding:7px 12px 9px;border-top:1px solid var(--line);font-size:11.5px;color:var(--dim)}
.st-meter{display:inline-block;width:32px;height:4px;border-radius:2px;background:var(--line);overflow:hidden}
.st-meter i{display:block;height:100%;background:var(--dim)}
.st.warn{color:#fbbf24}
.st.warn .st-meter i{background:#fbbf24}
.st.bad{color:#f87171}
.st.bad .st-meter i{background:#f87171}
/* A pool the serving model is not spending from: shown only when the strip is open, and quieter. */
.st.off{opacity:.55}
/* Phones and tablets held upright. Everything here is about the parts of a handset a desktop
   layout has no concept of: a URL bar that eats viewport height, a home indicator under the
   composer, Safari's zoom-on-focus, and a finger instead of a pointer. */
/* A 240px sidebar and a 240–320px panel leave too little chat on a laptop screen, so below
   1024px the right panel slides over the chat instead of taking a column — the same drawer the
   topic sidebar becomes at 640px, on the other edge. It stays laid out and is moved off-screen
   with a transform, because display:none has nothing to animate; the margin it used as a column
   is given up so the fixed position can take over. The backdrop is what dismisses it, as the
   sidebar drawer's is. */
@media(max-width:1023px){
  #schedules{position:fixed;top:0;right:0;bottom:0;z-index:20;width:min(88vw,380px);flex-basis:auto;box-shadow:-3px 0 12px rgba(0,0,0,.6)}
  #schedules.collapsed{margin:0;transform:translateX(100%)}
  #app.sched-open #backdrop{display:block}
  /* Nothing to dock it to here, so the resize handle is not offered: an overlay's width is the
     screen's, not the operator's. */
  #schedules>.panel-resize{display:none}
  /* Whichever panel is a drawer here runs to the bottom edge, so its last row needs the same
     home-indicator clearance the composer gets. */
  .panel-foot{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}
}
@media(max-width:640px){
  /* height:100% resolves against a viewport that still counts the collapsing browser chrome,
     so the composer sits below the fold until the page is scrolled. dvh is the height actually
     on screen; the plain vh declaration above it stays as the fallback for older engines. */
  html,body{height:100vh;height:100dvh}
  /* A column 240px wide leaves nothing of the chat on a 360px screen, so it becomes a drawer
     over it, dismissed by tapping the backdrop. Fixed rather than absolute so it tracks the
     visible viewport as the URL bar collapses instead of the taller page box behind it. The
     closed position is a transform rather than a negative margin, so it moves the full width
     of whatever the screen allowed — the same drawer the task panel is from 1023px down, at
     the same 88vw/380px, so the two edges feel like one component. */
  #sidebar{position:fixed;top:0;bottom:0;left:0;height:auto;z-index:20;width:min(88vw,380px);flex-basis:min(88vw,380px);box-shadow:3px 0 12px rgba(0,0,0,.6)}
  #sidebar.collapsed{margin:0;transform:translateX(-100%)}
  #app.sb-open #backdrop{display:block}
  #sidebar>.panel-resize{display:none}
  #topics .topic-item{padding:10px 9px}
  /* The header and the footer row are finger targets here: 12px text in 7px of padding is a
     30px target, and the × is the only way out of a panel that covers the chat. 49px rather
     than 42 so a 44px box fits without the bar growing twice. */
  .panel-head{min-height:49px;padding:0 4px 0 12px}
  .panel-head .btn-icon{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;font-size:20px}
  .panel-foot>button,.panel-menu button{min-height:44px}
  /* The drawer toggle is the only way back to the topic list on a phone, but it inherits
     .btn-icon's 13px glyph and 4px padding — a 26x21 target, well under the 44px every mobile
     HIG asks for. Pad it out to 44px square and grow the glyph to match; the header's own
     vertical padding gives way to it, so the title bar goes 42px -> 49px rather than 42 -> 56.
     The negative margin puts the glyph's ink back where .btn-icon had it, now that it sits in
     a box twice the width. Setting display here is only safe because of the global
     [hidden]{display:none!important} above — without it this rule would win over the UA's
     own [hidden] rule and strand the button on screen while the drawer is open. */
  #chat-header{padding:2px 12px}
  #expand-sidebar{display:inline-flex;align-items:center;justify-content:center;
    min-width:44px;height:44px;margin-left:-10px;font-size:20px;color:var(--fg)}
  /* The same 44px, for the same finger. The glyph grows with the box, or a 14px icon floats in
     a target three times its size and reads as a stray mark rather than a control. */
  #kill-agent{min-width:44px;height:44px}
  #kill-agent svg{width:18px;height:18px}
  #clear-topics svg{width:18px;height:18px}
  /* The panel keeps the drawer's width here rather than taking the whole screen: it is the same
     overlay the 1023px rule makes, sliding in from the right, and a strip of the conversation
     stays visible behind it. Only the header and the targets grow for a finger. */
  #schedules-toggle{min-width:44px;height:44px}
  #schedules-toggle svg{width:18px;height:18px}
  .sched-acts button{min-height:44px;padding:0 14px}
  .rev-open{min-height:44px;padding:0 14px}
  /* The skills window is the whole screen on a phone: 980px of desktop window shrunk into a
     phone is an editor with a sliver of transcript behind it, and the transcript is not what the
     operator opened. */
  #skills{padding:0}
  #skills-box{width:100%;height:100%;max-height:none;border:0;border-radius:0}
  #skills-bar{padding:0 4px 0 12px;min-height:49px}
  #skills-close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;font-size:20px}
  #skills-new{min-height:44px;padding:0 14px}
  .skill-acts button,.skill-file{min-height:44px;padding:0 12px}
  .skill-text{min-height:40dvh;font-size:14px}
  /* The settings page, for the same reason and the same way: a 760px window shrunk into a phone
     is a column of rows behind a sliver of transcript nobody opened it to read. */
  #settings-page{padding:0}
  #settings-box{width:100%;height:100%;max-height:none;border:0;border-radius:0}
  #settings-bar{padding:0 4px 0 12px;min-height:49px}
  #settings-close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;font-size:20px}
  #settings-body{padding:12px 12px calc(16px + env(safe-area-inset-bottom,0px))}
  /* A row's control goes under its text, full width, where it has room — except a switch, which is
     narrow and is where a thumb expects it. A model's value goes under its agent for the same
     reason: a 50-character model id beside an agent id is two truncated halves at 390px. */
  .set-item{grid-template-columns:minmax(0,1fr);gap:8px;padding:12px}
  .set-item.sw{grid-template-columns:minmax(0,1fr) auto}
  .set-item>.set-ctl{justify-self:stretch}
  .set-item.sw>.set-ctl{justify-self:end}
  .set-seg{display:flex;width:100%}
  .set-seg button{flex:1;min-height:40px;padding:0 4px}
  .set-select{max-width:none;width:100%;min-height:44px;font-size:16px}
  .set-open{grid-template-columns:minmax(0,1fr) auto;gap:3px 12px}
  .set-open>.set-tx{grid-column:1;grid-row:1}
  .set-open>.set-vv{grid-column:1;grid-row:2;max-width:none;justify-content:flex-start}
  .set-open>.set-chev{grid-column:2;grid-row:1/span 2}
  .set-type{min-height:44px;font-size:16px}
  .set-use{min-height:44px}
  .set-switch{width:52px;height:44px;margin:-12px -6px}
  .set-switch::before{left:8px;top:12px}
  .set-switch::after{left:11px;top:15px}
  .set-back{min-height:44px}
  /* A hover-revealed × does not exist on a finger, and the row is the only way to delete a
     scheduled run now that the switcher no longer lists it. */
  .sess-del{opacity:1;min-width:44px;height:44px}
  .chat-title{max-width:none}
  #log{padding:14px 12px 6px}
  #typing,#note{padding-left:12px;padding-right:12px}
  /* env() keeps the Send row clear of the home indicator rather than under it. */
  #bar{padding:8px 12px calc(10px + env(safe-area-inset-bottom,0px))}
  /* Safari zooms the whole page in when a field it focuses is under 16px, and it does not zoom
     back out afterwards — every tap on the composer would leave the page a little larger. */
  #input,#secret{font-size:16px}
  #input{max-height:30dvh}
  /* The window's two controls, for a finger. Same 44px the drawer toggle gets, and for the
     same reason — but here it also matters WHICH of the two a near miss lands on: one hides the
     terminal and the other kills what is running in it. The gap is the separation. Setting
     display is safe against the close button's own hidden attribute for the reason given
     there: the global [hidden] rule at the top is !important. */
  #term-bar{padding:2px 4px 2px 12px;gap:8px}
  #term-min,#term-end{display:inline-flex;align-items:center;justify-content:center;
    min-width:44px;height:44px;font-size:18px}
  /* The reader's way out, for the same finger: it measured 35x30 at 390px in Chromium before this.
     The bar gives up its vertical padding to it, as the chat header does to the drawer toggle.
     Download grows too — at 12px with 1px of padding it was a 22px-tall target beside the file's
     name. The window keeps a margin all round rather than going edge to edge, so it still reads
     as something laid over the conversation. */
  #reader{padding:8px}
  #reader-bar{padding:0 4px 0 12px}
  #reader-close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;font-size:20px}
  .files .view{padding:6px 12px}
  /* The idle-agents dialog's two answers, one of which ends processes: 34px tall at 390px before. */
  .idle-acts button{min-height:44px;padding:0 16px}
  /* Closer to the top on a phone, where the keyboard will take the bottom half; two columns, which
     at 390px leaves each card 170px — room for "DeepSeek Harness" without an ellipsis. */
  .launch{margin-top:3vh}
  .launch-head{margin-bottom:20px}
  .launch-grid{grid-template-columns:repeat(auto-fill,minmax(136px,1fr))}
  /* The status strip's token counts, on a screen with no room for them: the percentage beside the
     meter says the same thing in four characters, and a tap brings the counts back. Without this
     the line clipped before the cache and quota — the parts that change. */
  #status:not(.open) .st-x{display:none}
  /* The model switch is a finger target here: 44px tall, which makes the status line that tall —
     the price of a control that can be hit first time. The list is the composer's width. */
  .st-model{min-height:44px;padding:0 8px;margin:-8px -8px -8px -4px}
  #model-pop{left:8px;right:8px;width:auto;max-height:min(62dvh,520px)}
  #mp-filter{min-height:44px;font-size:16px}
  #mp-close{min-width:44px;min-height:44px}
  .mp-opt{min-height:48px}
  /* The same 44px for taking an attachment back off. A miss lands on the thumbnail, which only
     opens it — but a 15px glyph with no padding is a target a finger finds on the third try. */
  .chip-x{min-width:44px;min-height:44px}
}
`;

const SCRIPT = `
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var log=$('log'), app=$('app'), gate=$('login'), err=$('err'), input=$('input'),
      chips=$('chips'), hints=$('hints'), typing=$('typing'), note=$('note'), picker=$('picker'),
      bar=$('topics'), sidebar=$('sidebar'), collapseBtn=$('collapse-sidebar'),
      expandBtn=$('expand-sidebar'), newTopicBtn=$('new-topic'), backdrop=$('backdrop'),
      clearBtn=$('clear-topics'), idleBtn=$('close-idle'), noIdleBtn=$('no-idle'), idleCount=$('idle-count'),
      notifyBtn=$('notify-toggle'), notifyState=$('notify-state'), idleDialog=$('idle-dialog'), idleTitle=$('idle-title'),
      optsBtn=$('opts-toggle'), optsMenu=$('opts-menu'), manageBtn=$('manage-toggle'), manageMenu=$('manage-menu'),
      calmBtn=$('calm-toggle'), calmState=$('calm-state'),
      idleWhy=$('idle-why'), idleList=$('idle-list'), idleGo=$('idle-go'), idleCancel=$('idle-cancel'), chatTitle=$('topic-title'), chatStatus=$('topic-status'),
      chat=$('chat'), termBtn=$('term-toggle'), termHost=$('term-frames'),
      termName=$('term-name'), termMinBtn=$('term-min'), termEndBtn=$('term-end'),
      schedToggle=$('schedules-toggle'), schedAlert=$('sched-alert'), schedList=$('schedules-list'), schedSummary=$('schedules-summary'),
      schedClose=$('schedules-close'), schedNote=$('schedules-note'),
      schedPanel=$('schedules'), schedSessionList=$('sched-sessions'), schedResize=$('sched-resize'),
      schedTabTasks=$('sched-tab-tasks'), schedTabSessions=$('sched-tab-sessions'), schedTabReviews=$('sched-tab-reviews'),
      schedTabTasksN=$('sched-tab-tasks-n'), schedTabSessionsN=$('sched-tab-sessions-n'), schedTabReviewsN=$('sched-tab-reviews-n'),
      revPane=$('sched-reviews'), revList=$('sched-reviews-list'),
      lightbox=$('lightbox'), lightboxImg=$('lightbox-img'),
      reader=$('reader'), readerName=$('reader-name'), readerGet=$('reader-get'), readerBody=$('reader-body'),
      skillsWin=$('skills'), skillsToggle=$('skills-toggle'), skillsBack=$('skills-back'),
      skillsTitle=$('skills-title'), skillsCount=$('skills-count'), skillsNewBtn=$('skills-new'),
      skillsClose=$('skills-close'), skillsBody=$('skills-body'), skillsNote=$('skills-note'),
      skillsListEl=$('skills-list'), skillsDetailEl=$('skills-detail'),
      settingsPage=$('settings-page'), settingsBody=$('settings-body'), settingsTopicEl=$('settings-topic'),
      settingsClose=$('settings-close'), settingsOpenBtn=$('settings-open'),
      killBtn=$('kill-agent'), stopBtn=$('stop-turn'), statusEl=$('status'),
      modelPop=$('model-pop'), mpList=$('mp-list'), mpFilter=$('mp-filter'), mpAgent=$('mp-agent');
  var data={}, els={}, files=[], commands=[], stream=null, done=false;
  // Last markup written per message, so a sync that re-sends an unchanged message touches no DOM.
  var sig={};
  // The tool-bubble lines a reader has opened, per message key. See lineOpen.
  var opened={};
  // Whether #log currently holds placeholders rather than messages, and whether the next sync is
  // the one that opens a topic (which lands at the bottom no matter where the old one was read).
  var skeleton=false, entering=true;
  // What the last sync said about this topic being older than the daemon, and the notice element
  // that says so. Both are per topic, so both are reset on the way into one.
  var stale=false, emptyEl=null;
  // The agents the last sync said this topic could still be given to (null once it cannot, or
  // when the daemon offered none), the element laying them out, and what it was drawn from.
  var launch=null, launchEl=null, launchSig='';
  // Which run of the daemon the live stream belongs to, and whether this topic's first sync has
  // landed. 0 until one has: every message below is qualified by the generation it came from,
  // and before the first sync the only generations known are the ones out of the cache.
  var epoch=0, synced=false;
  var topic = new URLSearchParams(location.search).get('t') || '';
  // Whether this daemon serves a terminal at all, and whether it was given a way to END one (a
  // configured terminal.endCommand). Without that, the window has no close button rather than a
  // close button that cannot work.
  var TERM_OK = __TERM__;
  var TERM_END = __TERM_END__;
  // Whether the shared secret is still a way in. False means the gate above has no field and
  // the only thing that can sign anyone in is the proxy in front (sso.password: false).
  var PASSWORD_LOGIN = __PASSWORD__;
  // A terminal window belongs to a TOPIC, not to the page: 'open' is shown, 'min' is hidden and
  // still connected, absent is no window at all. Keyed this way because the alternative — one
  // window that follows whichever topic is on screen — would tear down the connection to the
  // topic being left, which is both a surprise (the pane you minimized is gone) and the end of
  // the switcher's marker ever meaning anything: at most one topic could ever be lit.
  var termState = {};
  var termFrames = {};
  // A reload asked for the pane, before any topic is known. "Asked for" is separate from
  // "shown": there is nothing to point a terminal at until the first sync names a topic, so
  // this is spent there rather than here.
  var termBoot = TERM_OK && new URLSearchParams(location.search).get('v')==='term';
  var topics = [];
  var readCounts = {};
  try { readCounts = JSON.parse(localStorage.getItem('aa_reads') || '{}'); } catch(x){}
  // The side panel: whether it is showing, the last task list drawn, and its refresh timer.
  // See "The side panel" below.
  var schedEnabled=true, schedTasks=null, schedBusy=false, schedSeq=0, schedTimer=0;
  // Which of the panel's three lists is on screen. Persisted, because it is a preference about the
  // workspace rather than about one visit.
  var schedTab='tasks';
  // The Reviews tab's last answer, and the rows the reader has opened. null is "not asked yet",
  // which is different from an empty list and is what the tab shows as Loading….
  var reviewData=null, reviewSeq=0, revOpen={};
  // The skills window: its list, the skill open in it, and whether the New form is showing. Not
  // persisted — a management surface is opened on purpose, and a window that came back on load
  // would sit over a conversation nobody asked it to cover.
  var skillsEnabled=true, skillList=[], skillSel=null, skillsBusy=false, skillNewMode=false;
  // The /setting page: the live settings message it draws, the topic it was opened in, and the
  // one message whose page the operator closed. A settings message is never a row in the
  // transcript, and the daemon marks a retired one (wasSettings) so it cannot become one later.
  // settingsClosed is per message id, so an edit to the page that was put away does not reopen
  // it — a new /setting is a new message, and that does open.
  //
  // A request made from the menu has no message id yet, so closing it while it is still Loading
  // cannot be remembered that way. It gets a token (settingsReq); the answers are matched to the
  // tokens by order, since the daemon answers one /setting with one screen, and closing cancels
  // every token issued so far (settingsClosedUpTo). An answer to a cancelled request is dropped;
  // a later request has a later token and still opens. A token is also tagged with the topic it
  // was asked in: an answer arriving after a topic switch belongs to that topic's queue, not the
  // one on screen.
  // settingsNote: the page's own line when a control's request failed (cleared by the next screen);
  // settingsLevel: which level is drawn, so a move between them starts at the top.
  var settingsMsg=null, settingsTopic=null, settingsClosed={}, settingsNote=null, settingsLevel='', settingsFade=0, settingsQuery='';
  var SETTINGS_FADE_MS=5000;
  var settingsReq=0, settingsPending=[], settingsClosedUpTo=0, settingsTimer=0;
  // How long the page waits for the screen before saying the daemon did not answer. The send
  // itself gives up after fifteen seconds on one attempt, so this is the same patience.
  var SETTINGS_WAIT_MS=15000;

  function saveReads(){
    try { localStorage.setItem('aa_reads', JSON.stringify(readCounts)); } catch(x){}
  }

  /**
   * Parents whose sub-agent topics are folded away (paintTopics), per browser. Folded by default:
   * a /super job's children are the working detail behind one conversation, and a dispatcher that
   * opens five of them would otherwise push five rows into a column read as a list of conversations.
   * An entry of false is an operator who opened one, and it stays open on this browser.
   */
  var folded = {};
  try { folded = JSON.parse(localStorage.getItem('aa_folded') || '{}') || {}; } catch(x){}
  function saveFolded(){
    try { localStorage.setItem('aa_folded', JSON.stringify(folded)); } catch(x){}
  }

  /**
   * How a message is identified ON THIS PAGE, which is deliberately not its server id.
   *
   * Server ids are 'w1', 'w2'..., counted per PROCESS — so a restarted daemon hands the same
   * ones out again, and this page keeps transcripts across restarts. Keyed by id alone, the
   * first reply after a restart silently overwrites a cached message from before it. The
   * generation — a sync's epoch field — is what tells the two apart. A message typed here and
   * not yet acknowledged has no server id at all and travels under its nonce instead, behind a
   * prefix no server id can collide with.
   */
  function keyOf(m){ return m._local ? m.id : m._g + ':' + m.id; }

  /** A cached message from a daemon that is no longer the one on the other end of the stream. */
  function isHistory(m){ return Boolean(m) && !m._local && epoch !== 0 && m._g !== epoch; }

  // ── The local transcript cache ─────────────────────────────────────────────
  // What lets a topic paint before the stream has answered, and what makes a daemon restart cost
  // the conversation its liveness rather than its contents. IndexedDB rather than localStorage:
  // one transcript with code blocks in it runs to hundreds of kilobytes, and localStorage's ~5MB
  // is shared with everything else this origin keeps.
  //
  // One record per topic, holding the message list as a STRING rather than an object graph. The
  // byte budget below is then something that can actually be measured, and nothing rests on how
  // a structured clone treats these objects.
  var DB_NAME='aa_cache', DB_VER=1, STORE='topics';
  // Rotation, because a cache that only grows is just a slower version of the bug being fixed:
  // the TAIL of a topic is kept, and the least recently written topics go first.
  var MAX_CACHE_TOPICS=24, MAX_CACHE_MSGS=200, MAX_CACHE_BYTES=512*1024;
  // How long writes are held together. A streamed reply upserts the same message every second or
  // so, and each one would otherwise re-serialise the whole topic.
  var SAVE_MS=400;
  var db=null, dbOff=false, saveTimer=null;

  function cacheOff(why){
    if(dbOff) return;
    dbOff=true; db=null;
    // Once, and only once. The page works without the cache, and a line per attempted write
    // would be the loudest thing in the console for a feature nobody can see failing.
    try { console.warn('[webui] local transcript cache disabled:', (why && why.message) || why || 'unavailable'); } catch(x){}
  }

  function idb(){
    if(db) return Promise.resolve(db);
    if(dbOff || !window.indexedDB) return Promise.resolve(null);
    return new Promise(function(res){
      var rq;
      try { rq = window.indexedDB.open(DB_NAME, DB_VER); } catch(x){ cacheOff(x); return res(null); }
      rq.onupgradeneeded = function(){
        var d = rq.result;
        if(d.objectStoreNames.contains(STORE)) return;
        // The at field is indexed so eviction can walk oldest-first over KEYS alone — a cursor
        // over the records would read every cached transcript into memory to delete one of them.
        d.createObjectStore(STORE, {keyPath:'topic'}).createIndex('at','at');
      };
      rq.onsuccess = function(){ db = rq.result; res(db); };
      rq.onerror = function(){ cacheOff(rq.error); res(null); };
      rq.onblocked = function(){ cacheOff('another tab holds an older version'); res(null); };
    });
  }

  /** One transaction. Resolves {ok:true, value} with whatever body asked for, or {ok:false}. */
  function cacheTx(mode, body){
    return idb().then(function(d){
      if(!d) return {ok:false};
      return new Promise(function(res){
        var t, out=null;
        try { t = d.transaction(STORE, mode); } catch(x){ cacheOff(x); return res({ok:false}); }
        var rq = body(t.objectStore(STORE));
        if(rq) rq.onsuccess = function(){ out = rq.result; };
        t.oncomplete = function(){ res({ok:true, value:out}); };
        t.onabort = function(){ res({ok:false, error:t.error}); };
        t.onerror = function(){ res({ok:false, error:t.error}); };
      });
    });
  }

  /** The slice of a topic worth keeping: its tail, trimmed to the byte budget. */
  function cacheBody(msgs){
    var out = msgs.length > MAX_CACHE_MSGS ? msgs.slice(-MAX_CACHE_MSGS) : msgs;
    var json = JSON.stringify(out);
    // A quarter at a time rather than one message at a time: a topic of long answers would
    // otherwise re-serialise itself dozens of times on the way under the budget.
    while(json.length > MAX_CACHE_BYTES && out.length > 1){
      out = out.slice(Math.max(1, Math.round(out.length/4)));
      json = JSON.stringify(out);
    }
    return json;
  }

  function cacheWrite(tId, msgs, retried){
    var rec = { topic: tId, at: Date.now(), json: cacheBody(msgs) };
    return cacheTx('readwrite', function(store){ store.put(rec); evict(store, tId, false); return null; })
      .then(function(r){
        if(r.ok || dbOff) return;
        if(retried) return cacheOff(r.error || 'the write was refused twice');
        // Out of room, most likely. Everything except the topic being read goes, and the write
        // is tried once more before the cache is written off for this session.
        return cacheTx('readwrite', function(store){ evict(store, tId, true); return null; })
          .then(function(){ return cacheWrite(tId, msgs, true); });
      });
  }

  /** Drop the least recently written topics. all throws away everything except keep. */
  function evict(store, keep, all){
    var count = store.count();
    count.onsuccess = function(){
      var over = all ? count.result : count.result - MAX_CACHE_TOPICS;
      if(over <= 0) return;
      var cur = store.index('at').openKeyCursor();
      cur.onsuccess = function(){
        var at = cur.result;
        if(!at || over <= 0) return;
        if(at.primaryKey !== keep){ store.delete(at.primaryKey); over--; }
        at.continue();
      };
    };
  }

  function cacheRead(tId){
    return cacheTx('readonly', function(store){ return store.get(tId); }).then(function(r){
      if(!r.ok || !r.value || !r.value.json) return null;
      try { var list = JSON.parse(r.value.json); return (list && list.length) ? list : null; } catch(x){ return null; }
    });
  }

  function cacheDrop(tId){ cacheTx('readwrite', function(store){ store.delete(tId); return null; }); }
  /** Drop every cached topic not in keep — over KEYS, for the same reason evict walks keys. */
  function cacheKeep(keep){
    cacheTx('readwrite', function(store){
      var cur = store.index('at').openKeyCursor();
      cur.onsuccess = function(){
        var at = cur.result;
        if(!at) return;
        if(!keep[at.primaryKey]) store.delete(at.primaryKey);
        at.continue();
      };
      return null;
    });
  }

  /**
   * What is on screen, in the order it is on screen, as the cache should hold it.
   *
   * Read off #log rather than from a list of our own, because here the DOM IS the order — and
   * what it holds is already the union of cached history and what the daemon has since sent,
   * which is exactly what the next reload should get back.
   *
   * A local message is never included. Everything this page has sent and not had acknowledged is
   * written to localStorage the moment it is sent (see unsent), which a write coalesced into a
   * 400ms window of an asynchronous database could not promise: a reload in that window used to
   * lose a send still in flight outright.
   */
  function cacheable(){
    var out=[];
    for(var n=log.firstChild; n; n=n.nextSibling){
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      var m = k ? data[k] : null;
      if(!m || m._local) continue;
      out.push(m);
    }
    return out;
  }

  /** Remember the current topic, at most once every SAVE_MS. */
  function cacheSave(){
    if(!topic || dbOff || saveTimer) return;
    saveTimer = setTimeout(function(){
      saveTimer = null;
      if(topic) cacheWrite(topic, cacheable(), false);
    }, SAVE_MS);
  }

  /** Write now rather than at the end of the window — for the way out of a topic. */
  function cacheFlush(){
    if(!saveTimer) return;
    clearTimeout(saveTimer); saveTimer = null;
    if(topic) cacheWrite(topic, cacheable(), false);
  }

  // The one place the narrow-screen breakpoint lives on this side of the wire. It has to stay
  // the same number as the @media rule above: the CSS turns the sidebar into an overlay, and
  // this decides whether opening a topic should then get it back out of the way.
  var NARROW = 640;
  function narrow(){ return window.innerWidth <= NARROW; }

  /**
   * One side panel, used on both edges of the page: the topic list on the left and the
   * scheduled work on the right. Everything about the way a panel behaves is here once — the
   * width and its drag handle, the open/close animation, the drawer it becomes under its
   * breakpoint, the inert state that keeps Tab out of a panel nobody can see, and the storage
   * that remembers both choices. What the two sides do not share is passed in: which edge it
   * is on, how wide it starts and may get, and how narrow the screen has to be before a column
   * has no room and it slides over the chat instead.
   *
   * Closed, a panel keeps its width and is moved off-screen with a negative margin (a column)
   * or a transform (a drawer) — never display:none, because a hidden element has nothing to
   * animate. --pw is the dragged width, inline and kept per browser; the stylesheet's
   * --pw-default is the fallback, and the two must agree with width() below.
   */
  function makePanel(cfg){
    var el=cfg.el, handle=cfg.handle, open=false, drag=null;
    function docked(){ return window.innerWidth >= cfg.dockAt; }
    function width(){
      var w=parseFloat(el.style.getPropertyValue('--pw'));
      if(w > 0) return w;
      return typeof cfg.width === 'function' ? cfg.width() : cfg.width;
    }
    function maxWidth(){
      return Math.max(cfg.min, Math.min(cfg.max, cfg.maxWidth ? cfg.maxWidth() : cfg.max));
    }
    function setWidth(w, keep){
      if(w == null){
        el.style.removeProperty('--pw');
        try { localStorage.removeItem(cfg.widthKey); } catch(x){}
        return;
      }
      w = Math.round(Math.max(cfg.min, Math.min(maxWidth(), w)));
      el.style.setProperty('--pw', w+'px');
      if(keep) try { localStorage.setItem(cfg.widthKey, String(w)); } catch(x){}
    }
    function paint(){
      el.classList.toggle('collapsed', !open);
      // A panel moved off-screen is still in the tab order: without this, Tab walks into a
      // column nobody can see. Removed as soon as it is open, and harmless on a docked column.
      if(open) el.removeAttribute('inert'); else el.setAttribute('inert', '');
      if(cfg.onPaint) cfg.onPaint(open);
    }
    function setOpen(next, opts){
      opts = opts || {};
      if(next === open){ if(opts.force) paint(); return; }
      open = next;
      // A close nobody asked for — following a session on an overlay, where the panel would
      // cover the chat it just opened — is not a preference, so it leaves storage alone.
      if(!opts.transient && cfg.storeKey){
        try { if(open) localStorage.setItem(cfg.storeKey,'1'); else localStorage.removeItem(cfg.storeKey); } catch(x){}
      }
      paint();
      if(cfg.onChange) cfg.onChange(open);
    }
    // The drag listens on the document rather than the 8px handle, because the pointer leaves
    // the handle on the first fast move. The edge it measures from is the one the panel is
    // anchored to: the left panel grows to the right, the right panel to the left.
    handle.addEventListener('pointerdown', function(e){
      if(!docked()) return;
      e.preventDefault();
      drag = {edge: cfg.side === 'left' ? el.getBoundingClientRect().left : el.getBoundingClientRect().right};
      handle.className = 'panel-resize dragging';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('pointermove', function(e){
      if(drag) setWidth(cfg.side === 'left' ? e.clientX - drag.edge : drag.edge - e.clientX, false);
    });
    document.addEventListener('pointerup', function(){
      if(!drag) return;
      drag = null;
      handle.className = 'panel-resize';
      document.body.style.userSelect = '';
      var w = parseFloat(el.style.getPropertyValue('--pw'));
      if(w > 0) setWidth(w, true);
    });
    handle.addEventListener('dblclick', function(){ setWidth(null); });
    // The saved width is applied before the first paint, so a reload does not flash the default
    // column and then jump to the operator's.
    var saved = 0;
    try { saved = Number(localStorage.getItem(cfg.widthKey)); } catch(x){}
    if(saved > 0) setWidth(saved, false);
    paint();
    return {el:el, isOpen:function(){ return open; }, setOpen:setOpen, toggle:function(){ setOpen(!open); },
            width:width, setWidth:setWidth, docked:docked};
  }

  // The two panels. The left starts open on a wide screen and closed on a phone; the right is
  // closed until asked for, and only restored where it can be docked (below 1024px it would come
  // back as a drawer over the chat nobody asked it to cover).
  var sbPane = makePanel({
    el: sidebar, handle: $('sidebar-resize'), side:'left',
    min:180, max:640, width:240, storeKey:'aa_sb_open', widthKey:'aa_sb_w',
    dockAt: NARROW + 1,
    // The cap leaves the chat 360px with the right panel docked: that panel's width comes off
    // the top, and the sidebar may take the rest up to 640.
    maxWidth: function(){
      return window.innerWidth - 360 - (schedPane && schedPane.isOpen() && schedPane.docked() ? schedPane.width() : 0);
    },
    onPaint: function(open){
      app.classList.toggle('sb-open', open);
      expandBtn.hidden = open;
    }
  });
  var schedPane = makePanel({
    el: schedPanel, handle: schedResize, side:'right',
    min:220, max:640,
    // The stylesheet's clamp(240px,20vw,320px), as the number the caps and the drag need.
    width: function(){ return Math.min(320, Math.max(240, Math.round(window.innerWidth * 0.20))); },
    storeKey:'aa_sched_open', widthKey:'aa_sched_w',
    dockAt: 1024,
    // The sidebar's stored width, not its current on-screen one: that is the width the chat
    // loses whenever the sidebar is open, which is what this cap has to keep room for.
    maxWidth: function(){ return window.innerWidth - sbPane.width() - 360; },
    onPaint: function(open){
      app.classList.toggle('sched-open', open);
      schedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      schedToggle.classList.toggle('on', open);
      paintSchedTab();
    },
    onChange: function(open){
      if(open){
        if(schedTasks === null) schedList.innerHTML = '<div class="sched-empty">Loading…</div>';
        loadSchedules();
        if(schedTab === 'reviews') loadReviews();
        armSched();
      } else {
        disarmSched();
      }
      clampPanels();
    }
  });

  /**
   * Both widths are capped against the other column, so opening or closing one can leave the
   * other past its maximum. The clamp rewrites --pw, not storage: the narrower width stays until
   * the page is reloaded, when the stored one is applied again.
   */
  function clampPanels(){
    // Only a column has a width of its own; in drawer mode the screen decides it, and a clamp
    // here would shrink the saved width of a window that is merely narrow at the moment.
    if(!sbPane.docked()) return;
    var w = parseFloat(sidebar.style.getPropertyValue('--pw'));
    if(w > 0) sbPane.setWidth(w, false);
    if(schedPane.docked()){
      var sw = parseFloat(schedPanel.style.getPropertyValue('--pw'));
      if(sw > 0) schedPane.setWidth(sw, false);
    }
  }

  function setSidebar(open){ sbPane.setOpen(open); }
  collapseBtn.addEventListener('click', function(){ setSidebar(false); });
  expandBtn.addEventListener('click', function(){ setSidebar(true); });

  // Restored on the next visit. A first visit on a phone starts with the topic list out of the
  // way; a wide one starts with it open. Neither writes the default back to storage.
  var savedSbOpen = null;
  try { savedSbOpen = localStorage.getItem('aa_sb_open'); } catch(x){}
  if(savedSbOpen === null) savedSbOpen = narrow() ? '0' : '1';
  if(savedSbOpen !== '0') sbPane.setOpen(true, {transient:true});

  /**
   * The two menus at the foot of the sidebar — Menu (all settings, notifications, low attention,
   * skills) and Manage (close idle). One open at a time, one box in one place;
   * a click anywhere else puts it away, and Escape puts it away and gives the focus back to the
   * button that opened it. A disclosure rather than an ARIA menu: role=menu promises arrow-key
   * navigation, and these are reached with Tab like any other buttons.
   */
  var menus = [];
  function setMenu(entry, open){
    for(var i=0;i<menus.length;i++){
      var e=menus[i], on = open && e === entry;
      e.menu.hidden = !on;
      e.btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }
  function openMenu(){
    for(var i=0;i<menus.length;i++) if(!menus[i].menu.hidden) return menus[i];
    return null;
  }
  function addMenu(btn, menu){
    var entry={btn:btn, menu:menu};
    menus.push(entry);
    btn.addEventListener('click', function(){ setMenu(entry, menu.hidden); });
  }
  addMenu(optsBtn, optsMenu);
  addMenu(manageBtn, manageMenu);
  document.addEventListener('click', function(e){
    var m=openMenu();
    if(!m || m.menu.contains(e.target) || m.btn.contains(e.target)) return;
    setMenu(null, false);
  });

  // One sheet dismisses whichever drawer is over the chat. Both are put away if a narrow screen
  // has somehow got both open — a tap outside means "show me the chat".
  backdrop.addEventListener('click', function(){
    if(schedPane.isOpen()) setSchedules(false);
    if(sbPane.isOpen()) setSidebar(false);
  });

  /**
   * The gateway's settings page, from the Menu. The command is sent quietly — the daemon
   * has to build the screen from the live config, and it answers with a message of its own, but a
   * page opening must not leave a /setting bubble in the transcript.
   */
  settingsOpenBtn.addEventListener('click', function(){
    setMenu(null, false);
    var token = openSettingsLoading();
    var t = settingsTopic;
    if(!token || !t) return;
    quietCommand('/setting', t).then(function(ok){
      if(ok) return;
      forgetSettingsRequest(token);
      if(!settingsMsg && !settingsPage.hidden) settingsSay('Could not reach the daemon. Close this and try again.');
    });
  });
  settingsClose.addEventListener('click', closeSettings);
  settingsPage.addEventListener('click', function(e){ if(e.target === settingsPage) closeSettings(); });

  /**
   * Low attention (#app.calm in the stylesheet, which says what it changes and why). Per device,
   * like the sidebar's width: the phone in a pocket and the desktop with five agents on it are not
   * asking for the same list. Absent means off, so nothing changes until someone asks for it.
   */
  var calm = false;
  try { calm = localStorage.getItem('aa_calm') === '1'; } catch(x){}
  function paintCalm(){
    app.classList.toggle('calm', calm);
    calmBtn.setAttribute('aria-pressed', calm ? 'true' : 'false');
    calmState.textContent = calm ? 'on' : 'off';
  }
  calmBtn.addEventListener('click', function(){
    calm = !calm;
    try { if(calm) localStorage.setItem('aa_calm', '1'); else localStorage.removeItem('aa_calm'); } catch(x){}
    paintCalm();
  });
  paintCalm();

  // ── The side panel ──────────────────────────────────────────────────────────
  /**
   * The gateway's background work, in a column of its own rather than in the topic list.
   *
   * Three tabs, because a task, a run of it and a review of a conversation are different things:
   * Tasks is the definitions with their controls, Sessions is the topics a new-session run opened,
   * and Reviews is what the automatic review learned from quiet conversations. Those session
   * topics are left out of the switcher (topicRows), so the Sessions tab is their only home — and
   * the only place to delete one. Reviews have no home anywhere else: a review that changed
   * nothing posts no line, and its result used to live only in the log.
   *
   * Closed on a first visit, then open until the operator closes it: the choice is kept in
   * localStorage (aa_sched_open), so opening a session from the panel leaves the panel where it
   * was. Only a docked panel is restored on load — below 1024px the panel is a drawer over the
   * chat, and coming back to a page with the whole screen covered is not "remembered", it is in
   * the way. Closing is the close button, Escape, the backdrop or the clock, and each of them is
   * remembered too.
   *
   * The task list is pulled when the panel opens, after every action, and on a timer while it is
   * visible (5s while a task is running, 30s otherwise). The sessions list needs no request: the
   * topics event that keeps the switcher current carries their flags, state and unread counts too.
   * Reviews are pulled on the same timer when their tab is the one on screen.
   */
  try {
    var savedSchedTab = localStorage.getItem('aa_sched_tab');
    if(savedSchedTab === 'sessions' || savedSchedTab === 'reviews'){
      schedTab = savedSchedTab;
      paintSchedTab();
    }
  } catch(x){}

  /** The topics a scheduled run opened, most recently active first (the order topics is in). */
  function schedSessions(){
    var out=[];
    for(var i=0;i<topics.length;i++) if(topics[i].scheduled) out.push(topics[i]);
    return out;
  }

  function schedAgo(at){
    if(!at) return '';
    var s=Math.max(0, Math.round((Date.now()-at)/1000));
    if(s<60) return s+'s ago';
    if(s<3600) return Math.round(s/60)+'m ago';
    if(s<86400) return Math.round(s/3600)+'h ago';
    return Math.round(s/86400)+'d ago';
  }

  /**
   * One scheduled run, as the Sessions tab draws it.
   *
   * The row is the only way to reach these topics now that the switcher leaves them out, and the
   * only way to delete one: the dot and the badge say whether it is working, waiting, unread; the
   * × is the operator deciding about this run rather than the whole task.
   */
  function schedSessionRow(t){
    var named=splitTitle(t.title || 'Untitled', t.dir && t.dir.host);
    var asking=Boolean(t.asking), running=Boolean(t.running);
    var dot='topic-dot'+(asking?' asking':(running?' running':(t.stage==='failed'?' failed':(t.stage==='review'?' review':(t.live?' live':'')))));
    var count=t.msgCount||0;
    var unread=t.id===topic?0:Math.max(0, count-(readCounts[t.id]||0));
    var badge=unread>0?'<span class="topic-badge">'+(unread>99?'99+':unread)+'</span>':'';
    var state=asking?'awaiting you':(running?'running':(t.stage==='failed'?'failed':(t.stage==='review'?'finished':'')));
    var meta=schedAgo(t.lastAt)+(count?' · '+count+' message'+(count===1?'':'s'):'')+(state?' · '+state:'');
    return '<div class="sess-item'+(t.id===topic?' on':'')+'" data-sess="'+text(t.id)+'" role="button" tabindex="0">'
      + '<span class="'+dot+'"></span>'
      + '<span class="sess-main"><span class="sess-title">'
      + (named.tag?'<span class="topic-tag">'+text(named.tag)+'</span> ':'')+text(named.rest)
      + '</span><span class="sess-meta">'+text(meta)+'</span></span>'
      + badge
      + '<button type="button" class="btn-icon sess-del" data-sdel="'+text(t.id)+'" title="Delete this session" aria-label="Delete this session">&times;</button>'
      + '</div>';
  }

  function paintSessions(){
    var list=schedSessions();
    if(!list.length){
      schedSessionList.innerHTML='<div class="sched-empty">No scheduled sessions yet. A task that runs in a new or daily session opens one here.</div>';
      return;
    }
    var h='';
    for(var i=0;i<list.length;i++) h+=schedSessionRow(list[i]);
    schedSessionList.innerHTML=h;
  }

  // ── Reviews ────────────────────────────────────────────────────────────────
  /**
   * What the automatic review did with the conversations that went quiet.
   *
   * Read-only, and pulled rather than pushed: a review is a rare, slow background event and the
   * daemon has no event for one finishing. There is no daily quota: the sweep has no cap, so the
   * list is the whole story.
   */
  function loadReviews(){
    if(app.hidden) return;
    var seq = ++reviewSeq;
    fetch('api/reviews', {credentials:'same-origin'}).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(d){
      if(seq !== reviewSeq) return;
      reviewData = d || { enabled:false, running:false, reviews:[] };
      paintReviews();
      paintSchedCounts();
      paintSummary();
    }).catch(function(e){
      if(seq !== reviewSeq) return;
      showSchedNote('Could not refresh reviews: ' + ((e && e.message) || 'network error'));
    });
  }

  function paintReviews(){
    if(reviewData === null){
      revList.innerHTML = '<div class="sched-empty">Loading…</div>';
      return;
    }
    if(!reviewData.enabled){
      revList.innerHTML = '<div class="sched-empty">This daemon has no conversation library, so there is no review history.</div>';
      return;
    }
    if(!reviewData.reviews.length){
      revList.innerHTML = '<div class="sched-empty">' + (reviewData.running
        ? 'No reviews yet. A conversation is reviewed once it has been quiet for an hour, after three messages from you.'
        : 'Automatic review is off. Name an agent under review.agent to turn it on; reviews recorded before then still appear here.') + '</div>';
      return;
    }
    var h='';
    for(var i=0;i<reviewData.reviews.length;i++) h += revRow(reviewData.reviews[i]);
    revList.innerHTML = h;
  }

  /** The panel is a column: a review is one line until it is opened, like a task card. */
  function revRow(r){
    var open = Boolean(revOpen[r.id]);
    var h = '<div class="rev-item ' + text(r.outcome) + (open ? ' open' : '') + '" data-rev="' + text(r.id) + '" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">';
    h += '<div class="rev-row"><span class="rev-dot"></span><span class="rev-topic">' + text(r.title) + '</span>';
    if(r.inferred) h += '<span class="rev-badge">inferred</span>';
    h += '<span class="rev-when" title="' + text(revWhen(r.at)) + '">' + text(schedAgo(r.at)) + '</span></div>';
    h += '<div class="rev-result">' + text(r.summary) + '</div>';
    if(open) h += revDetail(r);
    h += '</div>';
    return h;
  }

  function revDetail(r){
    var h = '<div class="rev-detail">';
    if(r.error) h += '<div class="rev-note bad">' + text(r.error) + '</div>';
    if(r.changes.length){
      h += '<div class="rev-label">Changes</div>';
      for(var i=0;i<r.changes.length;i++) h += revChange(r.changes[i]);
    }
    if(r.invalid.length){
      h += '<div class="rev-label">Rejected</div>';
      for(var j=0;j<r.invalid.length;j++) h += '<div class="rev-note">' + text(r.invalid[j]) + '</div>';
    }
    if(r.preferences.length){
      h += '<div class="rev-label">Preferences</div>';
      for(var k=0;k<r.preferences.length;k++) h += '<div class="rev-pref">' + text(r.preferences[k]) + '</div>';
    }
    if(r.inferred) h += '<div class="rev-note">Read from the raw answer: whether any of it took effect was not recorded.</div>';
    if(!r.changes.length && !r.preferences.length && !r.invalid.length && !r.error) h += '<div class="rev-note">Nothing worth changing.</div>';
    // Only when the topic is still in the switcher: a link to a topic the page does not have
    // would look like one and do nothing.
    if(r.topic && topicExists(r.topic)) h += '<button type="button" class="rev-open" data-rev-topic="' + text(r.topic) + '">Open the reviewed topic</button>';
    h += '</div>';
    return h;
  }

  /**
   * One change. applied is three-state on purpose: true and false are what the gateway recorded,
   * and absent is an old review whose raw answer never said — marked unknown rather than guessed.
   */
  function revChange(c){
    var what = c.action==='create' ? 'Create ' : (c.action==='patch' ? 'Update ' : 'Write ');
    var name = c.action==='write-file' ? (c.file || 'a file') + ' in ' + c.name : c.name;
    var status = c.applied===true ? '<span class="rev-status ok">applied</span>'
      : c.applied===false ? '<span class="rev-status bad">refused</span>'
      : '<span class="rev-status unknown">unknown</span>';
    var h = '<div class="rev-change">' + what + '<span class="rev-name">' + text(name) + '</span>' + status;
    if(c.reason) h += '<div class="rev-reason">' + text(c.reason) + '</div>';
    if(c.error) h += '<div class="rev-note bad">' + text(c.error) + '</div>';
    if(c.undo) h += '<code class="rev-undo">' + text(c.undo) + '</code>';
    h += '</div>';
    return h;
  }

  function revWhen(at){
    try { return new Date(at).toLocaleString(); }
    catch(x){ return new Date(at).toISOString(); }
  }

  function topicExists(id){
    for(var i=0;i<topics.length;i++) if(topics[i].id === id) return true;
    return false;
  }

  function paintSchedCounts(){
    schedTabTasksN.textContent = schedTasks ? String(schedTasks.length) : '';
    schedTabSessionsN.textContent = String(schedSessions().length);
    schedTabReviewsN.textContent = reviewData ? String(reviewData.reviews.length) : '';
  }

  /**
   * The clock's dot: a scheduled run is holding a question and nothing will move until it is
   * answered. Those topics have no row in the switcher, so this is the one signal that reaches the
   * operator without opening the panel.
   */
  function paintSchedAlert(){
    var waiting=false;
    for(var i=0;i<topics.length;i++){
      if(topics[i].scheduled && topics[i].stage==='answer'){ waiting=true; break; }
    }
    schedAlert.hidden = !waiting;
    var label = waiting ? 'Side tasks — a run is waiting on your answer' : 'Side tasks';
    schedToggle.title = label;
    schedToggle.setAttribute('aria-label', label);
  }

  function paintSummary(){
    if(schedTab==='reviews'){
      schedSummary.textContent = reviewData
        ? (reviewData.reviews.length
            ? reviewData.reviews.length + (reviewData.reviews.length===1?' review':' reviews')
            : 'no reviews yet')
        : 'loading…';
      return;
    }
    if(schedTab==='sessions'){
      var list=schedSessions(), busy=0;
      for(var i=0;i<list.length;i++) if(list[i].running || list[i].asking) busy++;
      schedSummary.textContent = list.length
        ? list.length + (list.length===1?' session':' sessions') + (busy?' · '+busy+' running':'')
        : 'no sessions yet';
      return;
    }
    if(schedTasks === null){ schedSummary.textContent = 'loading…'; return; }
    var active=0, paused=0, ended=0;
    for(var j=0;j<schedTasks.length;j++){
      if(schedTasks[j].state === 'active') active++;
      else if(schedTasks[j].state === 'paused') paused++;
      else ended++;
    }
    schedSummary.textContent = !schedEnabled
      ? 'not enabled'
      : schedTasks.length
        ? active + ' active' + (paused ? ' · ' + paused + ' paused' : '') + (ended ? ' · ' + ended + ' ended' : '')
        : 'nothing scheduled';
  }

  function paintSchedTab(){
    var sessions=schedTab==='sessions', reviews=schedTab==='reviews';
    schedTabTasks.classList.toggle('on', !sessions && !reviews);
    schedTabSessions.classList.toggle('on', sessions);
    schedTabReviews.classList.toggle('on', reviews);
    schedTabTasks.setAttribute('aria-selected', (!sessions && !reviews) ? 'true' : 'false');
    schedTabSessions.setAttribute('aria-selected', sessions ? 'true' : 'false');
    schedTabReviews.setAttribute('aria-selected', reviews ? 'true' : 'false');
    schedList.hidden = sessions || reviews;
    schedSessionList.hidden = !sessions;
    revPane.hidden = !reviews;
    if(sessions) paintSessions();
    if(reviews) paintReviews();
    paintSchedCounts();
    paintSummary();
  }

  function setSchedTab(tab){
    schedTab = tab==='sessions' ? 'sessions' : (tab==='reviews' ? 'reviews' : 'tasks');
    try { localStorage.setItem('aa_sched_tab', schedTab); } catch(x){}
    if(schedTab==='reviews') loadReviews();
    paintSchedTab();
  }

  function disarmSched(){
    if(schedTimer) clearTimeout(schedTimer);
    schedTimer = 0;
  }

  function armSched(){
    disarmSched();
    if(!schedPane.isOpen()) return;
    var wait = schedTasks && schedTasks.some(function(t){ return t.running; }) ? 5000 : 30000;
    schedTimer = setTimeout(function(){
      schedTimer = 0;
      if(!schedPane.isOpen()) return;
      if(document.visibilityState === 'hidden'){ armSched(); return; }
      loadSchedules();
      // A review takes minutes, so the same 30s poll is plenty; only the visible tab is asked for.
      if(schedTab === 'reviews') loadReviews();
    }, wait);
  }

  function setSchedules(open, transient){
    if(open === schedPane.isOpen()) return;
    // Docking the panel narrows the chat, which re-wraps the transcript. A reader at the bottom
    // should stay at the bottom; one reading history keeps the pixel position they chose.
    var wasBottom = atBottom();
    schedPane.setOpen(open, {transient:transient});
    if(wasBottom) toBottom();
  }

  function showSchedNote(msg){
    schedNote.hidden = false;
    schedNote.textContent = msg;
  }

  function loadSchedules(){
    // Before the gate is down the request would only be refused; the stream's open handler asks
    // again the moment the page is really in.
    if(app.hidden) return;
    var seq = ++schedSeq;
    schedNote.hidden = true;
    fetch('api/schedules', {credentials:'same-origin'}).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(d){
      if(seq !== schedSeq) return;
      schedEnabled = d.enabled !== false;
      paintSchedulesList(d.tasks || []);
    }).catch(function(e){
      if(seq !== schedSeq) return;
      // Keep what is on screen: a list that was true a moment ago beats an empty panel, and the
      // note says why it did not move.
      showSchedNote('Could not refresh: ' + ((e && e.message) || 'network error'));
    }).then(function(){
      if(seq === schedSeq) armSched();
    });
  }

  function schedIn(at){
    if(at <= Date.now()) return 'due now';
    return 'in ' + stLeft(at - Date.now());
  }

  function schedDur(ms){
    if(ms < 1000) return ms + 'ms';
    if(ms < 60000) return (ms/1000).toFixed(1) + 's';
    if(ms < 3600000) return Math.round(ms/60000) + 'm';
    return (ms/3600000).toFixed(1) + 'h';
  }

  function schedTarget(t){
    if(t.targetTopic){
      for(var i=0;i<topics.length;i++){
        if(topics[i].id === t.targetTopic) return 'posts to ' + (topics[i].title || t.targetTopic);
      }
    }
    return 'posts to ' + t.target;
  }

  /** The last run in one line: a word, how long ago, and how long it took. Empty when it has never
      run — "not run yet" is a line the eye reads to learn nothing. */
  function schedLast(t){
    if(!t.last) return '';
    var word = {ok:'ok', failed:'failed', interrupted:'interrupted', skipped:'skipped', missed:'missed'}[t.last.status] || t.last.status;
    var s = 'last run ' + word + ' · ' + schedAgo(t.last.at);
    if(t.last.durationMs != null) s += ' · ' + schedDur(t.last.durationMs);
    if(t.last.error) s += ' — ' + t.last.error;
    return s;
  }

  /** A word only for the states that are not the ordinary one: active is what a card is unless it
      says otherwise, and a badge on every card is noise the eye has to filter. */
  function schedStateTag(t, state){
    if(t.running) return '<span class="sched-state running">Running</span>';
    if(state === 'paused') return '<span class="sched-state paused">Paused</span>';
    if(state === 'expired') return '<span class="sched-state expired">Expired</span>';
    if(state === 'done') return '<span class="sched-state done">Done</span>';
    return '';
  }

  /**
   * One task, in the order the questions come: what is it, when does it run, when next, where does
   * it post, how did last time go. The name and the schedule carry the weight; the countdown is
   * the one live number; the rest is a quiet line under them. The prompt, the run mode and the
   * bookkeeping stay behind the card, which is what clicking it is for.
   */
  function schedCard(t){
    var state = t.state || 'active';
    var h = '<div class="sched-item ' + text(state) + (t.running ? ' running' : '') + '" data-id="' + text(t.id) + '">';
    h += '<div class="sched-row"><span class="sched-dot"></span><span class="sched-name">' + text(t.name) + '</span>' + schedStateTag(t, state) + '</div>';
    h += '<div class="sched-when">' + text(t.when) + '</div>';
    var sub = '';
    if(t.running) sub += '<span class="sched-next">running now</span><span class="sched-sep">·</span>';
    else if(state === 'active' && t.nextAt){
      var next = schedIn(t.nextAt);
      sub += '<span class="sched-next" title="' + text(t.next || '') + '">' + text(next === 'due now' ? next : 'next ' + next) + '</span><span class="sched-sep">·</span>';
    }
    sub += '<span class="sched-target">' + text(schedTarget(t)) + '</span>';
    h += '<div class="sched-sub">' + sub + '</div>';
    var last = schedLast(t);
    if(last) h += '<div class="sched-last' + (t.last.status !== 'ok' ? ' bad' : '') + '" title="' + text(t.last.atText) + '">' + text(last) + '</div>';
    h += '<div class="sched-detail" hidden>';
    h += '<div class="sched-detail-label">' + (t.kind === 'bash' ? 'Command' : 'Prompt') + '</div>';
    h += '<div class="sched-detail-body">' + text(t.detail) + '</div>';
    var meta = t.run + ' · #' + t.id + ' · ' + t.runs + (t.runs === 1 ? ' run' : ' runs');
    if(t.cwd) meta += ' · ' + t.cwd;
    if(t.expires) meta += ' · until ' + t.expires;
    h += '<div class="sched-detail-meta">' + text(meta) + '</div></div>';
    h += '<div class="sched-acts">';
    if(state === 'active') h += '<button type="button" data-op="pause">Pause</button>';
    if(state === 'paused') h += '<button type="button" data-op="resume">Resume</button>';
    if(state === 'active' || state === 'paused') h += '<button type="button" data-op="run"' + (t.running ? ' disabled' : '') + '>Run now</button>';
    h += '<button type="button" class="danger" data-op="remove">Delete</button>';
    h += '</div></div>';
    return h;
  }

  function paintSchedulesList(tasks){
    schedTasks = tasks || [];
    if(!schedTasks.length){
      schedList.innerHTML = '<div class="sched-empty">' + (schedEnabled
        ? 'No scheduled tasks yet. Ask an agent in a topic — for example “every morning at 8, summarise the CI failures” — and it will be registered here.'
        : 'Scheduled tasks are not enabled in this daemon.') + '</div>';
    } else {
      var h = '';
      for(var i=0;i<schedTasks.length;i++) h += schedCard(schedTasks[i]);
      schedList.innerHTML = h;
    }
    paintSchedCounts();
    paintSummary();
  }

  function schedOp(id, action, btn){
    if(schedBusy) return;
    schedBusy = true;
    if(btn) btn.disabled = true;
    fetch('api/schedules/op', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:id, action:action}),
      credentials:'same-origin'
    }).then(function(r){
      return r.json().catch(function(){ return { ok:false, error:'HTTP ' + r.status }; });
    }).then(function(d){
      if(d && d.ok && d.tasks) paintSchedulesList(d.tasks);
      else showSchedNote((d && d.error) || 'That did not work.');
    }).catch(function(e){
      showSchedNote('Could not reach the daemon: ' + ((e && e.message) || 'network error'));
    }).then(function(){
      schedBusy = false;
      if(btn) btn.disabled = false;
      armSched();
    });
  }

  schedToggle.addEventListener('click', function(){ setSchedules(!schedPane.isOpen()); });
  schedClose.addEventListener('click', function(){ setSchedules(false); });
  schedTabTasks.addEventListener('click', function(){ setSchedTab('tasks'); });
  schedTabSessions.addEventListener('click', function(){ setSchedTab('sessions'); });
  schedTabReviews.addEventListener('click', function(){ setSchedTab('reviews'); });

  revList.addEventListener('click', function(e){
    var openBtn = e.target.closest ? e.target.closest('[data-rev-topic]') : null;
    if(openBtn){
      e.stopPropagation();
      switchTopic(openBtn.getAttribute('data-rev-topic'));
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-rev]') : null;
    if(!row) return;
    var id = row.getAttribute('data-rev');
    if(!id) return;
    revOpen[id] = !revOpen[id];
    paintReviews();
  });

  revList.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    if(e.target.closest && e.target.closest('[data-rev-topic]')) return;
    var row = e.target.closest ? e.target.closest('[data-rev]') : null;
    if(!row) return;
    e.preventDefault();
    var id = row.getAttribute('data-rev');
    if(!id) return;
    revOpen[id] = !revOpen[id];
    paintReviews();
  });

  schedSessionList.addEventListener('click', function(e){
    var del = e.target.closest ? e.target.closest('[data-sdel]') : null;
    if(del){
      e.stopPropagation();
      var delId = del.getAttribute('data-sdel');
      if(delId) deleteTopic(delId);
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-sess]') : null;
    if(!row) return;
    var id = row.getAttribute('data-sess');
    if(!id || id===topic) return;
    switchTopic(id);
  });

  schedSessionList.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    if(e.target.closest && e.target.closest('[data-sdel]')) return;
    var row = e.target.closest ? e.target.closest('[data-sess]') : null;
    if(!row) return;
    e.preventDefault();
    var id = row.getAttribute('data-sess');
    if(id && id!==topic) switchTopic(id);
  });

  schedList.addEventListener('click', function(e){
    var opBtn = e.target.closest ? e.target.closest('[data-op]') : null;
    if(opBtn){
      e.stopPropagation();
      var item = opBtn.closest ? opBtn.closest('.sched-item') : null;
      var id = item ? item.getAttribute('data-id') : '';
      var op = opBtn.getAttribute('data-op');
      if(!id || !op) return;
      if(op === 'remove' && opBtn.getAttribute('data-confirm') !== '1'){
        // Two taps, like the /setting menu: the task is gone for good and a mis-tap on a phone
        // is easy. Any repaint clears it, and so does this timeout.
        opBtn.setAttribute('data-confirm', '1');
        opBtn.classList.add('confirm');
        opBtn.classList.remove('danger');
        opBtn.textContent = 'Delete?';
        setTimeout(function(){
          if(opBtn.getAttribute('data-confirm') === '1'){
            opBtn.removeAttribute('data-confirm');
            opBtn.classList.remove('confirm');
            opBtn.classList.add('danger');
            opBtn.textContent = 'Delete';
          }
        }, 4000);
        return;
      }
      schedOp(id, op, opBtn);
      return;
    }
    if(e.target.closest && e.target.closest('.sched-acts')) return;
    var card = e.target.closest ? e.target.closest('.sched-item') : null;
    if(!card) return;
    var detail = card.querySelector('.sched-detail');
    if(!detail) return;
    detail.hidden = !detail.hidden;
    card.classList.toggle('open', !detail.hidden);
  });

  // A timer is not worth running behind a hidden tab; ask once on the way back instead.
  document.addEventListener('visibilitychange', function(){
    if(!schedPane.isOpen()) return;
    if(document.visibilityState === 'hidden') disarmSched();
    else {
      loadSchedules();
      if(schedTab === 'reviews') loadReviews();
    }
  });

  // The panel's own choice, restored only where there is a column to dock it to. Its width was
  // applied by makePanel before the first paint.
  var restoreSched = false;
  try { restoreSched = localStorage.getItem('aa_sched_open') === '1'; } catch(x){}
  if(restoreSched && schedPane.docked()) setSchedules(true, true);

  // Escapes for BOTH uses this page makes of it: element content, and the inside of a
  // double-quoted attribute. textContent alone covers the first and leaves the quote, which is
  // what the second needs — a directory whose name contains a double quote would end the title
  // attribute early and put the rest of the path in the tag. Everything interpolated here is the
  // (their paths, their command list), so this is a rendering bug rather than a way in; the
  // load-bearing escaping is web-markdown.ts, which never lets agent output near a tag at all.
  function text(s){
    var d=document.createElement('div');
    d.textContent=s==null?'':String(s);
    return d.innerHTML.replace(/"/g,'&quot;');
  }
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  // Retried, which is only safe because every send carries a nonce the server remembers: on a
  // bad link a request can be accepted and still time out, and without the nonce a retry would
  // post the same message twice.
  //
  // limit is how long ONE attempt may go unanswered, in ms, before it is abandoned and counted as
  // a dropped request. fetch has no timeout of its own, so a request that never answers — a tunnel
  // that took the body and went quiet, a socket the OS has not noticed is dead — used to leave the
  // caller waiting for ever: for a send, a grey bubble that neither turned red nor offered Retry.
  // Only a send passes one. The other callers' requests are short, and a stuck button is a
  // different complaint from a message that looks sent and is not.
  function post(path, body, tries, limit){
    // Built first: JSON.stringify is the one thing here that can throw, and nothing is armed yet.
    var init = {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),credentials:'same-origin'};
    var expired = false, timer = 0;
    if(limit && typeof AbortController === 'function'){
      var ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(function(){ expired = true; ctl.abort(); }, limit);
    }
    return fetch(path, init).then(function(r){
      clearTimeout(timer);
      if(!r.ok && r.status>=500 && tries>0) return wait(700).then(function(){ return post(path, body, tries-1, limit); });
      return r;
    }, function(e){
      clearTimeout(timer);
      // An attempt that was given a minute or more was carrying an upload, and starting one over
      // from its first byte twice more is a quarter of an hour of grey for a link that has just
      // shown it cannot do it. It fails once instead, and Retry is a single tap.
      if(tries>0 && !(expired && limit > 60000)) return wait(700).then(function(){ return post(path, body, tries-1, limit); });
      throw e;
    });
  }

  /**
   * How long one attempt at posting this message may take: fifteen seconds, plus one for every
   * 64 KiB of it, up to the five minutes the server allows a request body (Node's
   * http.Server.requestTimeout, whose default has been 300000 since v18 — nodejs.org, http docs).
   *
   * Scaled rather than flat because the same page sends a line of text and a 20 MB attachment: a
   * limit short enough to catch the first would cut the second off mid-upload on any ordinary
   * mobile uplink and call that a failure.
   */
  function sendLimit(body){
    var n = (body.text || '').length, f = body.files || [];
    for(var i=0;i<f.length;i++) n += f[i].data.length + f[i].name.length;
    return Math.min(300000, 15000 + Math.round(n / 65.536));
  }

  function atBottom(){ return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function toBottom(){ log.scrollTop = log.scrollHeight; }

  // ── Where each topic was being read ────────────────────────────────────────
  /**
   * The place in a topic to come back to: the first message on screen when it was left, and how
   * far its top sat from the top of the viewport. No entry means the bottom — which is where a
   * reader who was following along wants to be, and where whatever was said while they were away
   * is going to land.
   *
   * A message rather than a scrollTop, because the transcript a topic comes back to is not the one
   * it was left with: it is rebuilt from the cache, which keeps the last 200 messages, and then
   * reconciled against a ring of 1000 — so the sync can put a few hundred older messages above the
   * one being read. A pixel offset would land in the middle of those; a message does not move.
   *
   * In memory only, and with no scroll listener. The whole cost is one measurement on the way out
   * of a topic, and one or two on the way back in (see land).
   */
  var views = {};
  // The view being restored on the way into the current topic, until its first sync has landed;
  // and the scrollTop that landing left behind, which is how a reader who has scrolled since is
  // told apart from one who has not. -1 until something has been landed.
  var view = null, landedAt = -1;

  /**
   * The first message whose bottom edge is below the top of the viewport. A binary search, since
   * the children are in vertical order and a topic can hold 1000 of them: every rect after the
   * first is read off a layout that is already up to date, so this forces one layout, not one per
   * message.
   */
  function firstVisible(){
    var kids = log.children, top = log.getBoundingClientRect().top;
    var lo = 0, hi = kids.length;
    while(lo < hi){
      var mid = (lo + hi) >> 1;
      if(kids[mid].getBoundingClientRect().bottom <= top) lo = mid + 1; else hi = mid;
    }
    // Past the divider, the waiting line and the placeholders: only a message has a key to find
    // again.
    for(var i=lo; i<kids.length; i++){ if(kids[i].getAttribute('data-k')) return kids[i]; }
    return null;
  }

  /** Remember where the topic being left was being read. */
  function saveView(id){
    if(!id) return;
    // Still on the way in: nothing on screen yet says more than the view being restored does, so
    // flicking through a topic before it has loaded must not forget where it was being read. A
    // reader who has scrolled the cached transcript since it was landed has answered for themselves.
    if(entering && (landedAt < 0 || log.scrollTop === landedAt)){
      if(view) views[id] = view; else delete views[id];
      return;
    }
    // No box to measure (the terminal window is over the transcript), or at the bottom, which is
    // what no entry already means.
    var el = (log.clientHeight && !atBottom()) ? firstVisible() : null;
    if(!el){ delete views[id]; return; }
    views[id] = { key: el.getAttribute('data-k'),
      off: el.getBoundingClientRect().top - log.getBoundingClientRect().top };
  }

  /**
   * Put the reader back where they left this topic, or at the bottom when there is nowhere to put
   * them: it was left there, it was never read, or the message they were on is no longer held.
   */
  function land(){
    var el = view && els[view.key];
    if(el) log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top - view.off;
    else toBottom();
    landedAt = log.scrollTop;
  }

  function clock(ms){
    var d=new Date(ms), p=function(n){ return (n<10?'0':'')+n; };
    return p(d.getHours())+':'+p(d.getMinutes());
  }

  /**
   * Draw one message, creating its element if this is the first sight of it.
   *
   * before is how cached history gets ABOVE a transcript the daemon has already sent: the node
   * is inserted in front of the first live message instead of appended after the last one.
   */
  function paint(key, before){
    var m=data[key]; if(!m) return;
    // A settings screen is drawn in the settings page, never in the transcript (see takeSettings).
    // The guard is here as well as at every call site because paint is the one funnel: an edit
    // that arrives through a path nobody thought of must not put the screen back in the log.
    if(m.settings || m.wasSettings) return;
    var el=els[key];
    if(!el){
      clearSkeleton();
      el=document.createElement('div');
      // The page's own key, on the node, so the order on screen can be read back off #log —
      // which is what the cache writes and what places the history divider.
      el.setAttribute('data-k', key);
      // before is where cached history goes; the waiting line, when one is up, is the last thing
      // in the log and has to stay there, so anything painted under it goes above it instead.
      var at = (before && before.parentNode === log) ? before : syncingEl;
      if(at) log.insertBefore(el, at); else log.appendChild(el);
      els[key]=el;
    }
    var hist = isHistory(m);
    var cls = 'm' + (m.own ? ' own' : '') + (hist ? ' hist' : '')
      + (m._local && m._state === 'sending' ? ' pending' : '')
      + (stuck(m) ? ' failed' : '');
    var h='';
    var tools = m.kind === 'tools';
    if(m.quote && m.quote.html) h += '<div class="q">'+m.quote.html+'</div>';
    h += '<div class="b">'+(tools ? foldLines(key, m.html) : m.html)+'</div>';
    if(m.file){
      // An image is drawn, not just named — a screenshot the agent took is about to be looked
      // at, and a round trip through the downloads folder to do that is the friction this
      // exists to remove. The link stays underneath either way: it is still the only way to
      // get the bytes onto disk, and it is what a picture that fails to load degrades to.
      if(m.file.image) h += '<img class="shot" src="'+text(m.file.url)+'" alt="'+text(m.file.name)+'" loading="lazy">';
      h += '<div class="files"><a href="'+text(m.file.url)+'" download'
        + (m.file.view && !hist ? ' data-view="'+text(m.file.view)+'"' : '')
        + '>'+text(m.file.name)+'</a>';
      // A report or a log is read by tapping its name (openReader); Download beside it is the
      // way to the bytes, which is what the name used to be. Not offered on history, for the
      // reason its buttons are dropped below: the token died with the process that minted it, so
      // the reader could only ever open onto "no longer here".
      if(m.file.view && !hist) h += '<a class="view" href="'+text(m.file.url)+'" download>Download</a>';
      h += '</div>';
    }
    // Buttons are dropped from a message that came out of the cache: the process that would
    // answer them is gone, and the id they name now means a different message or nothing at
    // all. A control that cannot act is worse than no control.
    if(!hist && m.buttons && m.buttons.length) h += menu(m);
    if(stuck(m)) h += failedActions(m);
    var meta = clock(m.at) + (m.reactions && m.reactions.length ? '  '+m.reactions.join(' ') : '');
    h += '<div class="t">'+text(meta)+(tools ? allToggle(key) : '')+'</div>';
    // Write nothing when nothing changed. A sync re-paints every message it carries, and most of
    // them are messages already on screen unchanged — rewriting innerHTML for those would drop
    // the caret out of a selection, restart any <img> decode, and undo the enabled state of a
    // button the click handler just disabled, all for identical markup.
    if(sig[key]===h && el.className===cls) return;
    el.className = cls;
    el.innerHTML = h;
    sig[key] = h;
  }

  /**
   * A message's buttons, laid out as what nearly all of them are: a menu to pick one thing from.
   *
   * A grid rather than buttons wrapped like words, because a wrapped row is only as wide as its
   * labels: a page of directories came out as a ragged block whose columns moved on every row, and
   * on a phone as one or two buttons a row in no order at all. The columns are sized from the
   * widest label (--cw, in the menu's own ch), so short names get more of them and long model ids
   * fewer, and the stylesheet keeps at least two — a label longer than half the row wraps inside
   * its cell rather than taking the row.
   *
   * Two things are read off the labels, because a label is all the daemon sends. The marks core
   * puts in front of an item (● the current one, ☑ ☐ a multi-select's ticks, ⌂ the workspace root)
   * become a mark the cell can colour, and the current choice is lit rather than left to be found
   * by a dot the same grey as its text. And the controls that move around a menu rather than
   * answer it (◀ Prev, Next ▶, ◀ Back, ‹ ›) go on a row of their own under the items, instead of
   * reading as two more things to choose. Both are presentation only: a label that happens to
   * match is drawn differently and still posts exactly its own id.
   */
  var MARK = /^([●☑☐⌂]) /, NAV = /^[◀‹]|[▶›]$/;
  function menu(m){
    var items = '', nav = '', widest = 0, msg = text(m.id);
    for(var i=0;i<m.buttons.length;i++){
      var b = m.buttons[i], label = String(b.label == null ? '' : b.label), mk = MARK.exec(label);
      var tag = '<button type="button" data-msg="'+msg+'" data-btn="'+text(b.id)+'"';
      if(NAV.test(label)){ nav += tag+'>'+text(label)+'</button>'; continue; }
      widest = Math.max(widest, labelWidth(label));
      var on = mk && (mk[1] === '●' || mk[1] === '☑');
      items += tag + (on ? ' class="on"' : '') + '>'
        + (mk ? '<span class="mk">'+mk[1]+'</span> '+text(label.slice(2)) : text(label)) + '</button>';
    }
    // 40 is core's label budget (truncateLabel); a longer one would be a column no row can hold.
    return '<div class="btns" style="--cw:'+Math.min(widest, 40)+'ch">' + items
      + (nav ? '<div class="nav">'+nav+'</div>' : '') + '</div>';
  }

  /**
   * A /setting screen as markup, for the settings page rather than for the transcript.
   *
   * The daemon sends the screen as data (WebMessage.settings): groups, rows, values, what control
   * each row is changed with, and the button id every control posts. Nothing here parses a label
   * or decides a value — the grid did, because a label was all it had. What IS decided here is
   * presentation: a choice of up to five short values is drawn as a segmented control (one tap,
   * every option visible), a longer one as a select.
   *
   * Every interactive element carries data-fk, a key that survives a redraw (the row's index and
   * the part of it), so focus can be put back after the daemon's answer replaces the markup.
   */
  function settingsScreen(m){
    var s = m.settings;
    if(!s) return '';
    return s.level === 'values' ? settingsValues(s) : settingsList(s);
  }

  // Escaped text with code spans kept: what the daemon writes in its sentences. Escaping comes
  // first, so the only markup that can come out is the <code> put in here.
  function inl(s){
    return text(s == null ? '' : s).replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
  }

  function settingsNotice(n){
    if(!n) return '';
    var tone = n.tone === 'ok' || n.tone === 'error' ? n.tone : 'info';
    return '<div class="set-notice '+tone+'" role="'+(tone === 'error' ? 'alert' : 'status')+'">'+inl(n.text)+'</div>';
  }

  function settingsList(s){
    var h = '';
    if(s.about) h += '<p class="set-about">'+inl(s.about)+'</p>';
    if(settingsNote) h += settingsNotice({ tone: 'error', text: settingsNote });
    h += settingsNotice(s.notice);
    var notes = {}, groups = s.groups || [];
    for(var g=0;g<groups.length;g++) notes[groups[g].name] = groups[g].note;
    var rows = s.rows || [], group = null, open = false;
    for(var i=0;i<rows.length;i++){
      var r = rows[i], name = String(r.group == null ? '' : r.group);
      if(name !== group){
        if(open) h += '</div></section>';
        group = name;
        h += '<section class="set-sec">'+(name ? '<h3 class="set-group">'+text(name)+'</h3>' : '')
          + (notes[name] ? '<p class="set-gnote">'+inl(notes[name])+'</p>' : '')
          + '<div class="set-card">';
        open = true;
      }
      h += settingsItem(r, i);
    }
    if(open) h += '</div></section>';
    return h;
  }

  /** A row's name, its badges and its one line: the left half of every kind of row. */
  function settingsText(r){
    var badges = '';
    if(r.here) badges += '<span class="set-badge here" title="Answers the topic \\u201c'+text(settingsTopicName(settingsTopic))+'\\u201d">this topic</span>';
    if(r.effectLabel) badges += '<span class="set-badge restart"'+(r.effectDetail ? ' title="'+text(r.effectDetail)+'"' : '')+'>'+text(r.effectLabel)+'</span>';
    return '<div class="set-tx"><div class="set-label"><span>'+text(r.label)+'</span>'
      + (r.targetKind ? '<span class="set-kind">'+text(r.targetKind)+'</span>' : '') + badges + '</div>'
      + (r.hint ? '<div class="set-hint">'+inl(r.hint)+'</div>' : '') + '</div>';
  }

  function settingsItem(r, i){
    var c = r.control || { kind: 'list' };
    if(c.kind === 'switch'){
      return '<div class="set-item sw">' + settingsText(r)
        + '<div class="set-ctl"><button type="button" class="set-switch" role="switch" aria-checked="'+(c.on ? 'true' : 'false')+'"'
        + ' aria-label="'+text(r.label)+'" data-fk="r'+i+'" data-btn="'+text(c.set)+'"></button></div></div>';
    }
    if(c.kind === 'choice') return '<div class="set-item">' + settingsText(r) + '<div class="set-ctl">'+settingsChoice(r, c.options || [], i)+'</div></div>';
    // A row with a screen of its own, or a way to another menu: the whole row is the button.
    var value = '';
    if(c.kind !== 'link' && r.value != null){
      value = '<span class="set-vv"><span class="set-v'+(r.unset ? ' unset' : '')+'" title="'+text(r.value)+'">'+text(r.value)+'</span>'
        + (r.valueNote ? '<span class="set-vnote">'+text(r.valueNote)+'</span>' : '') + '</span>';
    }
    return '<button type="button" class="set-item set-open" data-fk="r'+i+'" data-btn="'+text(r.buttonId)+'">'
      + settingsText(r) + value + '<span class="set-chev" aria-hidden="true">\\u203a</span></button>';
  }

  function settingsChoice(r, opts, i){
    var short = opts.length > 0 && opts.length <= 5;
    for(var k=0;k<opts.length;k++) if(String(opts[k].label).length > 6) short = false;
    var h = '', any = false;
    if(short){
      for(var j=0;j<opts.length;j++){
        var o = opts[j];
        h += '<button type="button" role="radio" aria-checked="'+(o.current ? 'true' : 'false')+'" data-fk="r'+i+'o'+j+'" data-btn="'+text(o.buttonId)+'"'
          + (o.detail ? ' title="'+text(o.detail)+'"' : '')+'>'+text(o.label)+'</button>';
      }
      return '<div class="set-seg" role="radiogroup" aria-label="'+text(r.label)+'">'+h+'</div>';
    }
    for(var n=0;n<opts.length;n++){
      var p = opts[n];
      if(p.current) any = true;
      // The value alone: a closed select shows its option's whole text, and a value with its
      // explanation was cut mid-sentence at 390px. The row's hint says what the values mean.
      h += '<option value="'+text(p.buttonId)+'"'+(p.current ? ' selected' : '')+(p.detail ? ' title="'+text(p.detail)+'"' : '')+'>'+text(p.label)+'</option>';
    }
    // A value none of the options names (a window typed by hand, 90m) is still shown as what it is.
    if(!any) h = '<option value="" selected disabled>'+text(r.value == null ? '' : r.value)+'</option>' + h;
    return '<select class="set-select" data-fk="r'+i+'" aria-label="'+text(r.label)+'">'+h+'</select>';
  }

  function settingsValues(s){
    var h = '', hd = s.head, n = s.nav || {};
    if(n.back) h += '<button type="button" class="set-back" data-fk="back" data-btn="'+text(n.back)+'">\\u2039 All settings</button>';
    if(hd){
      h += '<div class="set-head"><h3><span>'+text(hd.label)+'</span>'
        + (hd.target ? '<span class="set-tgt">'+text(hd.target)+'</span>' : '')
        + (hd.targetKind ? '<span class="set-kind">'+text(hd.targetKind)+'</span>' : '') + '</h3>'
        + '<p class="set-now">Now: <span class="set-v'+(hd.unset ? ' unset' : '')+'">'+text(hd.value)+'</span></p>'
        + (hd.source ? '<p class="set-src">'+inl(hd.source)+'</p>' : '')
        + '<p class="set-desc">'+inl(hd.description)+'</p>'
        + (hd.effect ? '<p class="set-when">'+inl(hd.effect)+'</p>' : '') + '</div>';
    }
    if(settingsNote) h += settingsNotice({ tone: 'error', text: settingsNote });
    h += settingsNotice(s.notice);
    var opts = s.options || [];
    // One field for both: it filters a long list as it is typed into, and Use (or Enter) takes
    // what is typed as the value — a harness takes model names its list never offers.
    if(s.typed){
      h += '<div class="set-typed"><input type="text" class="set-type" data-fk="typed" data-btn="'+text(s.typed.buttonId)+'"'
        + ' placeholder="'+text(opts.length > 8 ? 'Filter, or type a model name' : s.typed.placeholder)+'" aria-label="'+text(s.typed.placeholder)+'"'
        + ' autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">'
        + '<button type="button" class="set-use" data-fk="use">Use</button></div>';
    }
    if(s.loading || (hd && hd.hint)) h += '<div class="set-hintbox'+(s.loading ? ' loading' : '')+'">'+(s.loading ? '<span class="set-spin" aria-hidden="true"></span>' : '')+inl(hd && hd.hint ? hd.hint : 'Loading\u2026')+'</div>';
    if(opts.length){
      h += '<div class="set-card set-list">';
      for(var i=0;i<opts.length;i++) h += settingsOption(opts[i], i);
      h += '</div><p class="set-nomatch" hidden>No model in the list matches. Use takes the name as typed.</p>';
    }
    if(n.pageCount > 1){
      h += '<div class="set-nav">'
        + (n.prev ? '<button type="button" data-fk="prev" data-btn="'+text(n.prev)+'">\\u2039 Prev</button>' : '')
        + '<span class="set-page">'+text(n.page)+' / '+text(n.pageCount)+'</span>'
        + (n.next ? '<button type="button" data-fk="next" data-btn="'+text(n.next)+'">Next \\u203a</button>' : '')
        + '</div>';
    }
    return h;
  }

  function settingsOption(o, i){
    return '<button type="button" class="set-opt'+(o.current ? ' on' : '')+'" data-fk="o'+i+'" data-btn="'+text(o.buttonId)+'"'
      + (o.current ? ' aria-current="true"' : '')+' data-q="'+text(String(o.label+' '+(o.detail || '')).toLowerCase())+'">'
      + '<span class="set-check" aria-hidden="true">'+(o.current ? '\\u2713' : '')+'</span>'
      + '<span class="set-opt-main"><span class="set-opt-label">'+text(o.label)+'</span>'
      + (o.detail ? '<span class="set-opt-detail">'+text(o.detail)+'</span>' : '')
      + '</span></button>';
  }

  // ── The settings page ────────────────────────────────────────────────────────
  /**
   * /setting as a page of its own, not a message in the transcript.
   *
   * The daemon already answers /setting with one message carrying the structured screen
   * (SettingsScreen) and the button ids that write config.yaml. That is still the only source of
   * the rows, the values and the writes — this page never parses a label or builds a value. It
   * only moves the drawing out of the transcript and into a window: the message is taken out of
   * the log before it is painted, and its updates (the daemon edits the same message when a row is
   * tapped) are painted into this page instead. Closing the page is remembered per message id, so
   * a late edit does not reopen what the operator put away.
   *
   * It is bound to the topic it was opened in, though what it sets is not that topic's: every row
   * is config.yaml, for every conversation. The binding is mechanical — the buttons carry that
   * conversation's message id, and "this topic" marks the agent answering it — so switching topics
   * closes the page rather than leaving it pointing at the old one.
   */
  function settingsKey(m){ return (m._g || m.g || epoch) + ':' + m.id; }

  function settingsTopicName(id){
    for(var i=0;i<topics.length;i++) if(topics[i].id===id) return topics[i].title || 'Untitled';
    return 'Untitled';
  }

  // Where these settings live, which is the same for every topic. The bar used to name the topic
  // the page was opened in, and that read as "these are this topic's settings" — they never were.
  function paintSettingsTopic(){
    settingsTopicEl.textContent = 'Saved to config.yaml \u00b7 every topic';
    settingsTopicEl.title = 'Opened from the topic \u201c' + settingsTopicName(settingsTopic) + '\u201d';
  }

  /**
   * Draw the page from the message it holds. Focus goes back to the control that had it — the
   * daemon's answer to a switch replaces the markup, and a keyboard user would otherwise be sent
   * back to the top of the page after every toggle. A move between the list and a value screen
   * starts at the top instead.
   */
  function renderSettings(){
    if(!settingsMsg) return;
    var a = document.activeElement, fk = a && settingsBody.contains(a) ? a.getAttribute('data-fk') : null;
    var level = settingsMsg.settings ? settingsMsg.settings.level : '';
    var typed = settingsBody.querySelector('.set-type');
    if(typed) settingsQuery = typed.value;
    settingsBody.innerHTML = settingsScreen(settingsMsg);
    if(level !== settingsLevel){ settingsBody.scrollTop = 0; fk = null; settingsQuery = ''; }
    settingsLevel = level;
    // What was typed survives the redraw — the list arriving after "asking" is one — and so does
    // the filter it applies.
    var field = settingsBody.querySelector('.set-type');
    if(field && settingsQuery){ field.value = settingsQuery; filterSettings(); }
    // A notice that is good news fades once it has been seen; an error stays until the next screen.
    clearTimeout(settingsFade);
    var note = settingsBody.querySelector('.set-notice.ok, .set-notice.info');
    if(note) settingsFade = setTimeout(function(){ note.classList.add('faded'); }, SETTINGS_FADE_MS);
    if(fk){
      var back = settingsBody.querySelector('[data-fk="'+fk+'"]');
      if(back && back.focus) back.focus();
    }
  }

  /**
   * A live settings screen arrived: draw it, or update the page already drawing it.
   *
   * An edit of a page the operator closed is dropped; a new message is a new page. That is the
   * whole rule, and it is why the id is remembered rather than a boolean. An answer that belongs
   * to a request the operator closed while it was still Loading is dropped too — the request is
   * identified by its token, and the answers come back in the order they were asked for.
   */
  function takeSettings(m){
    m._g = m.g || epoch;
    var k = settingsKey(m);
    // An edit of the screen already on the page: update it in place, and do not consume a
    // pending request — this answer belongs to the message, not to a new question.
    if(!settingsPage.hidden && settingsMsg && settingsMsg.id === m.id){
      settingsMsg = m;
      settingsNote = null;
      renderSettings();
      return;
    }
    var wasHidden = settingsPage.hidden;
    if(wasHidden && settingsClosed[k]) return;
    if(!topic) return;
    var token = 0;
    for(var i=0;i<settingsPending.length;i++){
      if(settingsPending[i].t !== topic) continue;
      token = settingsPending[i].n;
      settingsPending.splice(i, 1);
      break;
    }
    if(wasHidden && token && token <= settingsClosedUpTo) return;
    settingsMsg = m;
    settingsNote = null;
    settingsLevel = '';
    settingsTopic = topic;
    paintSettingsTopic();
    renderSettings();
    settingsPage.hidden = false;
    settingsBody.scrollTop = 0;
    disarmSettingsWait();
  }

  /** The page, before the daemon has answered: it says which topic it is about at once. */
  function openSettingsLoading(){
    if(!topic) return 0;
    settingsMsg = null;
    settingsTopic = topic;
    settingsBody.innerHTML = '<div class="set-loading">Loading settings…</div>';
    paintSettingsTopic();
    settingsPage.hidden = false;
    settingsBody.scrollTop = 0;
    var token = ++settingsReq;
    settingsPending.push({ t: topic, n: token });
    armSettingsWait();
    return token;
  }

  /** Stop waiting for an answer: the page is open, closed, or the request failed. */
  function disarmSettingsWait(){
    if(settingsTimer){ clearTimeout(settingsTimer); settingsTimer = 0; }
  }

  /**
   * Say so rather than sitting on Loading for ever: the daemon may have dropped the request, or
   * answered with something that is not a screen at all. The page stays up, so the operator can
   * close it and try again.
   */
  function armSettingsWait(){
    disarmSettingsWait();
    settingsTimer = setTimeout(function(){
      settingsTimer = 0;
      if(settingsPage.hidden || settingsMsg) return;
      settingsSay('The daemon did not answer. Close this and try again.');
    }, SETTINGS_WAIT_MS);
  }

  /** The answer to a request that failed on the way out will never arrive; let its token go. */
  function forgetSettingsRequest(token){
    for(var i=0;i<settingsPending.length;i++){
      if(settingsPending[i].n !== token) continue;
      settingsPending.splice(i, 1);
      return;
    }
  }

  function settingsSay(s){
    settingsBody.innerHTML = '<div class="set-loading">'+text(s)+'</div>';
  }

  function closeSettings(){
    if(settingsPage.hidden) return;
    if(settingsMsg) settingsClosed[settingsKey(settingsMsg)] = 1;
    // Every request issued so far is cancelled, including one still in flight while Loading —
    // otherwise its answer would reopen the page the operator just put away.
    if(settingsReq) settingsClosedUpTo = Math.max(settingsClosedUpTo, settingsReq);
    disarmSettingsWait();
    settingsPage.hidden = true;
    settingsMsg = null;
    settingsNote = null;
    settingsTopic = null;
    settingsBody.textContent = '';
  }

  /**
   * A control on the settings page was used. Posted like any menu button, with the page's own
   * message and topic. A switch or a segment shows its new state at once — the round trip is the
   * daemon writing config.yaml, and a control that sits unmoved for it reads as broken — and the
   * daemon's answer redraws the page from what was actually written. When the answer cannot come
   * (the request failed, or the message is gone), the page is redrawn from what it last had, which
   * puts the control back, with a line saying why.
   */
  /** Show only the values whose name or meaning holds what is typed, and say so when none does. */
  function filterSettings(){
    var field = settingsBody.querySelector('.set-type');
    var q = field ? field.value.trim().toLowerCase() : '';
    var opts = settingsBody.querySelectorAll('.set-list .set-opt'), shown = 0;
    for(var i=0;i<opts.length;i++){
      var hit = !q || (opts[i].getAttribute('data-q') || '').indexOf(q) >= 0;
      opts[i].hidden = !hit;
      if(hit) shown++;
    }
    var none = settingsBody.querySelector('.set-nomatch');
    if(none) none.hidden = !(q && opts.length && !shown);
  }

  /** Use what is typed: the click carries it as its value (ButtonInteraction.value). */
  function useTyped(){
    var field = settingsBody.querySelector('.set-type');
    if(!field) return;
    var v = field.value.trim();
    if(!v){ field.focus(); return; }
    postSetting(field, field.getAttribute('data-btn'), v);
  }

  function postSetting(el, id, value){
    if(!settingsMsg || !settingsTopic || !id) return;
    var msgId = settingsMsg.id;
    if(el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    if(el.getAttribute('role') === 'radio'){
      var peers = el.parentNode ? el.parentNode.children : [];
      for(var i=0;i<peers.length;i++) peers[i].setAttribute('aria-checked', peers[i] === el ? 'true' : 'false');
    }
    el.disabled = true;
    el.classList.add('busy');
    var fail = function(why){
      if(!settingsMsg || settingsMsg.id !== msgId) return;
      settingsNote = why;
      renderSettings();
    };
    // A limit, unlike a transcript menu's tap: a request that goes quiet would leave the control
    // half-moved for ever, with nothing on the page to say the change never happened.
    var body = {topic:settingsTopic,messageId:msgId,buttonId:id};
    if(value) body.value = value;
    post('api/click',body,2,SETTINGS_WAIT_MS)
      .then(function(r){
        if(r.ok) return;
        fail(r.status === 409 || r.status === 404
          ? 'This settings page is out of date, so nothing was changed. Close it and open Settings again.'
          : 'The daemon did not take that (HTTP '+r.status+'), so nothing was changed. Try again.');
      }, function(){ fail('Could not reach the daemon, so nothing was changed. Check the connection and try again.'); });
  }

  /**
   * Send a command the operator did not type — the Menu asking the daemon for its own
   * settings screen. quiet tells the room not to write it into the conversation: a page opening
   * must not leave a /setting bubble in the transcript, and nothing on the daemon's side needs
   * the echo (the answer is a new message of its own).
   */
  function quietCommand(cmd, t){
    var nonce = Math.random().toString(36).slice(2)+Date.now().toString(36);
    return post('api/send', {topic:t, text:cmd, nonce:nonce, quiet:true}, 2)
      .then(function(r){ return r.ok; }, function(){ return false; });
  }

  /**
   * A button in a menu or in the settings page. Disabled and lit as well as disabled: the answer
   * is a round trip away, and a button that only greys out reads as "nothing happened" for
   * exactly that long. A refusal (409: that message is gone) leaves it disabled, but no longer
   * lit — nothing is coming.
   */
  function postButton(b, t){
    b.disabled = true;
    b.classList.add('busy');
    post('api/click',{topic:t,messageId:b.getAttribute('data-msg'),buttonId:b.getAttribute('data-btn')},2)
      .then(function(r){ if(!r.ok) b.classList.remove('busy'); })
      .catch(function(){ b.disabled=false; b.classList.remove('busy'); });
  }

  /**
   * A label's width in ch, near enough to size a column by: a CJK character is about two, and an
   * agent asking in Chinese offers its choices in Chinese. Erring wide is the cheap direction — a
   * column a little too roomy, against a label that wraps when it did not have to.
   */
  function labelWidth(s){
    var n = 0;
    for(var i=0;i<s.length;i++) n += s.charCodeAt(i) >= 0x2e80 ? 2 : 1;
    return n;
  }

  /**
   * Which lines of each tool bubble the reader has opened, by message key: {all, lines: {i: open}}.
   * A line with no entry of its own follows all, which is how "Show all" also opens the lines the
   * agent adds after it was pressed.
   *
   * Kept here rather than as a class on the elements, because a tool bubble is edited every time
   * a tool starts or finishes and every edit rewrites its markup — a line opened on the old
   * element would snap shut under the reader at the next ✓. In memory only: which line someone is
   * reading is a reading position, not part of the conversation, and the cache does not keep it.
   * Like a scroll position, though, it is not reset on the way out of a topic (opened is declared
   * beside sig, and only drop() forgets an entry): coming back finds the same lines open.
   */
  function lineOpen(st, i){
    if(!st) return false;
    return st.lines[i] !== undefined ? st.lines[i] : st.all;
  }

  /**
   * A tool bubble's markup with each line's index stamped on it and the opened ones marked.
   *
   * A string rewrite, not a DOM walk, so the result can be compared with what is on screen before
   * anything is written (see sig in paint). The pattern is exact because the markup is:
   * renderWebToolLines writes this tag and nothing else, and escapes every < inside a line.
   */
  function foldLines(key, html){
    var st = opened[key], i = 0;
    return html.replace(/<div class="tl">/g, function(){
      var n = i++;
      return '<div class="tl'+(lineOpen(st, n) ? ' open' : '')+'" data-i="'+n+'">';
    });
  }

  function allToggle(key){
    var st = opened[key];
    return '<button type="button" class="tl-all" data-tl-all="'+text(key)+'">'
      + (st && st.all ? 'Collapse' : 'Show all') + '</button>';
  }

  /** Open every line of a tool bubble, or fold them all back. Either way, per-line choices go. */
  function toggleAll(key){
    if(!data[key]) return;
    var st = opened[key];
    opened[key] = { all: !(st && st.all), lines: {} };
    paint(key);
  }

  /**
   * Open or fold one line. Not when the click ended a drag-select: copying part of a command is
   * the other thing a reader does with these lines, and repainting the bubble under the selection
   * would throw it away and fold the line they were copying from.
   */
  function toggleLine(line){
    var sel = window.getSelection ? window.getSelection() : null;
    if(sel && String(sel)) return;
    var host = line.closest('[data-k]');
    var key = host ? host.getAttribute('data-k') : null;
    if(!key || !data[key]) return;
    var i = line.getAttribute('data-i');
    var st = opened[key] || (opened[key] = { all: false, lines: {} });
    st.lines[i] = !lineOpen(st, i);
    paint(key);
  }

  /**
   * What a message that never reached the daemon offers instead of silence.
   *
   * Retry is there whenever this page can rebuild exactly what was sent: always for a message
   * typed in this tab, and after a reload for one that was text alone. A message that carried
   * files offers Copy and Discard alone once the page has been reloaded — the files were base64 in
   * a request body and deliberately never written down, and re-sending the text without the files
   * it was written about would be a different message.
   *
   * 'unsure' is a message that was still on its way when the last page went away, so nothing here
   * saw how it ended. The first sync settles it: carrying its echo, it is claimed like any other;
   * not carrying it, from the same daemon, it never arrived. Until then — and for good, when the
   * daemon has restarted since and its ring cannot say — it says it does not know.
   */
  function stuck(m){ return Boolean(m._local) && (m._state === 'failed' || m._state === 'unsure'); }

  function failedActions(m){
    var why = m._state === 'unsure'
      ? 'Not confirmed — the page closed before the daemon answered, so this may not have arrived.'
      : 'Not delivered — the agent never saw this.';
    var h = '<div class="warn">'+why+'</div><div class="acts">';
    if(outbox[m._nonce]) h += '<button type="button" data-retry="'+text(m._nonce)+'">Retry</button>';
    return h + '<button type="button" data-copy="'+text(m._nonce)+'">Copy</button>'
      + '<button type="button" data-discard="'+text(m._nonce)+'">Discard</button></div>';
  }

  function upsert(m){
    m._g = m.g || epoch;
    // The settings screen lives in its own page; it is not a message here. See takeSettings.
    if(m.settings || m.wasSettings) return;
    var stick=atBottom();
    var key = keyOf(m);
    data[key]=m; paint(key); syncEmptyNote(); if(stick) toBottom();
  }

  function drop(key){
    if(els[key]) { els[key].remove(); delete els[key]; }
    delete data[key];
    delete sig[key];
    delete opened[key];
    syncEmptyNote();
  }

  /**
   * Bring the transcript to exactly the list given, reusing what is already on screen.
   *
   * The predecessor emptied #log and rebuilt every message from the sync. That is what made
   * entering a topic jarring: the scroll container was destroyed along with its scrollTop, then
   * refilled and snapped, so a topic whose messages were ALREADY painted from cache still flashed
   * through blank. Here an unchanged message is left untouched (paint writes nothing when the
   * markup matches), and appendChild MOVES a node that already exists rather than cloning it — so
   * ordering costs no re-creation either, and nothing re-runs the fade-in animation.
   *
   * Only messages of the CURRENT generation are the sync's to remove. Cached history belongs to
   * a daemon that is not on the other end of this stream, and a local message still waiting on
   * its POST was never the server's to know about; both would otherwise vanish the moment the
   * connection blipped.
   *
   * A local message whose echo the sync carries is claimed here, exactly as a msg event claims
   * one. Only msg events used to, so an echo that arrived in a full sync instead — a reconnect the
   * backlog no longer reached, a reload — left the local copy on screen beside it, and one restored
   * after a reload could never be told it had arrived.
   */
  function reconcile(list){
    clearSkeleton();
    // The sync this was waiting for. Cleared before anything is painted, so the messages it
    // carries are appended to a log whose last child is a message again.
    clearSyncing();
    var keep={};
    for(var i=0;i<list.length;i++){
      var m=list[i];
      // A message a topic kept on disk from an earlier run says which run (g): it is that
      // run's history, under the key this browser's cache already has it by.
      m._g = m.g || epoch;
      // A settings screen — live or retired — is drawn in its own page, never in the transcript.
      // The sync is where a reload would otherwise bring one back as a plain bubble.
      if(m.settings || m.wasSettings) continue;
      claim(m);
      var key=keyOf(m);
      keep[key]=1;
      data[key]=m;
      paint(key);
      log.appendChild(els[key]);
    }
    var gone=[];
    for(var k in els){
      if(keep[k]) continue;
      var held=data[k];
      if(!held || held._local || held._g !== epoch) continue;
      gone.push(k);
    }
    for(var j=0;j<gone.length;j++) drop(gone[j]);
    sinkLocals();
  }

  /**
   * Put every message still waiting on the daemon under the transcript, in the order it was sent.
   *
   * The loop above appends each message the sync carries, which MOVES it to the end — so anything
   * it does not carry ends up above all of them. For cached history that is the point. For a
   * local message it put a failure restored after a reload at the head of the topic, above every
   * message the reader lands below, which on a long topic is indistinguishable from having lost
   * it. A message nobody has acknowledged is the newest thing in the room and waits where the
   * composer is. Nothing moves when they are already there, so a sync with nothing pending, which
   * is nearly all of them, re-runs no entrance animation.
   */
  function sinkLocals(){
    var mine=[], tail=0, other=false;
    for(var n=log.lastChild; n; n=n.previousSibling){
      if(n === syncingEl) continue;
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      if(k && data[k] && data[k]._local){ mine.unshift(n); if(!other) tail++; }
      else other = true;
    }
    if(tail === mine.length) return;
    var at = (syncingEl && syncingEl.parentNode === log) ? syncingEl : null;
    for(var i=0;i<mine.length;i++) log.insertBefore(mine[i], at);
  }

  /**
   * Hold the shape of a transcript that has not arrived yet.
   *
   * Only ever shown into an EMPTY log: a topic painted from cache has real content to look at,
   * and stacking placeholders under it would claim messages are still coming when the next event
   * is going to replace what is there rather than extend it.
   */
  var SKELETON = '<div class="sk own"><i style="width:34%"></i></div>'
    + '<div class="sk"><i style="width:86%"></i><i style="width:73%"></i><i style="width:41%"></i></div>'
    + '<div class="sk own"><i style="width:52%"></i><i style="width:28%"></i></div>'
    + '<div class="sk"><i style="width:79%"></i><i style="width:62%"></i></div>';

  function showSkeleton(){
    if(log.firstChild) return;
    log.innerHTML = SKELETON;
    skeleton = true;
  }

  function clearSkeleton(){
    if(!skeleton) return;
    skeleton = false;
    log.innerHTML = '';
    // Emptying #log invalidates anything held by reference into it, and these are the only
    // things in there that are not messages.
    emptyEl = null;
    launchEl = null;
    launchSig = '';
    dividerEl = null;
    syncingEl = null;
  }

  /**
   * Say why an empty room is empty, when the server said this topic predates the daemon.
   *
   * A transcript is kept on the daemon's disk, but not by a daemon older than 2.13.0 for a topic that
   * was not starred, nor when its file could not be read — and those topics are rows that open onto
   * nothing. Rendered faithfully that is a blank panel, which is indistinguishable from a page that
   * failed to load — and is exactly how it was reported.
   */
  var EMPTY_NOTE = 'This topic is older than the running daemon, and its transcript was not kept, so'
    + ' anything said in it is no longer here. The agent still has its context, so you can carry on'
    + ' where you left off.';

  function hasMessages(){
    for(var k in els) if(els.hasOwnProperty(k)) return true;
    return false;
  }

  function syncEmptyNote(){
    var empty = !hasMessages();
    // The choice of agent first, and instead of the notice: while the choice is open no agent has a
    // session here, so "the agent still has its context" would not be true of this room.
    syncLaunch(Boolean(launch) && empty);
    var want = stale && empty && !launchEl;
    if(want === Boolean(emptyEl)) return;
    if(want){
      clearSkeleton();
      emptyEl = document.createElement('div');
      emptyEl.className = 'empty';
      emptyEl.textContent = EMPTY_NOTE;
      log.appendChild(emptyEl);
    } else {
      if(emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
      emptyEl = null;
    }
  }

  /**
   * A new topic: the agents it could be given to, laid out where its transcript is going to be.
   *
   * The daemon sends the choice on the sync of an empty room for as long as it is open — the agent
   * that would answer has no session here yet — and it is drawn while the room stays empty. A tap
   * sends /agent <id> the way typing it would (command), so the transcript records the choice and
   * the daemon follows it with where that agent should work; the bubble that send paints is a
   * message, and a message is what takes this away. Typing instead is an answer too, which is why
   * the agent it would reach is marked. A send that fails and is discarded empties the room again,
   * and the choice comes back with it.
   */
  function launchHtml(c){
    var h = '<div class="launch-head"><div class="launch-title">Choose an agent</div>'
      + '<div class="launch-sub">Or just type \u2014 <b>'+text(c.current)+'</b> answers by default.</div></div>';
    // One machine needs no heading: it would name the only answer to a question nobody asked.
    var many = c.groups.length > 1;
    for(var i=0;i<c.groups.length;i++){
      var g = c.groups[i];
      h += '<section class="launch-group">';
      if(many) h += '<h3 class="launch-host">'+text(g.name)+' <span class="n">'+g.agents.length+'</span></h3>';
      h += '<div class="launch-grid">';
      for(var j=0;j<g.agents.length;j++){
        var a = g.agents[j], on = a.id === c.current;
        h += '<button type="button" class="agent-card'+(on?' def':'')+'" data-agent="'+text(a.id)+'" title="/agent '+text(a.id)+'">'
          + '<span class="ac-top"><span class="ac-id">'+text(a.id)+'</span>'+(on?'<span class="ac-tag">default</span>':'')+'</span>'
          + '<span class="ac-kind"><i class="ac-dot h-'+text(a.harness)+'"></i><span>'+text(a.kind)+'</span></span>'
          + (a.model ? '<span class="ac-model" title="'+text(a.model)+'">'+text(a.model)+'</span>' : '')
          + '</button>';
      }
      h += '</div></section>';
    }
    return h;
  }

  /** Show the choice, or take it away; redrawn only when what it was drawn from changed. */
  function syncLaunch(want){
    var s = want ? JSON.stringify(launch) : '';
    if(s === launchSig && want === Boolean(launchEl)) return;
    if(launchEl && launchEl.parentNode) launchEl.parentNode.removeChild(launchEl);
    launchEl = null;
    launchSig = '';
    if(want){
      clearSkeleton();
      launchEl = document.createElement('div');
      launchEl.className = 'launch';
      launchEl.innerHTML = launchHtml(launch);
      log.appendChild(launchEl);
      launchSig = s;
    }
    // The model switch waits on the launcher (paintStatus), so it follows it at once: up the moment
    // an agent is chosen, gone again if a failed send empties the room and the choice comes back.
    paintStatus();
  }

  /**
   * The line between what was said before the daemon restarted and what it is serving now.
   *
   * A restart does not take the conversation, which the agent still has, and it no longer takes
   * what was on screen either. The messages above this line came back out of the daemon's own copy
   * on disk, or out of this browser's cache: they are real, they are just no longer anything the
   * process can be asked about, which is why nothing up there has a button on it.
   */
  var DIVIDER_NOTE = 'Everything above is from before the daemon restarted.'
    + ' The agent still has its context, so you can carry on below.';
  var dividerEl=null;

  /** Keep the divider immediately after the last cached message, or gone when there are none. */
  function placeDivider(){
    var last=null;
    for(var n=log.firstChild; n; n=n.nextSibling){
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      if(k && isHistory(data[k])) last=n;
    }
    if(!last){
      if(dividerEl && dividerEl.parentNode) dividerEl.parentNode.removeChild(dividerEl);
      dividerEl=null;
      return;
    }
    if(!dividerEl){
      dividerEl=document.createElement('div');
      dividerEl.className='divider';
      dividerEl.textContent=DIVIDER_NOTE;
    }
    if(last.nextSibling !== dividerEl) log.insertBefore(dividerEl, last.nextSibling);
  }

  /**
   * That a transcript painted out of the local cache is not the whole story yet.
   *
   * Entering a topic with the cache warm is instantaneous — and then, a second or two later,
   * everything said in it while you were elsewhere appears in one frame, with nothing in between
   * having suggested more was coming. The skeleton cannot answer that: it only ever goes into an
   * EMPTY log, and this log is full. So the wait is marked where the missing messages are going
   * to land, at the bottom, and it says what it is waiting FOR rather than impersonating one of
   * them — most syncs add nothing and the line just goes away again.
   */
  var SYNC_NOTE = 'Checking for anything said while you were away';
  var syncingEl=null;

  function showSyncing(){
    // Not over an empty log: the skeleton is already standing in for the whole transcript there,
    // and two answers to one wait is one too many.
    if(syncingEl || synced || skeleton || !log.firstChild) return;
    syncingEl=document.createElement('div');
    syncingEl.className='syncing';
    syncingEl.innerHTML='<span class="dots"><i></i><i></i><i></i></span><span>'+SYNC_NOTE+'</span>';
    log.appendChild(syncingEl);
  }

  function clearSyncing(){
    if(syncingEl && syncingEl.parentNode) syncingEl.parentNode.removeChild(syncingEl);
    syncingEl=null;
  }

  /**
   * Re-draw whatever the cache handed us once a sync has said which generation is live.
   *
   * Before the first sync a cached message is painted as an ordinary message, because there is
   * nothing yet to say it is not one. The sync answers that: if the daemon has been restarted
   * since, every one of them is history, which changes how it is drawn (no buttons) and puts a
   * line under the lot. paint writes nothing for the messages whose markup did not change, so on
   * the ordinary path — same daemon, cache matching the ring — this costs one loop and no DOM.
   */
  function repaintHistory(){
    for(var k in els){ if(isHistory(data[k])) paint(k); }
    placeDivider();
  }

  // Guards a cache read that comes back after the reader has moved on, and keeps one topic from
  // being read twice (the page asks on the way in, and again when a sync names a topic it was
  // never told about).
  var restoreToken = 0, restoreFor = null;

  function restore(tId){
    if(!tId || restoreFor === tId) return;
    restoreFor = tId;
    var mine = ++restoreToken;
    cacheRead(tId).then(function(list){
      if(list && mine === restoreToken && tId === topic) adopt(list);
    });
  }

  /**
   * Put cached messages on screen around whatever is already there.
   *
   * Both orders happen and both are normal. Usually the cache wins the race against the first
   * sync, and is then simply the transcript, painted early — its keys are the ones the sync is
   * about to produce, so the sync reuses the nodes and writes nothing. When the sync gets there
   * first the only cached messages still worth showing are the ones the daemon does NOT have,
   * and those belong above what it sent.
   */
  function adopt(list){
    clearSkeleton();
    // On the way into a topic this is usually the first real paint, so it is where the reader is
    // put back (land, below). Otherwise the sync got here first and only someone already at the
    // bottom is kept there.
    var stick = !entering && atBottom();
    // Captured once: every history node goes in front of the same first live message, which is
    // what keeps them in the order they were said rather than reversing them.
    var anchor = synced ? log.firstChild : null;
    var moved = false;
    for(var i=0;i<list.length;i++){
      var m=list[i];
      if(!m || !m.id) continue;
      if(m._local){ moved = adoptLegacy(m) || moved; continue; }
      // Never a transcript row, and not something a cached copy should bring back either.
      if(m.settings || m.wasSettings) continue;
      var key = keyOf(m);
      if(data[key] || els[key]) continue;
      if(synced && !isHistory(m)) continue;
      data[key]=m;
      paint(key, synced ? anchor : null);
    }
    // Painted only now, and the cache rewritten without them: from here on unsent is their home.
    if(moved){ showUnsent(topic); cacheSave(); }
    // Before the waiting line goes in. Before the first sync the cache is appended under whatever is
    // already on screen, and that includes the messages restored from unsent, which belong under
    // all of it.
    sinkLocals();
    placeDivider();
    syncEmptyNote();
    // Last, so it is last in the log: what the sync may still add goes under what the cache had.
    showSyncing();
    if(entering) land(); else if(stick) toBottom();
  }

  /**
   * The rows in the order they are painted: what needs a decision first (needsYou, most pressing
   * first), then every root by state — working, resident and idle, no agent — with a starred row
   * ahead of its unstarred peers inside a state and the daemon's order (most recently active
   * first) underneath. Every topic is followed by the ones its agent opened (Topic.parent),
   * depth-first — unless it is folded. Only the painting is reordered: topics itself keeps the
   * daemon's order, because topics[0] is read elsewhere as "the most recent topic" — where to land
   * when the one on screen goes away.
   *
   * The topic on screen is never folded away: its ancestors are drawn open, without that being
   * saved, so a link into a sub-agent's topic lands on a row you can see. A parent field that loops
   * (only a hand-edited file could) leaves its topics unreachable from any root; they are drawn as
   * roots rather than not at all.
   */
  function topicRows(){
    // Scheduled runs are conversations, but not ones the person opened: the panel's Sessions tab
    // is where they live. Filtering here, rather than at paint time, also keeps their unread
    // badges and "needs you" rows out of the switcher — the same rooms must not appear twice.
    var visible=[];
    for(var v=0;v<topics.length;v++) if(!topics[v].scheduled) visible.push(topics[v]);
    var byId={}, kids={}, roots=[], i;
    for(i=0;i<visible.length;i++) byId[visible[i].id]=visible[i];
    for(i=0;i<visible.length;i++){
      var p=visible[i].parent;
      if(p && p!==visible[i].id && byId[p]) (kids[p]=kids[p]||[]).push(visible[i]); else roots.push(visible[i]);
    }
    var open={}, up=byId[topic], hops=0;
    while(up && up.parent && byId[up.parent] && hops++<32){ open[up.parent]=true; up=byId[up.parent]; }
    var rows=[], seen={}, dividers={};
    function state(t, depth){
      var ch=kids[t.id]||[], s='';
      for(var k=0;k<ch.length && depth<32;k++){
        var c=ch[k];
        var mine=c.asking?'asking':(c.stage==='failed'?'failed':(c.running?'running':''));
        var deeper=state(c, depth+1);
        var pick=[mine, deeper, s];
        s=pick.indexOf('asking')>=0?'asking':(pick.indexOf('failed')>=0?'failed':(pick.indexOf('running')>=0?'running':''));
      }
      return s;
    }
    function walk(t, depth){
      if(seen[t.id]) return;
      seen[t.id]=true;
      var ch=kids[t.id]||[];
      var shut=ch.length>0 && folded[t.id]!==false && !open[t.id];
      rows.push({t:t, depth:depth, kids:ch.length, shut:shut, under:shut?state(t, 0):''});
      if(shut) return;
      for(var k=0;k<ch.length;k++) walk(ch[k], depth+1);
    }
    // What needs the person first (needsYou), most pressing first, each with the topics it opened.
    var pinned=visible.filter(needsYou).sort(function(a,b){ return NEEDS_ORDER[a.stage]-NEEDS_ORDER[b.stage] || (b.lastAt||0)-(a.lastAt||0); });
    for(i=0;i<pinned.length;i++) walk(pinned[i], 0);
    var afterPinned=rows.length;
    // Then everything else in the order the list is read: working, a resident agent with nothing
    // to do, and no agent at all (the decision group is already drawn above). The daemon's order —
    // most recently active first — holds inside a state, and a starred row leads its unstarred
    // peers there: a star is a promise not to forget a topic, not a claim on the top of the column.
    var ordered=roots.slice().sort(function(a,b){
      var ra=stateRank(a), rb=stateRank(b), d=ra-rb;
      if(d) return d;
      if(ra===0) d=NEEDS_ORDER[a.stage]-NEEDS_ORDER[b.stage];
      return d || (b.starred?1:0)-(a.starred?1:0);
    });
    for(i=0;i<ordered.length;i++) walk(ordered[i], 0);
    for(i=0;i<visible.length;i++){
      // Hidden under a folded parent is seen-by-design; only a loop leaves one unseen.
      var hidden=false, a=visible[i], n=0;
      while(a && a.parent && byId[a.parent] && n++<32){ if(seen[a.parent] && folded[a.parent]!==false && !open[a.parent]){ hidden=true; break; } a=byId[a.parent]; }
      if(!seen[visible[i].id] && !hidden) walk(visible[i], 0);
    }
    if(afterPinned && afterPinned<rows.length) dividers[afterPinned]=true;
    var stars=0;
    for(i=0;i<roots.length;i++) if(roots[i].starred) stars++;
    return {rows:rows, dividers:dividers, stars:stars};
  }

  /** Whether a topic this one opened, or one of theirs, is working or asking. */
  function busyBelow(id){
    var stack=[id], seenB={}, n=0;
    while(stack.length && n++<256){
      var p=stack.pop();
      if(seenB[p]) continue;
      seenB[p]=true;
      for(var i=0;i<topics.length;i++){
        var t=topics[i];
        if(t.parent!==p) continue;
        if(t.running || t.asking) return true;
        stack.push(t.id);
      }
    }
    return false;
  }

  /**
   * Whether a row is drawn as working: its own turn, or a sub-agent's.
   *
   * A /super dispatcher hands its work to topics of its own and then sits idle between turns, so
   * drawn from its own flag alone it was the one row that looked dead while the agents under it
   * worked (reported 2026-11-04). busyBelow counts a question too — a sub-agent holding one has
   * not finished either, and the fold pill is what says which of the two it is.
   */
  function rowRunning(t){
    return Boolean(t.running) || busyBelow(t.id);
  }

  var NEEDS_ORDER = {answer:0, failed:1, review:2};
  var NEEDS_WHAT = {answer:'Waiting on your answer', failed:'Failed', review:'Finished'};
  /**
   * What needs the person: every topic but the one on screen whose stage is a question, a failure,
   * or a reply not yet read — the daemon decides the stage (core/topic-stage.ts) and sends it with
   * the list. Drawn as the topic's own row, first in the list and green (paintTopics). It was a
   * separate "Needs you" block above the list through 2.19.1, which put every such topic on screen
   * twice — the same title, two rows — and read as two conversations.
   *
   * A sub-agent's topic (one with a parent) counts only for a question of its own: its replies and
   * failures go to the agent that opened it, which says what comes of them (room.ts operatorStage,
   * the same rule for notifications).
   */
  function needsYou(t){
    if(t.id===topic || NEEDS_ORDER[t.stage]===undefined) return false;
    return !t.parent || t.stage==='answer';
  }

  /**
   * The four states the list is ordered by, most pressing first: a decision to make, work under
   * way, a resident agent with nothing to do, and no agent at all. stage already says the first,
   * rowRunning the second (a /super dispatcher is working while its sub-agents are), and live
   * splits the last two — the same facts the dot and the row's colours are drawn from, so the order
   * cannot disagree with what the rows say.
   */
  function stateRank(t){
    if(needsYou(t)) return 0;
    if(rowRunning(t)) return 1;
    return t.live ? 2 : 3;
  }

  /**
   * Split a topic's "[agent] subject" name into its tag and its subject, shortening the tag to the
   * agent id alone when the row's second line already names the same machine.
   *
   * The tag is the agent id, and for an agent on a host that id is "cbc@uniagent" — 15 characters
   * of a 240px column spent naming a machine the directory line repeats one line down, which left
   * a whole row reading "[cbc@uniagent] Oracle A…" (reported 2026-11-03). What the operator types
   * to bind an agent is the part before the @, so that is what the row keeps, and the name it was
   * cut from goes on the tag's tooltip. A tag whose host the second line does not name — no
   * directory known yet, or a group standing in for the host — is left whole: dropping the host
   * there would take the only place on the row that says which machine the agent is on.
   *
   * Only ever reads a leading bracketed group, which formatLaneTitle guarantees: an untagged
   * name (a topic seeded from its first message before any turn) has no tag and is shown as it is.
   * full is set only when the tag was shortened, so an untouched row gets no tooltip to explain
   * an abbreviation it does not have — and the row's own tooltip (what a needs-you row says) is
   * left to the rest of the row rather than covered by this one.
   */
  function splitTitle(title, host){
    var m=/^\\[([^\\]]+)\\]\\s*([\\s\\S]*)$/.exec(title);
    if(!m) return {tag:'', rest:title};
    var tag=m[1], rest=m[2], at=tag.indexOf('@');
    if(at>0 && host && tag.slice(at+1)===host) return {tag:'['+tag.slice(0, at)+']', rest:rest, full:title};
    return {tag:'['+tag+']', rest:rest};
  }

  function paintTopics(){
    var h='';
    var cur=null;
    var painted=topicRows();
    // The topic on screen may be a scheduled run, which topicRows leaves out of the list. The
    // header, Stop/power and the read marks still belong to it, so find it in the full list —
    // and seed a mark for every topic, hidden ones included, or the Sessions tab would count a
    // run's whole history as unread the first time it was opened.
    for(var i=0;i<topics.length;i++){
      var seed=topics[i];
      if(readCounts[seed.id]===undefined){ readCounts[seed.id]=seed.msgCount||0; saveReads(); }
      if(seed.id===topic){ cur=seed; readCounts[seed.id]=seed.msgCount||0; saveReads(); }
    }
    var stars=painted.stars;
    for(i=0;i<painted.rows.length;i++){
      var row=painted.rows[i];
      var t=row.t;
      var isCur=(t.id===topic);
      var isRunning=rowRunning(t);
      // A question on screen holds its turn open, so t.running is true at the same time. Asked
      // first everywhere below: "waiting for you" is the state you can act on, and the one the
      // running blue would otherwise hide.
      var isAsking=Boolean(t.asking);
      var isLive=Boolean(t.live);
      var count=t.msgCount||0;
      var unread=isCur?0:Math.max(0, count - readCounts[t.id]);
      var cls='topic-item '+(isCur?'on ':'')+(isRunning?'running':'idle')+(isLive?' live':'')
        +(t.starred?' starred':'')+(painted.dividers[i]?' after-needs':'')
        +(row.depth?' sub d'+Math.min(row.depth,3):'')
        +(needsYou(t)?' needs':'');
      var isFailed=t.stage==='failed';
      // A sub-agent's finished turn is news for the agent that opened it, not for the person
      // (needsYou says the same): its row keeps the ordinary idle/online grey instead of the
      // green "unread reply" dot, and the parent turns green when the report is waiting to be
      // read. Work and a question are still its own — blue and amber — because both are states a
      // person acts on, or watches, in that topic.
      var dotCls='topic-dot'+(isAsking?' asking':(isRunning?' running':(isFailed?' failed':(t.stage==='review'&&!t.parent?' review':(isLive?' live':'')))));
      // What the Needs-you block used to say on a second line, now on hover: the row keeps its shape.
      var says=needsYou(t)?' title="'+text(NEEDS_WHAT[t.stage]+(t.line?': '+t.line:''))+'"':'';
      var badge=unread>0?'<span class="topic-badge">'+(unread>99?'99+':unread)+'</span>':'';
      // Not "a shell is alive over there" — the daemon only sees the connection, so this says a
      // page has that topic's terminal open (shown or minimized). See terminal-sessions.ts.
      var term=t.term?'<span class="topic-term" title="A terminal is attached to this topic">&gt;_</span>':'';
      // The full path on the title attribute rather than in the row: two checkouts of one
      // project have the same last segment, and the column is 240px wide. The machine goes
      // first: it is the short word, and the one that tells apart two agents of one harness on two
      // hosts — whose directories usually share a name too — so it is what the ellipsis spares.
      var where=t.dir&&t.dir.host?t.dir.host+' · ':'';
      var dir=t.dir?'<span class="topic-dir" title="'+text((t.dir.host?t.dir.host+':':'')+t.dir.path)+'">'+text(where+t.dir.name)+'</span>':'';
      var named=splitTitle(t.title || 'Untitled', t.dir&&t.dir.host);
      var title='<span class="topic-title">'
         + (named.tag?'<span class="topic-tag"'+(named.full?' title="'+text(named.full)+'"':'')+'>'+text(named.tag)+'</span> ':'')
         + text(named.rest)+'</span>';
      // aria-pressed rather than two different buttons: it is one control with a state, and the
      // state is what a screen reader should announce.
      var star='<button type="button" class="btn-icon topic-star'+(t.starred?' on':'')+'" data-star="'+text(t.id)+'"'
         + ' aria-pressed="'+(t.starred?'true':'false')+'"'
         + ' title="'+(t.starred?'Unstar':'Star: never removed to make room, and kept by Clear')+'">'
         + (t.starred?'★':'☆')+'</button>';
      // Its own button, like the star: folding a parent is not a reason to switch to it.
      var fold=row.kids?'<button type="button" class="topic-fold'+(row.shut?' folded':'')+(row.under?' '+row.under:'')+'"'
         + ' data-fold="'+text(t.id)+'" aria-expanded="'+(row.shut?'false':'true')+'"'
         + ' title="'+(row.shut?'Show':'Hide')+' the '+row.kids+' topic'+(row.kids>1?'s':'')+' its agent opened">'
         + (row.shut?'▸':'▾')+' '+row.kids+'</button>':'';
      h += '<div class="'+cls+'" data-topic="'+text(t.id)+'" role="button" tabindex="0"'+says+'>'
         + '<span class="'+dotCls+'"></span>'
         + '<span class="topic-main">'
         + title
         + (fold ? '<span class="topic-line">'+fold+dir+'</span>' : dir)
         + '</span>'
         + term
         + badge
         + '<span class="topic-acts">'
         + star
         + '<button type="button" class="btn-icon topic-del" data-del="'+text(t.id)+'" title="Delete topic">×</button>'
         + '</span>'
         + '</div>';
    }
    bar.innerHTML=h;
    // Says what it will do: with stars in the list it no longer clears all of them.
    var clearLabel = stars ? 'Clear unstarred topics' : 'Clear all topics';
    clearBtn.title = clearLabel;
    clearBtn.setAttribute('aria-label', clearLabel);
    // The count sits on Manage's face, so it is read without opening the menu; the item inside
    // says what closing would do, and is absent when there is nothing to close.
    var idle=idleTopics().length;
    idleBtn.hidden = !idle;
    noIdleBtn.hidden = Boolean(idle);
    idleBtn.textContent = 'Close idle ('+idle+')';
    idleCount.textContent = idle ? '('+idle+')' : '';
    var below = cur ? busyBelow(cur.id) : false;
    if(cur){
      chatTitle.textContent=cur.title || 'Untitled';
      // Same order as the dot, and the same reason: during an ask the turn is still open, so
      // "running" is true and is the less useful of the two things to say. A dispatcher whose
      // sub-agents work is running too: its own turn ended, the job did not.
      var curRunning=Boolean(cur.running) || below;
      var state=cur.asking?'awaiting you':(curRunning?'running':'');
      chatStatus.textContent=state;
      chatStatus.className='chat-status'+(cur.asking?' asking':(curRunning?' running':''));
    } else {
      chatTitle.textContent='';
      chatStatus.textContent='';
    }
    // Each control exists only while its command has something to act on, read off the same flags
    // as the dot: Stop while a turn is open (a question holds one open, so asking implies it), and
    // the power button while a process is resident. Hiding beats disabling — a greyed-out control
    // asks to be explained, and "nothing is running" is already what an unlit dot says.
    killBtn.hidden = !(cur && cur.live);
    // Also over a topic whose own turn is over while the sub-agents it started still work — the
    // usual state of a /super job, and the one where there was nothing to press: /stop there stops
    // them too (Delegation.stopOpened).
    stopBtn.hidden = !(cur && (cur.running || cur.asking || below));
    stopBtn.title = below
      ? 'Stop this topic and the sub-agents it started — their conversations are kept (/stop)'
      : 'Stop what the agent is doing — the conversation is kept (/stop)';
    // The window's title bar names the same topic this row does, so a rename lands on both in
    // the same frame rather than leaving the bar holding the old name until the next switch.
    if(TERM_OK) paintFrames();
    // The panel's Sessions tab is drawn from this same list, and its counts must move when a run
    // opens or finishes even while the Tasks tab is the one on screen. The Reviews tab draws the
    // same list for a different reason: a link back to a topic exists only while that topic does.
    paintSchedCounts();
    paintSummary();
    paintSchedAlert();
    if(schedPane.isOpen() && schedTab==='sessions') paintSessions();
    else if(schedPane.isOpen() && schedTab==='reviews') paintReviews();
  }

  /**
   * Tell the daemon the operator is looking at the topic on screen, when that changes something: a
   * reply it has not been told was read (stage review). It stamps its own clock (WebRoom.markSeen),
   * and the stage — here and in the Needs-you list — moves on.
   * Only while the page is actually visible, and at most every two seconds per topic.
   */
  var seenPosted={};
  function reportSeen(){
    if(!topic || document.visibilityState==='hidden') return;
    var cur=null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    if(!cur || cur.stage!=='review') return;
    var now=Date.now();
    if(seenPosted[topic] && now-seenPosted[topic]<2000) return;
    seenPosted[topic]=now;
    post('api/seen',{topic:topic},0).catch(function(){});
  }
  document.addEventListener('visibilitychange', reportSeen);

  // ── Notifications ─────────────────────────────────────────────────────────
  // Web Push (webpush.ts on the server, sw.ts the worker): what reaches this device when the page is
  // closed or the phone is in a pocket. Off until the operator turns it on here, per device — the
  // browser asks for permission, and a permission prompt nobody asked for is the fastest way to a
  // "block". Only offered where the browser can do it at all: Chrome, Firefox, Edge, and Safari on
  // iOS only once the page is installed as an app.
  var PUSH_OK = Boolean(window.isSecureContext && navigator.serviceWorker && window.PushManager && window.Notification);
  var pushKey = null, pushSub = null, notifyInit = false;
  function keyBytes(s){
    var b = atob((s + '==='.slice((s.length + 3) % 4)).replace(/-/g,'+').replace(/_/g,'/'));
    var out = new Uint8Array(b.length);
    for(var i=0;i<b.length;i++) out[i]=b.charCodeAt(i);
    return out;
  }
  function paintNotify(){
    if(!PUSH_OK || !pushKey){ notifyBtn.hidden=true; return; }
    notifyBtn.hidden=false;
    if(window.Notification.permission==='denied'){
      notifyBtn.disabled=true;
      notifyBtn.setAttribute('aria-pressed','false');
      notifyState.textContent='blocked';
      notifyBtn.title='Blocked in this browser: allow notifications for this site in the browser settings, then reload';
      return;
    }
    notifyBtn.disabled=false;
    notifyBtn.setAttribute('aria-pressed', pushSub ? 'true' : 'false');
    notifyState.textContent = pushSub ? 'on' : 'off';
    notifyBtn.title = pushSub
      ? 'This device is notified when something needs you, even with the page closed. Click to stop.'
      : 'Notify this device when something needs you, even with the page closed';
  }
  // Once the stream is open, i.e. once signed in: api/push is behind the session like every route.
  function initNotify(){
    if(!PUSH_OK || notifyInit) return;
    notifyInit = true;
    fetch('api/push', {credentials:'same-origin'}).then(function(r){ return r.json(); }).then(function(d){
      if(!d || !d.enabled || !d.key) return;
      pushKey = d.key;
      return navigator.serviceWorker.getRegistration('sw.js').then(function(reg){
        return reg ? reg.pushManager.getSubscription() : null;
      }).then(function(sub){ pushSub = sub; paintNotify(); });
    }).catch(function(){});
  }
  notifyBtn.addEventListener('click', function(){
    if(!pushKey) return;
    notifyBtn.disabled = true;
    if(pushSub){
      var endpoint = pushSub.endpoint;
      pushSub.unsubscribe().catch(function(){}).then(function(){
        pushSub = null;
        return post('api/push/unsubscribe', {endpoint:endpoint}, 1);
      }).catch(function(){}).then(paintNotify);
      return;
    }
    window.Notification.requestPermission().then(function(permission){
      if(permission !== 'granted') return;
      return navigator.serviceWorker.register('sw.js').then(function(){ return navigator.serviceWorker.ready; }).then(function(reg){
        return reg.pushManager.getSubscription().then(function(old){
          return old || reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:keyBytes(pushKey)});
        });
      }).then(function(sub){
        return post('api/push/subscribe', sub.toJSON(), 1).then(function(r){
          if(r.ok){ pushSub = sub; return; }
          return r.json().then(function(d){ throw new Error((d && d.error) || ('HTTP '+r.status)); });
        });
      });
    }).catch(function(e){
      alert('Could not turn notifications on: ' + ((e && e.message) || e));
    }).then(paintNotify);
  });
  // A notification tapped while this page is open: the worker asks it to show the topic.
  if(PUSH_OK) navigator.serviceWorker.addEventListener('message', function(e){
    var goId = e.data && e.data.goto;
    if(goId && goId!==topic && topics.some(function(t){ return t.id===goId; })){
      switchTopic(goId);
      if(narrow()) setSidebar(false);
    }
  });


  // ── Terminal ───────────────────────────────────────────────────────────────
  // A window over the transcript, one per topic. The iframe holds ttyd's own terminal, which is
  // why this is a hundred lines instead of a terminal emulator. Nothing here speaks to the agent
  // — the two share a topic id and nothing else.

  // What the address bar should say now. The topic and the pane are both worth surviving a
  // reload, and both are written the same way so neither can silently drop the other.
  function urlNow(){
    return '?t='+encodeURIComponent(topic) + (termState[topic]==='open' ? '&v=term' : '');
  }

  // Mounted on first use, so a page that never opens a terminal never connects to ttyd, and
  // dropped only when the window is CLOSED — never when it is minimized and never when the
  // topic changes. What survives a drop is the session itself, on the far side, which is the
  // operator's arrangement (ttyd hangs up its child; their wrapper holds the session open) and
  // the reason closing needs a server round trip while minimizing does not.
  function applyTerm(){
    if(!TERM_OK) return;
    if(termBoot && topic){
      termBoot = false;
      if(!termState[topic]) termState[topic]='open';
    }
    var state = topic ? termState[topic] : undefined;
    var on = state === 'open';
    chat.classList.toggle('term', on);
    termBtn.classList.toggle('on', Boolean(state));
    termBtn.title = on ? 'Minimize the terminal' : (state ? 'Show the terminal (still running)' : 'Terminal');
    // Only ever rendered where a session can actually be ended; see TERM_END.
    termEndBtn.hidden = !TERM_END;
    if(state && topic) mountTerm(topic);
    paintFrames();
  }

  function mountTerm(id){
    if(termFrames[id]) return;
    var frame = document.createElement('iframe');
    frame.setAttribute('title','Terminal');
    // Relative, for the same reason every fetch here is: a reverse proxy may mount the daemon
    // under a sub-path, and an absolute "/" walks out of it.
    frame.setAttribute('src','term/?arg='+encodeURIComponent(id));
    termFrames[id] = frame;
    termHost.appendChild(frame);
  }

  /** Exactly one mounted terminal is visible: the current topic's, and only while it is open. */
  function paintFrames(){
    var on = topic && termState[topic]==='open';
    for(var id in termFrames){
      if(!Object.prototype.hasOwnProperty.call(termFrames, id)) continue;
      termFrames[id].classList.toggle('on', Boolean(on) && id===topic);
    }
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    termName.textContent = cur && cur.title ? cur.title : 'Untitled';
  }

  /** Unmount one topic's terminal. Ends a connection, never a session — see endTerm. */
  function dropTerm(id){
    var frame = termFrames[id];
    if(frame){
      if(frame.parentNode) frame.parentNode.removeChild(frame);
      delete termFrames[id];
    }
    delete termState[id];
  }

  function showTerm(){
    if(!TERM_OK || !topic) return;
    termState[topic] = 'open';
    history.replaceState(null,'',urlNow());
    applyTerm();
  }

  // Hidden, not unmounted: the point of minimizing is that whatever is running in there keeps
  // running AND stays connected, so coming back is a repaint rather than a reconnect and a
  // redraw.
  function minTerm(){
    if(!TERM_OK || !topic || !termState[topic]) return;
    termState[topic] = 'min';
    history.replaceState(null,'',urlNow());
    applyTerm();
  }

  /**
   * End the session, which is a different act from closing the window and is why it asks first.
   *
   * Dropping the iframe would only hang up on a shell that carries on without us. What actually
   * ends it is a command the operator configured, so this is a request; the window is taken down
   * only once the server says it worked, because a window closed over a session that is still
   * alive is the one outcome nobody could explain from the screen.
   */
  function endTerm(){
    if(!TERM_OK || !TERM_END || !topic || !termState[topic]) return;
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    var title = (cur && cur.title) ? cur.title : 'Untitled';
    if(!confirm('End the terminal session in "'+title+'"?\\n\\nAnything still running in it is killed. Minimize instead to leave it running.')) return;
    var id = topic;
    // Not retried, unlike a send. A 500 here means the operator's command ran and failed, and
    // running it again 700ms later answers the same way while spawning a second process; the
    // retry in post() is for a link that dropped a request, which is not this.
    post('api/terminal/end',{topic:id},0).then(function(r){
      return r.ok ? {ok:true} : r.json().then(function(d){ return {ok:false, error:(d&&d.error)||'could not end the terminal session'}; }, function(){ return {ok:false, error:'could not end the terminal session'}; });
    }).then(function(d){
      if(!d.ok){ alert(d.error); return; }
      dropTerm(id);
      if(id===topic){ history.replaceState(null,'',urlNow()); applyTerm(); }
    }, function(){
      alert('could not reach the daemon to end the terminal session');
    });
  }

  function switchTopic(id){
    if(!id || id===topic) return;
    // The settings page is bound to the topic it was opened in: its rows write that conversation's
    // agent and model, and its buttons name a message that topic holds. Following another topic
    // puts it away rather than leaving it pointing at the one being left.
    closeSettings();
    // The panel stays where it is: it is part of the workspace, and following a run out of it
    // should leave the list of runs beside the transcript. The one exception is the overlay under
    // 1024px, which covers the chat it just opened — there is nothing to keep it beside there.
    if(schedPane.isOpen() && !schedPane.docked()) setSchedules(false, true);
    // The topic being left, written now rather than at the end of its window — in a moment
    // nothing on screen belongs to it any more and there is nothing left to write.
    cacheFlush();
    // Both read off the topic being left, so both before anything below takes it off screen.
    saveView(topic);
    stashDraft(topic);
    topic = id;
    history.replaceState(null,'',urlNow());
    // Before the transcript work below, so the terminal follows the topic in the same frame
    // the title does rather than a repaint later.
    applyTerm();
    for(var i=0;i<topics.length;i++){
      if(topics[i].id===id){
        readCounts[id]=topics[i].msgCount || 0;
        saveReads();
        break;
      }
    }
    paintTopics();
    reportSeen();
    log.innerHTML='';
    data={};
    els={};
    sig={};
    skeleton=false;
    // All of these belong to the topic being left: the notice and divider elements are gone with
    // #log's children, whether the NEXT topic predates the daemon is the incoming sync's answer
    // to give, and its transcript has not been read back yet. epoch is NOT reset — it is a
    // property of the daemon on the other end, not of the room being entered.
    stale=false;
    emptyEl=null;
    launch=null;
    launchEl=null;
    launchSig='';
    dividerEl=null;
    syncingEl=null;
    // The strip describes the topic being left; the incoming sync says what the new one's is.
    closeModelPop();
    setStatus(null);
    entering=true;
    synced=false;
    view = views[id] || null;
    landedAt = -1;
    loadDraft(id);
    // The shape of a transcript while both the cache read and the stream are outstanding. The
    // cache normally answers first and replaces it; nothing about that is guaranteed, which is
    // why the placeholders go in regardless.
    showSkeleton();
    restore(id);
    // What was sent into this topic and not acknowledged — including a send still in flight from
    // before the switch, whose bubble went with the transcript it was in.
    showUnsent(id);
    connect();
  }

  function deleteTopic(delId){
    var target = null;
    for(var i=0;i<topics.length;i++){
      if(topics[i].id===delId){ target=topics[i]; break; }
    }
    var title = (target && target.title) ? target.title : 'Untitled';
    // A star protects a topic from everything automatic, not from this: the × is the operator
    // deciding about one row, which is exactly what a star defers to. The question says so.
    if(!confirm('Delete '+(target && target.starred ? 'starred ' : '')+'topic "' + title + '"?')) return;
    post('api/topics/delete',{topic:delId},1).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      if(!d) return;
      cacheDrop(delId);
      // The row is gone, so its terminal window has nothing left to belong to. Only the window
      // — the session on the far side outlives this exactly as it outlives a closed tab, which
      // is why deleting a topic is not offered as a way to end one.
      dropTerm(delId);
      delete readCounts[delId];
      saveReads();
      if(topic === delId){
        var remaining = topics.filter(function(t){ return t.id !== delId; });
        if(remaining.length > 0){
          switchTopic(remaining[0].id);
        } else {
          createTopic();
        }
      }
      // After the switch, which is what writes down the view and the draft of the topic being
      // left — this one, when it was the one on screen. The broadcast that is also on its way
      // prunes the same entries; this is so a draft of a deleted topic is not waiting on it.
      forget(delId);
    });
  }

  // ── The status strip ─────────────────────────────────────────────────────────
  // What the daemon last pushed about this topic's agent (see status-board.ts), or null. Every time
  // in it is absolute, so a countdown is worked out here against the clock rather than re-sent:
  // the server says when a cache expires once, and this page counts to it.
  var agentStatus = null, statusTimer = null, statusHtml = '';
  // How often a countdown on screen is redrawn. Minutes are its finest unit, so twice a minute is
  // as often as it can visibly change; and only while one is on screen and the tab is visible.
  var STATUS_TICK_MS = 30000;

  function setStatus(s){
    agentStatus = s || null;
    paintStatus();
    armStatusTick();
  }

  function hasCountdown(s){
    if(!s) return false;
    if(s.cacheExpiresAt) return true;
    var q = s.quota || [];
    for(var i=0;i<q.length;i++) if(q[i].resetsAt) return true;
    return false;
  }

  function armStatusTick(){
    var want = hasCountdown(agentStatus) && document.visibilityState !== 'hidden';
    if(want && !statusTimer) statusTimer = setInterval(paintStatus, STATUS_TICK_MS);
    else if(!want && statusTimer){ clearInterval(statusTimer); statusTimer = null; }
  }

  // The same units as the footer (core/runtime-footer.ts formatTokens / formatWindow), so a number
  // read here and one read under a reply can be compared.
  function stTokens(n){
    return n >= 1e6 ? (n/1e6).toFixed(1).replace(/\\.0$/,'')+'M' : Math.round(n/1000)+'k';
  }
  function stWindow(n){
    return n >= 1e6 ? (Math.floor(n/1e5)/10).toFixed(1).replace(/\\.0$/,'')+'M' : Math.floor(n/1000)+'k';
  }
  function stLeft(ms){
    var m = Math.floor(ms/60000);
    if(m < 1) return '<1m';
    var d = Math.floor(m/1440), h = Math.floor((m%1440)/60), mm = m%60;
    if(d > 0) return d+'d'+(h ? ' '+h+'h' : '');
    if(h > 0) return h+'h'+(mm ? ' '+mm+'m' : '');
    return m+'m';
  }
  function stClock(at){
    var t = new Date(at);
    return (t.getHours()<10?'0':'')+t.getHours()+':'+(t.getMinutes()<10?'0':'')+t.getMinutes();
  }
  // agy's pool ids, made readable: gemini-5h → Gemini 5h, 3p-weekly → 3P wk. An id of any other
  // shape is shown as it came, rather than dropped for not being one of the four known today.
  function poolLabel(id){
    var cut = id.lastIndexOf('-');
    var fam = cut > 0 ? id.slice(0, cut) : id, win = cut > 0 ? id.slice(cut+1) : '';
    fam = fam === '3p' ? '3P' : (fam === 'gemini' ? 'Gemini' : fam);
    win = win === 'weekly' ? 'wk' : (win === 'daily' ? 'day' : win);
    return win ? fam+' '+win : fam;
  }
  function seg(cls, title, html){
    return '<span class="st'+(cls ? ' '+cls : '')+'"'+(title ? ' title="'+text(title)+'"' : '')+'>'+html+'</span>';
  }

  function statusSegments(s, now, open){
    var out = [];
    out.push(seg('st-who', '', text(s.agent)+' \\u00b7 '+modelChip(s.model || 'Model')+(s.effort ? ' \\u00b7 '+text(s.effort) : '')));
    if(s.context && s.context.size > 0){
      var pct = Math.min(100, Math.max(0, Math.round(s.context.used / s.context.size * 100)));
      out.push(seg(pct >= 80 ? 'bad' : (pct >= 50 ? 'warn' : ''),
        s.context.used.toLocaleString()+' of '+s.context.size.toLocaleString()+' tokens in context',
        '<i class="st-meter"><i style="width:'+pct+'%"></i></i>'+pct+'%'
          +'<span class="st-x">'+stTokens(s.context.used)+'/'+stWindow(s.context.size)+'</span>'));
    }
    if(s.cost){
      var c = s.cost;
      out.push(seg('', 'Session cost so far, as the harness reports it ('+c.amount.toFixed(4)+' '+c.currency+')',
        c.currency === 'USD' ? '$'+c.amount.toFixed(2) : text(c.amount.toFixed(2)+' '+c.currency)));
    }
    if(s.cacheExpiresAt){
      var left = s.cacheExpiresAt - now;
      out.push(left > 0
        ? seg(left < 5*60000 ? 'warn' : '', 'Prompt cache expires at '+stClock(s.cacheExpiresAt)+'; after that the next message re-reads the whole context at full price', text('cache '+stLeft(left)))
        : seg('', 'Prompt cache expired at '+stClock(s.cacheExpiresAt)+'; the next message re-reads the whole context at full price', 'cache expired'));
    }
    var pools = s.quota || [], anyActive = false;
    for(var i=0;i<pools.length;i++) if(pools[i].active) anyActive = true;
    for(var j=0;j<pools.length;j++){
      var p = pools[j], off = anyActive && !p.active;
      // Closed, only the pools being spent from: the others are context, and the line is short.
      if(off && !open) continue;
      var rp = Math.round(p.remaining * 100);
      // A reset time is only worth the room while something has been spent.
      var reset = p.resetsAt && rp < 100 ? ' ('+stLeft(p.resetsAt - now)+')' : '';
      out.push(seg((rp <= 15 ? 'bad' : (rp <= 40 ? 'warn' : ''))+(off ? ' off' : ''),
        p.resetsAt ? 'Refills '+new Date(p.resetsAt).toLocaleString() : '',
        text(poolLabel(p.id)+' '+rp+'%'+reset)));
    }
    return out.join('');
  }

  function paintStatus(){
    var s = agentStatus;
    // With no status yet (a restart, a conversation that has not reported), the line still offers
    // the switch once the topic has a conversation in it — not in a new one, where the agent
    // launcher is the choice to make first. Asked of the launcher on screen, not of launch: that
    // is the last sync's snapshot of the empty room and stays set until the next sync, so testing it
    // hid the switch from the moment an agent was chosen until the first reply reported a status —
    // exactly when someone wants to pick the model the first message goes to.
    var html = s ? statusSegments(s, Date.now(), statusEl.classList.contains('open'))
      : (topic && synced && !launchEl && log.querySelector('.m') ? seg('st-who', '', modelChip('Model')) : '');
    // Compared before writing: the tick redraws twice a minute, and most of those change nothing.
    if(html === statusHtml) return;
    statusHtml = html;
    statusEl.innerHTML = html;
    statusEl.hidden = !html;
  }

  statusEl.addEventListener('click', function(e){
    if(e.target.closest && e.target.closest('.st-model')){
      if(modelPop.hidden) openModelPop(); else closeModelPop();
      return;
    }
    statusEl.classList.toggle('open');
    paintStatus();
  });

  // ── The model switch ─────────────────────────────────────────────────────────
  // /model as a control: the list the topic's agent offers (GET api/models, which starts a cold
  // agent the way /model does — hence "Asking…"), and the switch (POST api/models), which is
  // /model's own: a runtime override for this topic, config untouched. mp.seq drops an answer that
  // belongs to a list closed or reopened since.
  var mp = { topic: null, data: null, err: '', loading: false, busy: false, seq: 0 };
  var MODEL_WAIT_MS = 45000;

  function modelChip(label){
    return '<button type="button" class="st-model" aria-haspopup="dialog" aria-expanded="'+(modelPop.hidden ? 'false' : 'true')+'"'
      + ' title="Switch the model for this topic (/model)"><span class="st-mtext">'+text(label)+'</span></button>';
  }

  function openModelPop(){
    if(!topic) return;
    var n = ++mp.seq, t = topic;
    mp.topic = t; mp.data = null; mp.err = ''; mp.loading = true; mp.busy = false;
    mpFilter.value = '';
    modelPop.hidden = false;
    paintStatus();
    renderModelPop();
    // Not on a phone: the keyboard would take half the screen before the list was read.
    if(!narrow()) mpFilter.focus();
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctl) ctl.abort(); }, MODEL_WAIT_MS);
    fetch('api/models?t='+encodeURIComponent(t), ctl ? {credentials:'same-origin', signal: ctl.signal} : {credentials:'same-origin'})
      .then(function(r){ return r.json().then(function(j){ return { r: r, j: j }; }); })
      .then(function(x){
        clearTimeout(timer);
        if(n !== mp.seq) return;
        mp.loading = false;
        if(!x.r.ok) mp.err = 'The daemon did not give a list (HTTP '+x.r.status+').';
        else mp.data = x.j;
        renderModelPop();
      }, function(){
        clearTimeout(timer);
        if(n !== mp.seq) return;
        mp.loading = false;
        mp.err = 'Could not reach the daemon for the list. Check the connection and try again.';
        renderModelPop();
      });
  }

  function closeModelPop(){
    if(modelPop.hidden) return;
    mp.seq++;
    modelPop.hidden = true;
    mpList.innerHTML = '';
    paintStatus();
  }

  /** The list, or what stands in for it: asking, why there is none, or what went wrong. */
  function renderModelPop(){
    var d = mp.data;
    mpAgent.textContent = d && d.agent ? d.agent : '';
    mpFilter.hidden = !(d && d.ok && d.options.length > 8);
    if(mp.loading){ mpList.innerHTML = '<div class="mp-msg mp-wait"><span class="set-spin" aria-hidden="true"></span>Asking the agent for its models\u2026 a cold one takes a second or two to start.</div>'; return; }
    if(mp.err){ mpList.innerHTML = '<div class="mp-msg err">'+inl(mp.err)+'</div>'; return; }
    if(!d || !d.ok){ mpList.innerHTML = '<div class="mp-msg">'+inl(d ? d.text : '')+'</div>'; return; }
    var h = '';
    for(var i=0;i<d.options.length;i++){
      var o = d.options[i], on = o.value === d.current, def = d.configured && o.value === d.configured;
      var name = o.name && o.name !== o.value ? o.name : '';
      h += '<button type="button" class="mp-opt'+(on ? ' on' : '')+'" role="option" aria-selected="'+(on ? 'true' : 'false')+'" data-v="'+text(o.value)+'"'
        + ' data-q="'+text((o.value+' '+name).toLowerCase())+'">'
        + '<span class="mp-check" aria-hidden="true">'+(on ? '\u2713' : '')+'</span>'
        + '<span class="mp-main"><span class="mp-v">'+text(o.value)+'</span>'+(name ? '<span class="mp-n">'+text(name)+'</span>' : '')+'</span>'
        + (def ? '<span class="mp-tag" title="What this agent starts a new session with (Settings)">default</span>' : '')
        + '</button>';
    }
    mpList.innerHTML = h;
    filterModels();
  }

  function filterModels(){
    var q = mpFilter.value.trim().toLowerCase();
    var opts = mpList.querySelectorAll('.mp-opt');
    for(var i=0;i<opts.length;i++) opts[i].hidden = !!q && (opts[i].getAttribute('data-q') || '').indexOf(q) < 0;
  }

  /** Switch to one, as /model would. A refusal is /model's own sentence, shown in the list. */
  function chooseModel(b){
    if(mp.busy || !mp.topic) return;
    var n = mp.seq, t = mp.topic, v = b.getAttribute('data-v');
    mp.busy = true;
    b.classList.add('busy');
    post('api/models', {topic: t, value: v}, 1, MODEL_WAIT_MS)
      .then(function(r){ return r.json().then(function(j){ return { r: r, j: j }; }); })
      .then(function(x){
        mp.busy = false;
        if(n !== mp.seq) return;
        if(x.r.ok && x.j.ok){
          if(t === topic && agentStatus) agentStatus = Object.assign({}, agentStatus, { model: x.j.model });
          closeModelPop();
          note.textContent = String(x.j.text || '').replace(/\\x60/g, '');
          return;
        }
        mp.err = x.j && x.j.text ? x.j.text : 'The daemon refused that (HTTP '+x.r.status+').';
        renderModelPop();
      }, function(){
        mp.busy = false;
        if(n !== mp.seq) return;
        mp.err = 'Could not reach the daemon, so the model was not changed. Try again.';
        renderModelPop();
      });
  }

  mpList.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('.mp-opt') : null;
    if(b) chooseModel(b);
  });
  mpFilter.addEventListener('input', filterModels);
  $('mp-close').addEventListener('click', closeModelPop);
  // Its own Escape and outside click, ahead of nothing else: the list is not a window over the
  // page, so it does not join the overlays the page-wide Escape closes.
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && !modelPop.hidden){ closeModelPop(); e.stopPropagation(); }
  }, true);
  document.addEventListener('click', function(e){
    if(modelPop.hidden || !e.target.closest) return;
    if(e.target.closest('#model-pop') || e.target.closest('.st-model')) return;
    closeModelPop();
  });
  // A countdown is redrawn the moment the page is looked at again, rather than up to a tick late.
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState !== 'hidden') paintStatus();
    armStatusTick();
  });

  function handle(ev){
    if(ev.t==='sync'){
      // Only a sync for a topic we have since left is stale enough to drop. A first visit has
      // no topic at all — nothing put ?t= in the URL yet — and the server answers by picking
      // one for us, so testing ev.topic against an empty string threw away the only sync that
      // visit was ever going to get and left the page an empty shell.
      if(topic && ev.topic !== topic) return;
      var named = !topic;
      topic = ev.topic;
      // A visit that named no topic learns only here which room it is in, and so which composer
      // is its own. Not over anything already typed, though: that was typed into this room.
      if(named && drafts[topic] && !input.value && !files.length) loadDraft(topic);
      history.replaceState(null,'',urlNow());
      // The other half of "asked for is not shown": a reload straight into terminal mode, or a
      // first visit with no ?t= at all, only learns which topic to point at here.
      applyTerm();
      // Where the reader was, decided BEFORE the transcript moves under them. Opening a topic lands
      // where it was left (or at the bottom); a resync after a dropped connection must not yank
      // someone out of the history they were reading, which is only a choice at all now that the
      // reconcile leaves their scroll position intact. Nor may the sync that finishes OPENING a
      // topic, once the cache has put the transcript up and the reader has scrolled it — but when
      // they have not, landing again is what finds their message after the sync has put older
      // ones above it.
      var arriving = entering && (landedAt < 0 || log.scrollTop === landedAt);
      var stick = atBottom();
      entering = false;
      // Which run of the daemon everything in this sync belongs to. Anything already on screen
      // from another one is cached history from here on, whatever it was painted as.
      epoch = ev.epoch || 0;
      synced = true;
      // What the server says about this room BEFORE the transcript is reconciled, so the drops
      // that reconcile performs already know whether an emptied log needs explaining.
      stale = Boolean(ev.stale);
      // Present only for a room that is empty and can still be given to an agent; absent clears it.
      launch = ev.agents || null;
      repaintHistory();
      // Before the reconcile, which claims any of them whose echo this sync turns out to carry. A
      // visit that named no topic learns only now which ones are its own.
      showUnsent(topic);
      reconcile(ev.messages);
      settleUnsure();
      placeDivider();
      syncEmptyNote();
      cacheSave();
      // A visit that named no topic is only told which room it is in here, so this is also where
      // that room's cached transcript is asked for. Reading one twice is a no-op.
      restore(topic);
      readCounts[topic] = ev.messages.length;
      saveReads();
      commands = ev.commands || [];
      topics = ev.topics || [];
      paintTopics();
      prune();
      // Absent when the topic's agent has reported nothing since the daemon started, which clears
      // whatever a previous connection had put up.
      setStatus(ev.status);
      note.textContent='';
      if(arriving) land(); else if(stick) toBottom();
      view = null;
    }
    else if(ev.t==='msg'){
      // /setting is a page here, not a message: the daemon's screen goes to it, and a retired
      // one (wasSettings) stays out of the transcript for good. Anything else that edits the
      // message the page is drawing — the scheduled-task handover does — puts the page away and
      // is drawn as the menu it has become.
      var sm = ev.msg;
      if(sm && sm.settings){ takeSettings(sm); return; }
      if(sm && sm.wasSettings) return;
      if(sm && settingsMsg && sm.id === settingsMsg.id) closeSettings();
      // Before the upsert: if this is the echo of something typed here, it takes over the node
      // that local message is already occupying rather than appearing underneath it.
      claim(ev.msg);
      upsert(ev.msg);
      cacheSave();
      if(!agentStatus) paintStatus();
      readCounts[topic] = (readCounts[topic] || 0) + 1;
      saveReads();
      for(var i=0;i<topics.length;i++){
        if(topics[i].id===topic){
          topics[i].msgCount = (topics[i].msgCount || 0) + 1;
          break;
        }
      }
      paintTopics();
    }
    else if(ev.t==='del'){
      drop(epoch+':'+ev.id);
      cacheSave();
    }
    else if(ev.t==='react'){
      var rk = epoch+':'+ev.id;
      var m=data[rk]; if(!m) return;
      var kept=(m.reactions||[]).filter(function(e){ return e!==ev.emoji; });
      m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
      paint(rk);
      cacheSave();
    }
    else if(ev.t==='typing'){
      typing.hidden = !ev.on;
      for(var i=0;i<topics.length;i++){
        if(topics[i].id===topic){
          topics[i].running = ev.on;
          break;
        }
      }
      paintTopics();
    }
    else if(ev.t==='commands'){ commands = ev.commands || []; }
    else if(ev.t==='status'){ setStatus(ev.status); }
    else if(ev.t==='topics'){
      topics = ev.topics || [];
      paintTopics();
      reportSeen();
      if(topic && !topics.some(function(t){ return t.id===topic; })){
        if(topics.length > 0){
          switchTopic(topics[0].id);
        } else {
          createTopic();
        }
      }
      // After any switch above, which writes down the view and draft of the topic it leaves — a
      // topic that has just gone, in that case.
      prune();
    }
    else if(ev.t==='bye'){ done=true; if(stream) stream.close(); note.textContent='Disconnected. Reload when it is back.'; }
  }

  function connect(){
    if(stream) stream.close();
    // Placeholders for the wait that is about to start. Guarded on an empty log inside, so a
    // reconnect after a blip — where the conversation is still on screen and only the stream went
    // away — is not answered by replacing it with skeletons.
    showSkeleton();
    // EventSource resends the last id it saw on its own, so a blip is answered with the few
    // events that were missed rather than the whole conversation.
    stream = new EventSource('api/events' + (topic ? '?t='+encodeURIComponent(topic) : ''));
    stream.onmessage = function(e){ try{ handle(JSON.parse(e.data)); }catch(x){} };
    // Not focused on a phone: the keyboard would come up before a word has been read, and on
    // a portrait screen that is half the viewport gone to reach a field nobody asked for yet.
    stream.onopen = function(){
      gate.hidden=true; app.hidden=false; note.textContent=''; if(!narrow()) input.focus(); initNotify();
      // A panel opened (or restored from aa_sched_open) before the gate came down asked too
      // early (loadSchedules and loadReviews refuse while #app is hidden); this is the first
      // moment the answer can be had. The restored tab is read here too: on a reload that comes
      // back to Reviews the panel opens before the gate does, so nothing else would ask.
      if(schedPane.isOpen()){ loadSchedules(); if(schedTab === 'reviews') loadReviews(); armSched(); }
    };
    stream.onerror = function(){
      if(done) return;
      if(stream.readyState === 2){
        // Closed for good rather than retrying: the server refused it, which here means the
        // session is gone. Anything else leaves EventSource to reconnect on its own.
        app.hidden=true; gate.hidden=false;
      } else {
        note.textContent='Reconnecting...';
      }
    };
  }

  bar.addEventListener('click', function(e){
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if(del){
      e.stopPropagation();
      var delId = del.getAttribute('data-del');
      if(delId) deleteTopic(delId);
      return;
    }
    var fold = e.target.closest ? e.target.closest('[data-fold]') : null;
    if(fold){
      e.stopPropagation();
      var foldId = fold.getAttribute('data-fold');
      if(foldId){
        // Folded is the default (an absent entry), so both choices are written down: false is
        // "I opened this one", true is "I put it back".
        var shutNow = folded[foldId] !== false;
        folded[foldId] = !shutNow;
        saveFolded();
        paintTopics();
      }
      return;
    }
    // Before the row's own click, like the ×: starring a topic is not a reason to switch to it.
    var star = e.target.closest ? e.target.closest('[data-star]') : null;
    if(star){
      e.stopPropagation();
      var starId = star.getAttribute('data-star');
      if(starId) starTopic(starId);
      return;
    }
    var b = e.target.closest ? e.target.closest('[data-topic]') : null;
    if(!b) return;
    var id = b.getAttribute('data-topic');
    if(!id || id===topic) return;
    switchTopic(id);
    if(narrow()) setSidebar(false);
  });

  bar.addEventListener('keydown', function(e){
    if(e.key==='Enter' || e.key===' '){
      if(e.target.closest && e.target.closest('[data-del],[data-star],[data-fold]')) return;
      var b = e.target.closest ? e.target.closest('[data-topic]') : null;
      if(!b) return;
      e.preventDefault();
      var id = b.getAttribute('data-topic');
      if(!id || id===topic) return;
      switchTopic(id);
    }
  });

  function createTopic(){
    post('api/topics',{},1).then(function(r){
      if(r.ok) return r.json();
      // Never swallowed again. A refusal used to vanish here, so the + simply did nothing and the
      // only trace was a 409 in the network panel. The daemon now gives up its oldest topic to
      // make room by itself, which leaves one reason to refuse — every topic is starred or busy —
      // and its own sentence says which and what to do about it.
      return r.json().then(function(d){ return {error:(d && d.error) || ('HTTP '+r.status)}; },
        function(){ return {error:'HTTP '+r.status}; });
    }, function(){
      return {error:'the daemon could not be reached'};
    }).then(function(d){
      if(d && d.error){ alert('Could not open a new topic: '+d.error); return; }
      if(!d || !d.topic) return;
      switchTopic(d.topic.id);
      if(narrow()) setSidebar(false);
    });
  }

  /**
   * Star or unstar a topic. Drawn at once rather than on the broadcast that confirms it — a tap
   * on a slow link should not look ignored — and put back if the daemon refused, in which case
   * the broadcast that would have corrected it is not coming.
   */
  function starTopic(id){
    var t = topicById(id);
    if(!t) return;
    var on = !t.starred;
    t.starred = on;
    paintTopics();
    post('api/topics/star',{topic:id, starred:on},1).then(function(r){ return r.ok; }, function(){ return false; }).then(function(ok){
      if(ok) return;
      // Looked up again: a broadcast in between replaces the array, and the object held above
      // would no longer be the one on screen.
      var now = topicById(id);
      if(now){ now.starred = !on; paintTopics(); }
      alert('Could not '+(on?'star':'unstar')+' that topic.');
    });
  }

  function topicById(id){
    for(var i=0;i<topics.length;i++){ if(topics[i].id===id) return topics[i]; }
    return null;
  }

  newTopicBtn.addEventListener('click', createTopic);

  // Revealed only where there is something behind it. When the daemon serves no terminal the
  // button stays hidden and these listeners never have anything to toggle.
  if(TERM_OK){
    termBtn.hidden = false;
    // One button, three states: no window opens one, a shown window is minimized, a minimized
    // one comes back. Minimizing from here as well as from the title bar because the header
    // button is where the hand already is on a phone, and because it is what this button did
    // before there was a window to minimize.
    termBtn.addEventListener('click', function(){
      if(termState[topic]==='open') minTerm(); else showTerm();
    });
    termMinBtn.addEventListener('click', minTerm);
    termEndBtn.addEventListener('click', endTerm);
  }

  clearBtn.addEventListener('click', function(){
    setMenu(null, false);
    var stars = topics.filter(function(t){ return t.starred; }).length;
    var gone = topics.length - stars;
    if(stars && !gone){ alert('Every topic is starred, so there is nothing to clear. Unstar one first.'); return; }
    if(!confirm(stars
      ? 'Delete '+gone+' topic'+(gone===1?'':'s')+'? The '+stars+' starred one'+(stars===1?' is':'s are')+' kept. This cannot be undone.'
      : 'Delete all ' + topics.length + ' topics? This cannot be undone.')) return;
    post('api/topics/clear',{},1).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(!d || !d.topic) return;
      // What the daemon kept: the starred topics and the fresh one. Read from its answer rather
      // than from the stars on this page, which another tab may have changed since they were drawn.
      var list = d.topics || [d.topic];
      var keep = {};
      for(var i=0;i<list.length;i++) keep[list[i].id] = 1;
      // Every local record of the rooms that went goes with them. Leaving the caches would put
      // messages on screen for ids the daemon has forgotten, leaving the read marks would badge
      // the replacement topic against a count from a room that no longer exists, and a draft or a
      // terminal window would belong to nothing. The kept topics keep all of theirs.
      keepOnly(keep);
      // The list is replaced with what the server just told us rather than left to the broadcast
      // that is also on its way: paintTopics re-seeds a read mark for every topic it renders, so
      // painting the OLD list once more would write the ids we are here to forget straight back
      // into storage.
      topics=list;
      // Cleared rather than handed straight to switchTopic when the topic on screen went too:
      // nothing of a deleted room should be written back on the way out of it, and the
      // replacement id is four random bytes and may repeat the one being read — a one-in-4-billion
      // case where switchTopic would do nothing and leave a wiped transcript on screen. A starred
      // topic on screen is left alone, so its view and draft are saved like any other switch.
      if(!keep[topic]) topic='';
      switchTopic(d.topic.id);
      if(narrow()) setSidebar(false);
    });
  });

  // ── Closing idle agents ────────────────────────────────────────────────────
  /**
   * The topics whose agent is up and doing nothing — the dim dot, read off the same flags it is
   * drawn from, so the button's count and the dots cannot disagree. A dispatcher whose sub-agents
   * are still working is not one of them: its row is drawn as running (rowRunning), and offering
   * to close it under that row would be the list contradicting itself. In the sidebar's order:
   * starred first, so the dialog lists them where the eye already knows to find them.
   */
  function idleTopics(){
    var on=[], rest=[];
    for(var i=0;i<topics.length;i++){
      var t=topics[i];
      if(!t.live || t.running || t.asking || busyBelow(t.id)) continue;
      (t.starred ? on : rest).push(t);
    }
    return on.concat(rest);
  }

  /**
   * What the dialog was opened on: the ids it lists, which are the ids it posts. Not re-read from the
   * topic list at the click — a topic that went idle while the dialog was open was not shown, and
   * nothing is closed that the operator did not see. idleSeq drops an answer for a dialog since closed.
   */
  var idleIds=[], idleSeq=0;
  function openIdle(){
    var list=idleTopics();
    if(!list.length) return;
    idleIds=[];
    var h='';
    for(var i=0;i<list.length;i++){
      var t=list[i];
      idleIds.push(t.id);
      var where=t.dir?(t.dir.host?t.dir.host+' · ':'')+t.dir.name:'';
      h += '<li data-idle="'+text(t.id)+'"><span class="idle-main"><span class="idle-name">'+text(t.title || 'Untitled')+'</span>'
         + (where?'<span class="idle-dir">'+text(where)+'</span>':'')+'</span><span class="idle-out"></span></li>';
    }
    idleList.innerHTML=h;
    idleTitle.textContent='Close '+list.length+' idle agent'+(list.length===1?'':'s')+'?';
    idleWhy.hidden=false;
    idleGo.hidden=false;
    idleGo.disabled=false;
    idleCancel.textContent='Cancel';
    idleDialog.hidden=false;
    // Cancel, not Close: an Enter pressed out of habit should be the answer that changes nothing.
    idleCancel.focus();
  }
  function closeIdle(){
    if(idleDialog.hidden) return;
    idleDialog.hidden=true;
    idleSeq++;
    idleList.textContent='';
  }
  /**
   * The result, in the dialog rather than under the transcript: on a phone the sidebar is a drawer
   * over the transcript, and the status line there is behind it. Each row says what became of it,
   * because a topic that started working since the list was drawn is left alone (room.ts closeIdle),
   * and "5 of 6" alone would not say which one.
   *
   * Posted once, not retried: a retry after an answer that was lost would find every agent already
   * ended and report them all as left running.
   */
  function goIdle(){
    idleGo.disabled=true;
    var mine=++idleSeq;
    post('api/topics/close-idle',{topics:idleIds},0).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(mine!==idleSeq) return;
      if(!d) return idleFailed('The daemon refused the request.');
      var closed={}, i;
      for(i=0;i<d.closed.length;i++) closed[d.closed[i]]=1;
      var rows=idleList.querySelectorAll('li');
      for(i=0;i<rows.length;i++){
        var out=rows[i].querySelector('.idle-out'), ok=closed[rows[i].getAttribute('data-idle')];
        out.textContent = ok ? 'closed' : 'left running';
        out.className = 'idle-out' + (ok ? '' : ' kept');
      }
      var n=d.closed.length, k=d.kept.length;
      idleTitle.textContent='Closed '+n+' idle agent'+(n===1?'':'s')
        + (k ? '; '+k+' left running — busy again, or unable to resume' : '');
      idleWhy.hidden=true;
      idleGo.hidden=true;
      idleCancel.textContent='Done';
      idleCancel.focus();
    }, function(){ if(mine===idleSeq) idleFailed('Could not reach the server.'); });
  }
  function idleFailed(why){
    idleTitle.textContent=why;
    idleGo.disabled=false;
  }
  idleBtn.addEventListener('click', function(){ setMenu(null, false); openIdle(); });
  idleGo.addEventListener('click', goIdle);
  idleCancel.addEventListener('click', closeIdle);
  idleDialog.addEventListener('click', function(e){ if(e.target===idleDialog) closeIdle(); });

  /**
   * Forget everything local about every topic NOT in keep: cached transcript, read mark, reading
   * position, draft, terminal window. With nothing starred, keep holds only the fresh topic and
   * this is the whole-page wipe a clear always was.
   */
  function keepOnly(keep){
    var id;
    cacheKeep(keep);
    for(id in readCounts) if(!keep[id]) delete readCounts[id];
    saveReads();
    for(id in views) if(!keep[id]) delete views[id];
    for(id in drafts) if(!keep[id]) delete drafts[id];
    // One read-modify-write of the stored drafts, for the same reason writeDraft is one: a second
    // tab's drafts for the kept topics are on disk and not in this tab's map.
    try {
      var all = JSON.parse(localStorage.getItem(DRAFTS) || 'null') || {};
      var left = 0;
      for(id in all){ if(!keep[id]) delete all[id]; else left++; }
      if(left) localStorage.setItem(DRAFTS, JSON.stringify(all)); else localStorage.removeItem(DRAFTS);
    } catch(x){}
    // And what was sent into those rooms and never arrived: there is no longer anywhere to send it.
    for(var n in unsent) if(Object.prototype.hasOwnProperty.call(unsent, n) && !keep[unsent[n].t]) delete unsent[n];
    try {
      var out = JSON.parse(localStorage.getItem(UNSENT) || 'null') || {};
      var kept = 0;
      for(n in out){ if(!(out[n] && keep[out[n].t])) delete out[n]; else kept++; }
      if(kept) localStorage.setItem(UNSENT, JSON.stringify(out)); else localStorage.removeItem(UNSENT);
    } catch(x){}
    for(id in termFrames){
      if(Object.prototype.hasOwnProperty.call(termFrames, id) && !keep[id]) dropTerm(id);
    }
  }

  $('gate').addEventListener('submit', function(e){
    e.preventDefault();
    // No password to send: this gate's only control is a reload, which is what sends the
    // browser back through the identity provider.
    if(!PASSWORD_LOGIN){ location.reload(); return; }
    err.textContent='';
    post('api/login',{token:$('secret').value},0).then(function(r){
      if(r.ok){ $('secret').value=''; connect(); return; }
      err.textContent = r.status===429 ? 'Too many attempts. Wait a minute.' : 'That is not the right token.';
    }).catch(function(){ err.textContent='Could not reach the server.'; });
  });

  log.addEventListener('click', function(e){
    // A picture, filling the screen. Not a new tab: installed as an app this page has no tab
    // bar to come back from, and leaving the app to look at a screenshot is the same friction
    // as downloading it. Checked first — a picture carries none of the attributes below.
    var shot = e.target.closest ? e.target.closest('img.shot') : null;
    if(shot) return openShot(shot);
    // A link to another topic (a sub-agent's, see web-markdown.ts TOPIC_LINK_RE): switched to in
    // place, not loaded as a page — the stream, the caches and the composer all stay as they are.
    var go = e.target.closest ? e.target.closest('a[data-goto]') : null;
    if(go){
      e.preventDefault();
      var goId = go.getAttribute('data-goto');
      if(goId && topics.some(function(t){ return t.id===goId; })){
        switchTopic(goId);
        if(narrow()) setSidebar(false);
      }
      return;
    }
    // A new topic's choice of agent: typed for the operator, so it is a message like any other.
    var card = e.target.closest ? e.target.closest('button[data-agent]') : null;
    if(card) return command('/agent '+card.getAttribute('data-agent'));
    // The name of a file the server can render opens it (openReader); the Download link beside
    // it, and any file the server cannot render, stays an ordinary download.
    var view = e.target.closest ? e.target.closest('a[data-view]') : null;
    if(view){ e.preventDefault(); return openReader(view); }
    // What a message that failed to send offers. Checked before the ordinary buttons: these are
    // answered here, locally, and never posted as a click on a message the daemon has no idea
    // about.
    var act = e.target.closest ? e.target.closest('[data-retry],[data-copy],[data-discard]') : null;
    if(act){
      var retry = act.getAttribute('data-retry');
      if(retry) return deliver(retry);
      var copy = act.getAttribute('data-copy');
      if(copy) return copyLocal(copy, act);
      var discard = act.getAttribute('data-discard');
      if(discard) return discardLocal(discard);
      return;
    }
    // A tool bubble's lines, opened and folded. Also answered here and never posted: which line
    // someone is reading is nothing the daemon has a view on.
    var all = e.target.closest ? e.target.closest('[data-tl-all]') : null;
    if(all) return toggleAll(all.getAttribute('data-tl-all'));
    var line = e.target.closest ? e.target.closest('.tl') : null;
    if(line) return toggleLine(line);
    var b = e.target.closest ? e.target.closest('button[data-btn]') : null;
    if(!b) return;
    postButton(b, topic);
  });

  // The settings page's rows and values are the same buttons the transcript's menus carry, so
  // they post through the same function — with the topic the page was opened in, not whichever
  // one is on screen (the page is closed when that changes, but the two are not the same fact).
  settingsBody.addEventListener('click', function(e){
    if(!e.target.closest || !settingsMsg || !settingsTopic) return;
    if(e.target.closest('.set-use')){ useTyped(); return; }
    var b = e.target.closest('button[data-btn]');
    // A switch row is a target as a whole, as a settings row is anywhere: the label is the bigger
    // half of it, and on a phone the one a thumb lands on.
    if(!b){
      var row = e.target.closest('.set-item.sw');
      b = row ? row.querySelector('.set-switch') : null;
    }
    if(!b || b.disabled) return;
    postSetting(b, b.getAttribute('data-btn'));
  });
  settingsBody.addEventListener('input', function(e){
    if(e.target && e.target.classList && e.target.classList.contains('set-type')) filterSettings();
  });
  settingsBody.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' || !e.target || !e.target.classList || !e.target.classList.contains('set-type')) return;
    e.preventDefault();
    useTyped();
  });
  settingsBody.addEventListener('change', function(e){
    var sel = e.target;
    if(!sel || !sel.classList || !sel.classList.contains('set-select')) return;
    postSetting(sel, sel.value);
  });

  /**
   * A file the download table has since evicted, or one deleted off disk, answers 404 — and an
   * <img> says so with a broken frame that reads like a bug in the page. Hide it and the link
   * underneath is left, which is what a non-image shows anyway.
   *
   * Capture phase, because 'error' on an <img> does not bubble and so never reaches #log on its
   * own. The hiding survives a repaint for free: identical markup is not rewritten, and markup
   * that IS rewritten builds an image that 404s again.
   */
  log.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.classList && t.classList.contains('shot')) t.style.display='none';
  }, true);

  function openShot(img){
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
  }
  function closeShot(){
    if(lightbox.hidden) return;
    lightbox.hidden = true;
    // Dropped rather than left behind: a full-resolution screenshot held decoded by an overlay
    // nobody is looking at is the kind of thing a daemon running for weeks pays for.
    lightboxImg.removeAttribute('src');
  }
  lightbox.addEventListener('click', closeShot);
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    // An IME uses Escape to cancel its candidate list. That keystroke belongs to the composition,
    // not to the page: dismissing a panel (and remembering the dismissal) mid-word is not
    // something the person asked for.
    if(e.isComposing) return;
    // A recording is cancelled by Escape too, and the recorder's own listener below does that.
    // The same keystroke must not also put away what is behind the composer.
    if(rec) return;
    // Close the topmost thing first: Escape over a picture, the reader or a menu must not also
    // put away a panel behind it. The command suggestions are the composer's own overlay.
    var hintsOpen = !hints.hidden;
    var overlay = hintsOpen || !lightbox.hidden || !reader.hidden || !idleDialog.hidden || openMenu() || !skillsWin.hidden || !settingsPage.hidden;
    closeShot(); closeReader(); closeIdle(); closeSkills(); closeSettings();
    if(hintsOpen){ hints.hidden = true; hints.innerHTML = ''; }
    var m = openMenu();
    if(m){ setMenu(null, false); m.btn.focus(); }
    // The two panels answer Escape alike: the right one first, then the left. Each is a choice
    // the page remembers, and each has a control on screen that brings it back.
    if(!overlay){
      if(schedPane.isOpen()) setSchedules(false);
      else if(sbPane.isOpen()) setSidebar(false);
    }
  });

  /**
   * Read a file the agent sent without downloading it. The server renders it (reading.ts) and the
   * answer fills a window over the transcript. The name and the download link are on the file's
   * own link, so a slow link shows which file is coming rather than an empty frame.
   *
   * readSeq is which opening an answer belongs to. Close one file and open another before the first
   * has answered, and without it the first file's text would land under the second one's name.
   */
  var readSeq = 0;
  function openReader(link){
    readerName.textContent = link.textContent;
    readerName.title = readerName.textContent;
    readerGet.setAttribute('href', link.getAttribute('href'));
    readerSay('Loading\\u2026');
    reader.hidden = false;
    readerBody.focus();
    var mine = ++readSeq;
    fetch(link.getAttribute('data-view'), {credentials:'same-origin'}).then(function(r){
      return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; });
    }).then(function(res){
      if(mine !== readSeq) return;
      if(!res.ok) return readerSay(res.status === 404
        ? 'This file is no longer here: the daemon has let it go since it was sent.'
        : (res.body && res.body.error) || 'This file cannot be shown.');
      var j = res.body, h = '';
      if(j.shown < j.size) h += '<div class="reader-note">Showing the first '+text(byteSize(j.shown))+' of '+text(byteSize(j.size))+'. Download it for the rest.</div>';
      readerBody.innerHTML = h + '<div class="b">' + j.html + '</div>';
      readerBody.scrollTop = 0;
    }).catch(function(){ if(mine === readSeq) readerSay('Could not reach the server.'); });
  }
  function readerSay(s){ readerBody.innerHTML = '<div class="empty">'+text(s)+'</div>'; }
  function closeReader(){
    if(reader.hidden) return;
    reader.hidden = true;
    readSeq++;
    // Emptied, not kept: half a megabyte of rendered document is a lot of DOM to leave behind an
    // overlay nobody is looking at — the lightbox drops its picture for the same reason.
    readerBody.textContent = '';
  }
  function byteSize(n){ return n < 1048576 ? Math.max(1, Math.round(n/1024)) + ' KB' : (n/1048576).toFixed(1) + ' MB'; }
  $('reader-close').addEventListener('click', closeReader);
  // The dimmed page behind the window is a way out too, as it is for the lightbox — but only the
  // backdrop itself: a click that lands in the document must not close what is being read.
  reader.addEventListener('click', function(e){ if(e.target === reader) closeReader(); });

  // ── The skills page ────────────────────────────────────────────────────────
  // The gateway's managed skills (daemon/skills-store.ts), the same records the "talkcode skills"
  // command reads and writes. This half is presentation only: every verb is posted to api/skills/op and
  // the store answers with its own sentence when it refuses — the version guard on patch, the
  // 20 KB and path rules, and the archive that is the only "delete" there is.
  function skillAgo(iso){
    var at = iso ? Date.parse(iso) : 0;
    return at ? schedAgo(at) : '';
  }

  function skillState(s){
    return s === 'archived' ? 'Archived' : (s === 'expired' ? 'Expired' : 'Active');
  }

  function skillDetailMeta(s){
    var parts = [skillState(s.status), 'v' + s.version, 'created ' + skillAgo(s.createdAt)];
    if(s.pinned) parts.push('pinned');
    parts.push(s.lastUsedAt ? 'last used ' + skillAgo(s.lastUsedAt) : 'never used');
    parts.push(s.uses + (s.uses === 1 ? ' use' : ' uses'));
    return parts.join(' \\u00b7 ');
  }

  function skillCard(s){
    var meta = [];
    if(s.pinned) meta.push('pinned');
    meta.push(s.lastUsedAt ? 'last used ' + skillAgo(s.lastUsedAt) : 'never used');
    meta.push(s.uses + (s.uses === 1 ? ' use' : ' uses'));
    var h = '<div class="skill-item" data-skill="' + text(s.name) + '" role="button" tabindex="0">';
    h += '<div class="skill-row"><span class="skill-name">' + text(s.name) + '</span>';
    h += '<span class="skill-state ' + text(s.status) + '">' + text(skillState(s.status)) + '</span>';
    if(s.pinned) h += '<span class="skill-pin">pinned</span>';
    h += '</div>';
    h += '<div class="skill-desc">' + text(s.description || 'No description') + '</div>';
    h += '<div class="skill-meta">' + text(meta.join(' \\u00b7 ') + ' \\u00b7 v' + s.version) + '</div>';
    h += '</div>';
    return h;
  }

  function skillNewForm(){
    return '<div class="skill-item skill-new-form" data-newform="1">'
      + '<div class="skill-row"><span class="skill-name">New skill</span></div>'
      + '<input class="skill-field" id="skill-new-name" placeholder="name — lowercase-words-with-hyphens" autocomplete="off">'
      + '<input class="skill-field" id="skill-new-desc" placeholder="When should an agent use it?" autocomplete="off">'
      + '<textarea class="skill-text" id="skill-new-body" placeholder="Body (optional)"></textarea>'
      + '<div class="skill-acts editor"><button type="button" data-sop="create">Create</button>'
      + '<button type="button" class="danger" data-sop="cancel-new">Cancel</button></div></div>';
  }

  function renderSkillsList(){
    skillSel = null;
    skillsBack.hidden = true;
    skillsDetailEl.hidden = true;
    skillsListEl.hidden = false;
    skillsTitle.textContent = 'Skills';
    skillsCount.textContent = skillList.length ? skillList.length + (skillList.length === 1 ? ' skill' : ' skills') : '';
    skillsNewBtn.hidden = skillNewMode;
    var h = '';
    if(!skillsEnabled) h = '<div class="skills-empty">Skills are not enabled in this daemon.</div>';
    else if(!skillList.length) h = '<div class="skills-empty">No managed skills yet. An agent can create one when you ask it to remember a procedure, or press New.</div>';
    else for(var i=0;i<skillList.length;i++) h += skillCard(skillList[i]);
    if(skillNewMode) h = skillNewForm() + h;
    skillsListEl.innerHTML = h;
    if(skillNewMode){ var n = $('skill-new-name'); if(n) n.focus(); }
  }

  /** One history row. Only a change with something before it can be restored: the first version
      of a skill has no snapshot, and the store refuses that revert rather than inventing one. */
  function skillHistRow(e){
    var meta = skillAgo(e.at);
    if(e.note) meta += ' \\u00b7 ' + e.note;
    if(e.beforeVersion) meta += ' \\u00b7 ' + e.beforeVersion + ' \\u2192 ' + (e.afterVersion || '(no version)');
    var h = '<div class="skill-hist"><div class="skill-hist-main">'
      + '<div class="skill-hist-action">' + text(e.action) + '</div>'
      + '<div class="skill-hist-meta">' + text(meta) + '</div></div>';
    if(e.beforeVersion) h += '<button type="button" class="skill-file" data-revert="' + text(e.id) + '">Restore this version</button>';
    h += '</div>';
    return h;
  }

  function renderSkillDetail(){
    if(!skillSel) return renderSkillsList();
    var s = skillSel.skill, cur = skillSel.file;
    skillsListEl.hidden = true;
    skillsDetailEl.hidden = false;
    skillsBack.hidden = false;
    skillsNewBtn.hidden = true;
    skillsTitle.textContent = s.name;
    skillsCount.textContent = skillState(s.status);
    var h = '<div class="skill-head"><span class="skill-name">' + text(s.name) + '</span>';
    h += '<div class="skill-acts">';
    h += '<button type="button" data-sop="pin">' + (s.pinned ? 'Unpin' : 'Pin') + '</button>';
    h += s.status === 'archived'
      ? '<button type="button" data-sop="restore">Restore</button>'
      : '<button type="button" class="danger" data-sop="archive">Delete</button>';
    h += '</div></div>';
    h += '<div class="skill-desc">' + text(s.description || 'No description') + '</div>';
    h += '<div class="skill-meta">' + text(skillDetailMeta(s)) + '</div>';
    h += '<div class="skill-section">Files</div><div class="skill-files">';
    for(var i=0;i<skillSel.files.length;i++){
      var f = skillSel.files[i];
      h += '<button type="button" class="skill-file' + (cur.path === f.path ? ' on' : '') + '" data-file="' + text(f.path) + '">'
        + text(f.path) + '<small>' + text(byteSize(f.size)) + '</small></button>';
    }
    h += '</div>';
    h += '<div class="skill-section" id="skill-editor-label">' + text(cur.path) + '</div>';
    h += '<input class="skill-field" id="skill-path" value="' + text(cur.path) + '" placeholder="references/notes.md" autocomplete="off"'
      + (cur.path === 'SKILL.md' ? ' readonly' : '') + '>';
    h += '<textarea class="skill-text" id="skill-text" spellcheck="false"></textarea>';
    h += '<div class="skill-acts editor"><button type="button" data-sop="save">Save</button>'
      + '<button type="button" data-sop="new-file">New file</button>';
    if(cur.path !== 'SKILL.md') h += '<button type="button" class="danger" data-sop="remove-file">Remove file</button>';
    h += '</div>';
    h += '<div class="skill-section">History</div><div class="skill-history">';
    if(!skillSel.history.length) h += '<div class="skills-empty">No recorded changes yet.</div>';
    else for(var j=0;j<skillSel.history.length;j++) h += skillHistRow(skillSel.history[j]);
    h += '</div>';
    skillsDetailEl.innerHTML = h;
    var ta = $('skill-text');
    if(ta) ta.value = cur.content;
  }

  function skillNote(msg){
    skillsNote.hidden = false;
    skillsNote.textContent = msg;
  }
  function skillClearNote(){ skillsNote.hidden = true; }

  function loadSkills(){
    if(app.hidden) return;
    fetch('api/skills', {credentials:'same-origin'}).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(d){
      skillsEnabled = d.enabled !== false;
      skillList = d.skills || [];
      renderSkillsList();
    }).catch(function(e){
      skillNote('Could not load skills: ' + ((e && e.message) || 'network error'));
    });
  }

  function openSkill(name, file){
    var body = {action:'show', name:name};
    if(file) body.file = file;
    skillsBusy = true;
    skillClearNote();
    post('api/skills/op', body, 1).then(function(r){
      return r.json().catch(function(){ return {ok:false, error:'HTTP ' + r.status}; });
    }).then(function(d){
      if(!d || !d.ok){
        skillsBusy = false;
        return skillNote((d && d.error) || 'Could not open that skill.');
      }
      skillList = d.skills || skillList;
      skillSel = d.detail;
      skillNewMode = false;
      skillClearNote();
      // Released before the render, so a control that appears with it is usable at once. The
      // alternative — clear it in a trailing .then — leaves a frame where the page is drawn and
      // every button silently drops the click.
      skillsBusy = false;
      renderSkillDetail();
    }).catch(function(e){
      skillsBusy = false;
      skillNote('Could not reach the daemon: ' + ((e && e.message) || 'network error'));
    });
  }

  /** One write, then whatever the answer changed. The list always comes back, so a row cannot
      show the state from before the write; "show" also brings the detail. */
  function skillOp(body, then){
    if(skillsBusy) return;
    skillsBusy = true;
    skillClearNote();
    post('api/skills/op', body, 1).then(function(r){
      return r.json().catch(function(){ return {ok:false, error:'HTTP ' + r.status}; });
    }).then(function(d){
      if(!d || !d.ok){
        skillsBusy = false;
        return skillNote((d && d.error) || 'That did not work.');
      }
      skillList = d.skills || skillList;
      if(d.detail) skillSel = d.detail;
      // Released BEFORE then(): that callback may start a show of its own (the page re-reads the
      // skill after every write), and clearing the flag after it would make the editor writable
      // again while that request is still in flight — a late answer could then undo a newer one.
      skillsBusy = false;
      if(then) then(d);
      else if(skillSel) renderSkillDetail();
      else renderSkillsList();
    }).catch(function(e){
      skillsBusy = false;
      skillNote('Could not reach the daemon: ' + ((e && e.message) || 'network error'));
    });
  }

  function saveSkillFile(){
    if(!skillSel) return;
    var pathEl = $('skill-path'), textEl = $('skill-text');
    if(!pathEl || !textEl) return;
    var path = (pathEl.value || '').trim(), content = textEl.value, s = skillSel.skill;
    if(!path) return skillNote('A file path is required.');
    if(path === 'SKILL.md'){
      if(!skillSel.file || skillSel.file.path !== 'SKILL.md') return skillNote('Open SKILL.md to edit it.');
      skillOp({action:'patch', name:s.name, version:skillSel.file.version, content:content}, function(){
        openSkill(s.name, 'SKILL.md');
      });
    } else {
      skillOp({action:'write-file', name:s.name, file:path, content:content}, function(){
        openSkill(s.name, path);
      });
    }
  }

  function removeFileUi(){
    if(!skillSel) return;
    var pathEl = $('skill-path');
    var path = pathEl ? (pathEl.value || '').trim() : '';
    if(!path || path === 'SKILL.md') return;
    var name = skillSel.skill.name;
    if(!confirm('Remove ' + path + ' from "' + name + '"? The previous version stays in its history.')) return;
    skillOp({action:'remove-file', name:name, file:path}, function(){ openSkill(name, 'SKILL.md'); });
  }

  /** Two taps, like the scheduled panel's Delete: a phone mis-tap on a button that archives a
      skill is easy, and any repaint or four seconds puts it back. */
  function skillConfirm(btn, fn){
    if(btn.getAttribute('data-confirm') === '1'){ fn(); return; }
    var old = btn.textContent;
    btn.setAttribute('data-confirm', '1');
    btn.classList.add('confirm');
    btn.classList.remove('danger');
    btn.textContent = 'Delete?';
    setTimeout(function(){
      if(btn.getAttribute('data-confirm') === '1'){
        btn.removeAttribute('data-confirm');
        btn.classList.remove('confirm');
        btn.classList.add('danger');
        btn.textContent = old;
      }
    }, 4000);
  }

  function archiveUi(btn){
    if(!skillSel) return;
    var name = skillSel.skill.name;
    skillConfirm(btn, function(){
      skillOp({action:'archive', name:name}, function(){
        skillSel = null;
        renderSkillsList();
      });
    });
  }

  function openSkills(){
    if(!skillsWin.hidden) return;
    skillsWin.hidden = false;
    skillNewMode = false;
    skillClearNote();
    skillsListEl.innerHTML = '<div class="skills-empty">Loading\\u2026</div>';
    skillsDetailEl.hidden = true;
    skillsListEl.hidden = false;
    skillsBack.hidden = true;
    skillsTitle.textContent = 'Skills';
    skillsCount.textContent = '';
    loadSkills();
    skillsClose.focus();
  }
  function closeSkills(){
    if(skillsWin.hidden) return;
    skillsWin.hidden = true;
  }

  skillsToggle.addEventListener('click', function(){ setMenu(null, false); openSkills(); });
  skillsClose.addEventListener('click', closeSkills);
  skillsWin.addEventListener('click', function(e){ if(e.target === skillsWin) closeSkills(); });
  skillsBack.addEventListener('click', function(){ skillClearNote(); renderSkillsList(); });
  skillsNewBtn.addEventListener('click', function(){
    skillNewMode = true;
    skillClearNote();
    renderSkillsList();
  });

  skillsBody.addEventListener('click', function(e){
    var rev = e.target.closest ? e.target.closest('[data-revert]') : null;
    if(rev){
      e.stopPropagation();
      if(!skillSel) return;
      var id = rev.getAttribute('data-revert'), name = skillSel.skill.name;
      if(!id) return;
      if(!confirm('Restore the files from before this change? It is recorded as a new change, and can itself be reverted.')) return;
      skillOp({action:'revert', name:name, id:id}, function(){ openSkill(name); });
      return;
    }
    var opBtn = e.target.closest ? e.target.closest('[data-sop]') : null;
    if(opBtn){
      e.stopPropagation();
      var op = opBtn.getAttribute('data-sop');
      if(op === 'create'){
        var nameEl = $('skill-new-name'), descEl = $('skill-new-desc'), bodyEl = $('skill-new-body');
        var newName = nameEl ? nameEl.value.trim() : '';
        var newDesc = descEl ? descEl.value.trim() : '';
        if(!newName) return skillNote('A skill needs a name.');
        if(!newDesc) return skillNote('A skill needs a one-line description of when to use it.');
        var body = {action:'create', name:newName, description:newDesc};
        if(bodyEl && bodyEl.value) body.body = bodyEl.value;
        skillOp(body, function(){
          skillNewMode = false;
          skillSel = null;
          renderSkillsList();
          openSkill(newName);
        });
        return;
      }
      if(op === 'cancel-new'){ skillNewMode = false; skillClearNote(); renderSkillsList(); return; }
      if(op === 'save'){ saveSkillFile(); return; }
      if(op === 'new-file'){
        var p = $('skill-path'), t = $('skill-text'), label = $('skill-editor-label');
        if(!p || !t) return;
        p.value = ''; p.removeAttribute('readonly'); t.value = '';
        if(label) label.textContent = 'New file';
        p.focus();
        return;
      }
      if(op === 'remove-file'){ removeFileUi(); return; }
      if(op === 'archive'){ archiveUi(opBtn); return; }
      if(op === 'restore' && skillSel){
        var restoreName = skillSel.skill.name;
        skillOp({action:'restore', name:restoreName}, function(){ openSkill(restoreName); });
        return;
      }
      if(op === 'pin' && skillSel){
        var pinName = skillSel.skill.name, pinned = !skillSel.skill.pinned;
        skillOp({action:'pin', name:pinName, pinned:pinned}, function(){ openSkill(pinName); });
        return;
      }
      return;
    }
    var fileBtn = e.target.closest ? e.target.closest('[data-file]') : null;
    if(fileBtn && skillSel){
      var path = fileBtn.getAttribute('data-file');
      if(path) openSkill(skillSel.skill.name, path);
      return;
    }
    var card = e.target.closest ? e.target.closest('[data-skill]') : null;
    if(card){
      var cardName = card.getAttribute('data-skill');
      if(cardName) openSkill(cardName);
    }
  });

  skillsBody.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' && e.key !== ' ') return;
    if(e.target.closest && e.target.closest('button,input,textarea')) return;
    var card = e.target.closest ? e.target.closest('[data-skill]') : null;
    if(!card) return;
    e.preventDefault();
    var name = card.getAttribute('data-skill');
    if(name) openSkill(name);
  });

  // Grow to fit, and let the max-height in the stylesheet decide where to stop — it is stated
  // in dvh there, which on a phone with the keyboard up is the viewport that is actually left.
  // Clamping here as well would mean two numbers for one cap, and the JS one cannot see which
  // media query won.
  function grow(){ input.style.height='auto'; input.style.height=input.scrollHeight+'px'; }

  /**
   * The composer's attachments, one chip each: the name, a thumbnail when it is a picture, and a ×
   * that takes it back off the message. Before this a chip was a name and nothing else, so a
   * screenshot could not be checked before it went, and one pasted by mistake could only be got
   * rid of by sending it or by switching topics and back — which keeps it, since the draft does.
   *
   * Two constraints shape how the thumbnail is made:
   *   - It is a data: URL, not URL.createObjectURL. The page's CSP (server.ts) is img-src 'self'
   *     data:, so a blob: URL is refused and every thumbnail would be a broken frame. Widening the
   *     CSP for a preview is the wrong way round.
   *   - Each chip is built ONCE per file and moved, never rebuilt. The URL is the whole file again,
   *     and pushing it through innerHTML (and text() before that) on every paste re-parses and
   *     re-decodes every screenshot already there. The node lives in a WeakMap, not on the file
   *     object, because that object IS the upload: api/send is .strict() and would refuse a
   *     message carrying one more key.
   */
  var chipEls = new WeakMap();
  function chipFor(f){
    var el = chipEls.get(f);
    if(el) return el;
    el = document.createElement('span');
    el.className = 'chip';
    if(/^image\\//.test(f.mime) && f.data){
      var img = document.createElement('img');
      img.className = 'thumb';
      img.alt = f.name;
      img.src = 'data:'+f.mime+';base64,'+f.data;
      el.appendChild(img);
    }
    var name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = f.name;
    el.appendChild(name);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.title = 'Remove ' + f.name;
    x.setAttribute('aria-label', 'Remove ' + f.name);
    x.textContent = '\\u00d7';
    el.appendChild(x);
    chipEls.set(f, el);
    return el;
  }
  function renderChips(){
    chips.textContent = '';
    for(var i=0;i<files.length;i++){
      var el = chipFor(files[i]);
      // An index, re-stamped on every render: files only ever grows at the end or loses the one
      // being removed, and either way this render follows it before another click can land.
      el.lastChild.setAttribute('data-drop', String(i));
      chips.appendChild(el);
    }
  }
  chips.addEventListener('click', function(e){
    var x = e.target.closest ? e.target.closest('button[data-drop]') : null;
    if(x){ files.splice(Number(x.getAttribute('data-drop')), 1); renderChips(); return; }
    var t = e.target.closest ? e.target.closest('img.thumb') : null;
    if(t) openShot(t);
  });
  // A picture this browser cannot decode (HEIC on anything but Safari) keeps its name and loses
  // the broken frame, the same answer #log gives one that 404s — and for the same reason in the
  // capture phase: 'error' on an <img> does not bubble.
  chips.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.classList && t.classList.contains('thumb')) t.style.display='none';
  }, true);

  // ── A composer per topic ───────────────────────────────────────────────────
  /**
   * What each topic's composer held when it was left: the text, where the caret was, and the files
   * attached. One textarea serves every topic, so before this a half-written prompt followed the
   * reader into the next topic — and so did its attachments, which is how a screenshot meant for
   * one conversation got sent into another.
   *
   * The text is written through to localStorage, so a reload does not cost it either. Files are
   * not: they are base64, and a failed message cannot be retried after a reload for the same reason.
   *
   * Written when a topic is left, when a message is sent and when the page is hidden, and once
   * typing has paused for DRAFT_IDLE_MS — never per keystroke. visibilitychange is the last event
   * every way out of a page reliably fires (another tab, the app backgrounded, the window closed),
   * so nothing typed is still only in memory by the time the browser is free to discard the page.
   * The pause is for the ways out that fire nothing at all: a renderer that crashes, a phone that
   * kills the tab in the foreground. Those used to cost the whole draft; now they cost the last
   * second of typing, for one small write per pause rather than one per key.
   */
  var DRAFTS='aa_drafts';
  // Past this a draft is kept in memory only. localStorage is one ~5MB budget for the origin, and a
  // pasted log that filled it would take down the writes of the read marks and the drawer state too.
  var DRAFT_MAX=64*1024;
  var DRAFT_IDLE_MS=1000;
  var drafts={}, draftTimer=0;
  (function(){
    var saved=null;
    try { saved = JSON.parse(localStorage.getItem(DRAFTS) || 'null'); } catch(x){}
    if(!saved || typeof saved !== 'object') return;
    for(var id in saved){
      var s = saved[id];
      if(Object.prototype.hasOwnProperty.call(saved, id) && typeof s === 'string' && s)
        drafts[id] = {text:s, s:s.length, e:s.length, files:[]};
    }
  })();

  /**
   * Write one topic's draft through to storage and leave every other entry as it is ON DISK: a
   * second tab on this origin keeps drafts of its own, and writing this tab's whole map would put
   * back ones that tab has since sent. Nothing is written when nothing would change.
   */
  function writeDraft(id){
    try {
      var all = JSON.parse(localStorage.getItem(DRAFTS) || 'null') || {};
      var d = drafts[id];
      var want = (d && d.text && d.text.length <= DRAFT_MAX) ? d.text : undefined;
      if(all[id] === want) return;
      if(want === undefined) delete all[id]; else all[id] = want;
      localStorage.setItem(DRAFTS, JSON.stringify(all));
    } catch(x){}
  }

  /**
   * Take the composer's contents off the topic being left. Storage is only consulted when this
   * topic had a draft before or has one now — leaving an empty composer for an empty one, which is
   * most switches, reads and writes nothing.
   */
  function stashDraft(id){
    // Whatever was waiting on a pause in the typing is being done now, for the topic it was typed in.
    clearTimeout(draftTimer); draftTimer=0;
    if(!id) return;
    var had = Boolean(drafts[id]);
    if(input.value || files.length)
      drafts[id] = {text:input.value, s:input.selectionStart, e:input.selectionEnd, files:files};
    else delete drafts[id];
    if(had || drafts[id]) writeDraft(id);
  }

  /**
   * Put a topic's own composer back — an empty one, when it has none. Each step only when it
   * changes something: grow() measures the textarea, which forces a layout in the middle of the
   * switch, and an empty composer replacing an empty one needs neither that nor new chips.
   */
  function loadDraft(id){
    var d = id ? drafts[id] : null;
    var next = d ? d.text : '', list = d ? d.files : [];
    var chipsChange = files.length || list.length;
    files = list;
    if(chipsChange) renderChips();
    if(input.value !== next){ input.value = next; suggest(); grow(); }
    if(d) try { input.setSelectionRange(d.s, d.e); } catch(x){}
  }

  /** Everything this page remembers about one topic, for a topic that no longer exists. */
  function forget(id){
    delete views[id];
    for(var n in unsent) if(Object.prototype.hasOwnProperty.call(unsent, n) && unsent[n].t === id) dropUnsent(n);
    if(!drafts[id]) return;
    delete drafts[id];
    writeDraft(id);
  }

  /**
   * Forget the topics the list no longer carries — deleted here, in another tab, or by a clear.
   * Storage is only touched for a topic that actually had a draft or an unsent message.
   */
  function prune(){
    // An empty list is a list about to be replaced (the page creates a topic in answer), not an
    // instruction to throw every draft away.
    if(!topics.length) return;
    var known={}, id;
    for(var i=0;i<topics.length;i++) known[topics[i].id]=1;
    for(id in views) if(!known[id]) delete views[id];
    for(id in drafts) if(!known[id]) forget(id);
    for(id in unsent) if(Object.prototype.hasOwnProperty.call(unsent, id) && !known[unsent[id].t]) dropUnsent(id);
  }

  // The way out of the page, whichever it is. The hidden transition is "the last reliable time to
  // save app and user data"; beforeunload and unload are not, since on mobile neither fires when a
  // tab or the browser itself is closed (developer.chrome.com, Page Lifecycle API, read
  // 2026-09-29). pagehide is the belt: a second write of an unchanged draft writes nothing.
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'hidden') stashDraft(topic); });
  window.addEventListener('pagehide', function(){ stashDraft(topic); });

  // The rename argument exists for the clipboard, which is the one source that hands over files
  // the browser has already named badly — see the paste handler below. Everything else passes
  // the name through, and this stays the single place a file becomes a chip.
  function take(list, rename){
    // The topic this is being attached in, fixed now: FileReader answers a turn or more later, and
    // a topic switched to in between must not receive a file picked in the one before it.
    var into = topic;
    for(var i=0;i<list.length;i++){
      (function(f){
        var r=new FileReader();
        r.onload=function(){
          var s=String(r.result), c=s.indexOf(',');
          var file={name:(rename ? rename(f) : f.name) || 'file', mime:f.type||'', data:c<0?'':s.slice(c+1)};
          if(!into || into === topic){ files.push(file); renderChips(); return; }
          var d = drafts[into] || (drafts[into] = {text:'', s:0, e:0, files:[]});
          d.files.push(file);
        };
        r.readAsDataURL(f);
      })(list[i]);
    }
  }

  // Every engine calls a pasted screenshot 'image.png', so two of them in one message would
  // arrive as two attachments neither the chips nor the agent can tell apart. A counter is
  // enough: the name only has to be distinct within the message being composed.
  var pastes = 0;
  function pastedName(f){
    var type = f.type || 'image/png';
    var slash = type.indexOf('/');
    var ext = slash > 0 ? type.slice(slash+1).split(';')[0].split('+')[0] : 'png';
    pastes++;
    return 'pasted-' + pastes + '.' + ext;
  }

  picker.addEventListener('change', function(){ take(picker.files); picker.value=''; });
  $('attach').addEventListener('click', function(){ picker.click(); });
  document.addEventListener('dragover', function(e){ e.preventDefault(); });
  document.addEventListener('drop', function(e){
    e.preventDefault();
    if(e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files);
  });
  // Ctrl-V of a screenshot, which is the thing most worth showing an agent and the slowest to
  // get to it any other way. On the document rather than the textarea: the composer is not
  // necessarily focused after clicking a topic or a button, and a paste that reaches nothing is
  // indistinguishable from a broken feature. The login field is the only other paste target on
  // the page and a file is not a token, so nothing is taken away from it.
  //
  // preventDefault only once a file has actually been picked up. A clipboard carrying an image
  // usually carries an img tag in text/html beside it — swallowing that is the point — but a
  // plain text paste must still land in the textarea the ordinary way.
  document.addEventListener('paste', function(e){
    var items = e.clipboardData && e.clipboardData.items;
    if(!items) return;
    var found = [];
    for(var i=0;i<items.length;i++){
      if(items[i].kind !== 'file') continue;
      var f = items[i].getAsFile();
      if(f) found.push(f);
    }
    if(!found.length) return;
    e.preventDefault();
    take(found, pastedName);
  });

  /**
   * The voice-message button: tap to record, tap again to send.
   *
   * A recording is sent the moment it stops, as a message of its own, and the composer is left
   * alone. Both halves are load-bearing. The daemon transcribes a message that is audio and NOTHING
   * else (core/voice.ts) — a recording sent together with a half-typed draft would be read as a
   * file with a caption, and handed to the agent untranscribed. And whatever was being typed is
   * the user's, so recording must not cost it.
   *
   * The format is the browser's to choose, in this order: Ogg/Opus (Firefox), WebM/Opus
   * (Chromium), MP4/AAC (Safari) — the transcriber takes all three. Capped at ten minutes, which
   * is far past any voice message and well inside what the daemon will transcribe; at the cap it
   * stops and sends rather than discarding what was said. Esc throws a recording away.
   */
  var micBtn=$('mic'), rec=null, recStarting=false, voices=0;
  var MIC_TYPES=['audio/ogg;codecs=opus','audio/webm;codecs=opus','audio/mp4','audio/webm'];
  var MIC_MAX_MS=10*60*1000;
  micBtn.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  function recordType(){
    for(var i=0;i<MIC_TYPES.length;i++){
      try { if(MediaRecorder.isTypeSupported(MIC_TYPES[i])) return MIC_TYPES[i]; } catch(e){}
    }
    return '';
  }
  function micLabel(){
    if(!rec){ micBtn.innerHTML='&#127908;'; micBtn.classList.remove('rec'); micBtn.title='Record a voice message'; return; }
    var s=Math.floor((Date.now()-rec.started)/1000);
    micBtn.textContent='\\u25A0 '+Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);
    micBtn.classList.add('rec');
    micBtn.title='Stop and send the recording (Esc discards it)';
  }
  function micFailed(e){
    recStarting=false;
    note.textContent='Could not record: '+((e && (e.message || e.name)) || 'the microphone is unavailable')+'.';
    micLabel();
  }
  function releaseMic(r){ r.stream.getTracks().forEach(function(t){ t.stop(); }); }
  function voiceExt(mime){ var sub=mime.split('/')[1] || 'webm'; return sub==='mp4' ? 'm4a' : sub; }

  function startRec(){
    recStarting=true;
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      recStarting=false;
      var type=recordType(), mr;
      try { mr = type ? new MediaRecorder(stream, {mimeType:type}) : new MediaRecorder(stream); }
      catch(e){ stream.getTracks().forEach(function(t){ t.stop(); }); micFailed(e); return; }
      var r={mr:mr, stream:stream, type:type, parts:[], started:Date.now(), keep:true, timer:0, cap:0};
      mr.ondataavailable=function(ev){ if(ev.data && ev.data.size) r.parts.push(ev.data); };
      mr.onstop=function(){
        releaseMic(r);
        if(!r.keep || !r.parts.length) return;
        var mime=(mr.mimeType || r.type || 'audio/webm').split(';')[0];
        var fr=new FileReader();
        fr.onload=function(){
          var s=String(fr.result), c=s.indexOf(',');
          voices++;
          dispatch('', [{name:'voice-'+voices+'.'+voiceExt(mime), mime:mime, data:c<0?'':s.slice(c+1)}]);
        };
        fr.readAsDataURL(new Blob(r.parts, {type:mime}));
      };
      rec=r;
      mr.start();
      r.timer=setInterval(micLabel, 1000);
      r.cap=setTimeout(function(){ stopRec(true); }, MIC_MAX_MS);
      note.textContent='';
      micLabel();
    }, micFailed);
  }
  function stopRec(keep){
    var r=rec;
    if(!r) return;
    rec=null;
    r.keep=keep;
    clearInterval(r.timer); clearTimeout(r.cap);
    micLabel();
    try { r.mr.stop(); } catch(e){ releaseMic(r); }
  }
  micBtn.addEventListener('click', function(){
    if(rec) stopRec(true);
    else if(!recStarting && topic) startRec();
  });
  // Escape throws a recording away — unless it is an IME cancelling its candidate list, which is
  // a different Escape and must not also cost the recording.
  document.addEventListener('keydown', function(e){
    if(e.isComposing) return;
    if(e.key === 'Escape' && rec) stopRec(false);
  });

  function suggest(){
    var v=input.value;
    var picked=takesArg(v);
    if(picked){
      hints.innerHTML='<span class="arg-hint"><b>/'+text(picked.name)+' &lt;'+text(picked.options[0].name)+'&gt;</b> — '+text(picked.description)+'</span>';
      hints.hidden=false;
      return;
    }
    if(v.charAt(0)!=='/' || v.indexOf(' ')>=0 || v.indexOf('\\n')>=0){ hints.hidden=true; hints.innerHTML=''; return; }
    var q=v.slice(1).toLowerCase();
    var hit=commands.filter(function(c){ return c.name.indexOf(q)===0; }).slice(0,8);
    if(!hit.length){ hints.hidden=true; hints.innerHTML=''; return; }
    var h='';
    for(var i=0;i<hit.length;i++) h += '<button type="button" data-cmd="'+text(hit[i].name)+'" title="'+text(hit[i].description)+'">/'+text(hit[i].name)+'</button>';
    hints.innerHTML=h; hints.hidden=false;
  }

  /**
   * The command just chosen, when it takes an argument and nothing has been typed after it yet —
   * "/super " and no job. The list it was picked from has gone by then, and with it the only place
   * its description was (a button's title, which a phone never shows), so the hint row says what
   * comes next instead. Gone at the first character typed.
   */
  function takesArg(v){
    if(v.charAt(0)!=='/' || v.charAt(v.length-1)!==' ') return null;
    var name=v.slice(1,-1);
    for(var i=0;i<commands.length;i++){
      var c=commands[i];
      if(c.name===name && c.options && c.options.length) return c;
    }
    return null;
  }

  hints.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('button[data-cmd]') : null;
    if(!b) return;
    input.value='/'+b.getAttribute('data-cmd')+' ';
    suggest(); input.focus(); grow();
  });

  /**
   * The request bodies of sends that have not been acknowledged, by nonce — what Retry re-posts.
   *
   * In memory only: the body carries the attachments as base64, which is not something to write
   * into localStorage. What IS written down is the message itself, in unsent below; a text-only
   * body is rebuilt from that after a reload, so only a message that carried files loses its Retry.
   */
  var outbox = {};

  /**
   * Every message sent from this page that the daemon has not acknowledged, by nonce, written
   * through to localStorage at the moment it is sent — before the request leaves, and before the
   * composer's draft is cleared, so there is no instant at which the text is in neither place.
   *
   * This is what a connection that goes away mid-send costs nothing of. A Cloudflare Access session
   * that expires answers every request with a redirect to its sign-in page, so the send fails, the
   * stream cannot reconnect, and the only way back is a reload; a dead link is the same with a grey
   * bubble instead of a red one. Before this the bubble was all there was of the message: one still
   * in flight at the reload was gone, and one that had failed came back from the transcript cache
   * only to be sorted above the whole topic by the first sync. And a send still in flight when the
   * topic was switched away from failed with no bubble left to turn red.
   *
   * A record goes when the daemon has it — a 2xx, or its echo, in an event or in a sync — or when
   * it is discarded, or its topic is. { t: topic, x: text, n: file names, at, s: 'sending' |
   * 'failed' | 'unsure', g: the daemon's epoch when it was sent }. Text over DRAFT_MAX is kept in
   * memory only, for the same reason a draft that long is.
   */
  var UNSENT='aa_unsent';
  var unsent={};
  (function(){
    var saved=null;
    try { saved = JSON.parse(localStorage.getItem(UNSENT) || 'null'); } catch(x){}
    if(!saved || typeof saved !== 'object') return;
    for(var n in saved){
      var r = saved[n];
      if(!Object.prototype.hasOwnProperty.call(saved, n) || !r || typeof r.t !== 'string' || typeof r.x !== 'string') continue;
      // Anything not known to have failed was on its way when the last page went away, and nothing
      // that page saw can say how that ended. The first sync can.
      unsent[n] = {t:r.t, x:r.x, n:Array.isArray(r.n) ? r.n.map(String) : [], at:Number(r.at) || 0,
        s:r.s === 'failed' ? 'failed' : 'unsure', g:Number(r.g) || 0};
    }
  })();

  /**
   * Write one record through, leaving every other one as it is ON DISK — a second tab on this origin
   * has sends of its own, and its record must not be put back after it has been acknowledged there.
   */
  function writeUnsent(nonce){
    try {
      var all = JSON.parse(localStorage.getItem(UNSENT) || 'null') || {};
      var r = unsent[nonce];
      if(r && r.x.length <= DRAFT_MAX) all[nonce] = r;
      else if(Object.prototype.hasOwnProperty.call(all, nonce)) delete all[nonce];
      else return;
      var left = false;
      for(var k in all) if(Object.prototype.hasOwnProperty.call(all, k)){ left = true; break; }
      if(left) localStorage.setItem(UNSENT, JSON.stringify(all)); else localStorage.removeItem(UNSENT);
    } catch(x){}
  }

  function dropUnsent(nonce){
    if(!unsent[nonce]) return;
    delete unsent[nonce];
    writeUnsent(nonce);
  }

  /** The bubble for one record, in the shape dispatch draws one. */
  function localMsg(nonce, r){
    return { id:'p:'+nonce, _local:1, _nonce:nonce, _state:r.s, _text:r.x,
      own:true, html:localBody(r.x, r.n), at:r.at, buttons:[], reactions:[] };
  }

  /**
   * Draw what was sent into this topic and not acknowledged, oldest first, where it is not drawn
   * already. A text-only one gets its body back, which is all Retry needs; nonce and all, so a Retry
   * of one that did land is answered as the duplicate it is.
   */
  function showUnsent(tId){
    var list=[];
    for(var n in unsent){
      if(Object.prototype.hasOwnProperty.call(unsent, n) && unsent[n].t === tId && !data['p:'+n]) list.push(n);
    }
    if(!list.length) return;
    list.sort(function(a, b){ return unsent[a].at - unsent[b].at; });
    var stick = atBottom();
    for(var i=0;i<list.length;i++){
      var r = unsent[list[i]];
      if(!outbox[list[i]] && !r.n.length) outbox[list[i]] = {topic:r.t, text:r.x, nonce:list[i]};
      data['p:'+list[i]] = localMsg(list[i], r);
      paint('p:'+list[i]);
    }
    sinkLocals();
    syncEmptyNote();
    if(stick) toBottom();
  }

  /**
   * After a sync: a message restored as 'unsure' that it did not claim never arrived — provided the
   * daemon that answered is the one it was sent to. A restarted one starts with an empty ring, so
   * its silence says nothing, and the message goes on saying it does not know.
   */
  function settleUnsure(){
    for(var n in unsent){
      if(!Object.prototype.hasOwnProperty.call(unsent, n)) continue;
      var r = unsent[n];
      if(r.t === topic && r.s === 'unsure' && r.g && r.g === epoch) setLocal(n, 'failed');
    }
  }

  /**
   * A failure out of a transcript cache written before unsent existed, when the cache was where a
   * failed message was kept. Moved here, because the cache no longer carries local messages and the
   * next write of it would otherwise lose this one a reload later.
   */
  function adoptLegacy(m){
    var n = m._nonce;
    if(!n || unsent[n]) return false;
    var t = document.createElement('template');
    t.innerHTML = String(m.html || '');
    var chips = t.content.querySelectorAll('.files .chip'), names = [];
    for(var i=0;i<chips.length;i++) names.push(chips[i].textContent);
    unsent[n] = {t:topic, x:String(m._text || ''), n:names, at:Number(m.at) || 0, s:'failed', g:0};
    writeUnsent(n);
    return true;
  }

  /**
   * The same shape renderBody builds server-side, minus the pictures, so the echo can replace it in
   * place. The pictures arrive with the echo: they are served from the daemon's copy, and drawing
   * them here would mean putting the whole file into this bubble as a data: URL — which a bubble
   * rebuilt from unsent after a reload could not do again, since unsent keeps names and never bytes.
   */
  function localBody(typed, names){
    var h = '<div class="raw">'+text(typed)+'</div>';
    if(!names.length) return h;
    var chips='';
    for(var i=0;i<names.length;i++) chips += '<span class="chip">'+text(names[i])+'</span>';
    return h + '<div class="files">'+chips+'</div>';
  }

  /**
   * Show the message, then send it — in that order, and independently.
   *
   * Waiting for the daemon's echo to draw it meant a visibly empty transcript for as long as the
   * round trip took, and on a request that failed after its retries it meant the text was gone:
   * out of the composer, never into the conversation, nowhere to copy it back from. The local
   * bubble is the message until the echo claims it, and if nothing ever claims it, it stays and
   * says so.
   */
  function send(){
    var typed = input.value;
    if(!typed.trim() && !files.length) return;
    var attached = files;
    input.value=''; files=[]; renderChips(); suggest(); grow();
    // Dispatched first, because dispatch is what writes the message down as unsent. Only then is
    // the stored draft of this topic cleared — left on disk, a reload would put it back in the
    // composer to be sent again.
    dispatch(typed, attached);
    stashDraft(topic);
  }

  /**
   * Send a command on behalf of a control (Stop, the power button): exactly what typing it would
   * post — same bubble, same nonce, same echo — so the daemon has one way to be told and the
   * transcript records the command like any other.
   *
   * The composer is left alone on purpose. A half-written prompt is what someone reaching for Stop
   * mid-reply is most likely to have in there, and pressing it must not cost them that.
   */
  function command(text){
    if(topic) dispatch(text, []);
  }

  function dispatch(typed, attached){
    var nonce = Math.random().toString(36).slice(2)+Date.now().toString(36);
    var body = {topic:topic, text:typed, nonce:nonce};
    var names = [];
    for(var i=0;i<attached.length;i++) names.push(attached[i].name);
    if(attached.length) body.files = attached;
    outbox[nonce] = body;
    unsent[nonce] = {t:topic, x:typed, n:names, at:Date.now(), s:'sending', g:epoch};
    writeUnsent(nonce);
    data['p:'+nonce] = localMsg(nonce, unsent[nonce]);
    paint('p:'+nonce);
    syncEmptyNote();
    // Unconditionally, unlike an arriving message: you have just written this one, so wherever
    // you were in the history is not where you want to be now.
    toBottom();
    deliver(nonce);
  }

  /**
   * Post one queued message, for the first time or on a Retry.
   *
   * The same nonce goes out every time on purpose: the server remembers the last 64 and answers
   * a repeat as if it were the original, so a Retry after a request that actually landed cannot
   * duplicate the message — and the echo of the first attempt retires this bubble either way.
   */
  function deliver(nonce){
    var body = outbox[nonce];
    if(!body) return;
    setLocal(nonce, 'sending');
    // post() can throw before it returns a promise — JSON.stringify on a body too big for the
    // engine to build as one string. Left to escape, the bubble stayed 'sending' for ever, because
    // nothing was attached that could ever change it; as a rejection it becomes a failure, with
    // Copy and Discard, like any other message that did not go.
    var sent;
    try { sent = post('api/send', body, 2, sendLimit(body)); }
    catch(x){ sent = Promise.reject(x); }
    sent.then(function(r){
      setLocal(nonce, (r && r.ok) ? 'sent' : 'failed');
    }, function(){
      setLocal(nonce, 'failed');
    });
  }

  function setLocal(nonce, state){
    // The record first, and whether or not the bubble is on screen: a send still in flight when its
    // topic was switched away from settles here too, and the record is all that is left of it. A
    // 2xx is the daemon holding the message, so from there on its ring is what has it. Only a
    // change is written — a first attempt is already on disk as 'sending', put there by dispatch.
    var r = unsent[nonce];
    if(r && r.s !== state){
      if(state === 'sent') delete unsent[nonce]; else r.s = state;
      writeUnsent(nonce);
    }
    var key='p:'+nonce, m=data[key];
    if(!m) return;
    // Measured before the repaint: a failure grows the bubble by a warning line and three
    // buttons, and a reader sitting at the bottom would otherwise have the new controls pushed
    // off the screen they were just looking at.
    var stick = atBottom();
    m._state = state;
    paint(key);
    if(stick) toBottom();
  }

  /**
   * Put the text of a failed message on the clipboard.
   *
   * With a fallback, because navigator.clipboard does not exist on an insecure origin and
   * plain http is exactly how this page is expected to be reached on a LAN. The button says
   * which way it went rather than reporting success it did not have.
   */
  function copyLocal(nonce, btn){
    var m=data['p:'+nonce]; if(!m) return;
    var said=function(ok){ btn.textContent = ok ? 'Copied' : 'Select it above'; };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(m._text).then(function(){ said(true); }, function(){ said(fallbackCopy(m._text)); });
      return;
    }
    said(fallbackCopy(m._text));
  }

  function fallbackCopy(s){
    try {
      var ta=document.createElement('textarea');
      ta.value=s;
      ta.setAttribute('readonly','');
      ta.style.position='fixed';
      ta.style.top='-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok=document.execCommand('copy');
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch(x){ return false; }
  }

  function discardLocal(nonce){
    delete outbox[nonce];
    dropUnsent(nonce);
    drop('p:'+nonce);
    // For a failure an older page kept in the transcript cache: rewritten without it, or the next
    // read of the cache would bring it back.
    cacheSave();
  }

  input.addEventListener('input', function(){
    grow(); suggest();
    // Re-armed by every key, so it fires once typing pauses. stashDraft is what clears it, and every
    // switch calls that for the topic being left, so this never lands on the wrong one.
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function(){ stashDraft(topic); }, DRAFT_IDLE_MS);
  });
  /**
   * Enter sends and Shift-Enter writes a newline — except under the narrow-screen layout, where
   * the two are the other way round.
   *
   * 1.22.0 made Enter a newline on every width, and the half of that which was right is the
   * phone: held upright there is no Shift key to hold down, so Enter-to-send makes a multi-line
   * prompt impossible to type rather than merely awkward, and a stray Enter costs a half-written
   * one. Neither is true of a keyboard, where Shift-Enter is right there and every other chat
   * app on that screen sends on Enter — paying the cost of the phone's problem on a desktop buys
   * nothing. Ctrl/Cmd-Enter sends on both, so what 1.22.0 taught still works.
   *
   * narrow() is read per keypress rather than once: rotating a phone and dragging a window both
   * change the answer, and it is the same breakpoint the CSS uses to decide the layout — where
   * the phone layout applies, the phone's Enter applies.
   */
  input.addEventListener('keydown', function(e){
    // isComposing is an IME candidate being chosen, on either shortcut. It is a keystroke the
    // composer never sees the end of, and sending on it truncates the word being typed.
    if(e.key!=='Enter' || e.isComposing) return;
    if(e.ctrlKey || e.metaKey){ e.preventDefault(); send(); return; }
    if(e.shiftKey || e.altKey || narrow()) return;
    e.preventDefault(); send();
  });
  $('composer').addEventListener('submit', function(e){ e.preventDefault(); send(); });
  killBtn.addEventListener('click', function(){ command('/kill'); });
  stopBtn.addEventListener('click', function(){ command('/stop'); });

  /**
   * Retire the local bubble this message is the echo of.
   *
   * The node is REUSED rather than replaced: creating another element with the same content
   * would re-run the fade-in and move the scroll under whoever is reading, for a message that
   * has been on screen since it was typed.
   */
  function claim(m){
    if(!m.nonce) return;
    var pk = 'p:' + m.nonce;
    delete outbox[m.nonce];
    dropUnsent(m.nonce);
    if(!els[pk]) return;
    var key = (m.g || epoch) + ':' + m.id;
    if(els[key]){ els[pk].remove(); }
    else {
      els[key]=els[pk];
      sig[key]=sig[pk];
      els[key].setAttribute('data-k', key);
    }
    delete els[pk];
    delete sig[pk];
    delete data[pk];
  }

  // The transcript this browser already has, asked for before anything has been heard from the
  // daemon — which is the point: on a slow link the conversation is on screen long before the
  // stream has said anything, and after a restart it is on screen even though the daemon can no
  // longer produce it. A visit with no ?t= has no topic to ask about yet and is restored from
  // the sync instead.
  restore(topic);

  // What was being typed into this topic before the reload. A visit with no ?t= does not know its
  // topic yet, and picks its draft up from the first sync.
  if(topic && drafts[topic]) loadDraft(topic);

  // And what was sent from it and never acknowledged. The same holds for a visit with no ?t=.
  showUnsent(topic);

  // Reopens the pane a reload arrived in, when ?t= already named a topic. Without one this
  // does nothing and the sync handler picks it up instead.
  applyTerm();

  connect();
})();
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>__TITLE__</title>
<!-- Installable as an app. Every href is relative for the same reason the fetches are: a
     reverse proxy may mount the daemon under a sub-path, and an absolute "/" walks out of it.
     No viewport-fit=cover, deliberately — it would extend the page under the status bar and
     the gesture bar, which is work the browser is already doing correctly, and the composer's
     env(safe-area-inset-bottom) padding is there for the browsers that inset nothing. -->
<link rel="manifest" href="manifest.webmanifest">
<!-- Android paints the status bar this colour in standalone, so the app starts at its own
     background instead of being framed in white. -->
<meta name="theme-color" content="#131313">
<!-- iOS ignores the manifest for both of these. "black" is the closest opaque bar to #131313;
     "black-translucent" would put the clock on top of the chat header. -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<link rel="apple-touch-icon" href="icon.png">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" href="icon.png" sizes="192x192" type="image/png">
<style>${STYLE}</style>
</head>
<body>
__GATE__
<main id="app" hidden>
  <aside id="sidebar" class="panel panel-left">
    <div id="sidebar-header" class="panel-head">
      <span class="panel-title"><span class="panel-title-text">Topics</span><button type="button" class="btn-icon" id="clear-topics" title="Clear all topics" aria-label="Clear all topics"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v7"/><path d="M8.5 9h7v3h-7z"/><path d="M7.5 12h9l2.5 9.5H5z"/><path d="M10 15.5 9.3 21.5"/><path d="M14 15.5l.7 6"/></svg></button></span>
      <button type="button" class="btn-icon add" id="new-topic" data-new="1" title="New topic">+</button>
      <button type="button" class="btn-icon panel-close" id="collapse-sidebar" title="Close (Esc)" aria-label="Close">&times;</button>
    </div>
    <div id="topics"></div>
    <!-- Two menus, one row. Menu holds what is set once per device or visited rarely; Manage
         holds Close idle, with the idle count on its face so the number is still seen without
         opening anything. Both open upward with the same box and the same dismissal (setMenu). -->
    <div id="sidebar-footer" class="panel-foot">
      <button type="button" id="opts-toggle" aria-expanded="false" aria-controls="opts-menu" title="Menu"><span class="opts-gear">⚙&#xFE0E;</span><span class="opts-word"> Menu</span></button>
      <button type="button" id="manage-toggle" aria-expanded="false" aria-controls="manage-menu" title="Close idle agents"><span class="opts-gear"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v7"/><path d="M8.5 9h7v3h-7z"/><path d="M7.5 12h9l2.5 9.5H5z"/><path d="M10 15.5 9.3 21.5"/><path d="M14 15.5l.7 6"/></svg></span><span class="opts-word"> Manage</span><span class="foot-count" id="idle-count"></span></button>
      <div id="opts-menu" class="panel-menu" hidden>
        <!-- The gateway's own settings: agents, models, idle reclaim, scope. A page rather than a
             chat command, because the rows need the width a message never had. -->
        <button type="button" id="settings-open" title="Agents, models and conversation settings for this topic"><span>All settings</span></button>
        <button type="button" id="notify-toggle" hidden aria-pressed="false" title="Notify this device when something needs you"><span>Notifications</span><span class="opt-state" id="notify-state">off</span></button>
        <button type="button" id="calm-toggle" aria-pressed="false" title="Running topics stop pulsing and unread counts go grey; a question, a failure or an unread reply still stands out. This device only."><span>Low attention</span><span class="opt-state" id="calm-state">off</span></button>
        <div class="opts-sep"></div>
        <!-- The gateway's managed skills: a surface of its own, not a setting, which is why it
             was a footer button of its own until the row ran out of width. -->
        <button type="button" id="skills-toggle" title="Skills the gateway gives every agent"><span>Skills</span></button>
      </div>
      <div id="manage-menu" class="panel-menu" hidden>
        <button type="button" id="close-idle" hidden title="End the agent process of every topic that is idle — each conversation is kept">Close idle</button>
        <button type="button" id="no-idle" disabled>No idle agents</button>
      </div>
    </div>
    <div id="sidebar-resize" class="panel-resize" title="Drag to resize · double-click for the default width"></div>
  </aside>
  <div id="backdrop"></div>
  <!-- Filled in and revealed when a picture in the log is tapped. One node reused for every
       image, rather than one per message: the transcript holds hundreds. -->
  <div id="lightbox" hidden><img id="lightbox-img" alt=""></div>
  <!-- A file the agent sent, rendered for reading (openReader). One node for every file, like the
       lightbox; the body is emptied when it closes. A window over the transcript rather than a page
       of its own, so the conversation stays visible around it. tabindex lets the body take focus on
       open, so the keyboard scrolls the document rather than the transcript behind it. -->
  <div id="reader" hidden role="dialog" aria-modal="true" aria-labelledby="reader-name">
    <div id="reader-box">
      <div id="reader-bar">
        <span id="reader-name"></span>
        <a id="reader-get" download>Download</a>
        <button type="button" class="btn-icon" id="reader-close" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div id="reader-body" tabindex="-1"></div>
    </div>
  </div>
  <!-- The gateway's managed skills, as a window over the transcript. One node with two views
       inside it — the list and the open skill — because a skill is edited in place and going
       back is one tap, not a second window. Every write goes to api/skills/op; the store
       behind it is the one the talkcode skills command uses, and its Delete is an archive. -->
  <div id="skills" hidden role="dialog" aria-modal="true" aria-labelledby="skills-title">
    <div id="skills-box">
      <div id="skills-bar">
        <button type="button" class="btn-icon" id="skills-back" title="Back to all skills" aria-label="Back" hidden>&lsaquo;</button>
        <span id="skills-title">Skills</span>
        <span id="skills-count"></span>
        <button type="button" id="skills-new" title="Create a skill">New</button>
        <button type="button" class="btn-icon" id="skills-close" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div id="skills-body">
        <div id="skills-note" hidden></div>
        <div id="skills-list"></div>
        <div id="skills-detail" hidden></div>
      </div>
    </div>
  </div>
  <!-- /setting as a page rather than a message in the transcript. It is filled from the same
       structured screen the daemon already sends (settingsScreen), so the rows, the values and
       the write all stay on the daemon's side; this element only draws them. The bar says where
       they are kept: config.yaml, the same for every topic. -->
  <div id="settings-page" hidden role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div id="settings-box">
      <div id="settings-bar">
        <div class="set-heading">
          <span id="settings-title">Settings</span>
          <span id="settings-topic"></span>
        </div>
        <button type="button" class="btn-icon" id="settings-close" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div id="settings-body"></div>
    </div>
  </div>
  <!-- "Close idle agents", confirmed against the list it will act on (openIdle), then showing what
       happened to each. -->
  <div id="idle-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="idle-title">
    <div id="idle-box">
      <div id="idle-title"></div>
      <p id="idle-why">Each conversation is kept: the next message in a topic starts its agent again where it left off.</p>
      <ul id="idle-list"></ul>
      <div class="idle-acts">
        <button type="button" id="idle-cancel">Cancel</button>
        <button type="button" id="idle-go">Close agents</button>
      </div>
    </div>
  </div>
  <section id="chat">
    <div id="chat-header">
      <button type="button" class="btn-icon" id="expand-sidebar" title="Show topics" hidden>☰</button>
      <span id="topic-title" class="chat-title"></span>
      <!-- /kill, one tap away. Beside the title rather than beside Send because it is about the
           topic — the process behind it — and not about the message being written; shown only
           while there is a process to end, which is the same fact the sidebar dot is lit by.
           An SVG rather than U+23FB: that glyph only arrived in Unicode 9, not every system font
           carries it, and where it is missing it renders as an empty box — which nobody presses. -->
      <button type="button" class="btn-icon" id="kill-agent" hidden
        title="End the agent process — the conversation is kept, and the next message resumes it (/kill)"
        aria-label="End the agent process"><svg viewBox="0 0 24 24" width="14" height="14" fill="none"
        stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path
        d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg></button>
      <span id="topic-status" class="chat-status"></span>
      <!-- Present in the markup but hidden unless the daemon serves a terminal, so the script
           has one thing to reveal rather than one thing to build. -->
      <button type="button" class="btn-icon" id="term-toggle" title="Terminal" hidden>&gt;_</button>
      <!-- Always present, unlike the terminal's: the task panel is the only place on this page
           where scheduled tasks are managed. A clock rather than an emoji for the same reason
           the power button is an SVG — it has to sit on the header's text baseline. -->
      <button type="button" class="btn-icon" id="schedules-toggle" aria-expanded="false" aria-controls="schedules" title="Side tasks" aria-label="Side tasks"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span class="sched-alert" id="sched-alert" hidden></span></button>
    </div>
    <div id="log"></div>
    <div id="typing" hidden>...</div>
    <div id="note"></div>
    <!-- A window, not a mode: the bar is what makes minimize and close two different things.
         The dash hides it and leaves the session connected; the cross ends the session, and is
         rendered only where the daemon was given a way to do that. -->
    <div id="term">
      <div id="term-bar">
        <span id="term-name" class="term-name"></span>
        <button type="button" class="btn-icon" id="term-min" title="Minimize — the terminal keeps running">&#8211;</button>
        <button type="button" class="btn-icon" id="term-end" title="End this terminal session" hidden>&times;</button>
      </div>
      <div id="term-frames"></div>
    </div>
    <div id="bar">
      <!-- The agent's live status. Inside #bar rather than above it so it goes away with the
           composer in terminal mode, and so it reads as part of the place you type. -->
      <div id="status" hidden title="Tap for details"></div>
      <!-- The model switch's list, opened from the model in the status line (openModelPop). -->
      <div id="model-pop" hidden role="dialog" aria-labelledby="mp-heading">
        <div class="mp-head">
          <div class="mp-title"><b id="mp-heading">Model for this topic</b><span id="mp-agent"></span></div>
          <button type="button" class="btn-icon" id="mp-close" title="Close (Esc)" aria-label="Close">&times;</button>
        </div>
        <input id="mp-filter" type="text" placeholder="Filter models" aria-label="Filter models" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div id="mp-list" role="listbox" aria-labelledby="mp-heading"></div>
        <p class="mp-foot">This topic only, like <code>/model</code>. Each agent's default is in Settings.</p>
      </div>
      <div id="hints" hidden></div>
      <div id="chips"></div>
      <form id="composer">
        <div id="row">
          <textarea id="input" rows="1" placeholder="Message" autocomplete="off"></textarea>
          <input id="picker" type="file" multiple hidden>
          <button type="button" id="attach" title="Attach a file">+</button>
          <!-- A voice message: tap to record, tap again to send it on its own. Hidden where the
               browser cannot record (no MediaRecorder, or an insecure origin, where
               navigator.mediaDevices does not exist at all). -->
          <button type="button" id="mic" title="Record a voice message" hidden>&#127908;</button>
          <!-- /stop, while there is a turn to stop. Beside Send because that is where the eye
               already is while a reply streams in, and separate from it because the composer
               still sends mid-turn (into the running turn, or queued behind it) — neither of
               which is "stop". -->
          <button type="button" id="stop-turn" title="Stop what the agent is doing — the conversation is kept (/stop)" hidden>Stop</button>
          <!-- A tooltip is a pointer's affordance, so it names the pointer's shortcut: under the
               narrow-screen layout Enter writes a newline, but nothing there can hover to read
               this. Ctrl-Enter sends on both and is what that layout's users are left with. -->
          <button type="submit" title="Send (Enter)">Send</button>
        </div>
      </form>
    </div>
  </section>
  <!-- The side panel: the same .panel as the sidebar, on the right. A column of its own on a wide
       screen and a drawer below 1024px; the stylesheet decides which of the two it is from the
       width, and .collapsed is what moves it off-screen either way. Outside #chat because it is
       about the gateway, not about the topic being read. -->
  <aside id="schedules" class="panel panel-right" aria-label="Side tasks">
    <!-- The docked panel's width, dragged like the sidebar's. Not offered below 1024px, where
         the panel is a drawer and the screen decides its width. -->
    <div id="sched-resize" class="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize · double-click for the default width"></div>
    <div id="schedules-head" class="panel-head">
      <div class="sched-heading">
        <span class="panel-title">Side tasks</span>
        <span id="schedules-summary" class="sched-summary"></span>
      </div>
      <button type="button" class="btn-icon panel-close" id="schedules-close" title="Close (Esc)" aria-label="Close">&times;</button>
    </div>
    <div id="schedules-body">
      <div id="schedules-note" hidden></div>
      <div id="sched-sessions" role="tabpanel" aria-labelledby="sched-tab-sessions" hidden></div>
      <div id="schedules-list" role="tabpanel" aria-labelledby="sched-tab-tasks"></div>
      <div id="sched-reviews" role="tabpanel" aria-labelledby="sched-tab-reviews" hidden>
        <div id="sched-reviews-list"></div>
      </div>
    </div>
    <!-- A task is a definition, a session is one run that opened a topic of its own, and a review
         is what the gateway learned from a conversation afterwards. Three lists, because a run is
         not a task and a review is not either; merging them would make every run look like one.
         The tabs sit at the foot, in the same row the sidebar keeps its menus in, because they
         choose between views of this column rather than heading its content. -->
    <div id="sched-tabs" class="panel-foot" role="tablist" aria-label="Side sessions, tasks and reviews">
      <button type="button" class="sched-tab" id="sched-tab-sessions" role="tab" aria-selected="false" aria-controls="sched-sessions">Sessions <span class="sched-count" id="sched-tab-sessions-n"></span></button>
      <button type="button" class="sched-tab on" id="sched-tab-tasks" role="tab" aria-selected="true" aria-controls="schedules-list">Tasks <span class="sched-count" id="sched-tab-tasks-n"></span></button>
      <button type="button" class="sched-tab" id="sched-tab-reviews" role="tab" aria-selected="false" aria-controls="sched-reviews">Reviews <span class="sched-count" id="sched-tab-reviews-n"></span></button>
    </div>
  </aside>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
