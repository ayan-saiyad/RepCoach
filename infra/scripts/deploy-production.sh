#!/usr/bin/env bash
set -euo pipefail

# Creates RepCoach's production AWS stack in a deliberately two-phase flow:
# infrastructure/task definitions first, then one migration task, then services.
# It never creates provider credentials; set them in the output Secrets Manager
# secret after deployment, and enable Bedrock model access in the target region.

TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASK_STACK="${REPCOACH_STACK_NAME:-RepCoachProduction}"
TASK_REGION="${AWS_REGION:-us-east-1}"

if [[ "$TASK_REGION" != "us-east-1" ]]; then
  echo "RepCoachProduction currently deploys only to us-east-1 (CloudFront WAF scope)." >&2
  exit 2
fi

TASK_ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "$TASK_REGION")"
TASK_TAG="$(git -C "$TASK_ROOT" rev-parse --short HEAD)"

if [[ "${REPCOACH_CONFIRM_PAID_INFRA:-}" != "yes" ]]; then
  cat >&2 <<'EOF'
Refusing to create paid AWS infrastructure without an explicit acknowledgement.
Review the cost section in docs/deployment.md, then rerun with:
  REPCOACH_CONFIRM_PAID_INFRA=yes infra/scripts/deploy-production.sh
EOF
  exit 2
fi

cd "$TASK_ROOT"
npm ci

cd infra
../node_modules/.bin/cdk bootstrap "aws://${TASK_ACCOUNT}/${TASK_REGION}"

# Bootstrap durable resources and ECR repositories without starting placeholder images.
../node_modules/.bin/cdk deploy "$TASK_STACK" \
  --require-approval never \
  --parameters DeployServices=false

task_output() {
  aws cloudformation describe-stacks \
    --stack-name "$TASK_STACK" \
    --region "$TASK_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

TASK_API_REPOSITORY="$(task_output ApiRepositoryUri)"
TASK_DASHBOARD_REPOSITORY="$(task_output DashboardRepositoryUri)"
TASK_API_IMAGE="${TASK_API_REPOSITORY}:${TASK_TAG}"
TASK_DASHBOARD_IMAGE="${TASK_DASHBOARD_REPOSITORY}:${TASK_TAG}"

image_exists() {
  local repository_uri="$1"
  aws ecr describe-images \
    --repository-name "${repository_uri##*/}" \
    --image-ids "imageTag=${TASK_TAG}" \
    --region "$TASK_REGION" >/dev/null 2>&1
}

aws ecr get-login-password --region "$TASK_REGION" \
  | docker login --username AWS --password-stdin "${TASK_ACCOUNT}.dkr.ecr.${TASK_REGION}.amazonaws.com"

cd "$TASK_ROOT"
if image_exists "$TASK_API_REPOSITORY"; then
  echo "Reusing immutable API image ${TASK_API_IMAGE}"
else
  docker build --platform linux/arm64 --file backend/Dockerfile --tag "$TASK_API_IMAGE" backend
  docker push "$TASK_API_IMAGE"
fi
if image_exists "$TASK_DASHBOARD_REPOSITORY"; then
  echo "Reusing immutable dashboard image ${TASK_DASHBOARD_IMAGE}"
else
  docker build --platform linux/arm64 --file apps/dashboard/Dockerfile --tag "$TASK_DASHBOARD_IMAGE" .
  docker push "$TASK_DASHBOARD_IMAGE"
fi

# Register the release task definitions without opening public traffic yet.
cd infra
../node_modules/.bin/cdk deploy "$TASK_STACK" \
  --require-approval never \
  --parameters ApiImageUri="$TASK_API_IMAGE" \
  --parameters DashboardImageUri="$TASK_DASHBOARD_IMAGE" \
  --parameters DeployServices=false

TASK_CLUSTER="$(task_output ClusterName)"
TASK_API_DEFINITION="$(task_output ApiTaskDefinitionArn)"
TASK_TOPIC_BOOTSTRAP_DEFINITION="$(task_output TopicBootstrapTaskDefinitionArn)"
TASK_SUBNETS="$(task_output PrivateApplicationSubnetIds)"
TASK_API_SECURITY_GROUP="$(task_output ApiSecurityGroupId)"
TASK_WORKER_SECURITY_GROUP="$(task_output WorkerSecurityGroupId)"
TASK_NETWORK="awsvpcConfiguration={subnets=[${TASK_SUBNETS}],securityGroups=[${TASK_API_SECURITY_GROUP}],assignPublicIp=DISABLED}"
TASK_WORKER_NETWORK="awsvpcConfiguration={subnets=[${TASK_SUBNETS}],securityGroups=[${TASK_WORKER_SECURITY_GROUP}],assignPublicIp=DISABLED}"

TASK_BOOTSTRAP_ARN="$(aws ecs run-task \
  --cluster "$TASK_CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASK_TOPIC_BOOTSTRAP_DEFINITION" \
  --network-configuration "$TASK_WORKER_NETWORK" \
  --region "$TASK_REGION" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [[ -z "$TASK_BOOTSTRAP_ARN" || "$TASK_BOOTSTRAP_ARN" == "None" ]]; then
  echo "Kafka topic bootstrap did not start. Inspect the ECS task failure reason." >&2
  exit 1
fi
aws ecs wait tasks-stopped --cluster "$TASK_CLUSTER" --tasks "$TASK_BOOTSTRAP_ARN" --region "$TASK_REGION"
TASK_BOOTSTRAP_EXIT_CODE="$(aws ecs describe-tasks \
  --cluster "$TASK_CLUSTER" \
  --tasks "$TASK_BOOTSTRAP_ARN" \
  --region "$TASK_REGION" \
  --query 'tasks[0].containers[?name==`topic-bootstrap`].exitCode | [0]' \
  --output text)"
if [[ "$TASK_BOOTSTRAP_EXIT_CODE" != "0" ]]; then
  echo "Kafka topic bootstrap failed (exit ${TASK_BOOTSTRAP_EXIT_CODE}). Inspect WorkerLogs." >&2
  exit 1
fi

TASK_ARN="$(aws ecs run-task \
  --cluster "$TASK_CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASK_API_DEFINITION" \
  --network-configuration "$TASK_NETWORK" \
  --overrides '{"containerOverrides":[{"name":"api","command":["alembic","upgrade","head"]}]}' \
  --region "$TASK_REGION" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "Migration task did not start. Inspect the ECS task failure reason." >&2
  exit 1
fi
aws ecs wait tasks-stopped --cluster "$TASK_CLUSTER" --tasks "$TASK_ARN" --region "$TASK_REGION"
TASK_EXIT_CODE="$(aws ecs describe-tasks \
  --cluster "$TASK_CLUSTER" \
  --tasks "$TASK_ARN" \
  --region "$TASK_REGION" \
  --query 'tasks[0].containers[?name==`api`].exitCode | [0]' \
  --output text)"
if [[ "$TASK_EXIT_CODE" != "0" ]]; then
  echo "Migration task failed (exit ${TASK_EXIT_CODE}). Inspect the ApiLogs CloudWatch group." >&2
  exit 1
fi

../node_modules/.bin/cdk deploy "$TASK_STACK" \
  --require-approval never \
  --parameters ApiImageUri="$TASK_API_IMAGE" \
  --parameters DashboardImageUri="$TASK_DASHBOARD_IMAGE" \
  --parameters DeployServices=true

TASK_DASHBOARD_URL="$(task_output DashboardUrl)"
TASK_API_BASE_URL="$(task_output ApiBaseUrl)"
TASK_COGNITO_DOMAIN="$(task_output CognitoDomain)"
TASK_COGNITO_MOBILE_CLIENT_ID="$(task_output CognitoMobileClientId)"
echo "RepCoach is deployed: ${TASK_DASHBOARD_URL}"
echo "Expo public configuration:"
echo "  EXPO_PUBLIC_API_BASE_URL=${TASK_API_BASE_URL}"
echo "  EXPO_PUBLIC_COGNITO_DOMAIN=${TASK_COGNITO_DOMAIN}"
echo "  EXPO_PUBLIC_COGNITO_CLIENT_ID=${TASK_COGNITO_MOBILE_CLIENT_ID}"
echo "  EXPO_PUBLIC_COGNITO_REDIRECT_URI=repcoach://auth/callback"
echo "Set provider secrets using: aws secretsmanager put-secret-value --secret-id $(task_output IntegrationSecretArn) --secret-string file://..."
