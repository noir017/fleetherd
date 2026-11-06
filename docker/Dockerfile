# syntax=docker/dockerfile:1.7
#
# The gateway alone, for running it in a container of its own with every agent on a remote host
# (docs/docker.md). Built by .github/workflows/image.yml into ghcr.io/noir017/talkcode.
#
# It installs the published Release tarball, pinned by its SHA256SUMS line, rather than building
# this checkout: the image then holds the same bytes as `npm i -g <release URL>`, and rebuilding a
# version later cannot produce a gateway that differs from the one that was released. The checksum
# comes from the Release's own SHA256SUMS (the workflow reads it), not from hashing a download —
# a download swapped in transit would match a hash taken of itself.
FROM node:24-bookworm-slim

ARG TALKCODE_VERSION
ARG TALKCODE_SHA256
# The account the gateway runs as. Two things outside the image depend on this number: the files
# of the mounted config directory, and — when the web UI's terminal is used — the 0600 socket of
# the ttyd it connects to, which belongs to the host account that runs ttyd. 1001 is that account
# on the deployment this image was made for; build with another UID for yours.
ARG UID=1001
ARG GID=1001

# openssh-client: the gateway reaches every host with the system ssh (src/remote/binaries.ts).
# git: the managed skills are a git repository, kept in step with `skills.repo` over that same ssh
# (src/daemon/skills-git.ts); without it no managed skill is delivered.
# tini: PID 1 that reaps. The gateway spawns ssh, and a hook or an endCommand can spawn more; with
# node as PID 1 their orphans would stay zombies.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssh-client git tini tzdata ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g "${GID}" talkcode; \
    useradd -m -u "${UID}" -g "${GID}" -s /bin/bash talkcode

# ADD --checksum verifies before the layer exists, so a mismatch fails the build here.
ADD --checksum=sha256:${TALKCODE_SHA256} \
    https://github.com/noir017/talkcode/releases/download/v${TALKCODE_VERSION}/talkcode-${TALKCODE_VERSION}.tgz \
    /tmp/talkcode.tgz

# No agent runs in this image, so the Claude Code binary the Agent SDK carries as an optional
# dependency (~222 MB per architecture, pulled in through claude-agent-acp) is removed in the same
# layer that installed it. It cannot be left out instead: `npm install -g` ignores --omit=optional
# (measured with npm 12, 2026-09-23). A `harness: claude` agent without `host:` therefore fails here
# with "native binary not found" — agents belong on hosts, which bring their own.
RUN set -eux; \
    npm install -g /tmp/talkcode.tgz; \
    rm -f /tmp/talkcode.tgz; \
    root="$(npm root -g)/talkcode"; \
    test "$(node -p "require('${root}/package.json').version")" = "${TALKCODE_VERSION}"; \
    find "${root}" -type d -path '*/@anthropic-ai/claude-agent-sdk-*' -prune -exec rm -rf {} +; \
    if find "${root}" -type f -name claude -size +10M | grep .; then \
        echo "a bundled Claude binary is still inside talkcode" >&2; exit 1; \
    fi; \
    test -x "${root}/dist/remote-bin/talkcode-remote-linux-amd64"; \
    test -x "${root}/dist/remote-bin/talkcode-remote-linux-arm64"; \
    npm cache clean --force; \
    talkcode --version

USER talkcode
WORKDIR /home/talkcode
# The daemon logs to stdout; `docker logs` (with -t for timestamps) is the log.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["talkcode", "start"]
