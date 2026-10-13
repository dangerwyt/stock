#!/usr/bin/env python3
"""清理上传资料里的垃圾（OCR 失败 / 相关性被拒），还原 12 位老师的画像。

为什么需要：
  上传 OCR 失败的图片会触发 add_document 把该角色的 profile 置空，且 OCR 失败不会重跑
  提炼，于是 12 位老师的画像变 null、退出 TOP50 打分。本脚本把垃圾清掉，并把因此变空的
  画像从种子恢复，让老师们重新参与打分。

行为：
  默认（surgical）：遍历 agent_docs 下所有角色，删除 ocrStatus=failed 或 status=rejected
    的文档（含其 files/ texts 文件）；若某角色 profile 因此为 null，从种子恢复。
  --reset：仅对 12 位种子老师做整份还原（清空所有上传资料 + 写回种子画像/分数）。

默认 dry-run（只打印，不落盘）；--apply 才真正写盘。

运行位置：
  本地：  python scripts/clean_failed_docs.py [--apply|--reset]
  Docker：docker compose cp scripts/clean_failed_docs.py backend:/tmp/clean_failed_docs.py
          docker compose exec backend python /tmp/clean_failed_docs.py [--apply|--reset]
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def resolve_dirs():
    env = os.environ.get("AGENT_DOCS_DIR", "").strip()
    if env:
        docs_dir = Path(env)
    else:
        # 脚本可能位于 <repo>/scripts 或 <repo>/backend/scripts 或 /tmp（容器 cp 进去）。
        # 在候选里挑真实存在的那个；都没有则退回「脚本在 <repo>/scripts」的默认。
        here = Path(__file__).resolve().parent
        candidates = [
            here.parent / "backend" / "app" / "data" / "agent_docs",
            here / "app" / "data" / "agent_docs",
            here.parent / "app" / "data" / "agent_docs",
        ]
        docs_dir = next((c for c in candidates if c.exists()), candidates[0])
    docs_dir = docs_dir.resolve()
    data_dir = docs_dir.parent
    seed_path = data_dir / "custom_agents.seed.json"
    return docs_dir, seed_path


def load_seed(seed_path: Path):
    try:
        payload = json.loads(seed_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, []
    profiles = payload.get("profiles") or {}
    agents = [a for a in (payload.get("agents") or []) if isinstance(a, dict)]
    return profiles, agents


def is_junk(doc: dict) -> bool:
    return doc.get("ocrStatus") == "failed" or str(doc.get("status") or "").lower() == "rejected"


def _write_meta(meta_path: Path, meta: dict) -> None:
    tmp = meta_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(meta_path)


def main() -> None:
    ap = argparse.ArgumentParser(description="清理失败上传 + 还原 12 位老师画像")
    ap.add_argument("--apply", action="store_true", help="真正落盘（默认 dry-run）")
    ap.add_argument("--reset", action="store_true", help="对 12 位种子老师整份还原")
    args = ap.parse_args()

    docs_dir, seed_path = resolve_dirs()
    seed_profiles, seed_agents = load_seed(seed_path)
    teacher_ids = {str(a.get("id")) for a in seed_agents if a.get("id")}

    if not docs_dir.exists():
        print(f"agent_docs 目录不存在：{docs_dir}，无需清理。")
        return

    if args.reset:
        targets = sorted(teacher_ids)
        mode = "reset（12 位种子老师整份还原）"
    else:
        targets = sorted(p.name for p in docs_dir.iterdir() if p.is_dir())
        mode = "surgical（删失败/被拒文档 + 还原 null 画像）"

    print(("[dry-run] " if not args.apply else "[apply] ") + f"模式：{mode}")

    removed = 0
    reseeded = 0
    for agent_id in targets:
        adir = docs_dir / agent_id
        meta_path = adir / "meta.json"

        if args.reset:
            seeded = seed_profiles.get(agent_id)
            if seeded is None:
                print(f"  {agent_id}: 种子无此画像，跳过")
                continue
            if args.apply:
                default = {
                    "documents": [],
                    "extraction": {
                        "status": "idle", "error": None, "startedAt": None,
                        "finishedAt": None, "documentCount": 0, "historyCount": 0,
                    },
                    "profile": None, "scores": None, "autoExtract": None,
                }
                _write_meta(meta_path, {**default, **seeded})
            print(f"  {agent_id}: 写回种子画像")
            reseeded += 1
            continue

        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        docs = meta.get("documents") or []
        junk = [d for d in docs if is_junk(d)]
        profile_null = meta.get("profile") is None
        if not junk and not profile_null:
            continue

        if args.apply:
            for d in junk:
                did = d.get("id")
                if not did:
                    continue
                for f in (adir / "files").glob(f"{did}.*"):
                    f.unlink(missing_ok=True)
                t = adir / "texts" / f"{did}.txt"
                if t.exists():
                    t.unlink(missing_ok=True)
            if profile_null and agent_id in seed_profiles:
                sp = seed_profiles[agent_id]
                meta["profile"] = sp.get("profile")
                meta["scores"] = sp.get("scores")
                reseeded += 1
            meta["documents"] = [d for d in docs if d not in junk]
            eff = sum(
                1 for d in meta["documents"]
                if str(d.get("status") or "").lower() != "rejected"
            )
            ext = meta.get("extraction") or {}
            ext["documentCount"] = eff
            meta["extraction"] = ext
            _write_meta(meta_path, meta)

        removed += len(junk)
        flag = []
        if junk:
            flag.append(f"删 {len(junk)} 份垃圾")
        if profile_null and agent_id in seed_profiles:
            flag.append("画像已还原(seed)")
        elif profile_null:
            flag.append("画像仍 null(非种子角色)")
        print(f"  {agent_id}: {'; '.join(flag) if flag else '无变动'}")

    print(f"完成。删除垃圾文档 {removed} 份，还原画像 {reseeded} 个。")
    if not args.apply:
        print("（以上为 dry-run，未落盘。确认无误后加 --apply 执行。）")


if __name__ == "__main__":
    main()
