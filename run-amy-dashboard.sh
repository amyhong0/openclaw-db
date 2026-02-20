#!/bin/bash
# AMY Dashboard - OpenClaw gateway 연동
# 충돌 없음: gateway=18789, 대시보드=8080(기본), 배너서버=8000
# 8080 충돌 시: AMY_DASHBOARD_PORT=3333 ./run-amy-dashboard.sh
cd "$(dirname "$0")"

PORT="${AMY_DASHBOARD_PORT:-8080}"
export AMY_DASHBOARD_PORT="$PORT"

echo "AMY Dashboard: http://localhost:${PORT}/amy-dashboard.html"
echo "OpenClaw gateway(18789)에 연결됩니다."
exec node proxy-server.js
