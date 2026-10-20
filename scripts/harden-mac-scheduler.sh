#!/usr/bin/env bash
#
# Mac 生产级调度加固：确保每天各轮次都能按时跑，杜绝「10-15 之后 tick 全 rc=7 停摆」。
#
# 它做四件事：
#   1) 安装/确认 tick 常驻（com.stock-intelligence.scheduler，每 60s POST /api/admin/scheduled，
#      走既有 scripts/install-mac-scheduler.sh，用户级 LaunchAgent，登录即起）。
#   2) 栈保活（com.stock-intelligence.stack，每 5 分钟 ensure-stack-up.sh）：Docker 栈挂了最多 5 分钟自愈，
#      从根上消除「栈倒 → tick 全 rc=7 → 调度全停」的事故。
#   3) 防睡眠（com.stock-intelligence.insomnia，caffeinate -dimsu + pmset sleep 0）：
#      避免 Mac 空闲休眠导致隔夜轮次（07:20 / 22:00）被静默跳过。
#   4) 打印状态：三个 agent 是否加载、睡眠设置、栈健康。
#
# 注意：tick / stack / insomnia 均为「用户级 LaunchAgent」，依赖登录会话。
# 若需「登出也继续」，tick 可改系统级 LaunchDaemon（不需要 Docker），但 stack 需要 Docker 用户态，
# 仍须登录——故本脚本统一用 LaunchAgent，前提是你保持登录（你说 Mac 不关机，正合适）。
#
# 用法：
#   bash scripts/harden-mac-scheduler.sh            # 安装并启用全部
#   bash scripts/harden-mac-scheduler.sh --status   # 查看状态
#   bash scripts/harden-mac-scheduler.sh --uninstall
#
# 需要 sudo 的只有 pmset（关睡眠）；其余不需要。脚本会在那一步走 sudo 让你输密码。
set -uo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ 仅 macOS 可用（当前 $(uname -s)）" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$REPO_ROOT/.workbuddy/tmp"
mkdir -p "$AGENT_DIR" "$LOG_DIR"

TICK_LABEL="com.stock-intelligence.scheduler"
STACK_LABEL="com.stock-intelligence.stack"
INSOMNIA_LABEL="com.stock-intelligence.insomnia"
TICK_PLIST="$AGENT_DIR/$TICK_LABEL.plist"
STACK_PLIST="$AGENT_DIR/$STACK_LABEL.plist"
INSOMNIA_PLIST="$AGENT_DIR/$INSOMNIA_LABEL.plist"

ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --status)    ACTION="status" ;;
    --uninstall) ACTION="uninstall" ;;
    -h|--help)   echo "用法: bash scripts/harden-mac-scheduler.sh [--status|--uninstall]"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

unload() {
  launchctl unload "$1" 2>/dev/null || true
  rm -f "$1"
}

status() {
  echo "===== LaunchAgent 状态 ====="
  launchctl list | grep -E "stock-intelligence" || echo "（无加载）"
  echo
  echo "===== 睡眠设置 (pmset -g) ====="
  pmset -g 2>/dev/null | grep -iE "sleep|disablesleep" || echo "（取不到）"
  echo
  echo "===== Docker 栈健康 ====="
  if docker compose ps 2>/dev/null; then :; else echo "（docker 不可用或栈未起）"; fi
  echo
  echo "===== 最近 tick 日志（尾部 8 行）====="
  [[ -f "$LOG_DIR/scheduler-tick.log" ]] && tail -n 8 "$LOG_DIR/scheduler-tick.log" || echo "（无日志）"
}

if [[ "$ACTION" == "status" ]]; then
  status
  exit 0
fi

if [[ "$ACTION" == "uninstall" ]]; then
  unload "$TICK_PLIST"
  unload "$STACK_PLIST"
  unload "$INSOMNIA_PLIST"
  echo "✓ 已卸载三个 agent。如需恢复系统睡眠：sudo pmset -a sleep 30"
  exit 0
fi

# ----------------------------------------------------------------- 安装
echo "== [1/4] tick 常驻 =="
bash "$REPO_ROOT/scripts/install-mac-scheduler.sh" >/dev/null 2>&1 && echo "  ✓ tick 已安装/确认" || {
  echo "  ⚠ install-mac-scheduler.sh 执行异常，单独跑它看报错"
}

echo "== [2/4] 栈保活（每 5 分钟自愈）=="
cat > "$STACK_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$STACK_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/scripts/ensure-stack-up.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stack-up.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stack-up.log</string>
</dict>
</plist>
PLIST_EOF
launchctl unload "$STACK_PLIST" 2>/dev/null || true
launchctl load -w "$STACK_PLIST" && echo "  ✓ 栈保活 agent 已加载"

echo "== [3/4] 防睡眠（caffeinate + pmset）=="
cat > "$INSOMNIA_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$INSOMNIA_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dimsu</string>
    <string>sleep</string>
    <string>315360000</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/insomnia.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/insomnia.log</string>
</dict>
</plist>
PLIST_EOF
launchctl unload "$INSOMNIA_PLIST" 2>/dev/null || true
launchctl load -w "$INSOMNIA_PLIST" && echo "  ✓ 防睡眠 agent 已加载（caffeinate 常驻）"

echo "== [4/4] 关闭系统空闲睡眠（需要 sudo）=="
if sudo pmset -a sleep 0 2>/dev/null; then
  echo "  ✓ pmset sleep 0（永不空闲休眠）"
else
  echo "  ⚠ pmset 需要 sudo，请手动执行：sudo pmset -a sleep 0"
fi

echo
echo "✓ 加固完成。立刻验证一遍："
bash "$0" --status
echo
echo "提示：栈保活每 5 分钟跑一次 ensure-stack-up.sh；若想看实时 tick，可："
echo "  tail -f $LOG_DIR/scheduler-tick.log"
