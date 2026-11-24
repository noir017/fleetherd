import type { TopicInfo } from '../../plugins/api.js';

function buildChildrenMap(topics: readonly TopicInfo[]): Map<string, TopicInfo[]> {
  const children = new Map<string, TopicInfo[]>();
  for (const topic of topics) {
    if (!topic.parent) continue;
    let list = children.get(topic.parent);
    if (!list) {
      list = [];
      children.set(topic.parent, list);
    }
    list.push(topic);
  }
  return children;
}

function hasBusyDescendant(rootId: string, children: ReadonlyMap<string, readonly TopicInfo[]>): boolean {
  const visited = new Set<string>([rootId]);
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    const kids = children.get(cur);
    if (!kids) continue;
    for (const kid of kids) {
      if (visited.has(kid.id)) continue;
      visited.add(kid.id);
      if (kid.running || kid.asking) return true;
      stack.push(kid.id);
    }
  }
  return false;
}

export function computeRunningCount(topics: readonly TopicInfo[]): number {
  let count = 0;
  for (const topic of topics) {
    if (topic.running || topic.asking) count++;
  }
  return count;
}

export function computeIdleTopics(topics: readonly TopicInfo[]): TopicInfo[] {
  const children = buildChildrenMap(topics);
  const starred: TopicInfo[] = [];
  const rest: TopicInfo[] = [];
  for (const topic of topics) {
    if (!topic.live || topic.running || topic.asking) continue;
    if (hasBusyDescendant(topic.id, children)) continue;
    (topic.starred ? starred : rest).push(topic);
  }
  return starred.concat(rest);
}
