import type {
  SchedulePanelAction,
  SchedulePanelFormContext,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../../../../workbench.js';
import type { ScheduleTargetRequest } from '../../../protocol.js';
import type { MenuEntry } from '../../components/index.js';
import type { MenuLocation, TopicInfo, ViewContribution } from '../../plugins/api.js';
import type { OverlayManager } from '../../services/overlays.js';

export type SchedulePanelComponent = ReturnType<ViewContribution['component']>;
export type SchedulePanelInitContext = Parameters<SchedulePanelComponent['init']>[1];

export type ScheduleEditorMode = 'view' | 'edit' | 'new';

export interface ScheduleEditorInput {
  readonly id?: string | null;
  readonly mode?: ScheduleEditorMode;
  readonly title?: string;
}

export type ScheduleSubtab = 'tasks' | 'sessions';

export type TaskPageDetail = Omit<SchedulePanelTaskDetail, 'task'> & {
  task: SchedulePanelTask | null;
};

export interface TaskEditPayload {
  name?: string;
  cron?: string;
  at?: string;
  tz?: string;
  prompt?: string;
  command?: string;
  agent?: string;
  session?: 'fixed' | 'new' | 'daily';
  model?: string | null;
  cwd?: string | null;
  host?: string | null;
  timeoutMs?: number;
  wake?: boolean;
  wakeOn?: string | null;
  wakeMax?: number;
  tags?: string[];
  target?: ScheduleTargetRequest;
}

export interface SchedulesListResponse {
  readonly enabled?: boolean;
  readonly tasks?: SchedulePanelTask[];
}

export interface ScheduleOpResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly tasks?: SchedulePanelTask[];
}

export interface ScheduleDetailResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly detail?: SchedulePanelTaskDetail;
  readonly tasks?: SchedulePanelTask[];
}

export interface ScheduleFormResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly form?: SchedulePanelFormContext;
}

export interface SchedulesPluginDeps {
  readonly overlays?: OverlayManager;
  readonly doc?: Document;
  readonly win?: Window;
  readonly now?: () => number;
  readonly unreadOf?: (topic: TopicInfo) => number;
  readonly markAllRead?: (topics: readonly TopicInfo[]) => void | Promise<void>;
  readonly resolveMenuEntries?: (where: MenuLocation, target: unknown) => readonly MenuEntry[];
  readonly onBadgeChange?: () => void;
  readonly onOp?: (id: string, action: SchedulePanelAction) => void;
}
