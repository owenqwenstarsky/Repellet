ALTER TABLE projects ADD COLUMN starter_id text, ADD COLUMN starter_version integer,
 ADD COLUMN setup_command text NOT NULL DEFAULT '',
 ADD COLUMN preparation jsonb NOT NULL DEFAULT '{"status":"none","scaffolded":false,"fingerprint":null,"error":null}',
 ADD COLUMN app_status jsonb NOT NULL DEFAULT '{"status":"stopped"}', ADD COLUMN repository jsonb;
ALTER TABLE jobs ADD COLUMN step text, ADD COLUMN log text NOT NULL DEFAULT '', ADD COLUMN started_at timestamptz;
CREATE INDEX jobs_project_created_idx ON jobs(project_id, created_at DESC);
