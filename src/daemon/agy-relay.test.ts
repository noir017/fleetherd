import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDefSchema } from '../config/schema.js';
import { agyWindow } from './agy-acp.js';
import { AGY_DEFAULT_UPSTREAM, agyBudget, agyRelay, applyAgyBudget } from './agy-relay.js';

/**
 * A trimmed capture of agy 1.5.2's `fetchAvailableModels` answer (2026-11-07,
 * project-scripts/talkcode-agy-intercept/): two Gemini 3.8 Flash levels (1M window, 256k budget),
 * Claude Sonnet 4.6 (250k window, 160k budget) and a model with no budget at all. The checkpoint
 * document is as served except its long summary prompt, cut short.
 */
const CAPTURE = {
  "models": {
    "gemini-3.8-flash-high": {
      "displayName": "Gemini 3.8 Flash (High)",
      "maxTokens": 1048576,
      "maxOutputTokens": 65536,
      "model": "MODEL_PLACEHOLDER_M318",
      "modelExperiments": {
        "experiments": {
          "CASCADE_USE_EXPERIMENT_CHECKPOINTER": {
            "stringValue": "{\n    \"strategy\": \"CHECKPOINT_STRATEGY_SAME_MODEL\",\n    \"max_token_limit\": \"256000\",\n    \"token_threshold\": \"50000\",\n    \"max_overhead_ratio\": \"0.15\",\n    \"enabled\": true,\n    \"max_output_tokens\": \"16384\",\n    \"checkpoint_model\": \"MODEL_PLACEHOLDER_M50\",\n    \"use_last_planner_model\": true,\n    \"is_sync\": true,\n    \"max_user_requests\": 10,\n    \"include_last_user_message\": true,\n    \"include_conversation_log\": false,\n    \"include_running_task_snapshots\": true,\n    \"include_subagent_snapshots\": true,\n    \"include_artifact_snapshots\": true,\n    \"retry_config\": {\n        \"max_retries\": 4,\n        \"initial_sleep_duration_ms\": 1000,\n        \"exponential_multiplier\": 2,\n        \"include_error_feedback\": false\n    },\n    \"session_summary_prompt_override\": \"You have been working on the task described above but have not yet completed\\nit. Write a continuation summary that will\",\n    \"use_model_reported_token_count\": true\n}"
          },
          "retry_model_capacity_exhausted": {
            "boolValue": true
          }
        }
      }
    },
    "gemini-3.8-flash-low": {
      "displayName": "Gemini 3.8 Flash (Low)",
      "maxTokens": 1048576,
      "maxOutputTokens": 65536,
      "model": "MODEL_PLACEHOLDER_M320",
      "modelExperiments": {
        "experiments": {
          "retry_model_capacity_exhausted": {
            "boolValue": true
          },
          "CASCADE_USE_EXPERIMENT_CHECKPOINTER": {
            "stringValue": "{\n    \"strategy\": \"CHECKPOINT_STRATEGY_SAME_MODEL\",\n    \"max_token_limit\": \"256000\",\n    \"token_threshold\": \"50000\",\n    \"max_overhead_ratio\": \"0.15\",\n    \"enabled\": true,\n    \"max_output_tokens\": \"16384\",\n    \"checkpoint_model\": \"MODEL_PLACEHOLDER_M50\",\n    \"use_last_planner_model\": true,\n    \"is_sync\": true,\n    \"max_user_requests\": 10,\n    \"include_last_user_message\": true,\n    \"include_conversation_log\": false,\n    \"include_running_task_snapshots\": true,\n    \"include_subagent_snapshots\": true,\n    \"include_artifact_snapshots\": true,\n    \"retry_config\": {\n        \"max_retries\": 4,\n        \"initial_sleep_duration_ms\": 1000,\n        \"exponential_multiplier\": 2,\n        \"include_error_feedback\": false\n    },\n    \"session_summary_prompt_override\": \"You have been working on the task described above but have not yet completed\\nit. Write a continuation summary that will\",\n    \"use_model_reported_token_count\": true\n}"
          }
        }
      }
    },
    "claude-sonnet-4-6": {
      "displayName": "Claude Sonnet 4.6 (Thinking)",
      "maxTokens": 250000,
      "maxOutputTokens": 64000,
      "model": "MODEL_PLACEHOLDER_M35",
      "modelExperiments": {
        "experiments": {
          "retry_model_capacity_exhausted": {
            "boolValue": true
          },
          "CASCADE_USE_EXPERIMENT_CHECKPOINTER": {
            "stringValue": "{\n    \"strategy\": \"CHECKPOINT_STRATEGY_UNSPECIFIED\",\n    \"max_token_limit\": \"160000\",\n    \"token_threshold\": \"50000\",\n    \"max_overhead_ratio\": \"0.15\",\n    \"enabled\": true,\n    \"max_output_tokens\": \"16384\",\n    \"checkpoint_model\": \"MODEL_PLACEHOLDER_M50\",\n    \"use_last_planner_model\": false,\n    \"is_sync\": false,\n    \"max_user_requests\": 10,\n    \"include_last_user_message\": false,\n    \"include_conversation_log\": true,\n    \"include_running_task_snapshots\": true,\n    \"include_subagent_snapshots\": true,\n    \"include_artifact_snapshots\": true,\n    \"retry_config\": {\n        \"max_retries\": 0,\n        \"initial_sleep_duration_ms\": 1000,\n        \"exponential_multiplier\": 2,\n        \"include_error_feedback\": false\n    },\n    \"session_summary_prompt_override\": \"\",\n    \"use_model_reported_token_count\": true\n}"
          }
        }
      }
    },
    "tab_flash_lite_preview": {
      "maxTokens": 16384,
      "maxOutputTokens": 4096,
      "model": "MODEL_PLACEHOLDER_M19"
    }
  },
  "defaultAgentModelId": "gemini-3.8-flash-high"
};

const capture = (): typeof CAPTURE => JSON.parse(JSON.stringify(CAPTURE)) as typeof CAPTURE;
const limitOf = (json: typeof CAPTURE, id: keyof typeof CAPTURE.models): string | undefined =>
  /"max_token_limit": "(\d+)"/.exec(
    (json.models[id] as { modelExperiments?: { experiments: Record<string, { stringValue?: string }> } }).modelExperiments?.experiments
      .CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue ?? ''
  )?.[1];
const agy = (extra: Record<string, unknown> = {}) => AgentDefSchema.parse({ id: 'ag', harness: 'agy', ...extra });

afterEach(() => vi.restoreAllMocks());

describe('applyAgyBudget', () => {
  it('raises every model that can hold the budget, and leaves the rest at Google\'s', () => {
    const json = capture();
    const r = applyAgyBudget(json, 900_000)!;
    expect(r.changed).toBe(2);
    expect(limitOf(json, 'gemini-3.8-flash-high')).toBe('900000');
    expect(limitOf(json, 'gemini-3.8-flash-low')).toBe('900000');
    // 900k + Claude's 64k output reserve is past its 250k window.
    expect(limitOf(json, 'claude-sonnet-4-6')).toBe('160000');
    expect(r.budgets.get('gemini-3.8-flash-high')).toBe(900_000);
    expect(r.budgets.get('gemini 3.8 flash (high)')).toBe(900_000);
    expect(r.budgets.get('claude-sonnet-4-6')).toBe(160_000);
    expect(r.budgets.has('tab_flash_lite_preview')).toBe(false);
  });

  it('changes the number and nothing else in the checkpoint document', () => {
    const json = capture();
    const before = CAPTURE.models['gemini-3.8-flash-high'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue;
    applyAgyBudget(json, 900_000);
    const after = json.models['gemini-3.8-flash-high'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue;
    expect(after).toBe(before.replace('"max_token_limit": "256000"', '"max_token_limit": "900000"'));
  });

  it('lowers too, where asked', () => {
    const json = capture();
    expect(applyAgyBudget(json, 100_000)!.changed).toBe(3);
    expect(limitOf(json, 'claude-sonnet-4-6')).toBe('100000');
  });

  it('answers undefined for a body that is not a model list', () => {
    expect(applyAgyBudget({ flags: [] }, 900_000)).toBeUndefined();
    expect(applyAgyBudget(null, 900_000)).toBeUndefined();
  });
});

describe('agyRelay', () => {
  it('is only for an agent with a contextBudget', () => {
    expect(agyRelay(agy())).toBeUndefined();
    const r = agyRelay(agy({ contextBudget: 900_000 }))!;
    expect(r.envVar).toBe('CLOUD_CODE_URL');
    expect(r.spec.upstream).toBe(AGY_DEFAULT_UPSTREAM);
    expect(r.spec.paths).toEqual(['/v1internal:fetchAvailableModels']);
    // A safe name on the host (remote/paths.go safeName).
    expect(r.spec.id).toMatch(/^agy\.900000\.[0-9a-f]{8}$/);
  });

  it('chains to the operator\'s own CLOUD_CODE_URL', () => {
    const r = agyRelay(agy({ contextBudget: 900_000, env: { CLOUD_CODE_URL: 'https://proxy.example/cc' } }))!;
    expect(r.spec.upstream).toBe('https://proxy.example/cc');
    expect(r.spec.id).not.toBe(agyRelay(agy({ contextBudget: 900_000 }))!.spec.id);
  });

  it('serves the rewritten list, and the footer then reads the budget agy was given', async () => {
    const def = agy({ id: 'ag-footer', contextBudget: 800_000 });
    expect(agyWindow(def, 'gemini-3.8-flash')).toBe(1_048_576); // nothing told yet: the window table
    const out = await agyRelay(def)!.spec.transform('/v1internal:fetchAvailableModels', Buffer.from(JSON.stringify(CAPTURE)));
    expect(limitOf(JSON.parse(out!.toString()) as typeof CAPTURE, 'gemini-3.8-flash-high')).toBe('800000');
    // `agy acp` names the model without its level; the list has one per level.
    expect(agyBudget(def, 'gemini-3.8-flash')).toBe(800_000);
    expect(agyBudget(def, 'Gemini 3.8 Flash (High)')).toBe(800_000);
    expect(agyBudget(def, 'claude-sonnet-4-6')).toBe(160_000);
    expect(agyBudget(def, 'gpt-oss-120b-medium')).toBeUndefined();
    expect(agyWindow(def, 'gemini-3.8-flash')).toBe(800_000);
    expect(agyWindow({ ...def, contextWindow: 500_000 }, 'gemini-3.8-flash')).toBe(500_000);
  });

  it('serves a list it does not recognise as it came, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { transform } = agyRelay(agy({ contextBudget: 700_000 }))!.spec;
    expect(await transform('/v1internal:fetchAvailableModels', Buffer.from('{"models":{}}'))).toBeUndefined();
    expect(await transform('/v1internal:fetchAvailableModels', Buffer.from('not json'))).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('declines when nothing changes (the budget is already Google\'s)', async () => {
    const { transform } = agyRelay(agy({ contextBudget: 256_000 }))!.spec;
    expect(await transform('/v1internal:fetchAvailableModels', Buffer.from(JSON.stringify(CAPTURE)))).toBeUndefined();
  });
});

describe('contextBudget in config', () => {
  it('is refused for a harness other than agy', () => {
    const r = AgentDefSchema.safeParse({ id: 'cc', harness: 'claude', contextBudget: 900_000 });
    expect(r.success).toBe(false);
  });
});
