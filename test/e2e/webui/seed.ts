import crypto from 'node:crypto';
import type { FakeAgentMode, GatewayHandle } from './harness.js';

export interface SeedTopicSpec {
  title: string;
  message?: string;
  mode?: FakeAgentMode;
  starred?: boolean;
  waitForReply?: boolean;
}

export interface SeedResult {
  cookie: string;
  topics: Record<string, string>;
}

interface TopicCreateResponse {
  topic: { id: string; title: string };
}

interface TopicSnapshotResponse {
  messages?: Array<{ own?: boolean; text?: string; html?: string }>;
}

async function loginCookie(baseUrl: string, secret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secret }),
  });
  if (!res.ok) {
    throw new Error(`Seed login failed: HTTP ${res.status}`);
  }
  const raw = res.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';')[0] ?? '';
  if (!cookie) {
    throw new Error('Seed login response missing set-cookie header');
  }
  return cookie;
}

async function postJson<T>(baseUrl: string, cookie: string, route: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /${route} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

async function waitForAgentMessage(
  baseUrl: string,
  cookie: string,
  topicId: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/topic?t=${encodeURIComponent(topicId)}`, {
      headers: { cookie },
    });
    if (res.ok) {
      const data = (await res.json()) as TopicSnapshotResponse;
      const hasReply = (data.messages ?? []).some((m) => !m.own);
      if (hasReply) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for seeded agent reply in topic ${topicId}`);
}

export async function seedTopics(
  gateway: GatewayHandle,
  specs: readonly SeedTopicSpec[]
): Promise<SeedResult> {
  const cookie = await loginCookie(gateway.baseUrl, gateway.secret);
  const topics: Record<string, string> = {};

  for (const spec of specs) {
    const created = await postJson<TopicCreateResponse>(gateway.baseUrl, cookie, 'api/topics', {
      title: spec.title,
    });
    const id = created.topic.id;
    topics[spec.title] = id;

    if (spec.message) {
      gateway.setMode(spec.mode ?? 'ok');
      await postJson(gateway.baseUrl, cookie, 'api/send', {
        topic: id,
        text: spec.message,
        nonce: crypto.randomUUID(),
      });
      if (spec.waitForReply !== false && spec.mode !== 'slow') {
        await waitForAgentMessage(gateway.baseUrl, cookie, id);
      }
    }

    if (spec.starred) {
      await postJson(gateway.baseUrl, cookie, 'api/topics/star', { topic: id, starred: true });
    }
  }

  gateway.setMode('ok');
  return { cookie, topics };
}
