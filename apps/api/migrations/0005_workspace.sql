-- Additive migration: keep run_config and private agent histories readable by old clients.
ALTER TABLE documents ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE TABLE workspace_streams (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  retained_after bigint NOT NULL DEFAULT 0 CHECK (retained_after >= 0)
);
CREATE TABLE workspace_events (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  version integer NOT NULL DEFAULT 1,
  type text NOT NULL,
  actor jsonb,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, seq)
);
CREATE TABLE workspace_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor jsonb,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_activity_project_idx ON workspace_activity(project_id, created_at DESC);
CREATE TABLE project_preview_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_port integer NOT NULL CHECK(target_port BETWEEN 1024 AND 65535),
  allocated_port integer,
  status text NOT NULL DEFAULT 'stopped',
  http_status integer,
  last_probe timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE(project_id, name)
);
CREATE UNIQUE INDEX project_preview_default_idx ON project_preview_targets(project_id) WHERE is_default;
CREATE TABLE project_run_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  command text NOT NULL,
  cwd text NOT NULL DEFAULT '',
  environment_keys jsonb NOT NULL DEFAULT '[]',
  preview_target_id uuid REFERENCES project_preview_targets(id) ON DELETE SET NULL,
  auto_start boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE(project_id, name)
);
CREATE UNIQUE INDEX project_run_default_idx ON project_run_profiles(project_id) WHERE is_default;
CREATE TABLE workspace_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES project_run_profiles(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK(kind IN ('run','task','terminal')),
  status text NOT NULL CHECK(status IN ('starting','running','exited','failed','stopped')),
  pid integer,
  exit_code integer,
  started_at timestamptz,
  finished_at timestamptz,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_processes_project_idx ON workspace_processes(project_id, created_at DESC);
CREATE TABLE project_agent_policies (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL DEFAULT 'custom' CHECK(provider = 'custom'),
  model text NOT NULL DEFAULT '',
  reasoning_effort text,
  encrypted_credential text,
  base_url text,
  editors_can_execute boolean NOT NULL DEFAULT true,
  viewers_can_observe boolean NOT NULL DEFAULT true,
  credential_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_agent_threads (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, thread_id)
);
CREATE TABLE workspace_idempotency (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','completed')),
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, key)
);
CREATE INDEX workspace_idempotency_expiry_idx ON workspace_idempotency(created_at);
-- A compatibility trigger also covers project creation, duplication, and older API instances.
CREATE FUNCTION sync_legacy_run_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  INSERT INTO project_preview_targets(project_id,name,target_port,allocated_port,is_default)
  VALUES(NEW.id,'App',(NEW.run_config->>'port')::integer,NEW.preview_port,true)
  ON CONFLICT(project_id) WHERE is_default DO UPDATE
    SET target_port=EXCLUDED.target_port,allocated_port=EXCLUDED.allocated_port
  RETURNING id INTO target;
  INSERT INTO project_run_profiles(project_id,name,command,cwd,preview_target_id,is_default)
  VALUES(NEW.id,'Run',NEW.run_config->>'command',COALESCE(NEW.run_config->>'cwd',''),target,true)
  ON CONFLICT(project_id) WHERE is_default DO UPDATE
    SET command=EXCLUDED.command,cwd=EXCLUDED.cwd;
  RETURN NEW;
END $$;
CREATE TRIGGER projects_legacy_run_profile AFTER INSERT OR UPDATE OF run_config,preview_port ON projects
FOR EACH ROW EXECUTE FUNCTION sync_legacy_run_profile();
UPDATE projects SET run_config=run_config;
