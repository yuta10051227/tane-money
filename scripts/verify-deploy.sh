#!/bin/bash
# Vercelデプロイ確認スクリプト
# 使い方: npm run verify
# 　　　　npm run verify -- --wait   # デプロイ完了まで待つ
#
# ※ tane-versionはビルド時のHEAShを埋め込むため
#    index.htmlの値とVercelの値を比較する

PROD_URL="https://tane-money.vercel.app"
WAIT_MODE=false
[[ "$1" == "--wait" ]] && WAIT_MODE=true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ローカルindex.htmlに埋め込まれているバージョンを取得
EXPECTED=$(grep -o 'name="tane-version" content="[^"]*"' index.html | grep -o '"[^"]*"$' | tr -d '"' || echo "")
GIT_HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Tane Money デプロイ確認"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Git HEAD:   $GIT_HEAD"
echo " 期待バージョン: $EXPECTED (index.html埋め込み値)"
echo " 確認先:     $PROD_URL"
echo ""

fetch_remote_version() {
  # Python3でモバイルUA使用（Vercel Security Checkpointを回避）
  python3 - <<'PYEOF'
import urllib.request, ssl, re, sys
ctx = ssl.create_default_context()
req = urllib.request.Request(
  "https://tane-money.vercel.app",
  headers={
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "ja-JP,ja;q=0.9",
    "Cache-Control": "no-cache",
  }
)
try:
  r = urllib.request.urlopen(req, context=ctx, timeout=15)
  content = r.read().decode("utf-8", errors="replace")
  m = re.search(r'name="tane-version"\s+content="([^"]+)"', content)
  if not m:
    m = re.search(r'tane-version[^>]*content="([^"]+)"', content)
  print(m.group(1) if m else "")
except Exception as e:
  print("", file=sys.stderr)
  print("")
PYEOF
}

if $WAIT_MODE; then
  echo "▶ デプロイ完了を待機中（最大2分）..."
  MAX=24
  COUNT=0
  REMOTE=""
  while [ $COUNT -lt $MAX ]; do
    REMOTE=$(fetch_remote_version)
    if [ "$REMOTE" = "$EXPECTED" ]; then
      break
    fi
    COUNT=$((COUNT+1))
    printf "  待機中... %d秒 (Vercel: %s)\r" $((COUNT*5)) "${REMOTE:-Security Check中...}"
    sleep 5
  done
  echo ""
else
  REMOTE=$(fetch_remote_version)
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -z "$EXPECTED" ]; then
  echo " ⚠️  index.htmlにtane-versionがありません"
  echo " → npm run build を先に実行してください"
elif [ "$REMOTE" = "$EXPECTED" ]; then
  echo " ✅ デプロイ完了！"
  echo " 期待値 = Vercel: $EXPECTED"
elif [ -z "$REMOTE" ]; then
  echo " ⚠️  Vercelのバージョン情報が取得できません"
  echo " → Security Checkpointが応答中の可能性があります"
  echo " → npm run verify -- --wait で再試行してください"
else
  echo " ❌ バージョン不一致"
  echo " 期待値: $EXPECTED"
  echo " Vercel: $REMOTE"
  echo " → まだデプロイ中です。しばらく待ってから再実行してください"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
