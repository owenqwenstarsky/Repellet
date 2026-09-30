CREATE TABLE github_config (id integer PRIMARY KEY, encrypted text NOT NULL);
CREATE TABLE github_connections (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 encrypted text NOT NULL, login text NOT NULL, github_id bigint NOT NULL,
 installation_id bigint, expires_at timestamptz, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE github_states (
 hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX github_states_expires_idx ON github_states(expires_at);
