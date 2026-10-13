#!/usr/bin/env python3
"""产出指定日期的定时任务运行汇总（Markdown）。

读 ``job_runs.json``（``JOB_RUNS_PATH`` 或默认 ``backend/app/data/job_runs.json``），
按轮次表（``TRADING_ROUNDS``）遍历每个 (时间, 任务) 槽，从持久锁里查该槽的执行状态，
映射为「成功 / 失败 / 未执行」三态，生成一张
「时间 | 任务 | 用途 | 执行状态」表。

用途（每个 slot 的 用途 取自下面的 ``PURPOSE``，与轮次表一一对应）。

用法：
    python scripts/scheduler-summary.py                # 默认：上海时区前一天，打印到 stdout
    python scripts/scheduler-summary.py --date 2026-10-12
    python scripts/scheduler-summary.py --out report.md
    python scripts/scheduler-summary.py --out-dir docs/scheduler-summary   # 自动写 <date>.md

说明：非交易日调度只跑 ``CLOSED_ROUNDS``（仅 global-news），但本脚本默认按完整交易日
轮次表输出，未运行的槽会显示为「未执行」——这正是"昨天哪些没跑起来"的有用信号。
加 ``--closed`` 可只看非交易日轮次。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
try:
    from zoneinfo import ZoneInfo

    _SHANGHAI = ZoneInfo("Asia/Shanghai")
except Exception:  # noqa: BLE001 - 极少数环境（如未装 tzdata 的 Windows）缺时区数据，回落系统本地时间
    _SHANGHAI = None

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# 用 AST 直接从 market_schedule.py 抽出两张轮次表，避免触发
# ``market_schedule → job_runs → config → pydantic_settings`` 的重导入链，
# 这样脚本在没装后端依赖的机器上也能独立跑。market_schedule.py 仍是唯一数据源。
def _load_rounds() -> tuple[list, list]:
    import ast

    src = (ROOT / "backend" / "app" / "market_schedule.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    found: dict[str, list] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id in ("TRADING_ROUNDS", "CLOSED_ROUNDS"):
                    found[tgt.id] = ast.literal_eval(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id in ("TRADING_ROUNDS", "CLOSED_ROUNDS") and node.value is not None:
                found[node.target.id] = ast.literal_eval(node.value)
    return found["TRADING_ROUNDS"], found["CLOSED_ROUNDS"]


TRADING_ROUNDS, CLOSED_ROUNDS = _load_rounds()

# 每个 (slot, job) 的用途，与轮次表一一对应。
PURPOSE: dict[str, str] = {
    "07:20|us-etf-map": "采集美股 ETF，映射今日 A 股板块",
    "07:20|global-news": "采集全球、港股、美股和宏观资讯",
    "07:20|market-close": "获取上一交易日收盘行情并建立盘前基准",
    "07:20|top50": "用 12 套因子画像生成四周期 TOP50，并冻结预测",
    "09:26|opening-auction": "集合竞价行情采集",
    "09:26|global-news": "开盘前再次更新全球和宏观资讯",
    "10:30|market-pulse": "上午盘中异动和行情监控",
    "10:30|intraday-news": "上午盘中资讯",
    "11:35|market-pulse": "午间前行情监控",
    "11:35|intraday-news": "午间资讯",
    "11:35|midday-review": "午间复核",
    "13:05|market-pulse": "下午开盘行情监控",
    "13:05|intraday-news": "下午开盘资讯",
    "14:00|market-pulse": "下午盘中行情监控",
    "14:00|intraday-news": "下午盘中资讯",
    "17:40|market-close": "收盘数据校准",
    "17:40|post-close": "盘后复盘",
    "17:40|accuracy": "到期预测结果验证",
    "17:40|global-news": "晚间资讯更新",
    "22:00|global-news": "晚间资讯和缺失内容补采",
    "22:00|market-close": "收盘数据补采",
    "22:00|post-close": "盘后复盘补全",
    "22:00|accuracy": "预测证据补验证",
}


def classify(status: str | None) -> str:
    """锁记录里的原始 status → 汇总三态。

    completed → 成功；failed → 失败；stubbed / 无记录 → 未执行；
    partial/degraded/unavailable 等"跑了但有保留" → 成功(原始态) 以便追溯。
    """
    if status is None:
        return "未执行"
    if status == "completed":
        return "成功"
    if status == "failed":
        return "失败"
    if status == "stubbed":
        return "未执行"
    return f"成功({status})"


def load_job_runs(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def target_date(arg_date: str | None) -> str:
    """返回 YYYY-MM-DD。

    默认：上海时区的**前一天**（与后端 ``market_clock`` 锁键口径一致，不依赖运行机系统 TZ）。
    这样无论 Mac/服务器系统时钟是什么时区，生成的文件名都和被后端写进 ``job_runs.json``
    的锁键日期对齐，不会出现"深夜跑脚本差一天"的错位。

    注意：``job_runs.json`` 的锁键用的是**连字符**日期（``job:2026-10-12:...``），
    所以这里也用连字符格式去拼 key，否则会全部匹配不到。
    """
    if arg_date:
        d = arg_date.replace("-", "")
        return f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    if _SHANGHAI is not None:
        now = datetime.now(_SHANGHAI)
    else:
        # 极少数环境（如未装 tzdata 的 Windows）拿不到上海时区，回落系统本地时间并告警。
        print(
            "⚠️ 环境缺少 Asia/Shanghai 时区数据，'昨天'按系统本地时间计算；"
            "若系统 TZ 非上海，文件名可能与后端锁键日期差一天。",
            file=sys.stderr,
        )
        now = datetime.now()
    return (now - timedelta(days=1)).strftime("%Y-%m-%d")


def build_markdown(date: str, rounds: list[tuple[str, list[str]]], locks: dict) -> str:
    date_hyphen = date  # 已是连字符格式 YYYY-MM-DD
    rows: list[tuple[str, str, str, str]] = []
    for slot, jobs in rounds:
        for job in jobs:
            key = f"job:{date}:{slot}:{job}"
            rec = locks.get(key)
            status = rec.get("status") if isinstance(rec, dict) else None
            purpose = PURPOSE.get(f"{slot}|{job}", "")
            rows.append((slot, job, purpose, classify(status)))

    lines = [
        f"# 定时任务运行汇总 · {date_hyphen}",
        "",
        f"> 共 {len(rows)} 个任务槽（轮次表：{'交易日' if rounds is TRADING_ROUNDS else '非交易日'}）",
        ">",
        "| 时间 | 任务 | 用途 | 执行状态 |",
        "| --- | --- | --- | --- |",
    ]
    for slot, job, purpose, state in rows:
        lines.append(f"| {slot} | {job} | {purpose} | {state} |")
    lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description="定时任务运行汇总（Markdown）")
    ap.add_argument("--date", help="目标日期 YYYY-MM-DD（默认：前一天）")
    ap.add_argument("--out", help="输出 .md 文件路径（默认打印到 stdout）")
    ap.add_argument("--out-dir", help="输出目录，自动以 <date>.md 命名（与 --out 互斥，给 cron/launchd 用）")
    ap.add_argument("--closed", action="store_true", help="按非交易日轮次表输出")
    args = ap.parse_args()

    date = target_date(args.date)
    rounds = CLOSED_ROUNDS if args.closed else TRADING_ROUNDS

    env_path = os.environ.get("JOB_RUNS_PATH")
    jr_path = Path(env_path) if env_path else (ROOT / "backend" / "app" / "data" / "job_runs.json")
    runs = load_job_runs(jr_path)
    locks = runs.get("locks") or {}

    md = build_markdown(date, rounds, locks)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md, encoding="utf-8")
        print(f"已写入 {out}（{len(md.splitlines())} 行）")
    elif args.out_dir:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{date}.md"
        out.write_text(md, encoding="utf-8")
        print(f"已写入 {out}（{len(md.splitlines())} 行）")
    else:
        print(md)


if __name__ == "__main__":
    main()
