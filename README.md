# RepCoach

RepCoach is an AI-powered strength-training companion that turns pose landmarks into counted repetitions, form scores, and useful coaching cues. It is designed as a portfolio-quality, local-first vertical slice rather than a UI-only mockup: a mobile coach produces pose events, a FastAPI service persists the workout and publishes analysis work, a Kafka worker grades form, and a Next.js dashboard turns the session data into progress insights.

## Why this exists

Most workout trackers record that a set happened. RepCoach focuses on *how* it happened. Each completed repetition includes a numeric score, a form classification, and a concise correction such as “Sit two inches deeper” or “Keep your knees tracking over your toes.” The architecture supports low-latency live feedback while keeping more expensive video analysis asynchronous.

## Product slice

- **Guided squat coach:** a React Native/Expo experience with a deterministic pose-stream demo, a rep state machine, live form cues, and API sync.
- **Workout API:** FastAPI + PostgreSQL models for sessions, reps, and coaching plans; Redis response caching; OpenAPI documentation.
- **Analysis worker:** Kafka consumer that scores pose features with a PyTorch-compatible classifier adapter and publishes feedback events.
- **Progress dashboard:** Next.js dashboard for weekly volume, form trends, personal records, and an actionable coaching summary.
- **Platform adapters:** interfaces and local fallbacks for AWS Bedrock coaching, Stripe entitlements, Twilio reminders, and MediaPipe/native-camera ingestion. No cloud credential is needed to run the demo.

## Architecture

```text
Expo mobile app ── pose frames / completed reps ──► FastAPI ──► PostgreSQL + Redis
        │                                                │
        └──────── live local rep engine                  └──► Kafka topic
                                                                 │
Next.js dashboard ◄── REST API / cached summary ◄── analysis worker
                                                    (PyTorch classifier adapter)
```

The client-side engine provides immediate UI feedback. The backend pipeline produces an auditable server-side result and leaves a clean seam for uploaded-video analysis at scale.

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

## Engineering decisions

- The rep engine is intentionally deterministic and tested; a learned PyTorch model augments it rather than becoming a black box that can silently miscount.
- Kafka is used only across the asynchronous boundary. A user gets immediate device-side feedback even when a worker is slow or temporarily unavailable.
- Bedrock, Twilio, and Stripe are isolated behind ports so the app remains locally runnable and secrets never leak into client bundles.
- Postgres owns durable workout history; Redis caches read-heavy summaries; pgvector stores coachable workout-context embeddings for semantic retrieval.

See [docs/architecture.md](docs/architecture.md) for the data flow, schemas, and production hardening path.
