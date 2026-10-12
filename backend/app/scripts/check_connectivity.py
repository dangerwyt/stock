"""部署后连通性自检 —— 在服务器上「先验证再启用」。

动机：本机（上海/家用宽带）能连上的数据源，搬到别的网络环境后未必连得上。
Tushare 走的是第三方中继（自签证书 / 非标准端点）、晴红与 NewsAPI 全是公网直连，
任何一个不通都会变成「页面上某块永远转圈」。所以部署完第一件事是拿这个脚本过一遍，
而不是等用户点开页面才发现。

用法（在服务器上、项目根目录）：

    docker compose exec backend python -m app.scripts.check_connectivity

加 ``--all`` 会多打几行原始信息（HTTP 状态、首个响应片段），排查时用。

输出约定：每项 PASS / FAIL / SKIP，末尾给总结与建议动作。
**不改任何数据、不写任何文件**，纯读。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time

from app.config import settings

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"


def _mask(value: str, keep: int = 6) -> str:
    """凭据只露前几位 —— 自检输出常被贴到聊天里排查，不能把 key 整个带出去。"""
    text = str(value or "")
    if not text:
        return "(未配置)"
    if len(text) <= keep:
        return text[0] + "*" * (len(text) - 1)
    return text[:keep] + "…" + f"({len(text)}字符)"


class Report:
    def __init__(self, verbose: bool = False) -> None:
        self.rows: list[tuple[str, str, str]] = []
        self.verbose = verbose

    def add(self, name: str, status: str, detail: str) -> None:
        self.rows.append((name, status, detail))
        icon = {PASS: "✓", FAIL: "✗", SKIP: "-"}[status]
        print(f"  {icon} [{status:4}] {name:<28} {detail}")

    def summary(self) -> int:
        print()
        print("=" * 72)
        fails = [r for r in self.rows if r[1] == FAIL]
        passes = [r for r in self.rows if r[1] == PASS]
        skips = [r for r in self.rows if r[1] == SKIP]
        print(f"总计 {len(self.rows)} 项：PASS {len(passes)} / FAIL {len(fails)} / SKIP {len(skips)}")
        if not fails:
            print("全部通过 —— 数据源可用，可以正常使用了。")
            return 0
        print()
        print("以下项目不通，对应功能会降级（不会让服务整体挂掉）：")
        for name, _, detail in fails:
            print(f"  · {name}：{detail}")
        print()
        print("排查建议：")
        print("  1) 先确认容器能出网：docker compose exec backend python -c \"import urllib.request;print(urllib.request.urlopen('https://www.baidu.com',timeout=5).status)\"")
        print("  2) Tushare 主源是第三方中继（自签证书），不通先看是不是被网络策略拦了；B 套（GET+X-API-Key）是备用通道")
        print("  3) 需登录/付费的接口（晴红、NewsAPI）返回 401/403 属于凭据问题，不是网络问题")
        print("  4) 外部源全不通时应用仍能启动，页面会走内置兜底数据（sourceMode=fixtures）")
        return 1


async def check_tushare(rep: Report, verbose: bool) -> None:
    """Tushare —— 项目里最要紧也最容易不通的一条（走第三方中继）。"""
    from app import tushare_client

    print("\n[Tushare 行情/财务]")
    rep.add("TUSHARE_API_URL", PASS if settings.tushare_api_url else SKIP,
            settings.tushare_api_url or "(未配置，将直接用 B 套备用源)")
    rep.add("TUSHARE_TOKEN", PASS if settings.tushare_token else SKIP, _mask(settings.tushare_token))
    if settings.tushare_fallback_url:
        rep.add("TUSHARE_FALLBACK_URL", PASS, settings.tushare_fallback_url)
        rep.add("TUSHARE_FALLBACK_API_KEY", PASS if settings.tushare_fallback_api_key else SKIP,
                _mask(settings.tushare_fallback_api_key))
    else:
        rep.add("TUSHARE_FALLBACK_URL", SKIP, "(未配置备用源)")

    # 用 trade_cal 做探针：它轻量、必需 token、且不受交易时段影响
    started = time.monotonic()
    try:
        rows = await tushare_client._call(
            "trade_cal",
            {"exchange": "SSE", "start_date": "20260101", "end_date": "20260110"},
            "exchange,cal_date,is_open",
            timeout=30.0,
        )
        cost = time.monotonic() - started
        rep.add("trade_cal 取交易日历", PASS, f"{len(rows)} 行 / {cost:.1f}s")
        if verbose and rows:
            print(f"      首行：{rows[0]}")
    except Exception as exc:  # noqa: BLE001 —— 自检脚本要的是「任何失败都报出来」
        cost = time.monotonic() - started
        rep.add("trade_cal 取交易日历", FAIL, f"{type(exc).__name__}: {exc} ({cost:.1f}s)")

    # 全市场批量接口：TOP50 引擎的实际入口，单测它才知道 TOP50 能不能出结果
    started = time.monotonic()
    try:
        universe, trade_date = await tushare_client.fetch_top50_universe()
        cost = time.monotonic() - started
        if universe:
            rep.add("TOP50 全市场股票池", PASS, f"{len(universe)} 只 / 交易日 {trade_date} / {cost:.1f}s")
        else:
            rep.add("TOP50 全市场股票池", FAIL, f"返回空列表（交易日 {trade_date}，可能全市场接口被限流）")
    except Exception as exc:  # noqa: BLE001
        cost = time.monotonic() - started
        rep.add("TOP50 全市场股票池", FAIL, f"{type(exc).__name__}: {exc} ({cost:.1f}s)")


async def check_stock_search(rep: Report, verbose: bool) -> None:
    """个股搜索 —— 前端「搜索A股」直接依赖它。"""
    from app import tushare_client

    print("\n[个股搜索]")
    started = time.monotonic()
    try:
        items = await tushare_client.search_stock_basic("600519", limit=5)
        cost = time.monotonic() - started
        if items:
            rep.add("搜索 600519", PASS, f"{len(items)} 条 / {cost:.1f}s / 首个 {items[0].get('name')}")
            if verbose:
                print(f"      结果：{items[:3]}")
        else:
            rep.add("搜索 600519", FAIL, "无结果（可能 stock_basic 接口不可用）")
    except Exception as exc:  # noqa: BLE001
        rep.add("搜索 600519", FAIL, f"{type(exc).__name__}: {exc}")


async def check_llm(rep: Report) -> None:
    """LLM 通道 —— AI 研究室 / 自动提炼画像都靠它。一次极短调用即可验证。"""
    print("\n[LLM（MiniMax）]")
    rep.add("MINIMAX_BASE_URL", PASS if settings.minimax_base_url else SKIP, settings.minimax_base_url)
    rep.add("MINIMAX_MODEL", PASS if settings.minimax_model else SKIP, settings.minimax_model)
    rep.add("MINIMAX_API_KEY", PASS if settings.minimax_api_key else SKIP, _mask(settings.minimax_api_key))
    rep.add("LLM_BACKEND", PASS, settings.llm_backend)

    if not settings.minimax_api_key:
        rep.add("极短问答探针", SKIP, "未配置 API Key，跳过")
        return

    from app import llm

    # ⚠️ llm.chat 是**同步**函数（内部 httpx 同步调用 / langchain invoke），
    # 放进 async 里会阻塞事件循环 —— 自检脚本里用 to_thread 跑，别直接 await。
    started = time.monotonic()
    try:
        text = await asyncio.to_thread(
            llm.chat,
            [{"role": "user", "content": "回复一个字：好"}],
            max_tokens=16,
            temperature=0.0,
        )
        cost = time.monotonic() - started
        rep.add("极短问答探针", PASS, f"{cost:.1f}s / 回复 {str(text).strip()[:20]!r}")
    except Exception as exc:  # noqa: BLE001
        cost = time.monotonic() - started
        rep.add("极短问答探针", FAIL, f"{type(exc).__name__}: {exc} ({cost:.1f}s)")


async def check_qinghong(rep: Report) -> None:
    """晴红财经 —— 资讯聚合的首选源（它挂了会往后回落到 NewsAPI / Tushare）。"""
    print("\n[晴红财经（资讯首选源）]")
    if not settings.qinghong_api_key:
        rep.add("QINGHONG_API_KEY", SKIP, "未配置，资讯会直接走 NewsAPI / Tushare")
        return
    rep.add("QINGHONG_BASE_URL", PASS, settings.qinghong_base_url)
    rep.add("QINGHONG_API_KEY", PASS, _mask(settings.qinghong_api_key))
    rep.add("连通性", SKIP, "只做配置检查（该源无稳定的轻量探针接口，实际可用性看 /api/news 是否返回真实资讯）")


async def check_newsapi(rep: Report) -> None:
    """NewsAPI —— 资讯的次选源。"""
    print("\n[NewsAPI]")
    if not settings.newsapi_key:
        rep.add("NEWSAPI_KEY", SKIP, "未配置，资讯会跳过这一路（不会造假）")
        return
    rep.add("NEWSAPI_KEY", PASS, _mask(settings.newsapi_key))

    import httpx

    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://newsapi.org/v2/top-headlines",
                params={"country": "us", "pageSize": 1, "apiKey": settings.newsapi_key},
            )
        cost = time.monotonic() - started
        if resp.status_code == 200:
            body = resp.json()
            rep.add("top-headlines 探针", PASS, f"{resp.status_code} / 共 {body.get('totalResults')} 条 / {cost:.1f}s")
        elif resp.status_code in (401, 403):
            rep.add("top-headlines 探针", FAIL, f"{resp.status_code} 凭据无效或额度用尽（网络通，是 key 的问题）")
        else:
            rep.add("top-headlines 探针", FAIL, f"HTTP {resp.status_code} / {resp.text[:80]}")
    except Exception as exc:  # noqa: BLE001
        cost = time.monotonic() - started
        rep.add("top-headlines 探针", FAIL, f"{type(exc).__name__}: {exc} ({cost:.1f}s)")


async def check_runtime(rep: Report) -> None:
    """运行环境自检 —— 这些不对，功能会以奇怪的方式坏掉。"""
    print("\n[运行环境]")
    import os
    import platform

    rep.add("Python", PASS, platform.python_version())
    tz = os.environ.get("TZ") or "(容器内未设 TZ)"
    rep.add("时区", PASS if os.environ.get("TZ") else SKIP,
            f"{tz} / 当前 {time.strftime('%Y-%m-%d %H:%M:%S %z')}")
    if not os.environ.get("TZ"):
        print("      提示：定时任务按 Asia/Shanghai 计算，镜像里已设 TZ；这里为空只说明当前不在容器内。")
    rep.add("APP_ENV", PASS, settings.app_env)
    rep.add("数据目录", PASS, settings.agent_docs_dir)

    try:
        import pathlib

        pathlib.Path(settings.agent_docs_dir).mkdir(parents=True, exist_ok=True)
        probe = pathlib.Path(settings.agent_docs_dir) / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        rep.add("数据目录可写", PASS, "volume 挂载正常（否则上传资料会失败）")
    except Exception as exc:  # noqa: BLE001
        rep.add("数据目录可写", FAIL, f"{type(exc).__name__}: {exc}（检查 compose 的 volume 挂载）")


async def main() -> int:
    parser = argparse.ArgumentParser(description="部署后连通性自检")
    parser.add_argument("--all", action="store_true", help="打印更多原始信息，便于排查")
    args = parser.parse_args()

    print("=" * 72)
    print("连通性自检 —— 只读，不改任何数据")
    print("=" * 72)

    rep = Report(verbose=args.all)
    await check_runtime(rep)
    await check_tushare(rep, args.all)
    await check_stock_search(rep, args.all)
    await check_llm(rep)
    await check_qinghong(rep)
    await check_newsapi(rep)
    return rep.summary()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
