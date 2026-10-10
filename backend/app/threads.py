"""Persistence for AI research threads (研究会话).

Previously a stub that always returned an empty list, which is why a persona
created from the AI page never showed up in the session list. Kept in a single
JSON file keyed by ``clientId``, mirroring the agents / agent_docs stores.

Single uvicorn worker in dev, so a module lock around the read-modify-write is
sufficient.
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import agents, fixtures

DATA_DIR = Path(__file__).parent / "data"
STORE_PATH = DATA_DIR / "ai_threads.json"

# The UI states "最多保留100条"; keep the newest N per client.
MAX_THREADS = 100

# ---------------------------------------------------------------- 固定会话
# 「通用研究」：一条常驻会话，永远排在列表首位，且不可删除。
#
# 为什么必须显式标记而不是"随手建一条普通会话"：``_belongs_to`` 会按
# teacherNames / teacherName / title 把**整条**会话认领给某位老师，而那条链路通向
# 画像提炼 → agent_factor_score → top50_engine 打分 → StrategiesPage 矩阵。
# 固定会话必须躲开这个**整条认领**，所以它同时满足：① 不携带任何 teacherName；
# ② ``_belongs_to`` 里显式返回 False。
GENERAL_THREAD_ID = "general"
GENERAL_TITLE = "通用研究"

# ⚠️ 通用会话上还有一个 ``generalRoles`` 字段（用户在通用会话里选中的"本次由谁回答"
# 名单）。它**不参与** ``_belongs_to`` 的匹配，也刻意不叫 teacherName / teacherNames /
# title —— 那三个是"**整条**会话算在谁名下"的判据，把 generalRoles 掺进去就会变成
# 「当前选中谁，这条会话的全部历史（包括之前由别人答的、以及 0 位时通用助手答的）
# 就整体改判给谁」。用户中途换个角色，历史归账会被追溯改写，而它直接决定画像 → 因子
# 权重 → TOP50 排名，错了很难归因。
#
# 那通用会话的问答到底算不算画像素材？**算，但按条归账**：见 ``attributed_messages``。
# 判据是**每条回答消息上的 ``teacherNames``** —— 那是"发送那一刻实际答的角色"
# （前端从 agent 帧收集，0/1 位时读 summary 帧的 answeredRole），天然带
# "哪一问是谁答的"的信息。0 位（通用助手答的）不带任何名字，仍然完全不计入。

_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _general_id(client_id: str) -> str:
    """固定会话的 id。按 client 区分，否则多客户端会抢同一条。"""
    return GENERAL_THREAD_ID if not client_id else f"{GENERAL_THREAD_ID}::{client_id}"


def is_general(thread: dict | None) -> bool:
    """是否固定会话。

    认 ``general`` 标记为主、id 前缀做兜底 —— 只认 id 的话，将来 id 规则一改，
    已经落盘的老数据就会被静默当成普通会话（然后开始参与画像提炼）。
    """
    if not isinstance(thread, dict):
        return False
    if thread.get("general") is True:
        return True
    return str(thread.get("id") or "").split("::", 1)[0] == GENERAL_THREAD_ID


def general_roles(thread: dict | None) -> list[str]:
    """通用会话上存着的「本次回答角色」名单。

    兼容旧的单值字段 ``generalRole``（单选时代留下的），读到就当成单元素列表。
    注意回落条件：新字段**缺失或为空**时才看旧键 —— 只看"键在不在"的话，
    ``{"generalRoles": [], "generalRole": "B老师"}`` 这种迁移半途的状态会把
    旧值静默丢掉（实测数据里真的长这样：新字段先被建出来、旧键后写进去）。
    迁移由 ``ensure_general`` 就地做一次并删掉旧键，正常路径上只有列表词。
    """
    if not isinstance(thread, dict):
        return []
    stored = thread.get("generalRoles")
    names = (
        [str(r).strip() for r in stored if str(r).strip()]
        if isinstance(stored, list)
        else []
    )
    if names:
        return names
    legacy = str(thread.get("generalRole") or "").strip()
    return [legacy] if legacy else []


def ensure_general(client_id: str = "") -> dict:
    """取固定会话，没有就补一条（幂等，每次 list 都会调）。

    刻意存在磁盘上而不是每次都现造：它的消息要走同一套 append/update 落库路径，
    虚拟对象会让"刷新后消息全没了"变成必然。
    """
    wanted = _general_id(client_id)
    with _LOCK:
        threads = _read()
        for item in threads:
            if item.get("id") == wanted or (
                is_general(item) and (item.get("clientId") or "") == client_id
            ):
                # 就地迁移旧的单选字段 → 列表字段（只做一次），顺带删掉旧键，
                # 免得留下两个"看起来都能存角色"的字段。
                # 判据是**旧键在不在**，不是新键缺不缺 —— 两者同时存在是真实出现过的
                # 状态（新键先建、旧键后写），按新键判会跳过迁移、旧值就永久丢了。
                if "generalRole" in item or "generalRoles" not in item:
                    item["generalRoles"] = general_roles(item)
                    item.pop("generalRole", None)
                    _write(threads)
                return item
        thread: dict[str, Any] = {
            "id": wanted,
            "clientId": client_id,
            "title": GENERAL_TITLE,
            # 这两个留空是**故意的**：只要它们不是空串，history_for_agent 就会把
            # 这条会话当成某位老师的会话捞去提炼画像。
            "teacherName": "",
            "teacherNames": [],
            # 用户在通用会话里临时选中的角色**名单**（空 = 不选，走通用助手回答）。
            # 它不是绑定关系 —— 见文件头关于 generalRoles 的说明。
            "generalRoles": [],
            "stockCode": None,
            # ⚠️ 这里原本有个 "favorite": False —— 收藏/收藏夹功能已从前端整块下线，
            # 后端也没有任何读取方，是个纯死字段（还会被 PATCH 的 blocklist 放行写坏）。
            # 已连带存量记录一起清掉，别再写回来。
            "general": True,
            "pinned": True,
            "messages": [],
            "messageCount": 0,
            "activeJobId": None,
            "createdAt": _now(),
            "updatedAt": _now(),
        }
        threads.append(thread)
        _write(threads)
        return thread


def _read() -> list[dict]:
    if not STORE_PATH.exists():
        return []
    try:
        with STORE_PATH.open(encoding="utf-8") as fh:
            payload = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []
    items = payload.get("threads") if isinstance(payload, dict) else payload
    return [item for item in (items or []) if isinstance(item, dict)]


def _write(threads: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump({"threads": threads}, fh, ensure_ascii=False, indent=2)
    tmp.replace(STORE_PATH)


def _known_teacher_names() -> set[str]:
    payload = fixtures.load("teachers")
    items = payload.get("items") if isinstance(payload, dict) else payload
    return {str(item.get("name")) for item in (items or []) if item.get("name")}


def list_threads(client_id: str = "") -> list[dict]:
    """固定会话恒在首位，其余按 updatedAt 倒序。会话按 client 隔离。

    固定会话**不参与排序**：它每聊一句 updatedAt 都会更新，若按时间排会自己沉浮，
    而"一直在最上方"是它的定义，不是巧合。
    """
    ensure_general(client_id)
    items = [t for t in _read() if not client_id or t.get("clientId") == client_id]
    items.sort(key=lambda t: t.get("updatedAt") or "", reverse=True)
    pinned = [t for t in items if is_general(t)]
    rest = [t for t in items if not is_general(t)]
    return pinned + rest


def get(thread_id: str) -> dict | None:
    for item in _read():
        if item.get("id") == thread_id:
            return item
    return None


def create(payload: dict) -> dict:
    title = str(payload.get("title") or "").strip() or "新研究会话"
    teacher_names = [
        str(name).strip()
        for name in (payload.get("teacherNames") or [])
        if str(name).strip()
    ]
    if not teacher_names and payload.get("teacherName"):
        teacher_names = [str(payload["teacherName"]).strip()]

    thread: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "clientId": str(payload.get("clientId") or ""),
        "title": title,
        "teacherName": str(payload.get("teacherName") or (teacher_names[0] if teacher_names else "")),
        "teacherNames": teacher_names,
        "stockCode": payload.get("stockCode"),
        # 无 "favorite"：收藏功能已下线，见 ensure_general 里的说明。
        "messages": [],
        "messageCount": 0,
        "activeJobId": None,
        "createdAt": _now(),
        "updatedAt": _now(),
    }

    with _LOCK:
        threads = _read()
        threads.append(thread)
        # Trim oldest beyond the retention cap, per client.
        # 固定会话不参与淘汰：它通常是最早创建的那条，按 updatedAt 排序会被第一个剪掉，
        # 然后下一次 list 又把它重建出来 —— 表现为"通用研究的聊天记录隔几天就清空"。
        same_client = [
            t
            for t in threads
            if t.get("clientId") == thread["clientId"] and not is_general(t)
        ]
        if len(same_client) > MAX_THREADS:
            same_client.sort(key=lambda t: t.get("updatedAt") or "")
            drop = {t["id"] for t in same_client[: len(same_client) - MAX_THREADS]}
            threads = [t for t in threads if t.get("id") not in drop]
        _write(threads)
    return thread


def update(thread_id: str, patch: dict) -> dict | None:
    # ``general`` / ``pinned`` 不接受客户端改写：它们是"这条会话不参与画像提炼、
    # 且不可删除"的判据本身，能被 PATCH 掉就等于把护栏交给了调用方。
    # ``favorite`` 也挡掉：字段已随收藏功能一起删了，但浏览器里缓存的旧前端包
    # 仍会把它发上来，不挡就会被写回记录里、死字段复活。
    safe = {
        k: v
        for k, v in (patch or {}).items()
        if k not in {"id", "clientId", "createdAt", "general", "pinned", "favorite"}
    }
    with _LOCK:
        threads = _read()
        for index, item in enumerate(threads):
            if item.get("id") != thread_id:
                continue
            merged = {**item, **safe, "updatedAt": _now()}
            # 显式写入新字段时顺手清掉单选时代的旧键。留着会出事：清空角色写的是
            # ``generalRoles: []``，而下次 ``ensure_general`` 的迁移在"新列表为空"
            # 时会回落到旧键 —— 用户刚取消的角色又自己回来了。
            if "generalRoles" in safe:
                merged.pop("generalRole", None)
            if "messages" in safe and isinstance(safe["messages"], list):
                merged["messageCount"] = len(safe["messages"])
            threads[index] = merged
            _write(threads)
            return merged
    return None


def append_messages(thread_id: str, messages: list[dict]) -> dict | None:
    """Append messages to a thread, keeping the newest 200."""
    if not messages:
        return get(thread_id)
    with _LOCK:
        threads = _read()
        for index, item in enumerate(threads):
            if item.get("id") != thread_id:
                continue
            history = [*(item.get("messages") or []), *messages][-200:]
            merged = {
                **item,
                "messages": history,
                "messageCount": len(history),
                "updatedAt": _now(),
            }
            threads[index] = merged
            _write(threads)
            return merged
    return None


def remove(thread_id: str) -> bool:
    with _LOCK:
        threads = _read()
        # 固定会话不可删除。放在这里而不是只放路由层，是为了让"任何调用方"都删不掉它。
        if any(t.get("id") == thread_id and is_general(t) for t in threads):
            return False
        remaining = [t for t in threads if t.get("id") != thread_id]
        if len(remaining) == len(threads):
            return False
        _write(remaining)
        return True


def _belongs_to(thread: dict, target: str) -> bool:
    """**整条**会话是否挂在这个角色名下（看 teacherNames / teacherName / title）。

    ⚠️ 它只回答"整条会话属于谁"，所以固定会话在这里**无条件 False**。通用会话的
    问答是**按条**归账的（见 ``attributed_messages``）—— 别把 ``generalRoles`` 加到
    下面三个匹配字段里，那会把"这一问想让谁答"变成"整条会话都属于他"，用户中途换
    角色就会把之前别人答的、以及通用助手答的历史整体改判过去。

    ⚠️ 特别提醒：往这里加字段前先想一遍 —— 这个字段是否只表示"这一问想让谁回答"，
    而不是"整条会话属于谁"。
    """
    if not target:
        return False
    if is_general(thread):
        return False
    return (
        target in (thread.get("teacherNames") or [])
        or (thread.get("teacherName") or "").strip() == target
        or (thread.get("title") or "").strip() == target
    )


def _general_reply_by(message: dict, target: str) -> bool:
    """通用会话里的这条**回答**是不是 target 给出的。

    认消息上的 ``teacherNames`` —— 它在发送那一刻记录了"本次实际答的角色"
    （前端从 agent 帧收集参与者，0/1 位时读 summary 帧的 answeredRole）。
    刻意**不看**会话级的 ``generalRoles``：那是"现在选中谁"，用它归账等于让历史
    随用户切角色而被追溯改写。

    带 ``（已删除）`` 后缀的名字一律不认 —— 那是 ``purge_for_agent`` 写下的墓碑，
    专门用来断开"之后建一个同名角色就继承旧问答"的链路。
    （``agents.create()`` 已经拒绝以此后缀命名，这里再挡一道，防手改数据。）
    """
    if agents.is_retired_name(target):
        return False
    return target in (message.get("teacherNames") or [])


def attributed_messages(thread: dict, target: str) -> list[dict]:
    """这条会话里**算在 target 名下**的消息。

    这是 ``history_for_agent``（喂提炼）与 ``history_stats``（算变更指纹）**唯一**
    的口径来源 —— 两处共用同一个函数，否则会出现"指纹说没变、但提炼捞到的会话其实
    变了"这种查不出来的 bug（以前那条注释里的告诫同样适用）。

    - **普通会话**：整条算（``_belongs_to`` 判），与历史行为一致；
    - **通用会话**：**按条**算 —— 只收"该角色答的那一问"，并把紧邻在它前面的
      **提问**一起带上（只留回答的话，prompt 里有答无问、不成对话）。
      0 位（通用助手答的）消息不带任何 ``teacherNames``，因此一律不计入。
    """
    messages = thread.get("messages") or []
    picked: list[dict] = []
    if not is_general(thread):
        if not _belongs_to(thread, target):
            return []
        picked = list(messages)
    else:
        question: dict | None = None
        for message in messages:
            role = message.get("role")
            if role == "user":
                question = message
                continue
            if role == "assistant":
                if _general_reply_by(message, target):
                    if question is not None:
                        picked.append(question)
                    picked.append(message)
                question = None
    return [
        message
        for message in picked
        if message.get("type") != "error"
        and message.get("role") in {"user", "assistant"}
        and str(message.get("content") or "").strip()
    ]


def history_for_agent(
    agent_name: str,
    client_id: str = "",
    max_messages: int = 16,
    max_chars: int = 4000,
) -> list[dict]:
    """Chronological Q&A turns recorded under this persona's sessions.

    Fed to the LLM as a *supplementary* hint when extracting a profile — the
    uploaded documents stay the primary source. Returns oldest-first so the
    prompt reads like a conversation.

    含**通用会话里由该角色答的那几问**（用户在通用会话挑了这个角色，就该作为它的
    学习素材；见 ``attributed_messages``）。
    """
    target = (agent_name or "").strip()
    if not target:
        return []

    threads = [
        thread
        for thread in _read()
        if not client_id or thread.get("clientId") == client_id
    ]
    threads.sort(key=lambda t: t.get("updatedAt") or "")

    turns: list[dict] = []
    for thread in threads:
        for message in attributed_messages(thread, target):
            turns.append(
                {
                    "role": message.get("role"),
                    "content": str(message.get("content") or "").strip(),
                }
            )

    # Newest turns win; drop from the front until both budgets fit.
    turns = turns[-max_messages:]
    while turns and sum(len(turn["content"]) for turn in turns) > max_chars:
        turns.pop(0)
    return turns


def history_stats(agent_name: str, client_id: str = "") -> tuple[int, str]:
    """该角色名下**有效问答条数 + 最后一次更新时间**。

    供定时提炼做**变更检测**：指纹里带上这两个值，用户聊了新内容就会触发重提炼。
    口径必须与 ``history_for_agent`` 一致 —— 两处都走 ``attributed_messages``。
    """
    target = (agent_name or "").strip()
    if not target:
        return 0, ""

    count = 0
    last = ""
    for thread in _read():
        if client_id and thread.get("clientId") != client_id:
            continue
        messages = attributed_messages(thread, target)
        if not messages:
            continue
        count += len(messages)
        updated = thread.get("updatedAt") or ""
        if updated > last:
            last = updated
    return count, last


def purge_for_agent(agent_name: str) -> int:
    """Drop sessions whose title/teacher is the given persona name.

    固定会话永远不删 —— 若真有角色被命名为「通用研究」（``title`` 撞名），
    没这道护栏就会把固定会话当普通会话清掉。

    但通用会话上**该角色答过的痕迹要立一块墓碑**（``agents.retired_name``）：
    通用会话不能删，若只把名字原样留着，之后建一个**同名**角色就会把这几问继承
    过去当画像素材（等于拿旧角色的人设喂新角色）。做法是**只改名字、不删消息** ——
    气泡仍读得出"当时是谁答的"，历史不被抹掉，而新角色再也命中不了。
    改的是 ``teacherNames``（归账依据，也是气泡作者名）与 ``teacherAnswers``
    （折叠展开的逐位发言，纯展示）。

    返回**删掉的会话数**（墓碑不计入）。会话一个没删、只立了墓碑时也会落盘。
    """
    target = (agent_name or "").strip()
    if not target:
        return 0
    marker = agents.retired_name(target)
    with _LOCK:
        threads = _read()
        remaining = [
            t
            for t in threads
            if is_general(t)
            or (
                (t.get("title") or "").strip() != target
                and (t.get("teacherName") or "").strip() != target
            )
        ]
        removed = len(threads) - len(remaining)

        # 通用会话留下，但把"这个角色答过"的名字换成不可再命中的墓碑。
        tombstones = 0
        for thread in remaining:
            if not is_general(thread):
                continue  # 普通会话整条删了，没有残留
            for message in thread.get("messages") or []:
                touched = False
                names = message.get("teacherNames")
                if isinstance(names, list) and target in names:
                    message["teacherNames"] = [
                        marker if str(n).strip() == target else n for n in names
                    ]
                    touched = True
                answers = message.get("teacherAnswers")
                if isinstance(answers, list):
                    for answer in answers:
                        if isinstance(answer, dict) and (
                            str(answer.get("teacherName") or "").strip() == target
                        ):
                            answer["teacherName"] = marker
                            touched = True
                if touched:
                    tombstones += 1

        if removed or tombstones:
            _write(remaining)
        return removed
