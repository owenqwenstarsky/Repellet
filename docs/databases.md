# Development databases

Open **Database** using the database icon near the terminal and preview controls. It opens a tab beside Preview and Agent; closing the tab does not stop or delete the database. Its open state is saved per user and project.

Project owners can create one PostgreSQL 17 or MongoDB 8.0 database, retry startup, and delete it. Owners and editors can browse and modify data/schema; viewers have no Database access. Deleting a database permanently removes its data and connection variable. After deletion, create either engine to get a fresh database. Project duplication copies project files without databases or environment variables.

Each database uses its own container and persistent volume. A project-specific internal Docker network connects it to the workspace using a stable private hostname; database ports are not published. Containers start with the workspace and stop when it stops or sleeps. Data survives stop/start and environment rebuilds. A missing volume for a previously initialized database produces a failure instead of silently creating an empty replacement. Database failures leave the workspace usable and prevent automatic app startup until the database is ready.

Databases have a separate allowance of 1 CPU and 1 GiB memory. Their disk usage counts toward the existing monitored project storage limit. This is monitored storage, not a hard disk quota. Database commands and application connections can exceed it; monitor usage and remove data to recover. Backups include database volumes after containers are stopped. Restore recreates containers on the next workspace start using the recorded engine image and credentials. Backups from before this feature remain supported.

## Connection and environment variables

Creation saves an encrypted, protected `DATABASE_URL` containing the application connection. If that name already exists, rename or delete the existing variable first. Applications receive database-scoped credentials rather than an administrative account. Repellet's own installation-level `DATABASE_URL` remains separate.

In **Project settings → Environment**, rename the managed variable by editing its name and saving. Its value is read-only and its Remove control is disabled. Renaming also updates saved Run-profile environment selections. Deleting the database removes the variable under its current name; creating a replacement uses `DATABASE_URL` again.

Environment saves include a revision to reject stale edits. Use **Reload variables** after another user or an agent changes them. New terminals and restarted applications receive saved changes. Agent shell tools refresh variables before their next invocation. Existing application processes keep their original environment until restarted. A failed workspace synchronization retains canonical saved values; save/reload or restart the workspace to synchronize again.

## Data, schema, and commands

**Data** shows pages of 100 records and supports insertion, editing, and deletion. PostgreSQL updates/deletes require the complete primary key, including composite keys; use Console for tables without a primary key. New tables receive a generated bigint primary key. Visual insertion distinguishes database defaults, empty text, and NULL.

**Schema** creates/deletes tables or collections and adds, renames, or deletes PostgreSQL columns. Basic PostgreSQL types and nullability are supported. Use commands for advanced constraints, indexes, defaults, and migrations. Visual deletion requests confirmation and does not silently cascade dependencies.

**Console** accepts one SQL statement per request or a structured MongoDB command, for example `{"find":"users","filter":{},"limit":100}`. MongoDB documents and commands use Extended JSON to preserve ObjectIds, dates, and BSON numeric types. JavaScript evaluation is not supported. Commands run as database-scoped application users; cluster or server administration is not supported.

Queries have a 30-second deadline. Command results are capped at 1,000 records and 1 MiB; large fields or catalogs can produce a truncated response. After an uncertain write, inspect data before retrying. Console commands operate on development data and do not add production approval flows.

## Agent tools and compatibility

Agents have `database_status`, `database_schema`, `database_read`, and `database_execute`. The owner creates/deletes the database in the UI. Dedicated reads accept table/collection names, offsets, and field-equality filters. Execution accepts SQL with optional parameters or MongoDB Extended JSON commands.

`environment_list` returns names; `environment_get` retrieves a requested value. `environment_create`, `environment_update`, `environment_rename`, and `environment_delete` change saved project variables under the same protection rules as the UI. Plan mode allows database inspection and variable list/get while hiding and blocking mutations. Model-visible database output is limited to 64 KiB.

Workspace base image `repellet/workspace-base:0.7.0` includes the drivers and tools. Stop/start or rebuild older workspaces to install it. Migration `0006_project_databases.sql` adds database metadata and environment revisions without changing existing project variables. No real database, Docker, or browser validation is implied by the code-level tests.
