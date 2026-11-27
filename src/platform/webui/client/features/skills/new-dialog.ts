import { html } from '../../base/html.js';
import {
  type DialogController,
  openDialog,
  renderFieldRow,
  renderTextInput,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import type { SkillsStore } from './store.js';
import { getSkillIcon, type ResolvedSkillsDeps } from './types.js';

export function openNewSkillDialog(
  ctx: PluginContext,
  store: SkillsStore,
  deps: ResolvedSkillsDeps,
): DialogController {
  let name = '';
  let description = '';
  let category = '';
  let body = '';
  const categories = store.categories();
  const catListId = 'fh-skill-new-cat-list';
  const catLabel = ctx.i18n.t('wb.skills.categoryField') || 'Category';
  const catPlaceholder = ctx.i18n.t('wb.skills.categoryPlaceholder') || 'Choose or type a category…';

  const icons = deps.icons();
  const dlg = openDialog({
    title: tr('skills.newSkill'),
    confirmLabel: tr('common.create'),
    cancelLabel: tr('common.cancel'),
    loadingLabel: tr('common.saving'),
    closeIcon: getSkillIcon(icons, 'cross'),
    overlays: deps.overlays,
    doc: deps.doc,
    className: 'fh-skill-new-dialog',
    body: html`
      <div class="fh-skill-new-fields">
        ${renderFieldRow({
          id: 'fh-skill-new-name',
          label: tr('skills.newSkill'),
          required: true,
          control: renderTextInput({
            id: 'fh-skill-new-name',
            value: name,
            placeholder: tr('skills.newNamePlaceholder'),
            ariaLabel: tr('skills.newNamePlaceholder'),
            onInput: (val) => {
              name = val;
            },
          }),
        })}
        ${renderFieldRow({
          id: 'fh-skill-new-desc',
          label: tr('skills.newDescPlaceholder'),
          required: true,
          control: renderTextInput({
            id: 'fh-skill-new-desc',
            value: description,
            placeholder: tr('skills.newDescPlaceholder'),
            ariaLabel: tr('skills.newDescPlaceholder'),
            onInput: (val) => {
              description = val;
            },
          }),
        })}
        ${renderFieldRow({
          id: 'fh-skill-new-cat',
          label: catLabel,
          control: html`
            <input
              id="fh-skill-new-cat"
              type="text"
              class="fh-input"
              list=${catListId}
              .value=${category}
              placeholder=${catPlaceholder}
              aria-label=${catLabel}
              autocomplete="off"
              @input=${(ev: Event) => {
                category = (ev.currentTarget as HTMLInputElement).value;
              }}
            />
            <datalist id=${catListId}>
              ${categories.map((cat) => html`<option value=${cat}></option>`)}
            </datalist>
          `,
        })}
        ${renderFieldRow({
          id: 'fh-skill-new-body',
          label: tr('skills.newBodyPlaceholder'),
          control: html`<textarea
            id="fh-skill-new-body"
            class="fh-textarea skill-text"
            placeholder=${tr('skills.newBodyPlaceholder')}
            rows="6"
            @input=${(ev: Event) => {
              body = (ev.currentTarget as HTMLTextAreaElement).value;
            }}
          ></textarea>`,
        })}
      </div>
    `,
    onConfirm: async () => {
      const trimmedName = name.trim();
      const trimmedDesc = description.trim();
      if (!trimmedName) {
        dlg.setError(tr('skills.nameRequired'));
        return false;
      }
      if (!trimmedDesc) {
        dlg.setError(tr('skills.descRequired'));
        return false;
      }
      const outcome = await store.create({
        name: trimmedName,
        description: trimmedDesc,
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(body ? { body } : {}),
      });
      if (!outcome.ok) {
        dlg.setError(outcome.error || tr('common.didNotWork'));
        return false;
      }
      ctx.editors.open('skill', { name: trimmedName });
      return true;
    },
  });

  return dlg;
}
