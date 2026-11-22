import { describe, expect, it } from 'vitest';
import { en, zhCN, tMenus, type MenusMessageKey } from './menus.js';
import { buildAgentMenu, agentListText, type AgentGroup } from '../agent-menu.js';
import {
  buildModelMenu,
  modelSummaryText,
  modelNoSelectorText,
  modelChoiceText,
  modelMenuExpiredText,
  modelMenuSupersededText,
  type ModelOption,
} from '../model-menu.js';
import {
  buildEffortMenu,
  effortSummaryText,
  effortNoSelectorText,
  effortChoiceText,
  effortMenuExpiredText,
  effortMenuSupersededText,
  type EffortOption,
} from '../effort-menu.js';
import {
  buildWorkdirMenu,
  workdirSummaryText,
  workdirChoiceText,
  workdirMenuExpiredText,
  workdirMenuSupersededText,
} from '../workdir-menu.js';
import {
  genericCommandSpecs,
  buildHelpText,
  unconfiguredHarnessCommandText,
} from '../command-translate.js';
import { formatSkillCatalog, formatEmptyCatalog } from '../skills-catalog.js';
import {
  composePermissionPrompt,
  buildAskButtons,
} from '../../daemon/daemon-menus.js';
import type { AgentDef } from '../../config/schema.js';

const mockAgent = (id: string, extra: Partial<AgentDef> = {}): AgentDef =>
  ({ id, harness: 'claude', args: [], env: {}, permissions: 'auto', ...extra }) as AgentDef;

describe('core/i18n/menus', () => {
  describe('dictionary integrity', () => {
    it('has identical keys in en and zh-CN catalogs', () => {
      const enKeys = Object.keys(en).sort();
      const zhKeys = Object.keys(zhCN).sort();
      expect(zhKeys).toEqual(enKeys);
    });

    it('has non-empty values for all keys in both dictionaries', () => {
      for (const [key, val] of Object.entries(en)) {
        expect(val.trim().length, `en key ${key} should not be empty`).toBeGreaterThan(0);
      }
      for (const [key, val] of Object.entries(zhCN)) {
        expect(val.trim().length, `zhCN key ${key} should not be empty`).toBeGreaterThan(0);
      }
    });

    it('has matching interpolation parameters in en and zh-CN', () => {
      const paramRegex = /\{([a-zA-Z0-9_]+)\}/g;
      const linguisticParams = new Set(['plural']);
      for (const key of Object.keys(en) as MenusMessageKey[]) {
        const enParams = Array.from(en[key].matchAll(paramRegex), (m) => m[1] ?? '').filter(Boolean).sort();
        const zhParams = Array.from(zhCN[key].matchAll(paramRegex), (m) => m[1] ?? '').filter(Boolean).sort();
        for (const p of zhParams) {
          expect(enParams, `Parameter {${p}} in zh-CN key "${key}" must exist in en`).toContain(p);
        }
        for (const p of enParams) {
          if (!linguisticParams.has(p)) {
            expect(zhParams, `Data parameter {${p}} in en key "${key}" must exist in zh-CN`).toContain(p);
          }
        }
      }
    });
  });

  describe('tMenus translator', () => {
    it('defaults to English when locale is omitted or en', () => {
      expect(tMenus(undefined, 'cmd_desc_new')).toBe(en.cmd_desc_new);
      expect(tMenus('en', 'cmd_desc_new')).toBe(en.cmd_desc_new);
    });

    it('translates correctly to zh-CN', () => {
      expect(tMenus('zh-CN', 'cmd_desc_new')).toBe(zhCN.cmd_desc_new);
    });

    it('interpolates parameters in both languages', () => {
      expect(tMenus('en', 'cmd_use_agent', { target: 'Claude' })).toBe('Use Claude');
      expect(tMenus('zh-CN', 'cmd_use_agent', { target: 'Claude' })).toBe('使用 Claude');
    });

    it('falls back to English for unknown locales', () => {
      // @ts-expect-error test unknown locale fallback
      expect(tMenus('fr', 'cmd_desc_new')).toBe(en.cmd_desc_new);
    });
  });

  describe('menu and command outputs in zh-CN', () => {
    it('translates generic slash command descriptions and help text', () => {
      const specs = genericCommandSpecs(undefined, 'zh-CN');
      const modelCmd = specs.find((s) => s.name === 'model');
      expect(modelCmd?.description).toBe('查看或更改当前模型');

      const compactCmd = specs.find((s) => s.name === 'compact');
      expect(compactCmd?.description).toBe('压缩会话以释放上下文空间');

      const helpText = buildHelpText(
        {
          agents: [mockAgent('cc')],
          routing: { default: 'cc', pipeline: [] },
        },
        { agent: 'cc', harness: 'claude' },
        undefined,
        'zh-CN'
      );
      expect(helpText).toContain('**网关命令**');
      expect(helpText).toContain('`/new` — 开启新会话（清除当前上下文）');
      expect(helpText).toContain('`/cd` — 选择工作目录（在目标目录开启新会话）');
      expect(helpText).toContain('**Agent 命令**');
      expect(helpText).toContain('**当前 Agent 支持的命令**');
      expect(helpText).toContain('当前应答：**claude**');

      const unconfigured = unconfiguredHarnessCommandText('codex', 'zh-CN');
      expect(unconfigured).toContain('当前未配置 codex Agent');
    });

    it('translates agent menu and list text', () => {
      const groups: AgentGroup[] = [
        {
          name: 'host-a',
          agents: [mockAgent('a1')],
        },
        {
          name: 'host-b',
          offline: true,
          agents: [mockAgent('b1', { harness: 'codex' })],
        },
      ];

      const machineView = buildAgentMenu({
        reqId: 'test1',
        groups,
        current: 'a1',
        pageSize: 10,
        locale: 'zh-CN',
      });
      expect(machineView.text).toContain('选择哪台机器？ (当前: a1)');
      expect(machineView.buttons.some((b) => b.label.includes('离线'))).toBe(true);

      const agentView = buildAgentMenu({
        reqId: 'test2',
        groups,
        group: 0,
        current: 'a1',
        pageSize: 10,
        locale: 'zh-CN',
      });
      expect(agentView.text).toContain('由哪个 Agent 响应此话题 在 host-a 上？');
      expect(agentView.buttons.some((b) => b.label === '‹ 机器列表')).toBe(true);

      const retryView = buildAgentMenu({
        reqId: 'test3',
        groups,
        group: 0,
        current: 'a1',
        pageSize: 10,
        purpose: 'retry',
        locale: 'zh-CN',
      });
      expect(retryView.text).toContain('使用哪个 Agent 重试 在 host-a 上？');

      const listText = agentListText(groups, 'a1', 'zh-CN');
      expect(listText).toContain('可选 Agent（通过 `/agent <id>` 为此话题选择）：');
      expect(listText).toContain('(离线)');
    });

    it('translates model menu and summary text', () => {
      const options: ModelOption[] = [
        { name: 'Claude 3.7 Sonnet', value: 'claude-3-7-sonnet' },
        { name: 'Claude 3.5 Haiku', value: 'claude-3-5-haiku' },
      ];
      const menu = buildModelMenu({
        reqId: 'm1',
        options,
        current: 'claude-3-7-sonnet',
        page: 0,
        pageSize: 10,
        locale: 'zh-CN',
      });
      expect(menu.text).toContain('模型: claude-3-7-sonnet\n共 2 个可用 — 点击选择，或输入 `/model <名称片段>`。');

      const summary = modelSummaryText(
        { current: 'claude-3-7-sonnet', options },
        'zh-CN'
      );
      expect(summary).toContain('模型: claude-3-7-sonnet\n共 2 个可用 — 输入 `/model <名称片段>` 切换（例如 `/model sonnet`）。');

      expect(modelNoSelectorText('zh-CN')).toContain('该 Agent 未提供模型选择器');
      expect(modelMenuExpiredText('zh-CN')).toContain('该模型菜单已过期');
      expect(modelMenuSupersededText('claude-3-7-sonnet', 'zh-CN')).toContain('已被更新的 /model 菜单取代');

      const appliedText = modelChoiceText({ kind: 'applied', model: 'claude-3-7-sonnet' }, 'zh-CN');
      expect(appliedText).toBe('当前会话模型已切换为 `claude-3-7-sonnet`。');
    });

    it('translates effort menu and summary text', () => {
      const options: EffortOption[] = [
        { name: 'Low', value: 'low' },
        { name: 'High', value: 'high' },
      ];
      const menu = buildEffortMenu({
        reqId: 'e1',
        options,
        current: 'high',
        locale: 'zh-CN',
      });
      expect(menu.text).toContain('思考程度: high\n点击选择，或输入 `/effort <级别>`。');

      const summary = effortSummaryText(
        { current: 'high', options },
        'zh-CN'
      );
      expect(summary).toContain('思考程度: high\n可选级别: `low` · `high` — 输入 `/effort <级别>` 切换。');

      expect(effortNoSelectorText('codex', 'gpt-5', 'zh-CN')).toContain('Codex 未为 `gpt-5` 提供思考程度选项');
      expect(effortChoiceText({ kind: 'applied', effort: 'high' }, 'zh-CN')).toBe(
        '当前会话思考程度已设置为 `high`，将从下一条消息起生效。'
      );
      expect(effortMenuExpiredText('zh-CN')).toContain('该思考程度菜单已过期');
      expect(effortMenuSupersededText('high', 'zh-CN')).toContain('已被更新的 /effort 菜单取代');
    });

    it('translates workdir menu and summary text', () => {
      const options = [
        { name: 'proj1', path: '/home/user/proj1' },
        { name: 'proj2', path: '/home/user/proj2' },
      ];
      const menu = buildWorkdirMenu({
        reqId: 'w1',
        options,
        current: '/home/user/proj1',
        page: 0,
        pageSize: 10,
        locale: 'zh-CN',
      });
      expect(menu.text).toContain('工作目录: /home/user/proj1\n共 2 个可用 — 点击选择在此工作（将启动新会话），或输入 `/cd <名称片段>`。');

      const summary = workdirSummaryText('/home/user/proj1', options, 'zh-CN');
      expect(summary).toContain('工作目录: /home/user/proj1');
      expect(summary).toContain('切换目录将在此处启动新会话。');

      const emptySummary = workdirSummaryText('/home/user/proj1', [{ name: 'proj1', path: '/home/user/proj1' }], 'zh-CN');
      expect(emptySummary).toContain('没有其他可选目录 — Agent 根目录下无子目录。');

      expect(workdirChoiceText({ kind: 'applied', path: '/home/user/proj2' }, 'zh-CN')).toBe(
        '已切换至目录 `/home/user/proj2` 工作 — 新会话已启动，之前的上下文已保留在原目录。'
      );
      expect(workdirChoiceText({ kind: 'unchanged', path: '/home/user/proj1' }, 'zh-CN')).toBe(
        '当前已在目录 `/home/user/proj1` 工作 — 会话未重置。'
      );
      expect(workdirMenuExpiredText('zh-CN')).toContain('该目录菜单已过期');
      expect(workdirMenuSupersededText('/home/user/proj1', 'zh-CN')).toContain('已被更新的 /cd 菜单取代');
    });

    it('translates skills catalog', () => {
      const skills = [
        { name: 'build', description: 'Build the project', dir: '/skills/build' },
        { name: 'test', description: 'Run tests', dir: '/skills/test' },
      ];
      const catalog = formatSkillCatalog('Claude', skills, 'zh-CN');
      expect(catalog).toContain('**Claude** 拥有 2 个技能：');
      expect(catalog).toContain('例如 `/build <你的需求>`');

      const empty = formatEmptyCatalog('Claude', ['/path/to/skills'], 'zh-CN');
      expect(empty).toContain('**Claude** 未安装任何技能。');
    });

    it('translates permission prompt and elicit buttons', () => {
      const prompt = composePermissionPrompt('rm -rf /tmp/test', 120_000, undefined, 'zh-CN');
      expect(prompt).toContain('🔐 Agent 请求执行以下操作：');
      expect(prompt).toContain('若 2 分钟内未回复将自动拒绝。');

      const buttons = buildAskButtons('req1', ['Option 1'], new Set([0]), 'zh-CN');
      expect(buttons.some((b) => b.label === '✅ 完成 (1)')).toBe(true);

      const emptyButtons = buildAskButtons('req2', ['Option 1'], new Set(), 'zh-CN');
      expect(emptyButtons.some((b) => b.label === '✅ 完成')).toBe(true);
    });
  });
});
