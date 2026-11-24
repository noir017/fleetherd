import type { ViewContribution } from '../../plugins/api.js';
import type { OverlayManager } from '../../services/overlays.js';

export type ReviewPanelComponent = ReturnType<ViewContribution['component']>;
export type ReviewPanelInitContext = Parameters<ReviewPanelComponent['init']>[1];

export interface ReviewsPluginDeps {
  readonly overlays?: OverlayManager;
  readonly doc?: Document;
  readonly now?: () => number;
  readonly createTopic?: (seed: { readonly text: string; readonly draft: string }) => Promise<boolean>;
  readonly beforeSkillArchive?: () => void;
  readonly afterSkillArchive?: (refreshPending: boolean) => void;
  readonly onBadgeChange?: () => void;
}
