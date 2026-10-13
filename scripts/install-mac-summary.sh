#!/usr/bin/env bash
#
# 在 macOS 上把"定时任务运行汇总"挂成 launchd 每日任务（LaunchAgent，每天 00:15 跑一次）。
#
# 对齐 scripts/install-mac-scheduler.sh 的模型：
#   com.stock-intelligence.scheduler       —— 每 60 秒敲一次调度接口
#   com.stock-intelligence.scheduler-summary —— 每天 00:15 产出前一天的汇总 MD（本脚本负责这一个）
#
# 为什么用 launchd 而不是 crontab：Mac 的 cron 在机器休眠/唤醒后容易漏跑且不好排查，
# launchd 的 StartCalendarInterval 由系统接管，还能开机自启（RunAtLoad 这里不开，避免装机当天空跑）。
#
# 产出：默认写到 $REPO_ROOT/backend/app/data/summaries/<前一天>.md
#       （与 job_runs.json 同层，已在 .gitignore；想换目录就改 SCHEDULER_SUMMARY_OUT 后重装）。
#
# 用法：
#   bash scripts/install-mac-summary.sh            # 安装并加载
#   bash scripts/install-mac-summary.sh --status
#   bash scripts/install-mac-summary.sh --uninstall
#
# Linux 等价（cron，每天 00:15，TZ=Asia/Shanghai）：
#   15 0 * * * TZ=Asia/Shanghai /bin/bash /path/to/repo/scripts/scheduler-summary-run.sh >> /path/to/repo/.workbuddy/tmp/scheduler-summary.log 2>&1
# Windows 用"任务计划程序"触发 scripts/scheduler-summary-run.sh（或 scheduler-summary.py --out-dir）。
set -uo pipefail

LABEL="com.stock-intelligence.scheduler-summary"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SCRIPT="$REPO_ROOT/scripts/scheduler-summary-run.sh"
LOG_DIR="$REPO_ROOT/.workbuddy/tmp"
LOG="$LOG_DIR/scheduler-summary.log"

ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --status)    ACTION="status" ;;
    -h|--help)   echo "用法: bash scripts/install-mac-summary.sh [--status|--uninstall]"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ 这个脚本只用于 macOS（当前 $(uname -s)）。" >&2
  echo "  Linux 用上面的 cron 行；Windows 用任务计划程序。" >&2
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
    echo "--- 最近产物 ---"
    ls -t "$REPO_ROOT"/backend/app/data/summaries/*.md 2>/dev/null | head -3 || echo "（还没有汇总 MD）"
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
[[ -f "$RUN_SCRIPT" ]] || { echo "✗ 找不到 $RUN_SCRIPT" >&2; exit 1; }
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
    <string>$RUN_SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TZ</key>
    <string>Asia/Shanghai</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>0</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

echo "✓ 已写入 $PLIST"
echo "  触发时间：每天 00:15（上海时区，待前一天 22:00 轮次全部跑完后）"
echo "  产出目录：$REPO_ROOT/backend/app/data/summaries/"

# 先卸旧的再装，保证幂等（重复跑不会叠加出两个服务）。
unload_plist
if ! launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
  launchctl load -w "$PLIST" || { echo "✗ launchctl 加载失败，看上面的报错" >&2; exit 1; }
fi
echo "✓ 已加载 $LABEL"

echo
echo "马上手动跑一次验证（不依赖定时器）："
bash "$RUN_SCRIPT"
echo
echo "查状态：bash scripts/install-mac-summary.sh --status"
echo "卸载  ：bash scripts/install-mac-summary.sh --uninstall"
