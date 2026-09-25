# Production deployment

RepCoach has an AWS CDK production stack in [`infra/`](../infra). It is intentionally
two-phase: durable infrastructure is created before an immutable release image is
allowed to receive traffic. This prevents a placeholder image from accidentally
becoming a public service.

## What the stack creates

```text
CloudFront + WAF (HTTPS)
        |
        v
Application Load Balancer
   |              |
Next.js dashboard  FastAPI API ─── RDS PostgreSQL + pgvector
                         |          ElastiCache Serverless Valkey
                         |          Cognito JWT verification
                         |
          ECS topic bootstrap + worker ─── MSK Serverless (IAM/TLS)
```

- Two-AZ VPC with private application and isolated data subnets; one NAT gateway
  keeps the initial production footprint lower while data services have no public
  address.
- ECS/Fargate tasks run as non-root, use task roles, inject secrets only from
  Secrets Manager, and emit CloudWatch logs.
- PostgreSQL is encrypted, has automatic backups, snapshot-on-removal behavior,
  storage autoscaling, and a generated RDS credential. The existing Alembic
  migration enables `pgvector`.
- Valkey uses TLS (`rediss://`), and MSK Serverless uses IAM plus SASL/OAUTHBEARER.
  A one-shot, least-privilege Fargate task creates the three required Kafka topics
  before the long-lived worker starts; it is needed because MSK Serverless does
  not expose a CloudFormation topic resource.
- CloudFront provides the generated HTTPS endpoint until a custom domain is
  supplied. Its random origin header prevents direct ALB access to product API
  routes; `/health`, `/livez`, and `/readyz` remain available for probes.
- A Cognito hosted UI and constrained GitHub OIDC role are provisioned. API routes
  derive identity from a verified Cognito subject; browser/mobile clients never
  receive database, Stripe, Twilio, or Bedrock credentials.

## First production release

Prerequisites: AWS CLI credentials for the target account, Docker Desktop, Node 22,
and an explicit review of the recurring charges below.

```bash
cd /Users/ayansaiyad/Projects/RepCoach
REPCOACH_CONFIRM_PAID_INFRA=yes infra/scripts/deploy-production.sh
```

The script bootstraps CDK, creates the stack with ECS services disabled, publishes
immutable ARM64 images using the current Git SHA, provisions Kafka topics as one
Fargate task, runs Alembic as one Fargate task, then enables API, worker, and
dashboard services. It prints the CloudFront HTTPS URL and the exact public Expo
configuration when the stack reaches a stable state.

The script does **not** create third-party account credentials, submit mobile builds,
or enable a Bedrock model in the AWS console. Those are account-level actions that
should never be synthesized from source code.

## Provider secret values

The `IntegrationSecretArn` stack output points to a JSON secret with blank optional
values. Populate only the services that have been approved and configured:

```json
{
  "bedrock_model_id": "",
  "bedrock_embedding_model_id": "",
  "stripe_secret_key": "",
  "stripe_webhook_secret": "",
  "stripe_price_pro": "",
  "twilio_account_sid": "",
  "twilio_auth_token": "",
  "twilio_from_number": ""
}
```

Use `aws secretsmanager put-secret-value` with a local JSON file that is ignored by
Git. Do not put these values in GitHub variables, mobile EAS environments, Docker
build arguments, or `.env.example`.

Before enabling Bedrock, grant model access in `us-east-1`, choose a model compatible
with the configured embedding dimension, and set a budget/alarm. Before enabling
Stripe or Twilio, complete their webhook/consent/account configuration; the secret
alone is not a business or compliance configuration.

## GitHub delivery

After the first successful local stack deployment, take the `GitHubDeployRoleArn`
output and create the GitHub repository variable `AWS_DEPLOY_ROLE_ARN`. Optionally
set `AWS_REGION` (it defaults to `us-east-1`). The [`deploy` workflow](../.github/workflows/deploy.yml)
then runs only on relevant `main` changes or manual dispatch, uses GitHub OIDC rather
than a long-lived AWS key, publishes SHA-tagged images, refreshes the ECS service,
and idempotently verifies Kafka topics and the database migration. Its OIDC role is
bound to both `main` and the protected GitHub `production` environment.

Protect the GitHub `production` environment with a required reviewer before enabling
automatic runs. A fresh stack must be bootstrapped locally once because the OIDC role
is itself a resource of the stack.

## Mobile release

`apps/mobile/eas.json` defines development, preview, and production EAS profiles.
The deployed stack output prints the exact public values for
`EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_COGNITO_DOMAIN`, and
`EXPO_PUBLIC_COGNITO_CLIENT_ID`; add them as EAS public environment variables with
`EXPO_PUBLIC_COGNITO_REDIRECT_URI=repcoach://auth/callback`. The mobile client uses
the Cognito authorization-code flow with PKCE and OS-protected token storage; see
[`apps/mobile/README.md`](../apps/mobile/README.md) for the full setup.

After a real Expo project, Apple developer account, Google Play account, signing
credentials, support/privacy URLs, and production API endpoint exist, use the EAS
commands documented in [`apps/mobile/.env.example`](../apps/mobile/.env.example).

The current mobile release is correctly labeled as a pose-replay coach. It does not
claim that a native MediaPipe camera bridge or app-store release exists until those
external requirements are complete.

## Cost and irreversible-action review

This is a real managed stack, not a free static-site deployment. MSK Serverless is
the primary cost driver (AWS's published example is about **$0.75 per cluster-hour**,
roughly **$550/month** before throughput and storage). NAT gateway hourly/data charges,
RDS, ElastiCache, Fargate, ALB, CloudFront, WAF, CloudWatch, Bedrock usage, Twilio, and
Stripe costs are additional. Review the AWS Pricing Calculator before setting
`REPCOACH_CONFIRM_PAID_INFRA=yes`.

The stack deliberately retains RDS snapshots, ECR images, Cognito users, logs, and
secrets to avoid data loss. Destroying the CDK stack does not implicitly erase those
assets; delete them only through an explicit data-retention decision.
