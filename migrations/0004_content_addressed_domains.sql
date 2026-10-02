-- New snapshots share immutable objects within the same workspace/domain.
-- Existing inline snapshots remain readable; this migration does not delete or rewrite them.
CREATE TABLE domain_objects (
  workspace_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, domain_id, object_hash),
  FOREIGN KEY (workspace_id, domain_id) REFERENCES domains(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE domain_versions ADD COLUMN parent_version_id TEXT;
