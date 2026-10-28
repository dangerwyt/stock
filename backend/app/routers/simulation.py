"""模拟账户持久化端点。

量化工具「模拟」tab 的账户状态（可用余额 / 持仓 / 交易流水）原本只存活在
前端组件内存里 —— 刷新页面或重启容器就重置回 ¥1,000,000、持仓清空。

这里把它落盘到 ``app/data/simulation.json``（按 account 分桶），与项目
「数据全落 JSON、无数据库」的惯例一致；重启容器后前端挂载时能从磁盘恢复。

写入采用原子写（先写 ``.tmp`` 再 ``replace``），避免并发/崩溃留下半截 JSON。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Request

logger = logging.getLogger(__name__)

router = APIRouter()

# 路由在 ``app/routers/`` 下，数据目录在上一级 ``app/data``，所以是 ``.parent.parent``。
_SIM_PATH = Path(__file__).resolve().parent.parent / "data" / "simulation.json"

# 单账户默认状态：与前端 QuantPage.vue 的内存初值保持一致，保证「首次运行 / 存档
# 损坏」时也能回落到 ¥1,000,000 空仓，不会崩。
DEFAULT_STATE = {
    # 初始本金：累计盈亏的分母/基准（总资产 - 本金 = 累计盈亏）。
    "initialCapital": 1_000_000,
    "cash": 1_000_000,
    # 已实现盈亏：卖出时按（卖出价 - 卖出前均价）× 股数 累加。
    "realizedPnl": 0,
    # 多持仓：code -> {code, name, quantity, cost}
    # 浮动盈亏 = Σ(市值) - Σ(成本)；单只均价 = cost / quantity。
    "positions": {},
    "trades": [],
}

# 允许写入磁盘的字段白名单，避免把任意字段塞进运行态 JSON。
# 末尾几个是旧「单持仓」存档字段，仅为兼容读取/迁移保留，新前端不再写。
_WRITABLE_FIELDS = (
    "initialCapital",
    "cash",
    "realizedPnl",
    "positions",
    "trades",
    "positionQuantity",
    "positionCost",
    "heldStock",
    "stockCode",
)


def _load_all() -> dict:
    """读取整份分桶存档；文件缺失/损坏时回落空字典。"""
    if not _SIM_PATH.exists():
        return {}
    try:
        data = json.loads(_SIM_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("模拟存档读取失败，回落空状态：%s", exc)
        return {}
    return data if isinstance(data, dict) else {}


def _load_state(account_id: str) -> dict:
    """取出某账户状态，缺失字段用默认值补齐。"""
    return dict(DEFAULT_STATE, **(_load_all().get(account_id) or {}))


def _save_all(all_states: dict) -> None:
    """原子写整份存档（tmp → replace）。"""
    _SIM_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _SIM_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(all_states, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(_SIM_PATH)


@router.get("/api/simulation")
def get_simulation(account: str = "default") -> dict:
    """读取某模拟账户的持久化状态。"""
    return {"account": account, "state": _load_state(account)}


@router.post("/api/simulation")
async def post_simulation(request: Request) -> dict:
    """覆盖写入某模拟账户的状态（前端每笔交易后调用）。"""
    payload = await request.json() if request.headers.get("content-type") else {}
    if not isinstance(payload, dict):
        payload = {}

    account_id = payload.get("account") or "default"
    state = dict(DEFAULT_STATE)
    for key in _WRITABLE_FIELDS:
        if key in payload:
            state[key] = payload[key]

    all_states = _load_all()
    all_states[account_id] = state
    _save_all(all_states)
    logger.info("模拟账户 %s 状态已持久化（cash=%s 持仓=%s 笔数=%s）",
                account_id, state["cash"], state["positionQuantity"], len(state["trades"]))
    return {"account": account_id, "state": state}
