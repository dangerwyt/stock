"""Persistence layer for user-created agent (老师) personas.

The built-in 12 personas live in the read-only ``teachers`` fixture; anything a
user creates from the AI research page is appended to a small writable JSON file
so it survives restarts and is shared by every browser / every page.

Design notes
------------
* Single uvicorn worker in dev, so a plain ``threading.Lock`` around the
  read-modify-write is enough. Swapping this module for a real DB later only
  requires re-implementing ``list_custom`` / ``create`` / ``remove``.
* ``builtin_teachers()`` is the single source of truth for the seeded personas,
  which keeps StrategiesPage and AILabPage from drifting apart.
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import fixtures

DATA_DIR = Path(__file__).parent / "data"
STORE_PATH = DATA_DIR / "custom_agents.json"

_LOCK = threading.Lock()

# Fields a user is allowed to set when creating a persona.
EDITABLE_FIELDS = ("name", "style", "subtitle", "decision", "select", "risk", "horizon")


# 内置 fixture 把「选股条件」叫 ``selection``，而用户自建角色（以及画像提炼器
# ``agent_profile.TEXT_FIELDS``）叫 ``select``。同一个概念两个名字，导致
# StrategiesPage 读 ``.select`` 时把 12 位内置老师的「选股技巧」渲染成空白。
# 这里统一补上别名，不改动 fixtures 本身（它是原版接口的 1:1 快照）。
_BUILTIN_FIELD_ALIASES = {"selection": "select"}


def _with_field_aliases(item: dict) -> dict:
    out = dict(item)
    for source, target in _BUILTIN_FIELD_ALIASES.items():
        if target not in out and out.get(source) is not None:
            out[target] = out[source]
    return out


def builtin_teachers() -> list[dict]:
    """The 12 seeded personas from the original reference app."""
    payload = fixtures.load("teachers")
    items = payload.get("items") if isinstance(payload, dict) else payload
    # 逐条浅拷贝后再补别名：``fixtures.load`` 有 lru_cache，返回的是共享对象，
    # 直接原地改会污染缓存里的那份快照。
    return [_with_field_aliases(item) for item in (items or [])]


def _read() -> list[dict]:
    if not STORE_PATH.exists():
        return []
    try:
        with STORE_PATH.open(encoding="utf-8") as fh:
            payload = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []
    items = payload.get("agents") if isinstance(payload, dict) else payload
    return [item for item in (items or []) if isinstance(item, dict)]


def _write(agents: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump({"agents": agents}, fh, ensure_ascii=False, indent=2)
    tmp.replace(STORE_PATH)


def list_custom() -> list[dict]:
    with _LOCK:
        return _read()


def all_agents() -> list[dict]:
    """Built-in personas first, then user-created ones."""
    return builtin_teachers() + list_custom()


def visible_agents() -> list[dict]:
    """对外（HTTP / 前端）可见的角色：**只含用户自己创建的**。

    内置 12 位是原版原型里的 mock 人设（用户口径：「原来的 12 是 mock 数据，只体现创建
    的老师」），已从产品界面彻底去掉。

    注意这里**不动 ``all_agents()``**：引擎仍需要内置画像做「没有任何自建画像时」的兜底
    基线，而且 ``find`` / ``find_duplicate`` 必须看得见内置名 —— 否则用户可以创建一个
    与内置公式同名的角色，直接顶掉引擎 ``_AGENT_FORMULAS`` 里的同名键。
    """
    return list_custom()


def find_duplicate(name: str) -> dict | None:
    target = (name or "").strip()
    for item in all_agents():
        if (item.get("name") or "").strip() == target:
            return item
    return None


def find(agent_id: str) -> dict | None:
    for item in all_agents():
        if item.get("id") == agent_id:
            return item
    return None


def is_custom(agent_id: str) -> bool:
    """Built-in personas are read-only; only user-created ones can be edited."""
    return any(item.get("id") == agent_id for item in list_custom())


# Identity fields a patch must never overwrite.
_PROTECTED_FIELDS = {"id", "name", "custom", "createdAt"}

# ------------------------------------------------------- 已删除角色的名字标记
# 删角色时，**通用研究会话不能删**，但它上面"该角色答过"的痕迹必须处理掉：
# 若把名字原样留着，之后建一个**同名**角色就会把这几问继承过去当画像素材
# （等于拿旧角色的人设喂新角色）。所以改成 ``<名字>（已删除）`` ——
# 只改名字、不删消息，气泡仍读得出"当时是谁答的"，历史不被抹掉，
# 而新角色再也命中不了这个标记（见 ``threads._general_reply_by``）。
#
# 这个后缀因此是**保留名**：``create()`` 会拒绝以此结尾的角色名，否则用户
# 建一个真叫「张三（已删除）」的角色，标记就能被他命中、继承链又接上了。
RETIRED_SUFFIX = "（已删除）"


def retired_name(name: str) -> str:
    """角色名 → 已删除标记（幂等：已带后缀的不再重复追加）。"""
    target = str(name or "").strip()
    if not target or target.endswith(RETIRED_SUFFIX):
        return target
    return f"{target}{RETIRED_SUFFIX}"


def is_retired_name(name: str) -> bool:
    """是否已经是"已删除"标记。"""
    return str(name or "").strip().endswith(RETIRED_SUFFIX)


def update(agent_id: str, patch: dict) -> dict | None:
    """Merge ``patch`` into a user-created persona. Returns None if not found."""
    safe = {k: v for k, v in (patch or {}).items() if k not in _PROTECTED_FIELDS}
    if not safe:
        return find(agent_id)
    with _LOCK:
        agents = _read()
        for index, item in enumerate(agents):
            if item.get("id") == agent_id:
                agents[index] = {**item, **safe}
                _write(agents)
                return agents[index]
    return None


def create(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("请输入角色（老师）名称")
    if len(name) > 80:
        raise ValueError("角色名称不能超过 80 个字符")
    if is_retired_name(name):
        # 见 RETIRED_SUFFIX 的说明：这是保留后缀，占用了它就能命中"已删除"标记、
        # 把旧角色答过的问答继承过来。
        raise ValueError(f"角色名称不能以「{RETIRED_SUFFIX}」结尾")
    if find_duplicate(name):
        raise ValueError(f"角色「{name}」已存在")

    agent: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "style": str(payload.get("style") or "自定义").strip() or "自定义",
        "subtitle": str(payload.get("subtitle") or "自定义策略画像").strip(),
        "decision": str(payload.get("decision") or "尚未填写决策依据，可在策略页查看后补充。").strip(),
        "select": str(payload.get("select") or "尚未填写选股条件，可在策略页查看后补充。").strip(),
        "risk": str(payload.get("risk") or "尚未填写风险纪律，可在策略页查看后补充。").strip(),
        "horizon": str(payload.get("horizon") or "自定义").strip() or "自定义",
        "custom": True,
        "materialCount": 0,
        "candidateCount": 0,
        "productionVersion": {"id": "agent-custom-v0"},
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with _LOCK:
        agents = _read()
        agents.append(agent)
        _write(agents)
    return agent


def remove(agent_id: str) -> bool:
    with _LOCK:
        agents = _read()
        remaining = [item for item in agents if item.get("id") != agent_id]
        if len(remaining) == len(agents):
            return False
        _write(remaining)
        return True
