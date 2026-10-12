#!/usr/bin/env bash
#
# 外部 tick 调度驱动器 —— 每分钟 POST 一次 /api/admin/scheduled。
#
# 为什么把定时放在「外部 tick」而不是进程内定时器：
#   tick 只负责"敲一下"，服务端根据上海时间和磁盘上的持久锁决定"此刻该不该跑、跑没跑过"。
#   好处是进程重启后下一分钟自动接上，且同一轮不会因反复 tick 而重复执行。
#   （设计说明见 backend/app/market_schedule.py 顶部）
#
# 用法：
#   bash scripts/scheduler-tick.sh              # 常驻循环，每 60s 一次
#   bash scripts/scheduler-tick.sh --once       # 只跑一次 —— 给 cron / launchd(StartInterval) / systemd timer
#   BASE_URL=http://127.0.0.1:8080 bash scripts/scheduler-tick.sh
#
# 环境变量：
#   LOCAL_SCHEDULER_BASE_URL  调度接口地址。本地 uvicorn 用 :8000；Docker 部署走 nginx 用 :8080
#   ADMIN_API_TOKEN           鉴权 token（不设则从仓库根 .env 读取）
#   TICK_INTERVAL_SECONDS     常驻模式间隔，默认 60
#   TICK_TIMEOUT_SECONDS      单次请求超时，默认 300（07:20 那一轮含全市场 TOP50，可能上百秒；
#                             nginx 对 /api/ 放的是 600s，留足余量）
#
# 接线示例（Mac 服务器 / launchd，与本项目 v1 的模型一致）：
#   <key>ProgramArguments</key><array><string>/bin/bash</string>
#   <string>/path/to/repo/scripts/scheduler-tick.sh</string><string>--once</string></array>
#   <key>StartInterval</key><integer>60</integer>
#   或 crontab：* * * * * /bin/bash /path/to/repo/scripts/scheduler-tick.sh --once >> /tmp/sip-tick.log 2>&1
set -uo pipefail

MODE="loop"
for arg in "$@"; do
  case "$arg" in
    --once) MODE="once" ;;
    -h|--help)
      echo "用法: bash scripts/scheduler-tick.sh [--once]"
      echo "  无参数   常驻循环，每 \${TICK_INTERVAL_SECONDS:-60}s 一次"
      echo "  --once   只跑一次（cron / launchd StartInterval / systemd timer 用）"
      exit 0
      ;;
    *) echo "未知参数：$arg（支持 --once / --help）" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${LOCAL_SCHEDULER_BASE_URL:-http://127.0.0.1:8000}"
INTERVAL="${TICK_INTERVAL_SECONDS:-60}"
TIMEOUT="${TICK_TIMEOUT_SECONDS:-300}"

# token 优先取环境变量，其次从仓库根 .env 读（与后端凭据同一份来源，避免两处配置漂移）。
if [[ -z "${ADMIN_API_TOKEN:-}" && -f "$REPO_ROOT/.env" ]]; then
  ADMIN_API_TOKEN="$(grep -E '^ADMIN_API_TOKEN=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
if [[ -z "${ADMIN_API_TOKEN:-}" ]]; then
  echo "[tick] 缺少 ADMIN_API_TOKEN（环境变量或 $REPO_ROOT/.env），无法鉴权" >&2
  exit 1
fi

ENDPOINT="${BASE_URL%/}/api/admin/scheduled"

# 单次 tick。返回 0 = 成功（含"本轮没有到点的 job"这种空跑）。
# 解析方式刻意不用 mktemp + rm：把 HTTP 状态码用哨兵串接在响应体后面再切开即可，
# 且 ${var##pattern} / ${var%pattern} 在 macOS 自带的 bash 3.2 上同样可用。
tick_once() {
  local raw code payload rc
  raw="$(curl -sS -m "$TIMEOUT" --noproxy '*' -X POST "$ENDPOINT" \
      -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
      -w '|SIP_CODE|%{http_code}')"
  rc=$?
  code="${raw##*|SIP_CODE|}"
  payload="${raw%|SIP_CODE|*}"

  if [[ $rc -ne 0 ]]; then
    echo "[tick] $(date '+%F %T') 请求失败（curl rc=$rc）"
    return 1
  fi
  if [[ "$code" != "200" ]]; then
    echo "[tick] $(date '+%F %T') HTTP $code：$payload"
    return 1
  fi
  # 只在"确实执行了 job"时打印，避免每分钟刷屏（一天只有 8 个 5 分钟窗口，空跑是常态）。
  case "$payload" in
    *'"results":[]'*|*'"results": []'*) ;;
    *) echo "[tick] $(date '+%F %T') $payload" ;;
  esac
  return 0
}

if [[ "$MODE" == "once" ]]; then
  tick_once
  exit $?
fi

echo "[tick] 常驻模式：每 ${INTERVAL}s POST ${ENDPOINT}（Ctrl-C 退出）"
while true; do
  tick_once || true   # 常驻循环下单次失败不退出（依赖服务端持久锁，下轮自然补上）
  sleep "$INTERVAL"
done
