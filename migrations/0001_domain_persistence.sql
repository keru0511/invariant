-- Immutable, workspace-scoped persistence for canonical Domain v0 models.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS domain_versions (
  workspace_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  model_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, domain_id, version_id),
  FOREIGN KEY (workspace_id, domain_id)
    REFERENCES domains(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS domain_versions_lookup
  ON domain_versions (workspace_id, domain_id, version_id);
