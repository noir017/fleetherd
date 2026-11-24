// Example client plugin for fleetherd Web UI.
// Contributes a sidebar view, an activity bar entry, a status bar item, and a ping command.

/**
 * @typedef {import('../../dist/webui-plugin.d.ts').PluginContext} PluginContext
 * @typedef {import('../../dist/webui-plugin.d.ts').PanelComponent} PanelComponent
 * @typedef {{ ok: boolean; id: string; greeting: string; count: number; topics: number; now: string }} PingReply
 */

const EN_DICT = {
  'hello.title': 'Hello Plugin',
  'hello.desc': 'Minimal external plugin demonstrating a sidebar view, a status bar item, and a server route.',
  'hello.ping': 'Ping server',
  'hello.pinging': 'Pinging...',
  'hello.activeTopic': 'Active topic',
  'hello.noTopic': 'None',
  'hello.lastReply': 'Last response',
  'hello.never': 'Not pinged yet',
  'hello.statusIdle': 'Hello',
  'hello.statusCount': 'Hello ({count})',
};

const ZH_DICT = {
  'hello.title': 'Hello 示例插件',
  'hello.desc': '最小外部插件示例：演示侧栏视图、状态栏项与服务端路由调用。',
  'hello.ping': '请求服务端',
  'hello.pinging': '请求中...',
  'hello.activeTopic': '当前话题',
  'hello.noTopic': '无',
  'hello.lastReply': '最近响应',
  'hello.never': '尚未请求',
  'hello.statusIdle': 'Hello',
  'hello.statusCount': 'Hello ({count})',
};

/**
 * @param {PluginContext} ctx
 * @param {() => { loading: boolean; reply: PingReply | null; error: string | null }} getState
 * @param {() => Promise<void>} runPing
 * @param {(listener: () => void) => { dispose(): void }} onUpdate
 * @returns {PanelComponent}
 */
function createHelloView(ctx, getState, runPing, onUpdate) {
  const el = document.createElement('div');
  el.className = 'fh-hello-view';

  const paint = () => {
    const state = getState();
    const active = ctx.topics.active();
    const t = ctx.i18n.t;
    ctx.render(
      ctx.html`
        <div class="fh-hello-header">${t('hello.title')}</div>
        <p class="fh-hello-desc">${t('hello.desc')}</p>
        <div class="fh-hello-card">
          <div class="fh-hello-row">
            <span class="fh-hello-label">${t('hello.activeTopic')}</span>
            <span class="fh-hello-value">${active ? active.title || active.id : t('hello.noTopic')}</span>
          </div>
          <div class="fh-hello-row">
            <span class="fh-hello-label">${t('hello.lastReply')}</span>
            <span class="fh-hello-value">
              ${state.reply
                ? `${state.reply.greeting} (#${state.reply.count}, ${state.reply.topics} topics)`
                : t('hello.never')}
            </span>
          </div>
          ${state.error ? ctx.html`<div class="fh-hello-error">${state.error}</div>` : ''}
        </div>
        <button class="fh-hello-btn" type="button" ?disabled=${state.loading} @click=${() => void runPing()}>
          ${state.loading ? t('hello.pinging') : t('hello.ping')}
        </button>
      `,
      el
    );
  };

  let sub = null;
  return {
    element: el,
    init() {
      sub = onUpdate(paint);
      paint();
    },
    dispose() {
      sub?.dispose();
      sub = null;
    },
  };
}

/** @type {import('../../dist/webui-plugin.d.ts').WebuiPlugin} */
export default {
  id: 'hello',
  activate(ctx) {
    ctx.i18n.add('en', EN_DICT);
    ctx.i18n.add('zh-CN', ZH_DICT);

    /** @type {{ loading: boolean; reply: PingReply | null; error: string | null }} */
    const state = { loading: false, reply: null, error: null };
    const listeners = new Set();
    let statusEl = null;

    const notify = () => {
      paintStatus();
      for (const fn of listeners) fn();
    };

    const onUpdate = (fn) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    };

    const paintStatus = () => {
      if (!statusEl) return;
      const count = state.reply?.count ?? 0;
      statusEl.textContent = count > 0
        ? ctx.i18n.t('hello.statusCount', { count })
        : ctx.i18n.t('hello.statusIdle');
      statusEl.title = state.reply ? `${state.reply.greeting} (${state.reply.now})` : ctx.i18n.t('hello.ping');
    };

    const runPing = async () => {
      if (state.loading) return;
      state.loading = true;
      state.error = null;
      notify();
      try {
        const reply = await ctx.api.get('/api/plugins/hello/ping');
        state.reply = reply;
        ctx.storage.set('lastCount', reply.count);
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
      } finally {
        state.loading = false;
        notify();
      }
    };

    ctx.commands.register('hello.ping', runPing, { title: 'Hello: Ping Server' });

    ctx.views.register({
      id: 'hello.view',
      title: ctx.i18n.t('hello.title'),
      icon: 'bolt',
      part: 'sidebar',
      component: () => createHelloView(ctx, () => state, runPing, onUpdate),
    });

    ctx.activity.register({
      id: 'hello.activity',
      title: ctx.i18n.t('hello.title'),
      icon: 'bolt',
      view: 'hello.view',
      order: 90,
    });

    ctx.statusBar.register({
      id: 'hello.status',
      align: 'right',
      order: 5,
      render(el) {
        statusEl = el;
        el.classList.add('fh-hello-status');
        paintStatus();
      },
      onClick() {
        void runPing();
      },
    });

    ctx.events.on('topic.active', notify);
    ctx.events.on('locale.change', notify);
    ctx.events.on('plugin:hello:ping', (data) => {
      if (data && typeof data === 'object' && typeof data.count === 'number') {
        state.reply = {
          ok: true,
          id: 'hello',
          greeting: typeof data.greeting === 'string' ? data.greeting : 'Hello',
          count: data.count,
          topics: ctx.topics.list().length,
          now: typeof data.now === 'string' ? data.now : '',
        };
        notify();
      }
    });
  },
};
