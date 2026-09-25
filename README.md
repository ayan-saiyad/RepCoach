# RepCoach

RepCoach is an AI-powered strength-training companion that turns pose landmarks into counted repetitions, form scores, and useful coaching cues. It is designed as a portfolio-quality, local-first vertical slice rather than a UI-only mockup: a mobile coach produces pose events, a FastAPI service persists the workout and publishes analysis work, a Kafka worker grades form, and a Next.js dashboard turns the session data into progress insights.

![Validation](https://github.com/ayan-saiyad/RepCoach/actions/workflows/ci.yml/badge.svg)

Most workout trackers record that a set happened. RepCoach focuses on *how* it happened. Each completed repetition includes a numeric score, a form classification, and a concise correction such as “Sit two inches deeper” or “Keep your knees tracking over your toes.” The architecture supports low-latency live feedback while keeping more expensive video analysis asynchronous.

## Repository layout

```text
apps/
  dashboard/       Next.js progress dashboard
  mobile/          Expo React Native guided coach
backend/
  app/             FastAPI domain, API, persistence, service adapters
  worker/          Kafka pose-analysis worker
  tests/           focused domain/API tests
docs/              architecture and local-development notes
```

## Run locally

### 1. Start the data services

```bash
cp .env.example .env
docker compose up -d postgres redis kafka
```

### 2. Run the API and worker

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
uvicorn app.main:app --reload
# in another terminal
python -m worker.main
```

The API is available at `http://localhost:8000`, with interactive docs at `/docs`.

### 3. Run the web dashboard or mobile app

```bash
npm install
npm run dashboard:dev
# or
npm run mobile:dev
```

Set `NEXT_PUBLIC_API_BASE_URL` and `EXPO_PUBLIC_API_BASE_URL` if the API is not on the default local address.

## Verification

```bash
cd backend && pytest
npm run dashboard:lint
npm run mobile:typecheck
```

