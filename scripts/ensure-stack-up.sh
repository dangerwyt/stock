#!/usr/bin/env bash
#
# 幂等保证 Docker 栈（nginx:8080 + backend:8000）始终在跑。
# 供 com.stock-intelligence.stack LaunchAgent 每 5 分钟调用一次：
#   - docker 守护没起 → 尝试拉起 Docker Desktop，等其就绪
#   - 栈没起/挂了 → `docker compose up -d`（缺则建、停则起、已在则 no-op）
# 这样即便栈因意外退出，最多 5 分钟内自愈，tick 不会长时间 rc=7。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

if ! docker info >/dev/null 2>&1; then
  # Docker 守护未运行（多见于 Docker Desktop 被关）：拉起它，最多等 ~30s。
  open -a Docker >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

if docker info >/dev/null 2>&1; then
  docker compose up -d >/dev/null 2>&1
fi
