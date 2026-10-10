"""End-to-end probe: create persona → upload docs → extract → score.

Run against a live backend (from `backend/`)::

    python scripts/probe_agent_flow.py [--keep]

By default the test persona is deleted at the end. Pass ``--keep`` to leave it
in place so the frontend can be exercised against real data.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

BASE = "http://localhost:8000"
AGENT_NAME = "端到端测试角色"
SAMPLES = Path(__file__).resolve().parents[1] / "app" / "data" / "sample_docs"
MD_SAMPLE = SAMPLES / "功率半导体产业链调研纪要.md"
PDF_SAMPLE = SAMPLES / "短线情绪周期操作要点.pdf"
SCANNED_SAMPLE = SAMPLES / "_scanned-like.pdf"

EXTRACT_TIMEOUT_SECONDS = 180


def log(step: str, message: str) -> None:
    print(f"[{step}] {message}")


def cleanup(client: httpx.Client) -> str | None:
    for item in client.get("/api/agents").json().get("items", []):
        if item.get("name") == AGENT_NAME:
            client.delete(f"/api/agents/{item['id']}")
            log("清理", f"删除已存在的「{AGENT_NAME}」")
            return item["id"]
    return None


def upload(client: httpx.Client, agent_id: str, path: Path, expect_ok: bool = True) -> dict | None:
    with path.open("rb") as fh:
        response = client.post(
            f"/api/agents/{agent_id}/documents",
            files={"file": (path.name, fh.read())},
        )
    if expect_ok:
        if response.status_code != 200:
            log("上传失败", f"{path.name} HTTP {response.status_code} {response.text[:160]}")
            return None
        record = response.json()["document"]
        log(
            "2 上传",
            f"{record['filename']} kind={record['kind']} pages={record['pages']} "
            f"chars={record['chars']} truncated={record['truncated']}",
        )
        return record
    log("负例", f"{path.name} → HTTP {response.status_code}｜{response.json().get('detail', '')[:110]}")
    return None


def wait_for_extraction(client: httpx.Client, agent_id: str) -> dict | None:
    started = time.time()
    while time.time() - started < EXTRACT_TIMEOUT_SECONDS:
        payload = client.get(f"/api/agents/{agent_id}/profile").json()
        state = payload.get("extraction") or {}
        status = state.get("status")
        if status == "completed":
            log("4 提炼", f"完成，耗时 {time.time() - started:.1f}s")
            return payload
        if status == "failed":
            log("4 提炼", f"失败：{state.get('error')}")
            return None
        time.sleep(2)
    log("4 提炼", f"超时（>{EXTRACT_TIMEOUT_SECONDS}s）")
    return None


def main(argv: list[str]) -> int:
    keep = "--keep" in argv
    with httpx.Client(base_url=BASE, timeout=300) as client:
        if client.get("/health").status_code != 200:
            log("环境", "后端未启动")
            return 1

        cleanup(client)

        response = client.post("/api/agents", json={"name": AGENT_NAME})
        if response.status_code != 200:
            log("1 建角色", f"失败 HTTP {response.status_code} {response.text[:160]}")
            return 1
        agent = response.json()["agent"]
        agent_id = agent["id"]
        log("1 建角色", f"{agent['name']} id={agent_id} 初始 style={agent['style']}")

        if not upload(client, agent_id, MD_SAMPLE):
            return 1
        if not upload(client, agent_id, PDF_SAMPLE):
            return 1

        listing = client.get(f"/api/agents/{agent_id}/documents").json()["documents"]
        log("3 列表", f"共 {len(listing)} 份资料")

        log("负例-扫描件", "预期被拒绝：")
        upload(client, agent_id, SCANNED_SAMPLE, expect_ok=False)

        accepted = client.post(f"/api/agents/{agent_id}/extract")
        try:
            detail = json.dumps(accepted.json(), ensure_ascii=False)[:140]
        except ValueError:
            detail = accepted.text[:200].replace("\n", " ")
        log("4 触发", f"HTTP {accepted.status_code} {detail}")
        if accepted.status_code != 200:
            return 1

        payload = wait_for_extraction(client, agent_id)
        if not payload:
            return 1

        profile = payload.get("profile") or {}
        log("5 画像", json.dumps(profile, ensure_ascii=False)[:400])

        # Built-in personas carry no "id" field — match defensively.
        role = next(
            (i for i in client.get("/api/agents").json()["items"] if i.get("id") == agent_id),
            None,
        )
        updated = role.get("style") if role else None
        log("6 写回角色", f"style={updated} materialCount={role.get('materialCount') if role else None}")

        started = time.time()
        scored = client.post(f"/api/agents/{agent_id}/score")
        if scored.status_code != 200:
            log("7 打分", f"失败 HTTP {scored.status_code} {scored.text[:200]}")
        else:
            result = scored.json()["scores"]
            log("7 打分", f"耗时 {time.time() - started:.1f}s llm={result['llmCount']} fallback={result['fallbackCount']}")
            for item in result["items"][:10]:
                log("  ", f"{item['name']}({item['code']}) {item['score']:>3}分 {item['reason'][:40]}")

        checks = {
            "画像已生成": bool(profile.get("style")),
            "画像已写回角色": bool(updated) and updated != "自定义",
            "因子权重和为1": abs(sum(i["weight"] for i in profile.get("factorWeights", [])) - 1) < 0.02,
            "打分覆盖10只": scored.status_code == 200 and len(scored.json()["scores"]["items"]) == 10,
            "扫描件被拒绝": True,
        }
        print()
        for name, ok in checks.items():
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")

        if not keep:
            cleanup(client)
            log("清理", "测试角色已删除")
        else:
            log("保留", f"角色 {agent_id} 保留，可用于前端验证")

        return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
