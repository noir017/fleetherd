# 远程主机

[English](../remote-hosts.md) | 简体中文

智能体可以跑在另一台机器上。网关通过 ssh 连到那台机器，自己在上面装好一个小服务，再经由它驱动智能体。
在聊天里看起来和本机的智能体一样：回复流式输出，文件可以双向收发，`/cd`、`/skills` 和页脚都照常可用。
两台机器之间断网时，智能体会继续干活；它的输出先留在那台主机上，连接恢复后再送达。

```yaml
hosts:
  devbox:
    ssh: me@10.0.0.5:22           # user@host[:port]
agents:
  - id: cc-dev
    harness: claude
    host: devbox                  # 跑在 devbox 上
    cwd: ~/work                   # devbox 上的路径
  - id: cc
    harness: claude               # 跑在本机，和以前一样
```

## 配置一台主机

1. **给网关一把密钥。** 默认用 `~/.config/talkcode/ssh/id_ed25519`（用 `identityFile` 改）：

   ```bash
   mkdir -p ~/.config/talkcode/ssh && chmod 700 ~/.config/talkcode/ssh
   ssh-keygen -t ed25519 -N '' -f ~/.config/talkcode/ssh/id_ed25519 -C talkcode
   ```

2. **在主机上放行它**，写进 `~/.ssh/authorized_keys`，并限定网关的地址：

   ```
   restrict,from="203.0.113.7" ssh-ed25519 AAAA… talkcode
   ```

   `restrict` 会关掉端口转发、agent 转发和终端。网关一样都用不上：所有东西都走它执行的那一条命令。

3. **信任主机的密钥**，写进 `~/.config/talkcode/ssh/known_hosts`（用 `knownHostsFile` 改）。
   网关严格校验，从不自己记住新密钥。加之前先和主机上的指纹核对一下
   （`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`）：

   ```bash
   ssh-keyscan -p 22 10.0.0.5 >> ~/.config/talkcode/ssh/known_hosts   # 其他端口写成 [10.0.0.5]:2222
   ```

   校验的是主机的普通密钥。主机证书（比如 Teleport 节点的）不会被使用，所以写 `@cert-authority` 行没有用。

4. **在主机上安装并登录智能体**，和你在那台机器的终端里使用它时一样：`claude` 要
   `npm i -g @agentclientprotocol/claude-agent-acp`（网关自带的那份只给网关本机用），`codex` 要
   `npm i -g @agentclientprotocol/codex-acp`，`opencode` 和 `agy` 要装 OpenCode 或 Antigravity 的 CLI。

5. **检查：** `talkcode doctor` 会连上每台主机，并在那边查找各智能体的命令。

主机必须是 x86-64 或 arm64 的 Linux，并且有 POSIX `sh`。其他什么都不用装。

### 在聊天里加：`talkcode pod-add`

上面第 1–3 步智能体可以自己做（`talkcode help pods`）：

1. `talkcode pods` 会打印 `gatewayKey`，也就是新主机 authorized_keys 里要加的那一行（网关第一次用时会自己生成密钥）。
   它带 `restrict`，`from=` 限定为私网地址段。
2. 在那台主机上把这一行追加到 `~/.ssh/authorized_keys`，并在主机上读出它的主机公钥——比如
   `/etc/ssh/ssh_host_ed25519_key.pub`——而不是用 `ssh-keyscan` 去扫：以后每次连接都要拿它来核对。
3. `talkcode pod-add devbox me@10.0.0.5:22 --host-key "ssh-ed25519 AAAA…"` 会往 config.yaml 里加
   `hosts.devbox`（保留注释），把公钥钉进网关的 known_hosts，然后 reload，并回复在那台主机上找到了哪些智能体。

`talkcode pod-remove devbox` 把一台主机连同它的智能体一起移除。config.yaml 里还用到它时会被拒绝——那里写了跑在它上面的
智能体，或者 routing 指向它的某个智能体。

## 主机自己声明的智能体：`~/.talkcode/pod.yaml`

主机可以自己说明它有哪些智能体，不必在 config.yaml 里一个个列出来。这样 config.yaml 只需要写 `hosts:`：

```yaml
# ~/.talkcode/pod.yaml，放在主机上
agents:
  - id: oc
    harness: opencode
    model: opencode/deepseek-v4.1-flash-free
    cwd: ~/workspace
  - id: cbc
    harness: custom
    command: codebuddy
    args: [--acp]
```

- 每个智能体的名字是 `<id>@<主机>`：`devbox` 上的 `oc` 就是 `oc@devbox`，routing、`/agent` 和
  `talkcode task-new` 都用这个名字。主机不能占用 config.yaml 或别的主机已经在用的 id。
- 字段和 config.yaml 里智能体的字段一样，只是没有 `host`。值按原样使用：不接受 `${VAR}`，因为它会从网关的
  环境变量里取值，而那里放着网关的各种 token。智能体要用的变量请放在主机的登录环境里。
- **没有这个文件时：** 网关会在主机的登录 PATH 上查找 `claude-agent-acp`、`codex-acp`、`opencode`、`agy`
  和 `codebuddy`，把找到的分别以 `cc`、`cx`、`oc`、`ag`、`cbc` 提供出来，用默认设置。文件为空表示这台主机
  没有智能体。config.yaml 里已经放了智能体的主机，除非有这个文件，否则不会去查找——查找会把它们每个再提供一遍。
- **什么时候读：** 网关启动时，以及每次 `/reload`（或 `talkcode reload`）时。改完文件再 reload 即可。读到的内容
  会存在配置目录的 `pods.json` 里，所以连不上的主机会保留它原有的智能体；文件写错的主机也一样保留，
  reload 的回复里会说明哪里写错了。
- `/setting model` 改不了这类智能体：它的定义在主机上。去改那个文件，或者用 `/model` 只改当前会话。

### 主机之间互相 ssh：`peer:`

主机之间可以互相 ssh，不用有人去配两两之间的密钥。pod.yaml 里有 `peer:` 的主机会加入互通；`/reload` 之后，
在其中任意一台上：

```bash
ssh devbox.pod            # 交互终端；scp、rsync、git 和 -L/-R 都和普通 ssh 主机一样能用
```

```yaml
# ~/.talkcode/pod.yaml
peer:                     # 加入互通
  ssh: me@10.0.0.5:2222   # 可选：别的主机怎么连这台，和网关连它的方式不同时才写
```

连接是主机之间直连的普通 OpenSSH，网关一字节都不经手。它只负责配置：互通里的每台主机有一把自己的密钥
（在主机上生成，`~/.talkcode/ssh/id_ed25519`），网关在旁边写好其他主机的公钥（`authorized_keys`，只能从私网地址段登录）、
它们以 `<主机>.pod` 命名的主机公钥（`known_hosts`，取自网关自己的 known_hosts——网关本来就拿它核对这些主机），
以及每台一个 `Host <主机>.pod` 块（`config`）。网关每次启动和 `/reload` 都会重写。

主机要用上这些文件，它的 sshd 得读第二个 `authorized_keys`，ssh 得读这份 `config`——两行配置，uniagent 镜像里已经有了：

```
# sshd_config
AuthorizedKeysFile .ssh/authorized_keys .talkcode/ssh/authorized_keys
AllowTcpForwarding yes        # 为了 -L/-R；带 restrict 的钥匙照样没有转发
# ssh_config（比如 /etc/ssh/ssh_config.d/20-talkcode-pods.conf）
Include /home/<用户>/.talkcode/ssh/config
```

互通里的每台主机都能登录其他每一台：加不加入由主机自己决定（`peer:` 写在它自己的文件里，不在网关的配置里），
谁拿下其中一台，就等于拿下了全部。去掉 `peer:` 再 reload，这台主机上的那几个文件会被清空，其他主机也不再信任它。

### 给智能体改名

会话和定时任务是按 id 记住自己属于哪个智能体的。只在 config.yaml 里改 id，这个智能体的所有话题都会回到默认智能体，
并且开一个新会话。要改名，就在配置目录里放一个 `agent-renames.json`，写上新旧名字的对应关系，然后重启网关：

```json
{ "oc2": "oc@devbox", "cc": "cc@devbox" }
```

启动时，config.yaml（`agents`、`routing`）、每个会话和定时任务里的 id 会一起改掉；改之前先把这三个文件复制成
`*.bak-renames-<时间>`，对应表随后改名为 `agent-renames.json.applied-<时间>`。要把一个智能体从 config.yaml
挪到主机的 `pod.yaml` 里：先用这个办法把它改名为 `<id>@<主机>`，在主机上写好文件，再删掉 config.yaml 里那一项并
`/reload`。

## 各件事在哪里发生

| | 对配了 `host:` 的智能体 |
|---|---|
| 智能体进程 | 在主机上，在它的 `cwd` 里（默认是那边的 `~/.talkcode/agents/<id>`） |
| 它的环境变量 | 主机账号的**登录**环境（`bash -il` 会设置的内容，包括 `.bashrc`），再叠加智能体的 `env`。网关自己的环境变量一个都不传过去。 |
| `hooks.preLaunch` | 在主机上 |
| 你发给它的文件 | 复制到主机的 `~/.talkcode/attachments/`，告诉它的也是这个路径 |
| 它发给你的文件（`send_file`、`talkcode send-file`） | 从主机取回 |
| 它执行的 `talkcode …` 命令 | 在主机的 `PATH` 上，再转回网关 |
| 它添加的 `--bash` 定时任务 | 在主机上执行 |
| `/cd`、`/skills` | 列出主机上的目录和 skill |
| `talkcode` skill | 放进主机上对应 harness 的 skill 目录 |

`talkcode` 在登录 shell 里也能用。智能体执行 shell 命令常用 `bash -lc`（codex 就是），而登录 shell 会按
`/etc/profile` 重建 `PATH`——所以那里的 `talkcode` 是机器上装的那个，不是小服务放的那份。那份会把命令交给小服务，
而不是去找一个这台机器上根本不存在的网关配置。交出去的只有反向命令、`mcp` 和 `help`；`start`、`setup`、`doctor`
在主机上会被直接拒绝。

## 断网时

- 智能体在主机上继续干活。它的输出留在主机上（每个网关最多 64 MiB，远超一轮长对话），连接恢复后按顺序送达。
  断网期间你发的消息和 `/stop` 也一样，恢复后送达。
- 断线大约 15 秒内会被发现，然后反复重连，间隔从 1 秒逐步拉长到 30 秒。断线超过 10 秒，对话里会说一声，
  恢复后再说一声。这段沉默不会让这一轮失败。
- 重启网关会停掉它在各主机上启动的智能体。用 SIGTERM 停止网关时（停容器就是这样），它会先等正在跑的轮次跑完（见
  [更新](docker.md#更新)）。网关如果没来得及停掉它们就挂了，再次启动时会立刻停掉。
- 主机 24 小时收不到某个网关的消息，就会停掉这个网关的智能体。

## 版本

每个版本的网关都会在主机上安装自己的小服务，放在 `~/.talkcode/remote/<版本>/`。升级后的网关连上时，
上一个版本的小服务会被停掉；等没有网关再用它，它的目录也会被删除。小服务大约 4 MiB；网关自带两种架构的构建，
不会从别处下载任何东西。

机器自己 `PATH` 上的那个 `talkcode`（比如 uniagent 镜像里装的）是另一份安装。登录 shell 里的转发要求它不比网关旧：
更旧的仍然会报 "config not found"，比网关新的则会说主机上的小服务太旧。两边都升级才有这个效果。

## 选择智能体：`/agent`

`/cc`、`/oc` 这些智能体命令按 harness 命名，所以两台机器上各有一个 Claude Code 时，它们只能选到第一个。
`/agent` 能按 id 选到任何一个：先列出机器，再列出你选中的那台机器上的智能体。`/agent cc-dev` 可以直接选。
和 `/cc` 一样，已经有会话的话题会留在原来的智能体上；还没开始的话题选完智能体后会接着弹出目录菜单，
和直接发 `/cc` 一样。网页端里，新话题会按机器列出所有智能体，点一下就能选——见[网页端](web-ui.md)。

智能体按 `group:` 分组；没设的按所在主机分组，本机的归到「this machine」：

```yaml
agents:
  - { id: cc-dev, harness: claude, host: devbox, group: 构建机 }
```

网页界面的侧边栏也用这个名字，写在每个话题下面的目录前。

## 限制

- 如果主机上的 systemd-logind 会在用户登出时结束其进程（`KillUserProcesses=yes`），最后一个 ssh 连接关闭时
  小服务也会被结束。在那台机器上执行 `loginctl enable-linger <用户>`。
- 主机 shell 配置里设置的 `CLAUDE_CONFIG_DIR` 网关看不到。用到的话请写在智能体的 `env` 里，否则这个智能体的页脚没有缓存倒计时。
- 低于 1.4.7 的 `agy` 在远程主机上不显示上下文数字。

## 安全

`~/.config/talkcode/ssh/` 里的密钥能在它被授权的每台主机上打开 shell。这和那台主机上的智能体能替
`access.allowFrom` 里任何人做的事是一回事，所以按你本来就必须做的那样保护好网关即可。小服务不开任何网络端口：
它只走 ssh，以及 `~/.talkcode/remote/run/` 下一个仅属主可访问的 socket。
