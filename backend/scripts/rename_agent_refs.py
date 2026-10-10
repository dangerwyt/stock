"""把历史会话里残留的旧老师名批量改成新名字。

为什么需要它
------------
``ai_threads.json`` 存的是老师的**名字**（``teacherName`` / ``teacherNames[]``，
以及每条消息里的 ``teacherNames[]``），不是 id。所以一旦在
``custom_agents.json`` 里给自建角色改名（id 不变），历史会话就会继续带着旧名：

* 左侧会话列表 / 标题栏显示旧名；
* 前端 ``docsTarget`` 按名字匹配不到自建角色 → 上传按钮降级、点了报错。

用法
----
    cd backend
    # 先看会改什么（不落盘）
    python -m scripts.rename_agent_refs 3=A老师 3333=B老师 --dry-run
    # 确认后执行（自动先写 .bak 备份）
    python -m scripts.rename_agent_refs 3=A老师 3333=B老师

映射是「旧名=新名」，可以一次给多组。已经是新名的、以及内置老师的名字都不受影响。
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import threads  # noqa: E402


def _remap_list(values, mapping: dict[str, str]) -> tuple[list, int]:
    """返回 (新数组, 命中次数)。未命中的原样保留，重复项去重。"""
    if not isinstance(values, list):
        return values, 0
    hits = 0
    out: list = []
    for item in values:
        new = mapping.get(item, item) if isinstance(item, str) else item
        if new != item:
            hits += 1
        if new not in out:
            out.append(new)
    return out, hits


def migrate(mapping: dict[str, str], dry_run: bool) -> int:
    items = threads._read()
    if not items:
        print("ai_threads.json 里没有会话，无需迁移。")
        return 0

    changed: list[str] = []
    total_hits = 0
    for thread in items:
        hits = 0
        for field in ("title", "teacherName"):
            value = thread.get(field)
            if isinstance(value, str) and value in mapping:
                thread[field] = mapping[value]
                hits += 1
        teacher_names, n = _remap_list(thread.get("teacherNames"), mapping)
        thread["teacherNames"] = teacher_names
        hits += n
        for message in thread.get("messages") or []:
            if not isinstance(message, dict):
                continue
            names, n = _remap_list(message.get("teacherNames"), mapping)
            message["teacherNames"] = names
            hits += n
        if hits:
            total_hits += hits
            changed.append(f"  - {thread.get('id')}  {hits} 处 → teacherName={thread.get('teacherName')!r}")

    print(f"命中 {total_hits} 处，涉及 {len(changed)} 条会话：")
    print("\n".join(changed) if changed else "  （无）")
    if not changed:
        return 0

    if dry_run:
        print("\n--dry-run：未落盘。去掉 --dry-run 再跑一次即生效。")
        return total_hits

    backup = threads.STORE_PATH.with_suffix(".json.bak")
    shutil.copy2(threads.STORE_PATH, backup)
    threads._write(items)
    print(f"\n已写回 {threads.STORE_PATH}")
    print(f"备份   {backup}")
    return total_hits


def _parse_pairs(pairs: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for raw in pairs:
        if "=" not in raw:
            raise SystemExit(f"参数格式应为 旧名=新名，收到：{raw!r}")
        old, new = raw.split("=", 1)
        old, new = old.strip(), new.strip()
        if not old or not new:
            raise SystemExit(f"参数格式应为 旧名=新名，收到：{raw!r}")
        mapping[old] = new
    return mapping


def main() -> None:
    parser = argparse.ArgumentParser(description="批量重写历史会话里的老师名")
    parser.add_argument("pairs", nargs="+", help="旧名=新名，可多组，如 3=A老师 3333=B老师")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要修改的内容，不落盘")
    args = parser.parse_args()
    mapping = _parse_pairs(args.pairs)
    print(f"映射：{'  '.join(f'{k} → {v}' for k, v in mapping.items())}")
    migrate(mapping, args.dry_run)


if __name__ == "__main__":
    main()
