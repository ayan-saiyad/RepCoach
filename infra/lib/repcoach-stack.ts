import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as msk from "aws-cdk-lib/aws-msk";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

const tags = {
  Application: "RepCoach",
  Environment: "production",
  ManagedBy: "cdk",
};

/**
 * An intentionally complete, parameterized AWS deployment.
 *
 * The first deploy is a bootstrap deploy with DeployServices=false. That creates
 * durable infrastructure and ECR repositories without trying to start placeholder
 * images. The deploy script then publishes immutable images, runs the migration
 * task, and enables the three Fargate services.
 */
export class RepCoachStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const apiImageUri = new cdk.CfnParameter(this, "ApiImageUri", {
      type: "String",
      default: "public.ecr.aws/docker/library/alpine:3.20",
      description: "Immutable backend image URI. The bootstrap deploy leaves services disabled.",
    });
    const dashboardImageUri = new cdk.CfnParameter(this, "DashboardImageUri", {
      type: "String",
      default: "public.ecr.aws/docker/library/alpine:3.20",
      description: "Immutable dashboard image URI. The bootstrap deploy leaves services disabled.",
    });
    const deployServices = new cdk.CfnParameter(this, "DeployServices", {
      type: "String",
      allowedValues: ["true", "false"],
      default: "false",
      description: "Set true only after immutable images have been pushed to the output ECR repositories.",
    });
    const servicesEnabled = new cdk.CfnCondition(this, "ServicesEnabled", {
      expression: cdk.Fn.conditionEquals(deployServices.valueAsString, "true"),
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "application", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    cdk.Tags.of(vpc).add("Name", "repcoach-production");

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", {
      vpc,
      description: "Allows public HTTP only; CloudFront is the supported public endpoint.",
      allowAllOutbound: true,
    });
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP from CloudFront viewers");

    const apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc,
      description: "API tasks accept traffic only from the load balancer.",
      allowAllOutbound: true,
    });
    apiSecurityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(8000), "ALB to API");

    const dashboardSecurityGroup = new ec2.SecurityGroup(this, "DashboardSecurityGroup", {
      vpc,
      description: "Dashboard tasks accept traffic only from the load balancer.",
      allowAllOutbound: true,
    });
    dashboardSecurityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(3000), "ALB to dashboard");

    const workerSecurityGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
      vpc,
      description: "Workers have no inbound network surface.",
      allowAllOutbound: true,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      description: "PostgreSQL accepts application and worker connections only.",
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(5432), "API to PostgreSQL");
    databaseSecurityGroup.addIngressRule(workerSecurityGroup, ec2.Port.tcp(5432), "Worker to PostgreSQL");

    const cacheSecurityGroup = new ec2.SecurityGroup(this, "CacheSecurityGroup", {
      vpc,
      description: "Valkey accepts application and worker connections only.",
      allowAllOutbound: false,
    });
    cacheSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(6379), "API to Valkey");
    cacheSecurityGroup.addIngressRule(workerSecurityGroup, ec2.Port.tcp(6379), "Worker to Valkey");

    const kafkaSecurityGroup = new ec2.SecurityGroup(this, "KafkaSecurityGroup", {
      vpc,
      description: "MSK Serverless accepts TLS/IAM clients only from workers.",
      allowAllOutbound: false,
    });
    kafkaSecurityGroup.addIngressRule(workerSecurityGroup, ec2.Port.tcp(9098), "Worker to MSK IAM endpoint");

    const apiRepository = new ecr.Repository(this, "ApiRepository", {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 30, description: "Keep the latest 30 immutable releases." }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const dashboardRepository = new ecr.Repository(this, "DashboardRepository", {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 30, description: "Keep the latest 30 immutable releases." }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      databaseName: "repcoach",
      credentials: rds.Credentials.fromGeneratedSecret("repcoach"),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      deleteAutomatedBackups: false,
      cloudwatchLogsExports: ["postgresql", "upgrade"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    const cache = new elasticache.CfnServerlessCache(this, "Cache", {
      engine: "valkey",
      majorEngineVersion: "7",
      serverlessCacheName: "repcoach-production",
      description: "Encrypted RepCoach response cache.",
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      securityGroupIds: [cacheSecurityGroup.securityGroupId],
      cacheUsageLimits: {
        dataStorage: { maximum: 2, unit: "GB" },
        ecpuPerSecond: { maximum: 5000 },
      },
      snapshotRetentionLimit: 7,
      dailySnapshotTime: "05:00",
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });

    const kafkaCluster = new msk.CfnServerlessCluster(this, "Kafka", {
      clusterName: "repcoach-production",
      clientAuthentication: { sasl: { iam: { enabled: true } } },
      vpcConfigs: [{
        subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
        securityGroups: [kafkaSecurityGroup.securityGroupId],
      }],
      tags,
    });

    const kafkaBootstrap = new cr.AwsCustomResource(this, "KafkaBootstrapBrokers", {
      // Lambda's supported Node runtimes include the AWS SDK. Avoid an
      // unpinned npm install during a production CloudFormation deployment.
      installLatestAwsSdk: false,
      onCreate: {
        service: "Kafka",
        action: "getBootstrapBrokers",
        parameters: { ClusterArn: kafkaCluster.attrArn },
        physicalResourceId: cr.PhysicalResourceId.of(`${kafkaCluster.attrArn}:bootstrap-brokers`),
      },
      onUpdate: {
        service: "Kafka",
        action: "getBootstrapBrokers",
        parameters: { ClusterArn: kafkaCluster.attrArn },
        physicalResourceId: cr.PhysicalResourceId.of(`${kafkaCluster.attrArn}:bootstrap-brokers`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [kafkaCluster.attrArn],
      }),
    });
    kafkaBootstrap.node.addDependency(kafkaCluster);

    const edgeOriginSecret = new secretsmanager.Secret(this, "EdgeOriginSecret", {
      description: "CloudFront-to-RepCoach API origin verification secret.",
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    const integrationSecret = new secretsmanager.Secret(this, "IntegrationSecret", {
      description: "Server-only optional provider credentials for RepCoach.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          bedrock_model_id: "",
          bedrock_embedding_model_id: "",
          stripe_secret_key: "",
          stripe_webhook_secret: "",
          stripe_price_pro: "",
          twilio_account_sid: "",
          twilio_auth_token: "",
          twilio_from_number: "",
        }),
        generateStringKey: "bootstrap_nonce",
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const workerLogs = new logs.LogGroup(this, "WorkerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const dashboardLogs = new logs.LogGroup(this, "DashboardLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const userPoolDomain = userPool.addDomain("HostedUiDomain", {
      cognitoDomain: { domainPrefix: `repcoach-${this.account}` },
    });

    const apiTaskRole = new iam.Role(this, "ApiTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Least-privilege application permissions for RepCoach API tasks.",
    });
    apiTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:Converse"],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": this.region } },
    }));

    const workerTaskRole = new iam.Role(this, "WorkerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Kafka and data permissions for RepCoach analysis workers.",
    });
    const topicBootstrapTaskRole = new iam.Role(this, "TopicBootstrapTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "One-shot, least-privilege Kafka topic provisioner for RepCoach.",
    });
    const mskTopicArn = this.formatArn({
      service: "kafka",
      resource: "topic",
      resourceName: "repcoach-production/*/*",
    });
    const mskGroupArn = this.formatArn({
      service: "kafka",
      resource: "group",
      resourceName: "repcoach-production/*/*",
    });
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"],
      resources: [kafkaCluster.attrArn],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:ReadData",
        "kafka-cluster:WriteData",
      ],
      resources: [mskTopicArn],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["kafka-cluster:DescribeGroup", "kafka-cluster:AlterGroup"],
      resources: [mskGroupArn],
    }));
    topicBootstrapTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"],
      resources: [kafkaCluster.attrArn],
    }));
    topicBootstrapTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["kafka-cluster:CreateTopic", "kafka-cluster:DescribeTopic"],
      resources: [mskTopicArn],
    }));

    const apiExecutionRole = new iam.Role(this, "ApiExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });
    const workerExecutionRole = new iam.Role(this, "WorkerExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });

    const commonSecrets = {
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
      EDGE_ORIGIN_TOKEN: ecs.Secret.fromSecretsManager(edgeOriginSecret),
      BEDROCK_MODEL_ID: ecs.Secret.fromSecretsManager(integrationSecret, "bedrock_model_id"),
      BEDROCK_EMBEDDING_MODEL_ID: ecs.Secret.fromSecretsManager(integrationSecret, "bedrock_embedding_model_id"),
      STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(integrationSecret, "stripe_secret_key"),
      STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(integrationSecret, "stripe_webhook_secret"),
      STRIPE_PRICE_PRO: ecs.Secret.fromSecretsManager(integrationSecret, "stripe_price_pro"),
      TWILIO_ACCOUNT_SID: ecs.Secret.fromSecretsManager(integrationSecret, "twilio_account_sid"),
      TWILIO_AUTH_TOKEN: ecs.Secret.fromSecretsManager(integrationSecret, "twilio_auth_token"),
      TWILIO_FROM_NUMBER: ecs.Secret.fromSecretsManager(integrationSecret, "twilio_from_number"),
    };

    const commonEnvironment = {
      APP_ENV: "production",
      AUTO_CREATE_SCHEMA: "false",
      DATABASE_HOST: database.dbInstanceEndpointAddress,
      DATABASE_PORT: database.dbInstanceEndpointPort,
      DATABASE_NAME: "repcoach",
      DATABASE_USER: "repcoach",
      // Settings parses this as a boolean and configures asyncpg with the
      // platform trust store. RDS enforces encrypted connections at rest and
      // the task connects over TLS without embedding a DSN in the template.
      DATABASE_SSL: "true",
      REDIS_HOST: cache.attrEndpointAddress,
      REDIS_PORT: "6379",
      REDIS_SSL: "true",
      KAFKA_BOOTSTRAP_SERVERS: kafkaBootstrap.getResponseField("BootstrapBrokerStringSaslIam"),
      KAFKA_AUTH_MODE: "msk_iam",
      KAFKA_AWS_REGION: this.region,
      AUTH_DISABLED: "false",
      COGNITO_REGION: this.region,
      COGNITO_USER_POOL_ID: userPool.userPoolId,
      COGNITO_APP_CLIENT_ID: "configured-after-distribution",
      CORS_ORIGINS: "",
      EDGE_ORIGIN_REQUIRED: "true",
      LOG_LEVEL: "INFO",
      RUN_MIGRATIONS: "false",
    };

    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: apiTaskRole,
      executionRole: apiExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    database.secret!.grantRead(apiTask.executionRole!);
    edgeOriginSecret.grantRead(apiTask.executionRole!);
    integrationSecret.grantRead(apiTask.executionRole!);
    const apiContainer = apiTask.addContainer("api", {
      image: ecs.ContainerImage.fromRegistry(apiImageUri.valueAsString),
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: "api" }),
      environment: commonEnvironment,
      secrets: commonSecrets,
      healthCheck: {
        command: ["CMD-SHELL", "python -c \"from urllib.request import urlopen; urlopen('http://localhost:8000/readyz')\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    apiContainer.addPortMappings({ containerPort: 8000 });

    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: workerTaskRole,
      executionRole: workerExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    database.secret!.grantRead(workerTask.executionRole!);
    edgeOriginSecret.grantRead(workerTask.executionRole!);
    integrationSecret.grantRead(workerTask.executionRole!);
    const workerContainer = workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromRegistry(apiImageUri.valueAsString),
      command: ["python", "-m", "worker.main"],
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: "worker" }),
      environment: commonEnvironment,
      secrets: commonSecrets,
    });

    const topicBootstrapTask = new ecs.FargateTaskDefinition(this, "TopicBootstrapTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: topicBootstrapTaskRole,
      executionRole: workerExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    topicBootstrapTask.addContainer("topic-bootstrap", {
      image: ecs.ContainerImage.fromRegistry(apiImageUri.valueAsString),
      command: ["python", "-m", "worker.bootstrap_topics"],
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: "topic-bootstrap" }),
      environment: {
        APP_ENV: "production",
        LOG_LEVEL: "INFO",
        RUN_MIGRATIONS: "false",
        KAFKA_BOOTSTRAP_SERVERS: kafkaBootstrap.getResponseField("BootstrapBrokerStringSaslIam"),
        KAFKA_AUTH_MODE: "msk_iam",
        KAFKA_AWS_REGION: this.region,
      },
    });

    const dashboardTask = new ecs.FargateTaskDefinition(this, "DashboardTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const dashboardContainer = dashboardTask.addContainer("dashboard", {
      image: ecs.ContainerImage.fromRegistry(dashboardImageUri.valueAsString),
      logging: ecs.LogDrivers.awsLogs({ logGroup: dashboardLogs, streamPrefix: "dashboard" }),
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        COGNITO_REGION: this.region,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: "configured-after-distribution",
        COGNITO_DOMAIN: userPoolDomain.baseUrl(),
      },
      healthCheck: {
        command: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    dashboardContainer.addPortMappings({ containerPort: 3000 });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      securityGroup: loadBalancerSecurityGroup,
      dropInvalidHeaderFields: true,
    });
    const apiTargets = new elbv2.ApplicationTargetGroup(this, "ApiTargets", {
      vpc,
      targetType: elbv2.TargetType.IP,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: { path: "/readyz", healthyHttpCodes: "200" },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const dashboardTargets = new elbv2.ApplicationTargetGroup(this, "DashboardTargets", {
      vpc,
      targetType: elbv2.TargetType.IP,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: { path: "/healthz", healthyHttpCodes: "200" },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const listener = loadBalancer.addListener("HttpListener", { port: 80, defaultTargetGroups: [dashboardTargets] });
    listener.addTargetGroups("ApiRoutes", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/v1/*", "/health", "/livez", "/readyz", "/docs*"])],
      targetGroups: [apiTargets],
    });
    listener.addTargetGroups("ApiSchemaRoutes", {
      priority: 11,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/openapi.json", "/redoc*"])],
      targetGroups: [apiTargets],
    });

    const origin = new cloudfrontOrigins.LoadBalancerV2Origin(loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { "X-RepCoach-Origin": edgeOriginSecret.secretValue.unsafeUnwrap() },
    });
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, "ResponseHeaders", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: responseHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      enableLogging: true,
      logBucket: new cdk.aws_s3.Bucket(this, "DistributionLogs", {
        encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
        // Standard CloudFront access logs are delivered with an ACL. CDK's
        // CloudFront construct requires ObjectWriter for a supplied log bucket.
        objectOwnership: cdk.aws_s3.ObjectOwnership.OBJECT_WRITER,
        enforceSSL: true,
        lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
    });

    const userPoolClient = userPool.addClient("WebClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true, userPassword: false, adminUserPassword: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${distribution.domainName}/api/auth/callback`],
        logoutUrls: [`https://${distribution.domainName}/`],
      },
    });
    // Mobile apps use their own public OAuth client so a native redirect can
    // be constrained without widening the dashboard client's allow-list.
    // Authorization-code + PKCE keeps this safe even though native clients
    // cannot protect a client secret.
    const mobileUserPoolClient = userPool.addClient("MobileClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true, userPassword: false, adminUserPassword: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["repcoach://auth/callback"],
        logoutUrls: ["repcoach://auth/callback"],
      },
    });
    // The app/worker task definitions are constructed before CloudFront and the
    // callback-aware client. Replace their placeholder values once the client
    // exists rather than hard-coding its ID into source or a container image.
    apiContainer.addEnvironment("COGNITO_APP_CLIENT_ID", userPoolClient.userPoolClientId);
    apiContainer.addEnvironment(
      "COGNITO_APP_CLIENT_IDS",
      cdk.Fn.join(",", [userPoolClient.userPoolClientId, mobileUserPoolClient.userPoolClientId]),
    );
    workerContainer.addEnvironment("COGNITO_APP_CLIENT_ID", userPoolClient.userPoolClientId);
    dashboardContainer.addEnvironment("COGNITO_CLIENT_ID", userPoolClient.userPoolClientId);
    dashboardContainer.addEnvironment("APP_ENV", "production");
    // The dashboard's server-side BFF reaches the same canonical CloudFront
    // endpoint that browsers use. CloudFront adds the edge-origin header, so
    // the browser never receives that shared secret.
    dashboardContainer.addEnvironment("DASHBOARD_API_BASE_URL", `https://${distribution.domainName}`);
    dashboardContainer.addEnvironment("DASHBOARD_ORIGIN", `https://${distribution.domainName}`);
    dashboardContainer.addEnvironment(
      "COGNITO_REDIRECT_URI",
      `https://${distribution.domainName}/api/auth/callback`,
    );
    dashboardContainer.addEnvironment("COGNITO_LOGOUT_URI", `https://${distribution.domainName}/`);

    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "repcoach-web-acl",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSCommonRules",
          priority: 0,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "aws-common", sampledRequestsEnabled: true },
        },
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          statement: { rateBasedStatement: { aggregateKeyType: "IP", limit: 1500 } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "rate-limit", sampledRequestsEnabled: true },
        },
      ],
    });
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride("DistributionConfig.WebACLId", webAcl.attrArn);

    const apiService = new ecs.CfnService(this, "ApiService", {
      cluster: cluster.clusterArn,
      desiredCount: 1,
      enableExecuteCommand: true,
      launchType: "FARGATE",
      taskDefinition: apiTask.taskDefinitionArn,
      healthCheckGracePeriodSeconds: 90,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
        maximumPercent: 200,
        minimumHealthyPercent: 100,
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "DISABLED",
          securityGroups: [apiSecurityGroup.securityGroupId],
          subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        },
      },
      loadBalancers: [{
        containerName: apiContainer.containerName,
        containerPort: 8000,
        targetGroupArn: apiTargets.targetGroupArn,
      }],
      propagateTags: "SERVICE",
      enableEcsManagedTags: true,
    });
    apiService.cfnOptions.condition = servicesEnabled;
    apiService.addResourceDependency(listener.node.defaultChild as cdk.CfnResource);

    const workerService = new ecs.CfnService(this, "WorkerService", {
      cluster: cluster.clusterArn,
      desiredCount: 1,
      enableExecuteCommand: true,
      launchType: "FARGATE",
      taskDefinition: workerTask.taskDefinitionArn,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
        maximumPercent: 200,
        minimumHealthyPercent: 100,
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "DISABLED",
          securityGroups: [workerSecurityGroup.securityGroupId],
          subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        },
      },
      propagateTags: "SERVICE",
      enableEcsManagedTags: true,
    });
    workerService.cfnOptions.condition = servicesEnabled;

    const dashboardService = new ecs.CfnService(this, "DashboardService", {
      cluster: cluster.clusterArn,
      desiredCount: 1,
      launchType: "FARGATE",
      taskDefinition: dashboardTask.taskDefinitionArn,
      healthCheckGracePeriodSeconds: 90,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
        maximumPercent: 200,
        minimumHealthyPercent: 100,
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "DISABLED",
          securityGroups: [dashboardSecurityGroup.securityGroupId],
          subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        },
      },
      loadBalancers: [{
        containerName: dashboardContainer.containerName,
        containerPort: 3000,
        targetGroupArn: dashboardTargets.targetGroupArn,
      }],
      propagateTags: "SERVICE",
      enableEcsManagedTags: true,
    });
    dashboardService.cfnOptions.condition = servicesEnabled;
    dashboardService.addResourceDependency(listener.node.defaultChild as cdk.CfnResource);

    const api5xxAlarm = new cloudwatch.Alarm(this, "Api5xxAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApplicationELB",
        metricName: "HTTPCode_Target_5XX_Count",
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
        dimensionsMap: { TargetGroup: apiTargets.targetGroupFullName, LoadBalancer: loadBalancer.loadBalancerFullName },
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubProvider",
      `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const githubDeployRole = new iam.Role(this, "GitHubDeployRole", {
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        // Manual/main-branch jobs use the ref subject. The deploy workflow is
        // additionally bound to GitHub's protected `production` environment,
        // which changes the standard OIDC subject to the environment form.
        StringLike: {
          "token.actions.githubusercontent.com:sub": [
            "repo:ayan-saiyad/RepCoach:ref:refs/heads/main",
            "repo:ayan-saiyad/RepCoach:environment:production",
          ],
        },
      }),
      description: "GitHub Actions deploy role constrained to RepCoach main.",
    });
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*-deploy-role-${this.account}-${this.region}`, `arn:${this.partition}:iam::${this.account}:role/cdk-*-file-publishing-role-${this.account}-${this.region}`, `arn:${this.partition}:iam::${this.account}:role/cdk-*-image-publishing-role-${this.account}-${this.region}`, `arn:${this.partition}:iam::${this.account}:role/cdk-*-lookup-role-${this.account}-${this.region}`],
    }));
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }));
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeImages",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
      ],
      resources: [apiRepository.repositoryArn, dashboardRepository.repositoryArn],
    }));
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks"],
      resources: [
        this.formatArn({
          service: "cloudformation",
          resource: "stack",
          resourceName: `${this.stackName}/*`,
        }),
      ],
    }));
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: [apiTask.taskDefinitionArn, topicBootstrapTask.taskDefinitionArn],
      conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
    }));
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ecs:DescribeTasks"],
      resources: ["*"],
    }));
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [
        apiTask.executionRole!.roleArn,
        apiTask.taskRole.roleArn,
        topicBootstrapTask.executionRole!.roleArn,
        topicBootstrapTask.taskRole.roleArn,
      ],
    }));

    for (const [key, value] of Object.entries(tags)) cdk.Tags.of(this).add(key, value);

    new cdk.CfnOutput(this, "DashboardUrl", { value: `https://${distribution.domainName}` });
    new cdk.CfnOutput(this, "ApiBaseUrl", { value: `https://${distribution.domainName}` });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, "ApiRepositoryUri", { value: apiRepository.repositoryUri });
    new cdk.CfnOutput(this, "DashboardRepositoryUri", { value: dashboardRepository.repositoryUri });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "ApiTaskDefinitionArn", { value: apiTask.taskDefinitionArn });
    new cdk.CfnOutput(this, "WorkerTaskDefinitionArn", { value: workerTask.taskDefinitionArn });
    new cdk.CfnOutput(this, "TopicBootstrapTaskDefinitionArn", {
      value: topicBootstrapTask.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, "PrivateApplicationSubnetIds", { value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(",") });
    new cdk.CfnOutput(this, "ApiSecurityGroupId", { value: apiSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, "WorkerSecurityGroupId", { value: workerSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "CognitoClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "CognitoMobileClientId", {
      value: mobileUserPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "CognitoDomain", { value: userPoolDomain.baseUrl() });
    new cdk.CfnOutput(this, "IntegrationSecretArn", { value: integrationSecret.secretArn });
    new cdk.CfnOutput(this, "GitHubDeployRoleArn", { value: githubDeployRole.roleArn });
    new cdk.CfnOutput(this, "Api5xxAlarmName", { value: api5xxAlarm.alarmName });
  }
}
