# 前端镜像：多阶段构建 —— 用 node 打静态产物，再交给 nginx 托管。
# 生产环境没有 vite dev server，所以 /api 的反代要由 nginx 来做（见 nginx.conf）。
FROM node:22-alpine AS build

WORKDIR /app

# 同样先装依赖后拷源码，保住依赖层缓存
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build


FROM nginx:1.27-alpine

# 站点配置：静态文件 + /api 反代到后端容器
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
