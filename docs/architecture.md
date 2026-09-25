# RepCoach architecture

## Design goal

RepCoach needs to provide coaching while the lifter is moving, while also retaining a defensible workout record. The system therefore has two feedback loops:

1. The mobile rep engine uses incoming pose landmarks to update count and guidance immediately.
2. The server accepts completed-rep feature packets, stores them, and queues a richer review for the worker.

The first loop keeps UX responsive. The second loop makes it possible to improve models, re-score workouts, and produce trusted progress analytics without blocking a set.

## Data flow

```text
Pose provider -> client RepEngine -> on-device cue
                             |\
                             | completed rep
                             v
                      POST /v1/sessions/{id}/reps
                             |
                 PostgreSQL transaction + Kafka event
                             |
                    form-analysis.v1 topic
                             |
          worker -> classifier -> feedback event + persistence
                             |
                    Redis cache invalidation
                             |
              dashboard summary / retrieval-backed coach
```

## Domain boundaries

| Boundary | Responsibility | Implementation |
| --- | --- | --- |
| Pose ingestion | Convert camera/MediaPipe output into normalized frames | `PoseFrame` protocol and mobile provider |
| Rep engine | Phase transitions, count, deterministic safety feedback | TypeScript / Python `RepEngine` |
| Scoring | Combine learned and explainable form signals | `FormClassifier` adapter |
| Workout history | Durable sessions, reps, and progress records | SQLAlchemy + PostgreSQL |
| Event transport | Async analysis and retryable background work | Kafka/Redpanda |
| Personalized coaching | Retrieve relevant form history then generate advice | pgvector + Bedrock port |

## Privacy and safety

- The vertical slice sends pose-derived numeric features, not raw video, by default.
- Raw media upload should use a short-lived pre-signed object-store URL and a retention policy before production rollout.
- Form scores are coaching feedback, not medical advice. The app should direct users to stop when pain or unsafe conditions are reported.
- API tokens, payment keys, and messaging credentials are server-only environment variables.

## Production path

1. Replace the demo pose source with a native MediaPipe/Camera frame processor.
2. Train and version a PyTorch model on consented, labeled landmark sequences; log calibration by exercise and hardware class.
3. Add Kafka DLQ/retries, idempotency keys, schema registry, observability, and a managed Postgres/Redis/Kafka stack.
4. Enable Bedrock retrieval-augmented coaching only after guardrails and prompt-injection filtering are in place.
5. Add Stripe webhook verification and opt-in Twilio reminders with unsubscribe handling.
