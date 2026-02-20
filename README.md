# openclaw-db

AMY Dashboard - OpenClaw gateway 모니터링 UI

## 요구사항

- Node.js 18+
- OpenClaw gateway (localhost:18789에서 실행 중이어야 함)

## 설치

```bash
npm install
```

## 설정

`amy-dashboard.html`에서 `GW_TOKEN`을 OpenClaw gateway 토큰으로 교체하세요.

```javascript
// ~/.openclaw/openclaw.json 의 gateway.auth.token 값
const GW_TOKEN = 'YOUR_TOKEN_HERE';
```

## 실행

```bash
# 기본 (포트 8080)
npm start

# 또는
./run-amy-dashboard.sh

# 다른 포트 사용
AMY_DASHBOARD_PORT=3333 npm start
```

## 접속

- http://localhost:8080/amy-dashboard.html

## 포트

| 포트  | 용도                |
|-------|---------------------|
| 8080  | 대시보드 (기본)     |
| 18789 | OpenClaw gateway WS |
