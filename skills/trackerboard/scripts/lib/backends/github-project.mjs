import { registerBackendFactory } from "../backend.mjs";
import { createGitHubClient } from "./github-project-core.mjs";
import { createGitHubProjectBackend } from "./github-project-backend.mjs";

export { createGitHubClient, MAX_GITHUB_BYTES, MIN_GH_VERSION, verifyGitHubCli } from "./github-project-core.mjs";
export { createGitHubProjectBackend } from "./github-project-backend.mjs";

registerBackendFactory("github", {
  // GitHub is opt-in. Store initialization runs every adapter factory, so the
  // CLI/auth/capability checks stay lazy until a GitHub backend operation.
  initialize() {},
  open(context) {
    const executable = context?.config?.github?.executable || process.env.TRACKERBOARD_GH || "gh";
    return createGitHubProjectBackend(context, createGitHubClient(executable));
  },
});
