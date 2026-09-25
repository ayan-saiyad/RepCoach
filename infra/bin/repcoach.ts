#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { RepCoachStack } from "../lib/repcoach-stack";

const app = new cdk.App();
const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";

// The stack owns a CloudFront-scoped WAF web ACL. Keeping the complete first
// release in us-east-1 avoids a cross-region split solely for that global
// resource and matches the documented deployment command.
if (region !== "us-east-1") {
  throw new Error("RepCoachProduction currently deploys only to us-east-1.");
}

new RepCoachStack(app, "RepCoachProduction", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Production-ready AWS deployment for RepCoach.",
});
