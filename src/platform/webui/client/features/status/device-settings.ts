import { html, nothing, render } from '../../base/html.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { renderFieldRow, renderSegmentedField, renderSwitch } from '../../components/index.js';
import { SUPPORTED_LOCALES, type Locale } from '../../i18n/index.js';
import type { SettingsSectionContribution } from '../../plugins/api.js';
import { THEMES, type ThemeId } from '../../theme.js';
import type { StatusNotifyState } from './types.js';

export type DevicePanelComponent = ReturnType<SettingsSectionContribution['component']>;

export interface DevicePreferencesSnapshot {
  readonly theme: ThemeId;
  readonly locale: Locale;
  readonly calm: boolean;
  readonly notify: StatusNotifyState;
}

export interface DevicePreferencesPanelDeps {
  readonly doc?: Document;
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
  readonly getSnapshot: () => DevicePreferencesSnapshot;
  readonly onDidChange: (cb: () => void) => Disposable;
  readonly setTheme: (theme: ThemeId) => void;
  readonly setLocale: (locale: Locale) => void;
  readonly setCalm: (calm: boolean) => void;
  readonly toggleNotify: () => Promise<void>;
  readonly resetLayout: () => void;
}

function localizedThemeOptionLabel(
  id: ThemeId,
  t: (key: string) => string,
): string {
  switch (id) {
    case 'system':
      return t('menu.themeSystem');
    case 'dark':
      return t('menu.themeDark');
    case 'light':
      return t('menu.themeLight');
  }
}

function notifyHint(
  notify: StatusNotifyState,
  t: (key: string) => string,
): string {
  if (!notify.supported || !notify.available) {
    return t('devicePrefs.notificationsUnsupported');
  }
  if (notify.blocked) {
    return t('menu.notificationsBlockedTitle');
  }
  return notify.enabled ? t('menu.notificationsOnTitle') : t('menu.notificationsOffTitle');
}

export function createDevicePreferencesPanel(
  deps: DevicePreferencesPanelDeps,
): DevicePanelComponent {
  const doc = deps.doc ?? document;
  const element = doc.createElement('section');
  element.className = 'fh-device-prefs';
  const disposables = new DisposableStore();
  let layoutResetDone = false;
  let disposed = false;

  const paint = (): void => {
    if (disposed) return;
    const snap = deps.getSnapshot();
    const { t } = deps;

    const themeOptions = THEMES.map((entry) => ({
      value: entry.id,
      label: localizedThemeOptionLabel(entry.id, t),
    }));
    const localeOptions = SUPPORTED_LOCALES.map((entry) => ({
      value: entry.code,
      label: entry.label,
    }));

    const notifyDisabled = !snap.notify.supported || !snap.notify.available || snap.notify.blocked || snap.notify.busy;
    const notifyLabel = snap.notify.blocked
      ? t('menu.notificationsBlocked')
      : snap.notify.enabled
        ? t('common.onCap')
        : t('common.offCap');

    render(
      html`
        <div class="fh-device-prefs-head">
          <h3 class="fh-device-prefs-title">${t('devicePrefs.title')}</h3>
          <p class="fh-device-prefs-sub">${t('devicePrefs.subtitle')}</p>
        </div>
        <div class="fh-device-prefs-list fh-device-prefs-card">
          ${renderFieldRow({
            id: 'fh-pref-notify',
            label: t('devicePrefs.notifications'),
            hint: notifyHint(snap.notify, t),
            warning: snap.notify.blocked ? t('menu.notificationsBlocked') : null,
            inline: true,
            control: renderSwitch({
              id: 'fh-pref-notify',
              checked: snap.notify.enabled,
              label: notifyLabel,
              ariaLabel: t('devicePrefs.notifications'),
              disabled: notifyDisabled,
              onChange: () => {
                void deps.toggleNotify();
              },
            }),
          })}
          ${renderFieldRow({
            id: 'fh-pref-theme',
            label: t('devicePrefs.theme'),
            hint: t('devicePrefs.themeHint'),
            inline: true,
            control: renderSegmentedField({
              options: themeOptions,
              value: snap.theme,
              ariaLabel: t('devicePrefs.theme'),
              onChange: (value) => deps.setTheme(value as ThemeId),
            }),
          })}
          ${renderFieldRow({
            id: 'fh-pref-locale',
            label: t('devicePrefs.language'),
            hint: t('devicePrefs.languageHint'),
            inline: true,
            control: renderSegmentedField({
              options: localeOptions,
              value: snap.locale,
              ariaLabel: t('devicePrefs.language'),
              onChange: (value) => deps.setLocale(value as Locale),
            }),
          })}
          ${renderFieldRow({
            id: 'fh-pref-calm',
            label: t('devicePrefs.calm'),
            hint: t('devicePrefs.calmHint'),
            inline: true,
            control: renderSwitch({
              id: 'fh-pref-calm',
              checked: snap.calm,
              label: snap.calm ? t('common.onCap') : t('common.offCap'),
              ariaLabel: t('devicePrefs.calm'),
              onChange: (checked) => deps.setCalm(checked),
            }),
          })}
          ${renderFieldRow({
            id: 'fh-pref-reset-layout',
            label: t('devicePrefs.resetLayout'),
            hint: layoutResetDone ? t('devicePrefs.resetLayoutDone') : t('devicePrefs.resetLayoutHint'),
            inline: true,
            control: html`<button
              type="button"
              id="fh-pref-reset-layout"
              class="fh-btn fh-btn--secondary"
              data-action="reset-layout"
              @click=${() => {
                deps.resetLayout();
                layoutResetDone = true;
                paint();
              }}
            >${t('devicePrefs.resetLayoutBtn')}</button>`,
          })}
        </div>
      `,
      element,
    );
  };

  return {
    element,
    init(): void {
      paint();
      disposables.add(deps.onDidChange(paint));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposables.dispose();
      render(nothing, element);
    },
  };
}
