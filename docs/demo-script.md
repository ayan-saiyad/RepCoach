# RepCoach demo script

This is a four-minute, no-cloud-credentials demo of the product’s core engineering path.

## Prepare

```bash
cp .env.example .env
docker compose up --build
```

Wait for the `api` health check, then start the dashboard and Expo app from a second terminal.

```bash
npm install
npm run dashboard:dev
npm run mobile:dev
```

Optional: preload a history for the dashboard before the first mobile set.

```bash
docker compose exec api python -m app.scripts.seed_demo
```

For a physical phone, set `EXPO_PUBLIC_API_BASE_URL` to your development machine’s HTTPS or LAN address before starting Expo.

## Walkthrough

1. Open the **Coach** tab in Expo and press **Start demo set**. The replayed landmark sequence drives the same hysteresis-based rep engine used by the backend.
2. Watch the phase change from standing to descent, bottom, ascent, and completed. Each result card explains depth, knee tracking, torso position, tempo, and tracking confidence.
3. Complete the set. The app posts completed reps with stable idempotency keys; repeat a request and the API returns the original rep instead of double-counting it.
4. In the API container logs, point out the transactional outbox being published to `form-analysis.v1`, then the worker scoring it and emitting `form-analysis-results.v1`.
5. Open the web dashboard. It reads the API summary, displaying recent sets, rep-quality trend, and the one feedback pattern worth fixing next.
6. Ask the Coach panel a question such as “How should I improve my depth?” Without AWS credentials, it returns a cited, deterministic answer from stored coaching memory. With `BEDROCK_MODEL_ID` configured, the same endpoint upgrades to Bedrock Converse.

## Honest limits of the local demo

- The mobile app uses a replay source by default. Its `PoseProvider` is the seam for a native MediaPipe/Camera frame processor; raw video is never posted in this demo.
- The worker uses explainable rules until a trained PyTorch artifact is supplied with `FORM_MODEL_PATH`. Generate the synthetic pipeline artifact with `pip install -e '.[ml]'` then `python -m ml.train_form_classifier`—replace it with consented labeled data before any real deployment.
- Stripe Checkout and Twilio delivery stay in local simulation until server-only credentials are configured. Their routes and verified-provider adapters are implemented; no payment or SMS is attempted by default.
