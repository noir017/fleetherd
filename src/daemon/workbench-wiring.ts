import type { Config } from '../config/schema.js';
import type { ConversationRef } from '../core/conversation.js';
import type { HistoryStore } from '../history/store.js';
import type {
  HistoryPanel,
  ReviewPanel,
  SchedulePanel,
  SchedulePanelDetailResult,
  SchedulePanelFormContext,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
  WorkbenchHost,
} from '../platform/workbench.js';
import type { TopicKillResult } from '../types.js';
import type { ConversationRegistry } from './conversation.js';
import { buildFilesPanel } from './file-panel.js';
import { buildGitPanel } from './git-panel.js';
import { buildHistoryPanel } from './history-panel.js';
import { standingInstructions } from './instructions.js';
import { buildInstructionsPanel } from './instructions-panel.js';
import type { ReviewService } from './review.js';
import { buildReviewPanel } from './review-panel.js';
import type { ReviewStateStore } from './review-state.js';
import { panelEditInput, panelForm, panelNewInput, panelTarget, panelTaskDetail, panelTasks } from './schedule-panel.js';
import type { ScheduleService } from './schedule-service.js';
import { buildSkillsPanel } from './skills-panel.js';
import type { SkillsRepo } from './skills-repo.js';
import { activeSkillNames, type SkillRecord } from './skills-store.js';
import type { VoiceIntake } from './voice.js';

const PANEL_CHANNEL_LIMIT = 50;

export interface WorkbenchWiringDeps {
  readonly instance: string;
  readonly config: () => Config;
  readonly registry: ConversationRegistry;
  readonly schedules: ScheduleService | undefined;
  readonly history: HistoryStore | undefined;
  readonly reviews: ReviewService | undefined;
  readonly reviewState: ReviewStateStore | undefined;
  readonly skillsRepo: SkillsRepo;
  readonly voice: VoiceIntake;
  readonly killTopicTree: (ref: ConversationRef, confirmed: ReadonlySet<string>) => TopicKillResult[];
  readonly notifySkillArchived: (skill: SkillRecord) => void;
}

/** Wire all workbench lookup/panel hooks for one platform instance. */
export function attachWorkbench(wb: WorkbenchHost, deps: WorkbenchWiringDeps): void {
  wb.useWorkdirLookup((ref) => deps.registry.workdirForRef(ref));
  wb.useLivenessLookup((ref) => deps.registry.liveForRef(ref));
  wb.useIdleReclaim((ref) => deps.registry.reclaimIdleForRef(ref));
  wb.useTopicKill((ref, confirmed) => deps.killTopicTree(ref, confirmed));
  wb.useScheduleLookup((ref) => deps.schedules?.targets(ref) ?? false);

  const schedulePanel = buildSchedulePanel(deps);
  if (schedulePanel) wb.useSchedulePanel(schedulePanel);
  wb.useSkillsPanel(
    buildSkillsPanel({
      notifyArchived: (skill) => deps.notifySkillArchived(skill),
      write: (fn) => deps.skillsRepo.write(fn),
    })
  );
  const reviewPanel = buildReviewPanelFor(deps);
  if (reviewPanel) wb.useReviewPanel(reviewPanel);
  const historyPanel = buildHistoryPanelFor(deps);
  if (historyPanel) wb.useHistoryPanel(historyPanel);
  wb.useAgentCatalog((ref) => deps.registry.agentCatalogForRef(ref));
  wb.useTopicSetup((ref, opts) => deps.registry.setupTopicForRef(ref, opts));
  wb.useWorkdirBrowser((ref, opts) => deps.registry.browseWorkdirForRef(ref, opts));
  wb.useModelPicker({
    list: (ref) => deps.registry.modelPickerForRef(ref),
    choose: (ref, value) => deps.registry.chooseModelForRef(ref, value),
  });
  wb.useOptionPicker({
    peek: (ref) => deps.registry.optionStatusForRef(ref),
    list: (ref) => deps.registry.optionsForRef(ref),
    choose: (ref, optId, value) => deps.registry.chooseOptionForRef(ref, optId, value),
  });
  wb.useTurnChanges({
    status: (ref, turn) => deps.registry.turnChangesStatusForRef(ref, turn),
    file: (ref, turn, filePath) => deps.registry.turnChangesFileForRef(ref, turn, filePath),
    forget: (ref) => deps.registry.turnChangesForgetForRef(ref),
  });
  wb.useGitPanel(buildGitPanel((ref) => deps.registry.workspaceForRef(ref)));
  wb.useVoiceTranscriber({
    enabled: () => deps.voice.isConfigured(),
    transcribe: (bytes, mime) => deps.voice.transcribeBuffer(bytes, mime),
  });
  wireWritingPanels(wb, deps);
}

/** Opt-in write panels: never injected while disabled (security invariants 9 & 10). */
function wireWritingPanels(wb: WorkbenchHost, deps: WorkbenchWiringDeps): void {
  const platform = deps.config().platforms[deps.instance];
  if (platform?.type !== 'webui') return;
  if (platform.files.enabled) {
    wb.useFilesPanel(
      buildFilesPanel({
        instance: deps.instance,
        roots: platform.files.roots,
        workspaceForRef: (ref) => deps.registry.workspaceForRef(ref),
      })
    );
  }
  if (platform.instructions.enabled) {
    wb.useInstructionsPanel(buildInstructionsPanel({ instance: deps.instance, agents: () => deps.config().agents }));
  }
}

function buildSchedulePanel(deps: WorkbenchWiringDeps): SchedulePanel | undefined {
  const schedules = deps.schedules;
  if (!schedules) return undefined;
  const { instance } = deps;
  const list = (): SchedulePanelTask[] =>
    panelTasks(schedules.tasks(), schedules.now(), (id) => schedules.scheduler.isRunning(id), instance);
  const form = (): SchedulePanelFormContext => {
    const cfg = deps.config();
    return panelForm({
      agents: cfg.agents,
      hosts: Object.keys(cfg.hosts ?? {}),
      channels: deps.registry.listChannels({ limit: PANEL_CHANNEL_LIMIT }).channels,
      instance,
      tz: schedules.defaultZone(),
      agent: cfg.routing.default,
    });
  };
  const detail = (id: string): SchedulePanelTaskDetail | undefined => {
    const task = schedules.get(id);
    if (!task) return undefined;
    return panelTaskDetail(task, {
      now: schedules.now(),
      running: schedules.scheduler.isRunning(id),
      instance,
      form: form(),
      laneOf: (key) => deps.registry.laneFor(key),
    });
  };
  const instances = new Set(Object.keys(deps.config().platforms));
  const answer = async (write: () => Promise<{ id: string }>): Promise<SchedulePanelDetailResult> => {
    try {
      const { id } = await write();
      const page = detail(id);
      if (!page) return { ok: false, error: `#${id} was removed just after this change` };
      return { ok: true, detail: page, tasks: list() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    list,
    op: (id, action, tags) => {
      try {
        if (action === 'tags') schedules.setTags(id, tags ?? []);
        else schedules.op(id, action, undefined, false);
        return { ok: true, tasks: list() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    detail,
    form,
    add: (task) => answer(() => schedules.addFromPanel(panelNewInput(task), panelTarget(task.target, instance, instances))),
    edit: (id, change) =>
      answer(() =>
        schedules.editFromPanel(
          id,
          panelEditInput(change),
          change.target !== undefined ? panelTarget(change.target, instance, instances) : undefined
        )
      ),
  };
}

function buildReviewPanelFor(deps: WorkbenchWiringDeps): ReviewPanel | undefined {
  const { history, reviews, reviewState, instance } = deps;
  if (!history || !reviews) return undefined;
  return buildReviewPanel({
    history,
    instance,
    enabled: () => reviews.enabled(),
    dismissed: () => reviewState?.dismissedPreferences() ?? new Set<string>(),
    dismiss: (text) => reviewState?.dismissPreference(text),
    standing: () => standingInstructions(),
    activeSkills: () => new Set(activeSkillNames()),
    writeSkills: (fn) => deps.skillsRepo.write(fn),
  });
}

function buildHistoryPanelFor(deps: WorkbenchWiringDeps): HistoryPanel | undefined {
  if (!deps.history) return undefined;
  return buildHistoryPanel({ history: deps.history, instance: deps.instance });
}
