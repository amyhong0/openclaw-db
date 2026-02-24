# GCS 배포 가이드

OpenClaw 대시보드를 GCS 정적 호스팅으로 배포하고, JSON 수집 방식으로 에이전트 현황을 표시하는 방법입니다.

## 아키텍처

```
[로컬 PC] OpenClaw gateway (18789)
    ↑
    | collect-to-gcs.mjs (1분마다 cron)
    ↓
[GCS] status.json + amy-dashboard.html
    ↑
    | fetch (브라우저)
    ↓
[사용자] 대시보드 확인
```

## 1. GCS 버킷 생성

```bash
# 프로젝트 설정
export PROJECT_ID="livenow-auto"   # 또는 사용할 GCP 프로젝트
export BUCKET_NAME="openclaw-db"  # 전역 유일한 이름

gcloud config set project $PROJECT_ID
gsutil mb -l asia-northeast3 gs://${BUCKET_NAME}/
```

## 2. 버킷 공개 설정

```bash
# 객체 공개 읽기 허용
gsutil iam ch allUsers:objectViewer gs://${BUCKET_NAME}
```

## 3. 대시보드 파일 업로드

```bash
cd openclaw-db

# 대시보드 HTML (index로 접근 가능하게)
gsutil cp amy-dashboard.html gs://${BUCKET_NAME}/amy-dashboard.html
gsutil cp amy-dashboard.html gs://${BUCKET_NAME}/index.html
```

## 4. 수집 스크립트 설정 (로컬)

Gateway가 실행 중인 Mac에서 주기적으로 상태를 수집해 GCS에 올립니다.

```bash
cd openclaw-db
npm install

# 수동 1회 실행
GCS_BUCKET=gs://${BUCKET_NAME} node collect-to-gcs.mjs

# cron 등록 (1분마다) - crontab -e
# */1 * * * * cd /path/to/openclaw-db && GCS_BUCKET=gs://BUCKET_NAME node collect-to-gcs.mjs >> /tmp/collect.log 2>&1
```

**필수**: `gcloud auth login` 및 `gsutil` 사용 가능해야 합니다.

## 5. 접속

- **대시보드**: `https://storage.googleapis.com/${BUCKET_NAME}/amy-dashboard.html?static=1`
- **또는**: `https://storage.googleapis.com/${BUCKET_NAME}/?static=1` (index.html)

`?static=1` 이 있으면 `./status.json` 을 fetch 합니다. 같은 버킷에 `status.json` 이 있어야 합니다.

## 6. 다른 도메인의 status.json 사용

status.json을 다른 버킷/URL에 둔 경우:

```
.../amy-dashboard.html?data=https://storage.googleapis.com/다른버킷/status.json
```

## CORS (다른 도메인에서 fetch 시)

버킷이 대시보드와 다른 경우 CORS 설정이 필요할 수 있습니다. `cors.json`:

```json
[
  {
    "origin": ["https://storage.googleapis.com", "http://localhost:8080"],
    "method": ["GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

```bash
gsutil cors set cors.json gs://${BUCKET_NAME}
```

## 요약

| 단계 | 명령 |
|------|------|
| 버킷 생성 | `gsutil mb -l asia-northeast3 gs://BUCKET/` |
| 공개 설정 | `gsutil iam ch allUsers:objectViewer gs://BUCKET` |
| 업로드 | `gsutil cp amy-dashboard.html gs://BUCKET/` |
| 수집(cron) | `GCS_BUCKET=gs://BUCKET node collect-to-gcs.mjs` |
| 접속 | `https://storage.googleapis.com/BUCKET/amy-dashboard.html?static=1` |
