import { registerRootComponent } from "expo";

import App from "./App";

// Keep the Expo entrypoint inside this workspace. `expo/AppEntry` resolves
// relative to a hoisted node_modules directory in a monorepo and can otherwise
// look for a nonexistent repository-root App file during EAS builds.
registerRootComponent(App);
