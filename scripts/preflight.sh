#!/usr/bin/env bash
# 部署前环境预检 —— 在 Mac 服务器上、`docker compose up` 之前跑。
#
#   bash scripts/preflight.sh
#
# 只做检查，不改任何东西。作用是把「跑到一半才发现」的问题提前暴露：
#   · Docker 装了吗 / daemon 起了吗 / compose 版本够吗
#   · 端口 8080 空着吗（被占的话 compose 起不来）
#   · .env 建了吗（没建的话凭据全是空，数据源全挂）
#   · 关键凭据填了吗（Tushare / MiniMax 至少要有）
#   · 磁盘够吗 / 域名能解析吗 / 外网通吗
#
# 退出码：0 = 可以部署；1 = 有阻断项，先修。

set -u

# ---------- 小工具 ----------
if [ -t 1 ]; then
  C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[36m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_R=''; C_G=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  %s✓%s %-26s %s\n' "$C_G" "$C_0" "$1" "${2:-}"; }
warn() { WARN=$((WARN+1)); printf '  %s!%s %-26s %s\n' "$C_Y" "$C_0" "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s✗%s %-26s %s\n' "$C_R" "$C_0" "$1" "${2:-}"; }
skip() { printf '  %s-%s %-26s %s\n' "$C_D" "$C_0" "$1" "${2:-}"; }
head_() { printf '\n%s[%s]%s\n' "$C_B" "$1" "$C_0"; }

# 脚本所在仓库根目录（scripts/ 的上一级）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || { echo "无法进入仓库根目录"; exit 1; }

printf '================================================================\n'
printf '部署前环境预检 —— 只读，不改任何东西\n'
printf '仓库根：%s\n' "$ROOT"
printf '================================================================\n'

# ---------- 1. 系统 ----------
head_ '系统'
OS="$(uname -s)"
ARCH="$(uname -m)"
ok '操作系统' "$OS / $ARCH"
if [ "$OS" = "Darwin" ]; then
  skip 'Docker Desktop' 'macOS：需已安装并启动 Docker Desktop（命令栏能看到鲸鱼图标）'
fi

# ---------- 2. Docker ----------
head_ 'Docker'
if command -v docker >/dev/null 2>&1; then
  ok 'docker 命令' "$(docker --version 2>/dev/null)"
else
  bad 'docker 命令' '未安装 —— macOS 请装 Docker Desktop：https://www.docker.com/products/docker-desktop/'
fi

if docker info >/dev/null 2>&1; then
  SRV="$(docker info --format '{{.ServerVersion}}' 2>/dev/null)"
  ok 'docker daemon' "已运行（引擎 $SRV）"
else
  bad 'docker daemon' '连不上 —— Docker Desktop 没启动？打开它等鲸鱼图标稳定后再试'
fi

if docker compose version >/dev/null 2>&1; then
  ok 'docker compose' "$(docker compose version --short 2>/dev/null || docker compose version 2>/dev/null | head -1)"
else
  bad 'docker compose' '不可用 —— 需 Docker Compose v2（Docker Desktop 自带）'
fi

# ---------- 3. 端口 ----------
head_ '端口'
PORT_LINE="$(grep -E '^[[:space:]]*-[[:space:]]*"?[0-9]+:[0-9]+' docker-compose.yml 2>/dev/null | head -1)"
# 取「宿主端口:容器端口」里的宿主端口。注意别用 .* 贪婪匹配，
# 否则 "8080:80" 会被吃到只剩最后的 0 —— 必须先剥掉行的前缀，再取第一段数字。
HOST_PORT="$(printf '%s' "$PORT_LINE" | sed -E 's/^[^0-9]*([0-9]+):[0-9]+.*$/\1/')"
case "$HOST_PORT" in
  ''|*[!0-9]*) HOST_PORT=8080 ;;   # 提取失败就退回默认值，别让脚本崩
esac
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    bad "端口 $HOST_PORT" "已被占用 —— 换 compose 里的映射（如 \"8081:80\"）或先停掉占用进程"
  else
    ok "端口 $HOST_PORT" '空闲'
  fi
elif command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":$HOST_PORT "; then
    bad "端口 $HOST_PORT" '已被占用'
  else
    ok "端口 $HOST_PORT" '空闲'
  fi
elif command -v nc >/dev/null 2>&1; then
  if nc -z 127.0.0.1 "$HOST_PORT" >/dev/null 2>&1; then
    bad "端口 $HOST_PORT" '已被占用'
  else
    ok "端口 $HOST_PORT" '空闲'
  fi
else
  # 最后的兜底：bash 内建 /dev/tcp 探一下（只在 bash 下可用）
  if (exec 3<>/dev/tcp/127.0.0.1/"$HOST_PORT") >/dev/null 2>&1; then
    exec 3<&- 2>/dev/null
    bad "端口 $HOST_PORT" '已被占用'
  else
    ok "端口 $HOST_PORT" '空闲（/dev/tcp 探测）'
  fi
fi

# ---------- 4. 配置文件 ----------
head_ '配置文件'
if [ -f .env ]; then
  ok '.env' '存在'
  ENV_SRC=.env
elif [ -f .env.example ]; then
  bad '.env' '不存在 —— 先执行：cp .env.example .env 然后填凭据（否则数据源全部为空）'
  ENV_SRC=.env.example
else
  bad '.env' '不存在，且 .env.example 也找不到 —— 仓库不完整？'
  ENV_SRC=/dev/null
fi

for f in docker-compose.yml backend/Dockerfile frontend/Dockerfile frontend/nginx.conf; do
  if [ -f "$f" ]; then ok "$f" '存在'; else bad "$f" '缺失 —— 仓库不完整？'; fi
done

# ---------- 5. 凭据 ----------
head_ '凭据（从 .env 读，值脱敏）'
getval() {
  # 取最后一个非注释的 KEY= 的值（后写的覆盖前面的）
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_SRC" 2>/dev/null | tail -1 | sed -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//" | tr -d '"' | tr -d "'" | tr -d '\r'
}
mask() { # 前 6 字符 + 长度
  v="$1"
  n=${#v}
  if [ "$n" -eq 0 ]; then printf '(空)'; elif [ "$n" -le 8 ]; then printf '%s…(%d字符)' "$(printf '%s' "$v" | cut -c1-2)" "$n"; else printf '%s…(%d字符)' "$(printf '%s' "$v" | cut -c1-6)" "$n"; fi
}

# 必需：没有它行情/TOP50 全挂
for k in TUSHARE_TOKEN TUSHARE_API_URL; do
  v="$(getval "$k")"
  if [ -n "$v" ]; then ok "$k" "$(mask "$v")"; else bad "$k" '未填 —— 行情与 TOP50 榜会用不了'; fi
done

# 次必需：没有它 AI 会诊不可用
v="$(getval MINIMAX_API_KEY)"
if [ -n "$v" ]; then ok 'MINIMAX_API_KEY' "$(mask "$v")"; else warn 'MINIMAX_API_KEY' '未填 —— AI 研究室会诊不可用'; fi

# 可选：缺了只是少一路数据，不阻断
for k in TUSHARE_FALLBACK_URL TUSHARE_FALLBACK_API_KEY QINGHONG_BASE_URL QINGHONG_API_KEY ADMIN_API_TOKEN NEWSAPI_KEY; do
  v="$(getval "$k")"
  if [ -n "$v" ]; then ok "$k" "$(mask "$v")"; else skip "$k" '未填（可选）'; fi
done

# ---------- 6. 网络 ----------
head_ '网络连通性'
if command -v curl >/dev/null 2>&1; then
  # 外网
  if curl -sS -o /dev/null --max-time 8 https://registry-1.docker.io/v2/ 2>/dev/null; then
    ok 'Docker Hub' '可达（拉取基础镜像需要）'
  else
    warn 'Docker Hub' '不可达或很慢 —— 国内网络常见；若卡在拉取，考虑配镜像加速'
  fi
  # Tushare 主源
  TU="$(getval TUSHARE_API_URL)"
  if [ -n "$TU" ]; then
    if curl -sS -o /dev/null --max-time 10 "$TU" 2>/dev/null; then
      ok 'Tushare 主源' "$TU 可达"
    else
      warn 'Tushare 主源' "$TU 无响应 —— 换网络再测，或确认该中继是否仍有效（自签证书源在部分网络下会被拦）"
    fi
  fi
  # MiniMax
  if curl -sS -o /dev/null --max-time 10 https://api.minimaxi.com/ 2>/dev/null; then
    ok 'MiniMax' 'api.minimaxi.com 可达'
  else
    warn 'MiniMax' 'api.minimaxi.com 无响应 —— AI 功能会失败'
  fi
else
  skip '网络探测' '没有 curl，跳过'
fi

# ---------- 7. 磁盘 ----------
head_ '磁盘'
AVAIL_KB="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "${AVAIL_KB:-}" ]; then
  AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
  # 两个镜像 + 构建缓存，留 5G 比较稳（node 构建层挺占地方）
  if [ "$AVAIL_GB" -ge 8 ]; then
    ok '可用空间' "${AVAIL_GB}G（构建缓存 + 两个镜像约需 3~5G）"
  elif [ "$AVAIL_GB" -ge 4 ]; then
    warn '可用空间' "${AVAIL_GB}G —— 偏紧，构建可能失败；建议清理后再来"
  else
    bad '可用空间' "${AVAIL_GB}G —— 不够，至少留 4G"
  fi
else
  skip '可用空间' '读不到'
fi

# ---------- 8. 数据目录 ----------
head_ '数据目录'
if [ -d backend/app/data ]; then
  N_FILES="$(find backend/app/data -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$N_FILES" = "0" ]; then
    ok 'backend/app/data' '存在且为空 —— 首次部署正常（角色/会话都从零开始）'
  else
    ok 'backend/app/data' "存在，已有 $N_FILES 个文件 —— 这些会被容器直接使用（不是覆盖）"
  fi
  if [ -w backend/app/data ]; then
    ok '目录可写' 'volume 挂载前提满足'
  else
    bad '目录可写' '不可写 —— 容器里上传资料会失败，检查属主/权限'
  fi
else
  warn 'backend/app/data' '不存在 —— 首次启动 compose 会自动创建（或用 mkdir -p 先建）'
fi

# ---------- 总结 ----------
printf '\n================================================================\n'
printf '总结：%sPASS %d%s / %sWARN %d%s / %sFAIL %d%s\n' \
  "$C_G" "$PASS" "$C_0" "$C_Y" "$WARN" "$C_0" "$C_R" "$FAIL" "$C_0"
printf '================================================================\n'

if [ "$FAIL" -gt 0 ]; then
  printf '\n%s有阻断项，先修上面的 ✗ 再来。%s\n' "$C_R" "$C_0"
  printf '提示：Docker 相关的问题看 docs/DEPLOY.md 的「排障速查」一节。\n'
  exit 1
fi

printf '\n%s✓ 预检通过，可以部署了：%s\n' "$C_G" "$C_0"
printf '\n    docker compose up -d --build\n'
printf '    docker compose exec backend python -m app.scripts.check_connectivity\n'
printf '    然后浏览器访问  http://<本机IP>:%s\n' "$HOST_PORT"
printf '\n%s注意：首次构建要装依赖 + 打前端产物，Mac 上大约 3~8 分钟属正常。%s\n' "$C_D" "$C_0"
exit 0
