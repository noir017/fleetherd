import { z } from 'zod';

/**
 * Per-platform config schemas (the `platforms.<id>` entries in config.yaml).
 *
 * Design: every platform owns a typed schema here — credentials are required fields
 * validated at load time (no more untyped `options` pocket where lark/qq credentials
 * hid without validation while discord fields squatted on the top level). The platform
 * layer owns this file; the central config schema (config/schema.ts) only composes the
 * discriminated union. Adding a platform = profile file + one schema + one line in the
 * union below. Kept as ONE sibling module (not inside each profile) so that config
 * loading never has to import the heavy satori adapter chain.
 *
 * zod note: z.discriminatedUnion requires plain ZodObject members, so cross-field rules
 * (e.g. slack protocol=http needs signing) live in ConfigSchema.superRefine, not here.
 */

/**
 * Response gating for one platform instance ("who/where does the bot listen & respond").
 * These four knobs plus the listen allowlist were previously frozen in EXPERIENCE
 * (`inbound.gating`), which made freeResponseChannels/ignoredChannels dead config —
 * they are per-deployment decisions, so they live on the user surface now. The
 * remaining gating fields (respondInDirect / threadParticipationExempt) stay frozen.
 */
export const ChatGateSchema = z
  .object({
    /**
     * Listen-channel allowlist; empty = all channels.
     *
     * All three channel lists here take the textual address form (`core/conversation.ts`):
     * `<chat>` names a chat AND every topic/thread inside it, `<chat>/<thread>` names one lane.
     * Matched by `addressSelects`, whose doc block records why a bare chat entry has to include
     * its lanes — a Feishu topic-mode group mints a topic id per message, so exact matching made
     * all three lists unusable there.
     */
    channels: z.array(z.string()).default([]),
    /** Whether group/guild channels require an @mention to respond. */
    requireMention: z.boolean().default(true),
    /** Channels that respond without a mention (same address form as `channels`). */
    freeResponseChannels: z.array(z.string()).default([]),
    /** Channels that are fully ignored (same address form as `channels`). */
    ignoredChannels: z.array(z.string()).default([]),
    /** Responding to other bots: none / mentions (only when @-ed) / all. */
    allowBots: z.enum(['none', 'mentions', 'all']).default('none'),
  })
  .default({});
export type ChatGate = z.infer<typeof ChatGateSchema>;

/**
 * Fields shared by every platform instance. Spread into each per-platform object
 * (discriminatedUnion forbids .extend chains that hide the discriminator).
 * slash/autoThread are gated by platform capabilities at runtime — harmless defaults
 * on platforms without those features.
 */
const common = {
  /** Response gating + listen allowlist for this instance. */
  chat: ChatGateSchema,
  /** Register platform-native slash commands (where the platform supports runtime registration). */
  slash: z.boolean().default(true),
  /** Auto-thread policy: off = none / perTurn = open one thread per turn (thread-capable platforms only). */
  autoThread: z.enum(['off', 'perTurn']).default('off'),
  /** Thread auto-archive duration (minutes); Discord accepts only 60/1440/4320/10080. */
  threadAutoArchiveMinutes: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .default(1440),
  /**
   * Rename a conversation's thread to the title the agent generates for it.
   *
   * On by default, because a topic named after what is being discussed is the point of having
   * topics, and the alternative — every lane keeping the placeholder it was created with — is what
   * this setting exists to end. Gated at runtime by `capabilities.renameThread`, so it is inert on
   * platforms that cannot do it.
   *
   * Turn it off when the lane names are yours to curate: with it on, a new title from the harness
   * WILL overwrite a name you set by hand (the Bot API cannot report a topic's current name, so
   * "was this renamed by a human" is not a question that can be answered — only "is it what we
   * last set"). That is the deliberate trade for keeping the name current.
   */
  autoRenameThread: z.boolean().default(true),
};

export const DiscordConfigSchema = z.object({
  type: z.literal('discord'),
  token: z.string().min(1).describe('Discord bot token'),
  /**
   * Gateway IDENTIFY intents bitmask override. Adapter default includes
   * GUILD_MESSAGES|MESSAGE_CONTENT; an override MUST keep MESSAGE_CONTENT or text
   * message content comes through empty (privileged intent).
   */
  intents: z.number().int().optional(),
  /** If set, register slash commands at guild level (effective immediately); otherwise global (~1h propagation). */
  commandGuildId: z.string().optional(),
  ...common,
});

export const TelegramConfigSchema = z.object({
  type: z.literal('telegram'),
  token: z.string().min(1).describe('Telegram bot token (from BotFather)'),
  ...common,
});

export const SlackConfigSchema = z.object({
  type: z.literal('slack'),
  appToken: z.string().min(1).describe('Slack app-level token (xapp-…, for Socket Mode)'),
  botToken: z.string().min(1).describe('Slack bot OAuth token (xoxb-…, for send/reaction)'),
  /** ws = Socket Mode (default, no public URL); http = Events API (requires signing). */
  protocol: z.enum(['ws', 'http']).default('ws'),
  /** Signing secret (request verification); required when protocol=http (enforced in ConfigSchema.superRefine). */
  signing: z.string().optional(),
  ...common,
});

export const LarkConfigSchema = z.object({
  type: z.literal('lark'),
  appId: z.string().min(1).describe('Lark / Feishu App ID'),
  appSecret: z.string().min(1).describe('Lark / Feishu App Secret'),
  /** API endpoint: feishu (default, cn) or lark (global). Was `options.platform` in v0. */
  endpoint: z.enum(['feishu', 'lark']).default('feishu'),
  /** ws (default, no public callback) or http (webhook subscription; needs selfUrl below). */
  protocol: z.enum(['ws', 'http']).default('ws'),
  // http-protocol-only fields (webhook subscription):
  selfUrl: z.string().optional(),
  path: z.string().optional(),
  encryptKey: z.string().optional(),
  verificationToken: z.string().optional(),
  verifyToken: z.boolean().optional(),
  verifySignature: z.boolean().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ...common,
});

export const QQConfigSchema = z.object({
  type: z.literal('qq'),
  appId: z.string().min(1).describe('QQ bot AppID'),
  /** AppSecret (clientSecret, exchanged for an access_token) — NOT the platform token. Was `options.secret`. */
  secret: z.string().min(1).describe('QQ bot AppSecret'),
  /** Bot domain type. Was `options.type` in v0 (renamed: clashes with the discriminator). */
  botType: z.enum(['public', 'private']).describe('QQ bot type (public/private domain)'),
  sandbox: z.boolean().default(false),
  /** Gateway intents override; must include INTERACTIONS for button clicks. Default derived from botType. */
  intents: z.number().int().optional(),
  protocol: z.enum(['websocket', 'webhook']).default('websocket'),
  ...common,
});

export const LineConfigSchema = z.object({
  type: z.literal('line'),
  token: z.string().min(1).describe('LINE channel access token'),
  secret: z.string().min(1).describe('LINE channel secret (webhook signature)'),
  /** Public callback URL (LINE POSTs to <selfUrl>/line; also used for the media proxy). Required — without it the webhook silently degrades. */
  selfUrl: z.string().min(1).describe('LINE webhook public URL'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  ...common,
});

export const WecomConfigSchema = z.object({
  type: z.literal('wecom'),
  corpId: z.string().min(1).describe('WeCom CorpID'),
  agentId: z.string().min(1).describe('WeCom AgentID'),
  secret: z.string().min(1).describe('WeCom app secret (AppSecret)'),
  /** Callback verification token (was top-level platform.token in v0). */
  token: z.string().min(1).describe('WeCom callback verification token'),
  aesKey: z.string().min(1).describe('WeCom callback EncodingAESKey'),
  /** Public callback URL (callback path is <selfUrl>/wecom). Required — inbound silently hangs without it. */
  selfUrl: z.string().min(1).describe('WeCom webhook public callback URL'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  ...common,
});

export const DingtalkConfigSchema = z.object({
  type: z.literal('dingtalk'),
  appkey: z.string().min(1).describe('DingTalk app AppKey (Client ID)'),
  secret: z.string().min(1).describe('DingTalk app AppSecret (Client Secret)'),
  /** Optional AgentId; only used to resolve the bot's display name/avatar. */
  agentId: z.number().int().optional(),
  /** ws = Stream mode (default, no public callback) or http = webhook (POST <public host>/dingtalk; needs host/port below). */
  protocol: z.enum(['ws', 'http']).default('ws'),
  // http-protocol-only fields (webhook server):
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ...common,
});

/**
 * The built-in web UI: a browser chat page this daemon serves itself.
 *
 * The only platform here with no account, no bot token and no upstream service — which is
 * the point of it. It is also the only one that opens a port for HUMANS rather than for a
 * platform's webhook, so four of its fields are security decisions rather than connection
 * details, and all four are documented where the operator will read them.
 */
export const WebuiConfigSchema = z.object({
  type: z.literal('webui'),
  /**
   * Shared secret for the login page. Required, and required for a reason: behind this page
   * is an agent the daemon grants full tool access, and `host` below defaults to every
   * interface. Use `${VAR}` and keep it out of the file.
   *
   * Still required when `sso` below is configured, and deliberately so — the wizard's prompts
   * are generated from this shape, so an optional field is a field nobody is ever asked for,
   * and a deployment that later removes the `sso:` block would quietly become an open port.
   * Set `sso.password: false` to stop this secret from being a door without removing it.
   */
  token: z.string().min(1).describe('Shared login secret for the web UI'),
  /**
   * Interface to bind.
   *
   * `0.0.0.0` by default, because a gateway whose whole purpose is reaching your agent from
   * elsewhere is not useful bound to loopback. That default is safe only because `token` is
   * mandatory; there is no TLS here, so put a reverse proxy in front before this crosses
   * anything you do not control. Set `127.0.0.1` to reach it over an SSH tunnel instead.
   */
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(8787),
  /**
   * The page's `<title>`, and the only text on it that is not conversation.
   *
   * Configurable because a deliberately unremarkable title is the difference between a tab
   * someone glances past and one they ask about. The default says nothing.
   */
  title: z.string().default('Chat'),
  /**
   * Single sign-on: let an identity-aware proxy in front decide who gets in.
   *
   * Absent by default, and worth setting up the moment this page is reachable from anywhere
   * you do not control. `token` above is one secret shared by everyone who has it, with no
   * name on it and no way to revoke it for one person; a proxy like Cloudflare Access or
   * Teleport's Application Service has already authenticated a *person* — SSO, MFA, an access
   * list the operator maintains where they maintain everything else — and says so in a JWT it
   * signed. This block is what makes the daemon check that signature instead of asking for a
   * password a second time.
   *
   * Every field that decides *who* is let in is required, with no default: a permissive
   * default here would be one typo away from accepting any token the provider ever signed,
   * including one minted for a different application. See `webui/sso.ts`.
   */
  sso: z
    .object({
      /**
       * Where the assertion is. Defaults to Cloudflare Access's header; Teleport sets
       * `Teleport-Jwt-Assertion`.
       */
      header: z.string().default('Cf-Access-Jwt-Assertion'),
      /**
       * Cookie to read when the header is absent — `CF_Authorization` for Cloudflare Access.
       * Worth setting: the terminal pane's WebSocket handshake does not always carry the
       * header, and a pane that hangs is harder to diagnose than one that refuses.
       */
      cookie: z.string().optional(),
      /**
       * Where the provider publishes its public keys. Fetched, cached, refetched on rotation.
       *
       * HTTPS, and enforced rather than advised: every guarantee this block makes reduces to
       * "these keys are really the provider's", and one `http://` here hands that to anyone on
       * the path — they substitute a key set and mint themselves an admitted identity. Loopback
       * is the one exception, for a provider stub in a test or on the same machine.
       */
      jwksUrl: z
        .string()
        .url()
        .refine((u) => {
          const parsed = new URL(u);
          return parsed.protocol === 'https:' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
        }, 'sso.jwksUrl must be https (or loopback): over plain http, anyone on the path can substitute the signing keys'),
      /** Exact `iss` the token must carry. */
      issuer: z.string().min(1),
      /**
       * The `aud` the token must carry: Cloudflare's per-application AUD tag, or the app's
       * public address in Teleport. This is what keeps a valid token for some *other* app of
       * the same provider from opening this one.
       */
      audience: z.string().min(1),
      /** Claim naming the person: `email` under Cloudflare Access, `username` under Teleport. */
      claim: z.string().default('email'),
      /** Who may in, matched against that claim, case-insensitively. */
      allow: z.array(z.string().min(1)).min(1),
      /**
       * CIDRs (or bare addresses) the request must arrive from — the proxy, and nothing else.
       *
       * Required rather than optional. The signature is what makes a forged header useless;
       * this is what keeps a mistake in the four fields above from being fatal. A refusal logs
       * the address it came from, which is how you find the value to put here.
       */
      from: z.array(z.string().min(1)).min(1),
      /**
       * Whether the shared secret above is still a way in. Leave it true until SSO is proven
       * working — with `false`, a provider outage means nobody opens this page at all.
       */
      password: z.boolean().default(true),
    })
    .optional(),
  /**
   * The raw terminal pane: a real PTY in this machine, rendered in the page.
   *
   * Off by default, and this is the third security decision in this schema rather than a
   * convenience toggle. Everything else here puts the login secret in front of *talking to an
   * agent*; this puts it in front of *an interactive shell*. The agent already runs with full
   * tool access, so the ceiling is the same — but the distance from a leaked token to
   * arbitrary commands goes from "ask the agent nicely" to "type".
   *
   * The daemon does not own a PTY and never spawns one: it proxies, behind the session
   * cookie, to a `ttyd` already listening on `socket`. So turning this on without that
   * process running is inert rather than dangerous, and the terminal a user sees is whatever
   * that ttyd was told to run — which is what makes the pane work with any CLI at all.
   */
  terminal: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Where ttyd listens. A unix socket, not a port: nothing on the network can reach it,
       * so the session check in front of the proxy is the only way in rather than one of two.
       *
       * Defaults to `term.sock` beside the daemon's own state — resolved in `webui/index.ts`,
       * not here, because `config/schema.ts` imports this file and reaching back to
       * `config/load.ts` for `configDir()` would close the cycle.
       */
      socket: z.string().optional(),
      /**
       * How to END one topic's terminal session — the argv of a command the operator supplies.
       *
       * Absent by default, and its absence is a feature rather than an omission: the pane's
       * close button only exists when this is set, so a deployment that has not answered "what
       * does ending a session even mean here" does not get a button that pretends to.
       *
       * It is configuration rather than code because of the same line `terminal-proxy.ts`
       * draws: the daemon does not own the terminal and must not learn what is behind it. A
       * session survives a closed connection only because the operator's wrapper runs `tmux`
       * — that is *their* arrangement, and `tmux -L aa-web kill-session -t aa-{topic}` is
       * theirs to write. Teaching this process that name would make the pane work with one
       * backend instead of any.
       *
       * An argv array, never a shell string: `{topic}` is substituted into each element and
       * then handed to `execFile`, so there is no shell to quote for and no way for the
       * substitution to become a second command. What it substitutes is already narrow — the
       * page's id is matched against `^[0-9a-f]{8}$` and then against the topic store — but
       * the reason it is safe is the missing shell, not the pattern.
       */
      endCommand: z
        .array(z.string().min(1))
        .min(1)
        .refine(
          (argv) => argv.slice(1).some((arg) => arg.includes('{topic}')),
          'terminal.endCommand must use {topic} in an argument, or it would end the same session (or every session) whichever terminal the page asked to close'
        )
        .optional(),
    })
    .default({}),
  /**
   * The file window: browse and edit the files of whichever machine a topic's agent runs on.
   *
   * Off by default, and this is the fourth security decision here rather than a convenience. The
   * page already puts the login secret in front of talking to an agent; opening this puts it in
   * front of WRITING files on the agent's machine — which is running commands by another route, so
   * the distance from a leaked token to arbitrary code becomes a save button. Keep it off unless
   * you would also turn the terminal on.
   *
   * Reach: each topic's working directory, plus `roots`. A path is normalized and must land under
   * one of those; a `..` that climbs out is refused. Symlinks inside a root are followed, so what a
   * link points at is writable through it — a workspace laid out as links into mounted volumes is
   * a normal arrangement, and resolving them would refuse the files this exists for.
   */
  files: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Directories reachable from every topic besides its own working directory. Absolute, or
       * `~/…` (expanded on the machine the agent runs on — a remote agent's home, not this one).
       *
       * Checked for shape at load, because a relative entry would be silently inert: containment
       * is decided against absolute paths, so nothing under a relative root could ever match it.
       */
      roots: z
        .array(
          z
            .string()
            .min(1)
            .refine(
              (p) => /^(?:~(?:\/|$)|\/|[A-Za-z]:[\\/])/.test(p),
              'files.roots entries must be absolute (or start with ~/); a relative one would match nothing'
            )
        )
        .default([]),
    })
    .default({}),
  /**
   * The instruction editor on the settings page: the gateway's `instructions/` files every agent
   * reads (common.md and one per harness), and the files each agent's harness references on its own
   * machine (Claude Code's `@path`).
   *
   * Off by default, and the fifth security decision here. With it on, the login secret guards what
   * every agent — on every platform and every host — reads before every conversation: a change made
   * here is in force for sessions nobody on this page is watching, which a message to one agent never
   * is. Reach is fixed by the daemon, not the page: the gateway's own files by name, and on an agent's
   * machine only the files its harness references at that moment (daemon/instructions-panel.ts).
   */
  instructions: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  /**
   * External Web UI plugins loaded from local directories (each containing `fleetherd-plugin.json`).
   *
   * Empty by default, and the sixth security decision in this schema. A plugin's server module runs
   * in the gateway process with its full permissions, and its client module runs in the signed-in
   * browser session — there is no sandbox. Only config.yaml may configure plugins; no HTTP route,
   * reverse command, or MCP tool can install or modify them.
   */
  plugins: z
    .array(
      z
        .object({
          path: z.string().min(1),
          config: z.unknown().optional(),
        })
        .strict()
    )
    .default([]),
  ...common,
});

/** All platform entry schemas, keyed by type. setup's schema-driven prompts iterate this. */
export const PLATFORM_SCHEMAS = {
  discord: DiscordConfigSchema,
  telegram: TelegramConfigSchema,
  slack: SlackConfigSchema,
  lark: LarkConfigSchema,
  qq: QQConfigSchema,
  line: LineConfigSchema,
  wecom: WecomConfigSchema,
  dingtalk: DingtalkConfigSchema,
  webui: WebuiConfigSchema,
} as const;

/** One entry of the `platforms:` map (discriminated on `type`). */
export const PlatformConfigSchema = z.discriminatedUnion('type', [
  DiscordConfigSchema,
  TelegramConfigSchema,
  SlackConfigSchema,
  LarkConfigSchema,
  QQConfigSchema,
  LineConfigSchema,
  WecomConfigSchema,
  DingtalkConfigSchema,
  WebuiConfigSchema,
]);
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type PlatformType = PlatformConfig['type'];

/** A platform entry plus its map key — what the runtime passes around. */
export type PlatformInstance = PlatformConfig & {
  /** Instance id (the `platforms:` map key). InboundMessage.platform / routing / allowFrom use this. */
  id: string;
};

export type DiscordPlatformConfig = z.infer<typeof DiscordConfigSchema>;
export type TelegramPlatformConfig = z.infer<typeof TelegramConfigSchema>;
export type SlackPlatformConfig = z.infer<typeof SlackConfigSchema>;
export type LarkPlatformConfig = z.infer<typeof LarkConfigSchema>;
export type QQPlatformConfig = z.infer<typeof QQConfigSchema>;
export type LinePlatformConfig = z.infer<typeof LineConfigSchema>;
export type WecomPlatformConfig = z.infer<typeof WecomConfigSchema>;
export type DingtalkPlatformConfig = z.infer<typeof DingtalkConfigSchema>;
export type WebuiPlatformConfig = z.infer<typeof WebuiConfigSchema>;
export type WebuiPluginConfig = WebuiPlatformConfig['plugins'][number];
