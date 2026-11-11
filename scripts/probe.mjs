// 诊断探针:验证 Discord gateway 是否连上、能否收到消息、intent 是否够。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { Context } from '@satorijs/core';
import DiscordAdapterNS from '@koishijs/plugin-adapter-discord';
import HttpNS from '@cordisjs/plugin-http';

const DiscordBot = DiscordAdapterNS.default ?? DiscordAdapterNS;
const HTTP = HttpNS.default ?? HttpNS;

const cfgPath = path.join(os.homedir(), '.config', 'fleetherd', 'config.yaml');
const cfg = parse(fs.readFileSync(cfgPath, 'utf8'));
const token = cfg.platform.token;

const ctx = new Context();
ctx.plugin(HTTP); // discord bot inject:["http"],必须先提供 http 服务
ctx.plugin(DiscordBot, { type: 'bot', token });

// 各种生命周期事件,看 bot 是否上线。
ctx.on('login-added', (login) => console.log('[login-added]', login?.selfId, login?.status));
ctx.on('login-updated', (login) => console.log('[login-updated]', login?.selfId, 'status=', login?.status));
ctx.on('login-removed', (login) => console.log('[login-removed]', login?.selfId));

// 收到消息。
ctx.on('message', (s) => {
  console.log('[message] platform=%s channel=%s user=%s content=%j elements=%j',
    s.platform, s.channelId, s.userId, s.content, s.elements?.map(e => e.type));
});

// 任何内部错误。
ctx.on('internal/error', (e) => console.log('[internal/error]', e?.message ?? e));

await ctx.start();
console.log('[probe] ctx.start() 完成,等待 gateway 连接…');

// 每 3s 打印 bot 状态(0=offline 1=online 2=connect 3=disconnect 4=reconnect ...)。
const STATUS = { 0: 'offline', 1: 'online', 2: 'connecting', 3: 'disconnect', 4: 'reconnecting' };
setInterval(() => {
  const bots = ctx.bots.map(b => `${b.platform}:${b.user?.name ?? '?'}=${STATUS[b.status] ?? b.status}`);
  console.log('[bots]', bots.length ? bots.join(', ') : '(无 bot)');
}, 3000);
