# 后端镜像：单进程 uvicorn（FastAPI + APScheduler 进程内调度）
#
# ⚠️ 必须单 worker：定时任务（每天 9:00 自动提炼画像）跑在进程内的 AsyncIOScheduler 上，
# 多 worker 会变成「每个 worker 各跑一遍」，同一批角色被重复塞进模型。
# 也正因为如此这里不用 gunicorn 多进程，直接 uvicorn 单进程。
#
# ⚠️ 基镜像锁 3.12，不是 3.13：OCR 依赖 rapidocr-onnxruntime==1.4.4 的
# Requires-Python 是 >=3.6,<3.13，在 3.13 上装不上（本 PyPI 镜像能装的版本
# 又要求 <3.12）。保持 3.12 才能让 OCR 跑起来。其余依赖均兼容 3.12。
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

# OpenCV（rapidocr 的依赖，GUI 版 opencv-python）在 Debian slim 里缺 libGL 等系统库，
# 运行时 import cv2 会抛 ImportError，被 documents.py 当成"缺少 rapidocr"误报、且 OCR 直接废掉。
# 装齐 OpenCV 运行所需的最小系统库集（slim 镜像默认不带 X11/OpenGL 库）。
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖再拷代码：改了业务代码不会让依赖层缓存失效
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# ⚠️ 关于配置读取（踩过的坑，别删这段注释）：
#
# `app/config.py` 的 env_file 指向 **仓库根目录的 .env**，路径是这么推出来的：
#     _REPO_ROOT = Path(__file__).resolve().parents[2]      # app/config.py → 上两级
# 本机布局是 `<repo>/backend/app/config.py` → parents[2] = <repo> ✅
# 但容器里布局是 `/app/app/config.py`     → parents[2] = `/`  → 它会去找 `/.env`（不存在）。
#
# 之所以仍能正常工作：**环境变量优先级高于 env_file**（pydantic-settings 的固定顺序），
# 而 compose 的 `env_file: .env` 会把这些键作为**环境变量**注入容器。
# 所以凭据全部走环境变量进来，那个找不到的 `/.env` 只是被静默跳过，不影响功能。
#
# 结论：不要往镜像里 COPY .env（凭据不进镜像）；需要加配置项时，
#       同时改根目录 `.env`（compose 会注入）和 `.env.example`（文档）。
#       想验证最终生效值，跑：docker compose exec backend python -m app.scripts.check_connectivity

# 数据目录（角色 / 会话 / 上传资料）—— compose 里挂成 volume，
# 这样重建容器不会丢数据。首次启动该目录为空是正常的。
RUN mkdir -p /app/app/data

EXPOSE 8000

# healthcheck 用 python 自带库发请求，避免为它多装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status==200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
