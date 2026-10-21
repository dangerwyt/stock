"""按当前证据链口径重算冻结快照里的 ``selectionEvidence``（不拉行情、不改分数）。

为什么需要它
------------
``selectionEvidence`` 是**随快照冻结**的：``/api/top50/evidence`` 只读 ``_CACHE["evidence"]``。
所以改了 ``build_selection_evidence`` 的口径（例如「反对 Agent」从绝对 ``<45`` 改成与支持
互补的 ``<60`` + 相对保留兜底）之后，旧快照不会自动更新 —— 要么等下一次 07:20 冻结轮，
要么 ``force=True`` 重算，而后者会重新消耗 Tushare 全市场额度（4 个大调用）。

本脚本只读快照里**已冻结**的 ``agentScores`` 与运行态画像，原地重算证据字段：
零行情调用、不改任何分数与排名、不动 ``snapshotId`` / ``predictionId``。

用法（在 ``backend/`` 下执行）
------------------------------
    ./.venv/Scripts/python.exe -m scripts.repatch_top50_evidence --dry-run   # 只看分布
    ./.venv/Scripts/python.exe -m scripts.repatch_top50_evidence --apply     # 写回快照

⚠️ 写回后需要**重启 uvicorn** 才会生效（``_CACHE`` 是进程内缓存，启动时从落盘文件恢复）。
⚠️ 若同一数据窗口内后端正在跑，别让它在写之前触发重算，否则会用旧口径覆盖回来。
"""

from __future__ import annotations

import argparse
import json
from collections import Counter

from app import agent_factor_score
from app import top50_engine as te

# 补算时必须原样搬回去的字段：它们标识"哪一批冻结"，重算不该改变。
_PRESERVE_KEYS = ("snapshotId", "cycleSnapshotId", "rank", "dataCutoff")


def main() -> None:
    parser = argparse.ArgumentParser(description="离线重算 TOP50 冻结快照的证据链")
    parser.add_argument("--dry-run", action="store_true", help="只演练、不落盘（默认行为）")
    parser.add_argument("--apply", action="store_true", help="真正写回快照文件")
    args = parser.parse_args()
    dry_run = not args.apply

    path = te._snapshot_file()
    if not path.exists():
        raise SystemExit(f"快照文件不存在：{path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    snapshot = payload.get("snapshot") or {}
    cycles = snapshot.get("cycles") or {}
    if not cycles:
        raise SystemExit("快照里没有 cycles，无可补算")

    specs = agent_factor_score.custom_teacher_specs()
    custom_names = [spec["name"] for spec in specs]
    profiles = {**te.TEACHER_PROFILES, **agent_factor_score.profile_meta(specs)}
    evidence_store = payload.get("evidence") or {}

    modes: Counter[str] = Counter()
    patched = 0
    for cycle, data in cycles.items():
        config = te.CYCLES.get(cycle)
        if not config:
            continue
        cycle_weights = te._cycle_weights(config, custom_names)
        for item in data.get("ranking") or []:
            old = item.get("selectionEvidence")
            if not isinstance(old, dict) or not old:
                continue
            rebuilt = te.build_selection_evidence(
                item,
                cycle,
                {**config, "weights": cycle_weights},
                str(old.get("dataCutoff") or ""),
                profiles,
            )
            for key in _PRESERVE_KEYS:
                rebuilt[key] = old.get(key)
            item["selectionEvidence"] = rebuilt
            prediction_id = item.get("predictionId")
            if prediction_id and prediction_id in evidence_store:
                evidence_store[prediction_id]["selectionEvidence"] = rebuilt
            modes[rebuilt.get("opposingMode") or "unknown"] += 1
            patched += 1

    print(f"目标文件：{path}")
    print(f"重算 {patched} 条；模式分布：{dict(modes)}")
    if dry_run:
        print("（dry-run，未落盘；加 --apply 写回）")
        return

    payload["snapshot"] = snapshot
    payload["evidence"] = evidence_store
    text = json.dumps(payload, ensure_ascii=False)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    print(f"已写回：{path}（{len(text.encode('utf-8')) / 1048576:.1f} MB）")
    print("⚠️ 重启 uvicorn 后生效（进程内 _CACHE 启动时才从文件恢复）")


if __name__ == "__main__":
    main()
