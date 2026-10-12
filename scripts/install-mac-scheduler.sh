#!/usr/bin/env bash
#
# 在 macOS 上把调度 tick 挂成 launchd 常驻服务（LaunchAgent，每 60 秒跑一次 --once）。
#
# 对齐 reference-react 的 scripts/install-mac-services.mjs：
#   com.stock-intelligence.server     —— 起网站和 API（本项目是 docker compose 或本机 uvicorn）
#   com.stock-intelligence.scheduler  —— 每 60 秒调一次调度接口（本脚本负责这一个）
#
# 为什么用 launchd 而不是 crontab：Mac 上的 cron 在机器休眠/唤醒后容易漏跑且不好排查，
# launchd 的 StartInterval 由系统接管，还能开机自启（RunAtLoad）。
#
# 用法：
#   bash scripts/install-mac-scheduler.sh                     # 安装并启动（默认打 :8080，即 Docker 部署）
#   LOCAL_SCHEDULER_BASE_URL=http://127.0.0.1:8000 bash scripts/install-mac-scheduler.sh
#   bash scripts/install-mac-scheduler.sh --status
#   bash scripts/install-mac-scheduler.sh --uninstall
#
# 注意：ADMIN_API_TOKEN 刻意**不写进 plist** —— tick 脚本自己会去仓库根 .env 读，
# 免得同一个密钥存在两处、改一处忘一处。
set -uo pipefail

LABEL="com.stock-intelligence.scheduler"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TICK_SCRIPT="$REPO_ROOT/scripts/scheduler-tick.sh"
BASE_URL="${LOCAL_SCHEDULER_BASE_URL:-http://127.0.0.1:8080}"
LOG_DIR="$REPO_ROOT/.workbuddy/tmp"
LOG="$LOG_DIR/scheduler-tick.log"

ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --status)    ACTION="status" ;;
    -h|--help)   echo "用法: bash scripts/install-mac-scheduler.sh [--status|--uninstall]"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ 这个脚本只用于 macOS（当前 $(uname -s)）。" >&2
  echo "  Linux 用 systemd timer / cron，Windows 用任务计划程序 —— 见 docs/DEPLOY.md 第八节。" >&2
  exit 1
fi

unload_plist() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
}

case "$ACTION" in
  status)
    echo "plist 路径 : $PLIST"
    [[ -f "$PLIST" ]] && echo "plist 状态 : 已安装" || echo "plist 状态 : 未安装"
    echo "--- launchctl 视图 ---"
    launchctl list | grep -F "$LABEL" || echo "（未加载）"
    echo "--- 最近日志（尾部 15 行）---"
    [[ -f "$LOG" ]] && tail -n 15 "$LOG" || echo "（暂无日志：说明每次 tick 都是空跑，或还没跑过）"
    exit 0
    ;;
  uninstall)
    unload_plist
    rm -f "$PLIST"
    echo "✓ 已卸载并删除 $PLIST"
    exit 0
    ;;
esac

# ---------------------------------------------------------------- 安装
[[ -f "$TICK_SCRIPT" ]] || { echo "✗ 找不到 $TICK_SCRIPT" >&2; exit 1; }
[[ -f "$REPO_ROOT/.env" ]] || { echo "✗ 仓库根没有 .env（tick 要从里面读 ADMIN_API_TOKEN）" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$TICK_SCRIPT</string>
    <string>--once</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LOCAL_SCHEDULER_BASE_URL</key>
    <string>$BASE_URL</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

echo "✓ 已写入 $PLIST"
echo "  目标接口：$BASE_URL/api/admin/scheduled"
echo "  日志：$LOG"

# 先卸旧的再装，保证幂等（重复跑这个脚本不会叠加出两个服务）。
unload_plist
if ! launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
  launchctl load -w "$PLIST" || { echo "✗ launchctl 加载失败，看上面的报错" >&2; exit 1; }
fi
echo "✓ 已加载 $LABEL"

echo
echo "马上验证一次（RunAtLoad 会先跑一轮，等几秒看日志）："
sleep 3
if [[ -f "$LOG" ]]; then
  echo "--- $LOG ---"
  tail -n 10 "$LOG"
  echo "（没有内容 = 本次 tick 空跑，属正常：一天只有 8 个 5 分钟窗口会真正执行任务）"
else
  echo "（日志还没落盘，等下一分钟再看：bash scripts/install-mac-scheduler.sh --status）"
fi
echo
echo "查状态：bash scripts/install-mac-scheduler.sh --status"
echo "卸载  ：bash scripts/install-mac-scheduler.sh --uninstall"
