# Projects and daily workflows

Repellet keeps the container lifecycle, dependency preparation, app process, and HTTP readiness separate. A healthy editor remains usable after a dependency installation fails.

## Starters

Choose **HTML / CSS / JavaScript**, **React / Vite / TypeScript**, or **Python / FastAPI** under Project source. Repellet builds or reuses the runtime environment and writes version 1 of the bundled files without overwriting existing files. Static HTML has no dependency installation. React uses the committed npm lockfile; Python installs pinned requirements into `.venv`. The app stays stopped until **Run**.

The HTML starter opens `index.html` and includes `style.css` and a browser JavaScript module, `script.js`. Click **Run** to serve the project on `0.0.0.0:3000` using the bundled server. Saved changes automatically refresh the private iframe and previews opened in another tab, including collaborator edits and terminal changes. The server injects its reload script into HTTP responses without editing your files. Page policies that block the script, or HTML files larger than 2 MiB, require manual preview refresh.

Static sites support ordinary relative URLs, nested HTML pages, and directory `index.html` files. Missing resources return 404; directory listings and SPA fallback routing are disabled. Hidden files and symlinks outside the serving directory are blocked. `/__repellet_static__/` is reserved for reload connections, which use the existing authenticated preview gateway. Runtime environment secrets and bridge routes are not exposed by the static server.

For an imported or uploaded static site, inspect the desired working directory under **Run & setup** and apply the suggestions. An `index.html` without a supported application manifest suggests the bundled server with no setup command. Framework manifests take precedence. Use **Working directory** to serve a subfolder; if changing **Preview port**, also update the run command's `--port` argument. Import inspection and confirmation do not start the app or overwrite files.

React listens on `0.0.0.0:3000` with a strict port and accepts the installation hostname. FastAPI listens on `0.0.0.0:8000` with reload enabled. The initial tab is `src/App.tsx` or `main.py`. Edit, wait for autosave, and view the preview; Python may need a preview refresh after its reload.

Preparation logs are available in the workspace banner and `GET /api/projects/:id/preparation`. Each job records bounded output, step outcomes, and start/finish timestamps. Runtime builds are separate `start`/`rebuild` jobs, so cold builds can be measured independently from cached dependency preparation. Dependency fingerprints prevent reinstalling unchanged prepared projects. Changing dependency manifests requires **Retry preparation** before Run; the server independently enforces this check.

Failed installations preserve the workspace for troubleshooting. **Retry preparation** repeats dependency installation and skips completed scaffolding. **Stop workspace** cancels preparation and stops app/terminal processes. Interrupted preparation after an API restart is marked retryable; installation is never silently resumed. Reopen the workspace and explicitly retry. If the worker/container restarts, Run must be clicked again to start the app.

Run waits for open-document acknowledgements, flushes saved server documents, and replaces the previous process only after it has exited. The Run terminal retains app output. Readiness checks the actual HTTP target through the worker and sends no IDE credentials to the app. These checks do not update idle activity. HTTP errors still render with a warning. After 60 seconds without a response, troubleshooting guidance appears and the app remains running; **Retry readiness** checks again.

Project badges show **Running** only while the main Run app process is verified alive, and **Idle** otherwise. An open workspace, terminals, tasks, and additional services do not count. HTTP readiness is separate: a live app still counts while its preview is starting or has timed out. Workspace startup progress and errors remain available in their existing views.

Duplicating a project copies files, preparation and Run settings, and starter provenance. It skips scaffolding and never copies a member's GitHub connection or a project repository link. A ready duplicate can reuse copied dependencies. Existing projects keep their files and commands and have no automatic dependency setup.

## Workspace preferences and open files

`Cmd/Ctrl+P` opens a file by relative path. The bridge index excludes Git metadata, dependencies, build output, caches, and symlinks, and returns at most 20,000 paths. The normal file-opening checks still reject binary and oversized editor files.

Tabs, active file, cursor and scroll position, sidebar selection/visibility, terminal selection, preview/terminal visibility, and panel dimensions are stored in version 1 browser-local preferences. The key includes installation origin, authenticated user ID, and project ID. No file contents, secrets, or credentials are stored. Refresh restores existing accessible text files; moves/deletes update open tabs. Dimensions are clamped to the viewport. The terminal is selected only if its session still exists. Preferences are private to each collaborator and browser; changing the installation origin starts a new preference scope.

**Open files** groups current diagnostics by file and severity. Selecting a problem opens its location. Open models and document subscriptions survive active-tab changes. One language connection per runtime handles all open documents; reconnect clears stale diagnostics and resends documents. Closing, moving, and deleting tabs clears their old diagnostics. Service availability is shown explicitly. Use terminals for full-project lint/type checks.

## GitHub App setup

The instance owner opens **GitHub** and registers one app through the manifest flow. Choose a personal account or specify an organization. The app is public so invited members can install it on their own accounts; Repellet itself stays invite-only. Only repository **Contents read/write** and **Metadata read** are requested. Webhooks and public inbound server access are unnecessary. Browser callback URLs must be reachable by the person authorizing the app.

For manual setup, create the app on GitHub, disable webhooks, allow installation on member accounts, enable expiring user tokens, and set the user authorization callback to:

```
https://YOUR-REPELLET-ORIGIN/api/github/callback/authorize
```

Enter the App ID, slug, Client ID, client secret, and RSA PEM private key in the owner screen. These secrets and each member's access/refresh tokens are encrypted with `ENCRYPTION_KEY`. Replacing the instance app disconnects existing connections. Preserve this key with backups. GitHub Enterprise, pull-request management, and workflow-file writes are outside this release.

Each member connects their own GitHub account, installs the app if necessary, refreshes installations, and selects one. Repository discovery is the intersection of that user's access and the app installation's repositories. Authorization state expires after ten minutes, is bound to the initiating Repellet account, and can be consumed once. The callback landing page completes through an authenticated same-origin POST, preserving the existing Strict session cookie. If the session expired, sign in and begin authorization again.

Choose **GitHub repository** during project creation. Manifests can suggest runtimes before import. After cloning, open **Project settings → Repository setup**, inspect manifests in the root or an explicitly selected working directory, optionally apply suggestions, review editable commands/port, and click **Confirm and prepare**. Add missing runtimes under Environment first. Run remains explicit. Suggestions never replace saved settings automatically; unsupported package managers and ambiguous entrypoints require manual commands. Imported projects start with an empty Run command until an owner saves commands.

To connect an existing repository, set its single origin fetch/push URL to the exact GitHub HTTPS clone URL in the terminal, then select the matching repository in Repository setup. SSH and other remotes keep manual terminal credentials.

Pull/push validate Repellet permissions and GitHub access independently for the acting user. A short-lived operation-scoped credential helper supplies a token only to the validated GitHub host and repository path. Tokens are never written to URLs, Git configuration, shared terminal environments, or logs. Redirects are disabled. UI remote operations disable Git hooks while credentials are present. Shared terminals receive no automatic GitHub credentials. Users without GitHub access can edit/commit locally; remote operations explain missing access or reconnection.

The Git pane lists local and remote branches, upstream and ahead/behind counts, and separate staged/unstaged changes. Each change opens a read-only Monaco comparison; files with both index and working-tree changes have both comparisons. First push establishes upstream. Pull stays fast-forward-only; divergence, conflicts, protected branches, and force pushes remain terminal workflows. UI commits use the connected GitHub user's public identity/noreply email, falling back to Repellet identity.

## Recovery and rollout

Migrations 0002–0004 are additive. Static HTML support needs no additional migration. The bridge base image advances to 0.3.0 so new runtime images include the bundled static server. Running containers retain their previous image: stop the **workspace**, then use **Start workspace** to rebuild its environment with the updated bridge before using the bundled server in an existing project. Stopping only the app does not update the container. Project files and home configuration are preserved. Apply database migrations with the normal API startup workflow. Back up the database, workspace/home volumes, and installation environment before upgrading. Encrypted GitHub configuration/connections and durable jobs are in the database dump; the environment backup supplies the matching encryption key. Restored expired access tokens refresh under a database row lock. Expired/revoked refresh authorization requests reconnection.

Validate and release milestones in order: starter loops/recovery, workspace restoration/diagnostics, then GitHub setup/permissions and Git controls. Before enabling GitHub for members, run the live two-user smoke procedure below. Keep existing projects unprepared until their owners opt in.

### Disposable live smoke procedure

This procedure requires a real configured app, a disposable private repository, and two connected Repellet users. The automated fake-service checks do not count as a live GitHub test.

1. Install the app for a private repository with a `package.json`/npm lockfile. Give user A write access and user B read access. Connect both users independently.
2. Import as A, confirm setup, prepare, Run, and verify preview. Commit an edit using the Git pane and push; verify its GitHub author and upstream. Pull a second fast-forward commit.
3. Share the Repellet project with B as an editor. Confirm B can edit/commit locally and pull, but push is denied with useful permission details. Confirm unrelated repositories/installations do not appear.
4. Revoke B's GitHub authorization. Check that repository discovery/remote operations request reconnection while local work remains usable. Reconnect B and repeat discovery.
5. Change origin to a different repository/host in the terminal. Check that UI remote operations refuse credentials. Restore origin and reconnect its matching repository.
6. Stop during a long setup, restart the API, and verify interrupted preparation requires an explicit retry. Back up/restore the installation and confirm expired user tokens refresh or request reconnection.
7. Record date, platform, app/repository IDs (without secrets), users/roles, job durations, outcomes, and GitHub commit URLs. Delete the disposable repository and revoke test authorizations after the operator completes validation.

Live smoke execution is pending in this workspace: no real GitHub App credentials or designated disposable repository/two authorized accounts were supplied.
