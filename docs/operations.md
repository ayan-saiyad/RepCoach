# Local operations

## Service topology

`docker compose up --build` starts PostgreSQL with pgvector, Redis, Redpanda-compatible Kafka, the FastAPI API, and the Kafka worker. The API runs `alembic upgrade head` before binding its port. The worker waits for the API health check, then drains the transaction outbox and consumes analysis messages. The host defaults are `5433` for Postgres and `6380` for Redis to avoid colliding with local development services; containers use their normal internal ports.

## Useful checks

```bash
curl http://localhost:8000/health
curl http://localhost:8000/docs
docker compose logs -f api worker
docker compose exec postgres psql -U repcoach -d repcoach -c '\dt'
```

## Cloud configuration

Server-only variables belong in your secret manager, never in either client app:

- `BEDROCK_MODEL_ID` and optionally `BEDROCK_EMBEDDING_MODEL_ID`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_PRO`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`

The default configuration uses deterministic local fallbacks, making accidental payment, SMS, or Bedrock usage impossible during development.

For Amazon MSK Serverless, set `KAFKA_AUTH_MODE=msk_iam`, set
`KAFKA_AWS_REGION`, and use the MSK IAM bootstrap brokers. The API/worker ECS
task role supplies credentials through Boto3's default credential chain; do not
store static AWS credentials in an environment variable. Local Docker and
Redpanda remain on `KAFKA_AUTH_MODE=plaintext`.

## Production checklist

1. Set `AUTO_CREATE_SCHEMA=false` and run Alembic migrations as a deployment job.
2. Use managed Postgres, Redis, and Kafka with TLS/authentication and rotate credentials.
3. Add authentication and server-side authorization before storing a user’s workout history.
4. Route raw media through short-lived object-store URLs and enforce a retention policy.
5. Add metrics for outbox lag, Kafka consumer lag, classifier fallback rate, webhook failures, and opt-in reminder delivery.
