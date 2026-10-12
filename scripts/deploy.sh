#!/usr/bin/env bash
# 一键部署 —— 在 Mac / Linux 服务器上 clone 完跑这一条就够：
#
#   bash scripts/deploy.sh
#
# 它会按顺序做：
#   1. 检查 .env（不存在就从 .env.example 生成，然后停下让你填凭据）
#   2. 检查关键凭据非空（TUSHARE_TOKEN 必填、MINIMAX_API_KEY 强烈建议）
#   3. 调 scripts/preflight.sh 做环境预检（Docker / 端口 / 网络 / 磁盘）
#   4. docker compose up -d --build
#   5. 等两个容器 healthy
#   6. 跑容器内连通性自检
#   7. 打印访问地址
#
# 幂等：可以重复跑。已在跑的容器会被 compose 增量更新（数据在 volume 里，不会丢）。
#
# 兼容 macOS 自带的 bash 3.2 —— 不用关联数组 / sed -i / mapfile。

set -u

# ---------- 颜色 ----------
if [ -t 1 ]; then
  C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[36m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_R=''; C_G=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi

say()  { printf '%s\n' "$*"; }
head_() { printf '\n%s==> %s%s\n' "$C_B" "$1" "$C_0"; }
die()  { printf '\n%s✗ %s%s\n' "$C_R" "$1" "$C_0"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || die "无法进入仓库根目录"

printf '================================================================\n'
printf '一键部署\n'
printf '仓库根：%s\n' "$ROOT"
printf '================================================================\n'

# ==============================================================
# 1. .env
# ==============================================================
head_ '1/7 检查 .env'

if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    die "既没有 .env 也没有 .env.example —— 仓库不完整？"
  fi
  cp .env.example .env
  printf '\n%s已从 .env.example 生成 .env，但现在还不能部署。%s\n' "$C_Y" "$C_0"
  printf '请先填入你的凭据（至少这两个）：\n\n'
  printf '    TUSHARE_TOKEN=...        # 行情与 TOP50 榜必需，不填整个榜都用不了\n'
  printf '    MINIMAX_API_KEY=...      # AI 研究室与画像提炼必需\n\n'
  printf '编辑命令：\n\n'
  printf '    vim .env        （或 nano .env / open -e .env）\n\n'
  printf '填完再跑一次：bash scripts/deploy.sh\n'
  exit 0
fi
printf '  %s✓%s .env 存在\n' "$C_G" "$C_0"

# ==============================================================
# 2. 关键凭据
# ==============================================================
head_ '2/7 检查关键凭据'

# 读最后一个非注释的 KEY= 值
getval() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" .env 2>/dev/null | tail -1 \
    | sed -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//" | tr -d '"' | tr -d "'" | tr -d '\r'
}
mask() {
  v="$1"; n=${#v}
  if [ "$n" -eq 0 ]; then printf '(空)'
  elif [ "$n" -le 8 ]; then printf '%s…(%d字符)' "$(printf '%s' "$v" | cut -c1-2)" "$n"
  else printf '%s…(%d字符)' "$(printf '%s' "$v" | cut -c1-6)" "$n"; fi
}

MISSING=0
v="$(getval TUSHARE_TOKEN)"
if [ -n "$v" ]; then
  printf '  %s✓%s TUSHARE_TOKEN        %s\n' "$C_G" "$C_0" "$(mask "$v")"
else
  printf '  %s✗%s TUSHARE_TOKEN        未填 —— 行情/TOP50 会直接 503，必须填\n' "$C_R" "$C_0"
  MISSING=1
fi

v="$(getval TUSHARE_API_URL)"
if [ -n "$v" ]; then printf '  %s✓%s TUSHARE_API_URL      %s\n' "$C_G" "$C_0" "$(mask "$v")"
else printf '  %s✗%s TUSHARE_API_URL      未填\n' "$C_R" "$C_0"; MISSING=1; fi

v="$(getval MINIMAX_API_KEY)"
if [ -n "$v" ]; then
  printf '  %s✓%s MINIMAX_API_KEY      %s\n' "$C_G" "$C_0" "$(mask "$v")"
else
  printf '  %s!%s MINIMAX_API_KEY      未填 —— AI 研究室与画像提炼不可用（不阻断启动）\n' "$C_Y" "$C_0"
fi

if [ "$MISSING" -eq 1 ]; then
  printf '\n%s有必需的凭据没填，先补上再跑。编辑：vim .env%s\n' "$C_R" "$C_0"
  exit 1
fi

# ==============================================================
# 3. 预检
# ==============================================================
head_ '3/7 环境预检'
if [ -f scripts/preflight.sh ]; then
  if bash scripts/preflight.sh; then
    printf '  %s✓%s 预检通过\n' "$C_G" "$C_0"
  else
    die "预检有阻断项（见上方 ✗）。修好后再跑一次。"
  fi
else
  printf '  %s!%s 没有 scripts/preflight.sh，跳过预检\n' "$C_Y" "$C_0"
fi

# ==============================================================
# 4. 构建并启动
# ==============================================================
head_ '4/7 构建并启动（首次要拉镜像+装依赖，通常 3~10 分钟）'

# 重复部署（git pull 后重跑）是常规操作：这时本项目容器还在跑，compose 会增量更新。
# 数据在 volume 里，重建容器不会丢；这条提示只是让你知道没走错。
if docker compose ps --format '{{.Name}}' 2>/dev/null | grep -q '^sip-'; then
  printf '  %s!%s 检测到已有部署在运行 → 增量更新（数据在 volume，不会丢）\n' "$C_Y" "$C_0"
fi

say ''
if ! docker compose up -d --build; then
  die "构建/启动失败。看日志：docker compose logs --tail=80"
fi
printf '\n  %s✓%s compose 已启动\n' "$C_G" "$C_0"

# ==============================================================
# 5. 等 healthy
# ==============================================================
head_ '5/7 等待容器 healthy'

wait_healthy() {
  name="$1"; timeout="$2"; i=0
  while [ "$i" -lt "$timeout" ]; do
    st="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo 'missing')"
    case "$st" in
      healthy)
        printf '  %s✓%s %s  healthy（%ds）\n' "$C_G" "$C_0" "$name" "$((i * 3))"
        return 0 ;;
      missing)
        printf '  %s✗%s %s  容器不存在 —— 启动崩了？看 docker compose logs\n' "$C_R" "$C_0" "$name"
        return 1 ;;
    esac
    i=$((i + 1))
    sleep 3
  done
  printf '  %s!%s %s  %ds 内没到 healthy（最后状态：%s）\n' "$C_Y" "$C_0" "$name" "$((timeout * 3))" "$st"
  return 1
}

BE_OK=0; FE_OK=0
wait_healthy sip-backend 60 && BE_OK=1
wait_healthy sip-frontend 40 && FE_OK=1

if [ "$BE_OK" -eq 0 ]; then
  printf '\n%s后端没起来，最近日志：%s\n' "$C_R" "$C_0"
  docker compose logs --tail=40 backend
  printf '\n排查建议见 docs/DEPLOY.md 的「排障速查」。\n'
  exit 1
fi

# ==============================================================
# 6. 连通性自检
# ==============================================================
head_ '6/7 数据源连通性自检'
if docker compose exec -T backend python -m app.scripts.check_connectivity; then
  printf '\n  %s✓%s 数据源自检通过\n' "$C_G" "$C_0"
else
  printf '\n  %s!%s 自检有 FAIL —— 服务本身能起来，但对应数据源不可用。\n' "$C_Y" "$C_0"
  printf '      （应用仍可用，页面会走兜底数据；修好网络/凭据后重启即可）\n'
fi

# ==============================================================
# 7. 访问地址
# ==============================================================
head_ '7/7 完成'

HOST_PORT="$(grep -E '^[[:space:]]*-[[:space:]]*"?[0-9]+:[0-9]+' docker-compose.yml 2>/dev/null | head -1 | sed -E 's/^[^0-9]*([0-9]+):[0-9]+.*$/\1/')"
case "$HOST_PORT" in ''|*[!0-9]*) HOST_PORT=8080 ;; esac

# 找一个局域网 IP 方便同网段访问。
# ⚠️ `ipconfig getifaddr en0` 是 **macOS 专有**语法 —— 在 Linux/Windows 上跑，
# `ipconfig` 是另一个程序，会把帮助文本吐到 stdout 被误当成 IP。
# 所以：① 先判平台；② 无论来源，都用 `case` 校验形状像不像 IPv4 才采用。
is_ipv4() {
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

LAN_IP=''
if [ "$(uname -s)" = "Darwin" ]; then
  for iface in en0 en1 en2; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    if is_ipv4 "$ip"; then LAN_IP="$ip"; break; fi
  done
fi
if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then
  # Linux：hostname -I 列出所有地址，取第一个
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  is_ipv4 "$ip" && LAN_IP="$ip"
fi
if [ -z "$LAN_IP" ] && command -v ip >/dev/null 2>&1; then
  # 再兜一层：从 `ip route` 里取默认出口的源地址
  ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1)"
  is_ipv4 "$ip" && LAN_IP="$ip"
fi

printf '\n%s✓ 部署完成%s\n\n' "$C_G" "$C_0"
printf '  本机访问：      http://localhost:%s\n' "$HOST_PORT"
if [ -n "$LAN_IP" ]; then
  printf '  局域网访问：    http://%s:%s\n' "$LAN_IP" "$HOST_PORT"
  printf '                  （同一 Wi-Fi 下其它设备用这个；首次可能要允许防火墙入站）\n'
fi
printf '\n  常用命令：\n'
printf '    看状态        docker compose ps\n'
printf '    看日志        docker compose logs -f --tail=100 backend\n'
printf '    重启后端      docker compose restart backend\n'
printf '    停止（留数据） docker compose down\n'
printf '    再跑自检      docker compose exec backend python -m app.scripts.check_connectivity\n'
printf '\n  数据都在 ./backend/app/data（volume 挂载），删容器不会丢；备份就打包这个目录。\n'
printf '  定时任务：每天 09:00（Asia/Shanghai）自动更新角色画像。\n'
