ALTER TABLE projects ADD COLUMN environment_revision integer NOT NULL DEFAULT 0;
CREATE TABLE project_databases (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('postgresql', 'mongodb')),
  image text NOT NULL,
  credentials text NOT NULL,
  initialized boolean NOT NULL DEFAULT false,
  variable_name text NOT NULL DEFAULT 'DATABASE_URL',
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'ready', 'stopped', 'failed', 'deleting')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
