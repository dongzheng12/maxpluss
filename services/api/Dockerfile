FROM node:20-slim

# 时区基线（跟 Dockerfile.prod 保持一致）：node:20-slim 自带 zoneinfo
ENV TZ=Asia/Shanghai

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

RUN npm install tsx

COPY tsconfig.json ./
COPY src/ ./src/
COPY prisma/schema.prisma ./prisma/

# 中文 PDF 字体（vendoring 单文件 OTF，决策见 src/standard-execution/packageBundle.ts 注释）
COPY assets/fonts/NotoSansSC-Regular.otf ./assets/fonts/NotoSansSC-Regular.otf

RUN npx prisma generate

EXPOSE 3000

# 注意：实际发版用 Dockerfile.prod（混淆产物），本 Dockerfile 仅用于开发环境。
# API 测试门禁在 build-obfuscate.sh 脚本开头，不在 Dockerfile 里。
CMD ["npx", "tsx", "src/main.ts"]
