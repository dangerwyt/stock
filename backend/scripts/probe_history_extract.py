"""Verify that session Q&A is fed into profile extraction.

Two layers of evidence:
  A) deterministic  — build_messages / history_for_agent output inspected directly
  B) end-to-end     — same document extracted twice (no chat vs. with chat), diffed

Run:  python scripts/probe_history_extract.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import agent_profile, threads  # noqa: E402
from app.documents import ExtractedDocument  # noqa: E402

BASE = "http://localhost:8000"
CLIENT = "vue-web-client"
SAMPLE = Path(__file__).resolve().parents[1] / "app/data/sample_docs/功率半导体产业链调研纪要.md"

CHAT = [
    {"role": "user", "content": "我做短线，只看情绪周期和资金接力，不太看业绩，这套思路写进我的画像。"},
    {
        "role": "assistant",
        "content": "明白。情绪冰点后的首板接力是你的主要买点，业绩只作为排雷项，不作为买入理由。",
    },
]

client = httpx.Client(base_url=BASE, timeout=180)
checks: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    checks.append((label, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")


def wait_extraction(agent_id: str) -> dict:
    for _ in range(40):
        state = client.get(f"/api/agents/{agent_id}/profile").json()["extraction"]
        if state.get("status") in {"completed", "failed"}:
            return state
        time.sleep(3)
    return {"status": "timeout"}


# ---------------------------------------------------------------- A) deterministic
print("\n=== A) 确定性验证：prompt 组装 ===")
doc = ExtractedDocument(
    filename="样例.md", suffix=".md", kind="markdown",
    text="该策略以产业链供给瓶颈为主线。", chars=15, pages=None, truncated=False, notes=[],
)
with_chat = agent_profile.build_messages("测试角色", [doc], CHAT)[1]["content"]
without = agent_profile.build_messages("测试角色", [doc])[1]["content"]

check("有历史时有【历史对话补充】段", "【历史对话补充】" in with_chat)
check("历史里的问题进入 prompt", "情绪周期和资金接力" in with_chat)
check("历史里的回答进入 prompt", "首板接力" in with_chat)
check("无历史时没有该段", "【历史对话补充】" not in without)
check("资料段两种情况下都在", "【资料1】" in with_chat and "【资料1】" in without)
check("历史段在资料之前（资料为主）", with_chat.index("【历史对话补充】") < with_chat.index("【资料1】"))

# ---------------------------------------------------------------- B) end-to-end
print("\n=== B) 端到端：无对话 vs 有对话 ===")
created = client.post("/api/agents", json={"name": "历史验证角色", "style": "待提炼"}).json()
agent_id = created["agent"]["id"]
print(f"  角色 id={agent_id}")

with SAMPLE.open("rb") as fh:
    up = client.post(
        f"/api/agents/{agent_id}/documents",
        files={"file": (SAMPLE.name, fh.read(), "text/markdown")},
    )
check("上传资料", up.status_code == 200, f"HTTP {up.status_code}")

# ---- run 1: no conversation yet
client.post(f"/api/agents/{agent_id}/extract")
state_a = wait_extraction(agent_id)
profile_a = client.get(f"/api/agents/{agent_id}/profile").json()["profile"] or {}
print(f"  第一次（无对话）: {state_a.get('status')} historyCount={state_a.get('historyCount')}")
check("无对话时 historyCount=0", state_a.get("historyCount") == 0)
check("第一次提炼成功", state_a.get("status") == "completed")

# ---- inject a conversation for this persona
thread = client.post(
    "/api/ai/threads",
    json={"clientId": CLIENT, "title": "历史验证角色", "teacherName": "历史验证角色",
          "teacherNames": ["历史验证角色"], "stockCode": None},
).json()["thread"]
client.post(f"/api/ai/threads/{thread['id']}/messages", json={"messages": CHAT})

turns = threads.history_for_agent("历史验证角色")
check("history_for_agent 取到 2 条", len(turns) == 2, f"实际 {len(turns)}")
check("顺序为时间正序（用户在前）", turns and turns[0]["role"] == "user")
check("max_messages=1 只留最新一条", len(threads.history_for_agent("历史验证角色", max_messages=1)) == 1)
check("max_chars 过小时被裁空", threads.history_for_agent("历史验证角色", max_chars=5) == [])
check("无关角色名返回空", threads.history_for_agent("不存在的角色") == [])

# ---- run 2: with conversation
client.post(f"/api/agents/{agent_id}/extract")
state_b = wait_extraction(agent_id)
payload = client.get(f"/api/agents/{agent_id}/profile").json()
profile_b = payload["profile"] or {}
print(f"  第二次（有对话）: {state_b.get('status')} historyCount={state_b.get('historyCount')}")
check("有对话时 historyCount=2", state_b.get("historyCount") == 2)
check("第二次提炼成功", state_b.get("status") == "completed")

def weights(p: dict) -> str:
    return " ".join(f"{w['factor']}{round(w['weight'] * 100)}%" for w in p.get("factorWeights") or [])

print(f"\n  画像A(无对话) 风格={profile_a.get('style')} 周期={profile_a.get('horizon')}")
print(f"                因子: {weights(profile_a)}")
print(f"  画像B(有对话) 风格={profile_b.get('style')} 周期={profile_b.get('horizon')}")
print(f"                因子: {weights(profile_b)}")
changed = profile_a.get("factorWeights") != profile_b.get("factorWeights")
print(f"  因子权重是否变化: {changed}（LLM 有随机性，此项仅作参考）")

# ---------------------------------------------------------------- cleanup
client.delete(f"/api/ai/threads/{thread['id']}")
client.delete(f"/api/agents/{agent_id}")
remaining = client.get("/api/agents").json()["items"]
print(f"\n  清理后角色数={len(remaining)} 自建={[i['name'] for i in remaining if i.get('custom')]}")

failed = [c for c in checks if not c[1]]
print(f"\n{'=' * 60}\n结果: {len(checks) - len(failed)}/{len(checks)} PASS"
      + ("" if not failed else f"  失败项: {[c[0] for c in failed]}"))
sys.exit(1 if failed else 0)
