-- Tracks publication by this workflow, distinguishing replay from an external ID collision.
ALTER TABLE domain_versions ADD COLUMN proposal_id TEXT;

-- A single authoritative head per domain, including versions published by older
-- callers. Historical bootstrap uses publication time, then version id as tie-break.
CREATE TABLE domain_heads (
  workspace_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, domain_id),
  FOREIGN KEY (workspace_id, domain_id, version_id)
    REFERENCES domain_versions(workspace_id, domain_id, version_id)
);
INSERT INTO domain_heads (workspace_id, domain_id, version_id)
SELECT v.workspace_id, v.domain_id, v.version_id FROM domain_versions v
WHERE NOT EXISTS (
  SELECT 1 FROM domain_versions newer
  WHERE newer.workspace_id = v.workspace_id AND newer.domain_id = v.domain_id
    AND (newer.published_at > v.published_at
      OR (newer.published_at = v.published_at AND newer.version_id > v.version_id))
);
CREATE TRIGGER domain_versions_advance_head AFTER INSERT ON domain_versions
BEGIN
  INSERT INTO domain_heads (workspace_id, domain_id, version_id)
  VALUES (NEW.workspace_id, NEW.domain_id, NEW.version_id)
  ON CONFLICT (workspace_id, domain_id) DO UPDATE SET version_id = excluded.version_id;
END;

-- Proposals are immutable review snapshots, scoped to their verified author.
-- Saving a proposal never changes an executable domain version.
CREATE TABLE domain_proposals (
  workspace_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  base_version TEXT NOT NULL,
  version_id TEXT NOT NULL,
  review_digest TEXT NOT NULL,
  review_json TEXT NOT NULL,
  model_json TEXT NOT NULL,
  authoring_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, domain_id, proposal_id),
  UNIQUE (workspace_id, domain_id, version_id),
  FOREIGN KEY (workspace_id, domain_id, base_version)
    REFERENCES domain_versions(workspace_id, domain_id, version_id)
);
