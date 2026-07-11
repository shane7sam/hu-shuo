#!/usr/bin/env bash
# AI 产业链仪表盘 · 一键部署脚本（在 Git Bash 中运行）
# 前置：已安装 git、gh（GitHub CLI）、Node.js（用于可选的 wrangler）
set -e

REPO="hu-shuo"

echo "=========================================="
echo " AI 产业链仪表盘 · 部署脚本"
echo "=========================================="

# ---------- 1) GitHub 登录 ----------
echo "[1/5] 检查 GitHub 登录..."
if ! gh auth status >/dev/null 2>&1; then
  echo "    未登录，请在浏览器中完成授权："
  gh auth login
fi
USER=$(gh api user --jq .login)
echo "    已登录为: $USER"

# ---------- 2) 建仓并推送 ----------
echo "[2/5] 创建仓库并推送（若已存在则直接推送）..."
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "    仓库 $REPO 已存在，仅推送。"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$USER/$REPO.git"
else
  gh repo create "$REPO" --public --source=. --push \
    --description "AI 产业链行情仪表盘（GitHub Pages + Cloudflare Worker）"
fi
git branch -M main
cp ai-industry-chain.html index.html 2>/dev/null || true   # 站点以根目录 index.html 提供服务（干净网址 hu-shuo/）；若源文件缺失则跳过，交由 CI 处理
# 美股K线内嵌快照(方案B)：若已生成则一并部署，云端必显示；未生成则提示先跑脚本
if [ -f us_kline_cache.js ]; then
  git add index.html us_kline_cache.js
  echo "    已包含美股K线快照 us_kline_cache.js（方案B，云端必显示）。"
else
  echo "    ⚠ 未找到 us_kline_cache.js，请先运行: python regenerate_us_kline_cache.py"
  git add index.html
fi
git push -u origin main || git push -u origin main
echo "    代码已推送。"

# ---------- 3) 提醒开启 Pages ----------
echo "[3/5] 请在 GitHub 开启 Pages："
echo "    → 打开 https://github.com/$USER/$REPO/settings/pages"
echo "    → Source 选择 'GitHub Actions'"
echo "    → 保存后访问： https://$USER.github.io/$REPO/"

# ---------- 4) 验证公告/要闻 ----------
echo "[4/5] 打开站点后点个股，查看「重大公告·近期要闻」："
echo "    - 能显示 → 已完成，无需 Worker。"
echo "    - 空白/报错 → 执行第 5 步部署 Cloudflare Worker。"

# ---------- 5) 可选：Cloudflare Worker ----------
read -p "[5/5] 是否现在部署 Cloudflare Worker（可选，稳定公告/要闻）? [y/N] " DO_W
if [ "$DO_W" = "y" ] || [ "$DO_W" = "Y" ]; then
  echo "    安装并登录 wrangler（需要 Cloudflare 账号）..."
  npm i -g wrangler
  wrangler login
  echo "    部署 Worker..."
  wrangler deploy
  read -p "    请输入 Worker 地址（如 https://ai-industry-proxy.xxx.workers.dev）：" WURL
  if [ -n "$WURL" ]; then
    sed -i "s#const ANN_PROXY='[^']*'#const ANN_PROXY='$WURL'#" ai-industry-chain.html
    sed -i "s#const KLINE_PROXY='[^']*'#const KLINE_PROXY='$WURL'#" ai-industry-chain.html
    cp ai-industry-chain.html index.html
    git add index.html us_kline_cache.js 2>/dev/null || git add index.html
    git commit -m "enable Cloudflare Worker proxy (ann+kline)"
    git push
    echo "    已写入 ANN_PROXY 与 KLINE_PROXY 并推送，Pages 将自动重建。"
    echo "    Worker 现同时提供：公告/要闻 + 实时美股K线(方案A)；快照 us_kline_cache.js 仍作兜底(方案B)。"
  fi
else
  echo "    跳过 Worker。公告/要闻将尝试东方财富 JSONP 直连；"
  echo "    若页面显示不出来，再回来执行：wrangler login && wrangler deploy"
fi

echo "=========================================="
echo " 完成。站点： https://$USER.github.io/$REPO/"
echo "=========================================="
