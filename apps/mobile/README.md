# RepCoach mobile authentication

The Expo client uses Cognito's OAuth authorization-code flow with PKCE. The
native bundle contains only public OAuth metadata; access, ID, and refresh
tokens are stored with `expo-secure-store` in the device credential store.

## Build configuration

Set the following **public** EAS variables for preview and production builds:

```text
EXPO_PUBLIC_API_BASE_URL=https://your-public-api-origin
EXPO_PUBLIC_COGNITO_DOMAIN=https://your-domain.auth.us-east-1.amazoncognito.com
EXPO_PUBLIC_COGNITO_CLIENT_ID=your-mobile-public-client-id
EXPO_PUBLIC_COGNITO_REDIRECT_URI=repcoach://auth/callback
EXPO_PUBLIC_COGNITO_SCOPES=openid profile email
```

The Cognito app client must enable the authorization-code grant, have no client
secret, and allow `repcoach://auth/callback` as both a callback and sign-out
URL. The API—not the mobile client—verifies each bearer token and authorizes
the Cognito `sub` used in a workout request.

`EXPO_PUBLIC_DEMO_MODE=true` enables the deterministic pose replay only in an
Expo development build. Preview and production builds ignore it and do not
present replayed measurements as a live camera workout.

## Required install

From the monorepo root, refresh the lockfile after this package manifest change:

```bash
npm install
```

Then validate the client:

```bash
npm run mobile:typecheck
```
