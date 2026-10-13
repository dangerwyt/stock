#!/usr/bin/env bash
#
# 定时任务运行汇总 —— 自动产出"前一天"的 MD（给 cron / launchd / systemd timer 调用）。
#
# 日期与命名交给 scheduler-summary.py：
#   * 默认目标日期 = 上海时区的前一天（脚本内部 datetime.now() - 1 天，受 TZ 影响）；
#   * --out-dir 下自动以 <date>.md 命名，幂等可重复跑（覆盖同一天文件）。
#
# 用法：
#   bash scripts/scheduler-summary-run.sh
#   SCHEDULER_SUMMARY_OUT=/path/to/dir bash scripts/scheduler-summary-run.sh
#   SCHEDULER_SUMMARY_PY=/usr/bin/python3 bash scripts/scheduler-summary-run.sh
#
# 环境变量：
#   SCHEDULER_SUMMARY_OUT   输出目录（默认 $REPO_ROOT/backend/app/data/summaries，与 job_runs.json 同层，gitignore）
#   SCHEDULER_SUMMARY_PY    Python 解释器（默认 python3；脚本只依赖标准库，无需后端 venv）
#   SCHEDULER_SUMMARY_TZ    时区（默认 Asia/Shanghai，决定"前一天"按哪个市场日切分）
set -uo pipefail

export TZ="${SCHEDULER_SUMMARY_TZ:-Asia/Shanghai}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${SCHEDULER_SUMMARY_OUT:-$REPO_ROOT/backend/app/data/summaries}"
PY="${SCHEDULER_SUMMARY_PY:-python3}"

mkdir -p "$OUT_DIR"
exec "$PY" scripts/scheduler-summary.py --out-dir "$OUT_DIR"
