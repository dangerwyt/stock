from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# `.env` 只有**一个**来源：仓库根目录。
#
# 为什么不用裸 ".env"：`env_file` 是相对进程 CWD 解析的，而 uvicorn 从 `backend/`
# 启动，裸文件名会去找 `backend/.env`（不存在），凭据就静默读成空串。
#
# 为什么不再兼容 `backend/.env`：两个位置同时存在时，后写的会静默覆盖前一个，
# 一旦有人往 `backend/` 放一份旧配置就会出现「改了 key 却不生效」这种极难排查的问题。
# 想覆盖就用**环境变量**（优先级高于 .env），不要再引入第二个文件。
#
# 将来若要把 backend/ 单独部署：改这一处路径即可，不要去动 `_BACKEND_DIR` 的其它用途。
_HERE = Path(__file__).resolve()
_REPO_ROOT = _HERE.parents[2]
_BACKEND_DIR = _HERE.parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "development"
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    frontend_origin: str = "http://localhost:5173"

    # Providers
    minimax_api_key: str = ""
    minimax_base_url: str = "https://api.minimaxi.com/v1"
    minimax_model: str = "MiniMax-M3"
    tushare_token: str = ""
    tushare_api_url: str = "https://api.tushare.pro"
    tushare_verify_ssl: bool = True
    # B 套「ProMax 接口聚合」——主源(relay A)不可达/报错时的备用数据源。
    # 对齐 reference-react `tushareQuery` 的回落分支：GET {url}/{api_name} + 查询参数
    # + 头 `X-API-Key: {key}`，返回体与主源同为 {code,data:{fields,items}}。
    # 两个都为空 = 不启用回落（行为与从前一致，失败直接抛 TushareError）。
    tushare_fallback_url: str = ""
    tushare_fallback_api_key: str = ""
    qinghong_base_url: str = "http://124.223.180.129:3220"
    qinghong_api_key: str = ""
    newsapi_key: str = ""
    admin_api_token: str = ""

    # LLM / document extraction budgets (demo-stage guard rails)
    ai_daily_call_limit: int = 200
    llm_timeout_seconds: int = 120
    llm_max_tokens: int = 3000
    max_document_chars: int = 20000
    # 上传文件大小上限（所有类型）。OCR 文字提取对扫描件 PDF 体积敏感，
    # 5MB 太容易触发，调到 50MB 容纳多页扫描件；仍可经环境变量 MAX_UPLOAD_MB 覆盖。
    max_upload_mb: int = 50
    max_pdf_pages: int = 30
    # 走哪个 LLM 通道：
    #   langchain  —— langchain_openai.ChatOpenAI 打 MiniMax 的 OpenAI 兼容端点
    #                 {base_url}/chat/completions
    #   minimax_v2 —— 手写 httpx 打 MiniMax 原生 /text/chatcompletion_v2
    # 两条通道都在请求里传了 thinking={"type":"disabled"} 关掉思考（见 llm.py），
    # 所以耗时/质量基本一致；默认 langchain 是为了对齐 KnowPilot 技术栈。
    llm_backend: str = "langchain"

    # Where uploaded agent documents live
    agent_docs_dir: str = str(_BACKEND_DIR / "app" / "data" / "agent_docs")

    # 调度运行记录（per-round 去重锁 + attempt + 最近一次运行快照）。
    # 与 custom_agents.json / ai_threads.json 同处 app/data/ —— 都是运行态 JSON，
    # 已在 .gitignore 里，删了不影响代码，只是"今天这轮跑没跑"的记忆会丢。
    job_runs_path: str = str(_BACKEND_DIR / "app" / "data" / "job_runs.json")

    # TOP50 快照落盘：同一「数据窗口」内复用，uvicorn 重启后不再全量重算（省 Tushare
    # 额度最直接的一条）。同样是运行态 JSON，已在 .gitignore 里。
    top50_snapshot_path: str = str(_BACKEND_DIR / "app" / "data" / "top50_snapshot.json")

    # 上传资料的相关性过滤（T2）：入库判定整篇是否属于股票财经范畴。
    # 关掉后所有能解析的文件都直接入库，不做内容判断。
    doc_relevance_enabled: bool = True

    # 定时自动更新自建角色的画像（T4）：每天固定时刻跑一次（Asia/Shanghai）。
    # 用 cron 而不是 interval —— 重启后依然是「每天 00:30」，不会漂移成「从启动起算 24h」。
    # 代价是进程若在当天这个时刻之后才启动，当天就跳过，等第二天。
    # 想临时验证，把 hour/minute 调成下一分钟，或直接调 scheduler.refresh_all()。
    auto_extract_enabled: bool = True
    auto_extract_hour: int = 0
    auto_extract_minute: int = 30

    # 自建老师（AI 学习提炼出画像的「学生」）在每个持有周期里**合计**占的权重份额。
    #
    #  1.0  —— 自建老师**完全接管**：内置 12 位 mock 画像的权重被压成 0 后剔除，
    #          score / 排名 / 票数 / 证据链全部只由自建老师决定（**当前口径**）。
    #  0.3  —— 内置留 70% 做基线，自建占 30%。
    #  0.0  —— 完全回到原版行为（内置独占；自建仍有分，但不参与加权）。
    #
    # 无论取何值，剩余 (1 - share) 都按**原比例**分给内置 lead agents ——「前半段按原版」
    # 的比例关系不变。团队内按老师人数均分。
    # ⚠️ 没有任何自建老师学出画像时，引擎自动回落内置基线（否则加权会全是 0、榜单直接崩）。
    custom_teacher_weight_share: float = 1.0

    # 形成「共识」所需的最少**参与打分**画像数。低于它时票数不构成共识，
    # 榜单标的的 risk 最多给到「中」（不会出现「低风险 / 可试仓」）。
    #
    # 为什么需要：票数阈值是按比例缩放的（原版 12 套写死 7/6 ≈ 58%/50%，现在
    # ceil(n*7/12) / ceil(n*6/12)）。n = 1 时两个阈值都是 1，于是"唯一那位画像
    # 给了 60 分以上"就被判成「低风险」，而榜单展示的又恰好是分数最高的 50 只 ——
    # 整张榜清一色「低 / 可试仓」，风险标签失去信息量。这是"一位画像看好"冒充
    # "多画像共识"，原版 12 套系数下不会发生。
    #
    # ⚠️ 注意分母口径：这里数的是**参与打分**的画像数（meta.agentCount），
    # 不是用户创建的老师总数（meta.teacherCount）—— 没学出画像的角色不投票。
    min_consensus_participants: int = 3

    # 周期先验在自建老师画像上的**混合强度 λ**（0~1，见 top50_engine._apply_cycle_tilt）。
    #
    # 自建老师接管后每位老师在四个周期的权重都是 100%，周期差异整个消失 → 四份榜单
    # 完全一样。所以每个周期会从"原版该周期启用的老师班底"里推导出一份因子先验
    # （含 cap：中长线的第一大因子），再与画像按 λ 混合：
    #   * λ = 0  → 纯画像，周期不影响（回到"四份榜单一样"的状态，仅用于对照）；
    #   * λ = 1  → 纯周期基线，AI 画像不再影响该周期；
    #   * 默认 0.5 → 画像与持有周期各占一半话语权。
    # 取 0.5 的理由：实测再低（0.3）时"超短 vs 短线"仍会排出完全相同的 Top10，
    # 因为画像本身很集中（89% 押趋势）时，乘性缩放不足以拉开差距；再高则老师的
    # 画像会被周期基线压过去，"AI 学习改变分数"这件事就不明显了。
    cycle_tilt_strength: float = 0.5


settings = Settings()
