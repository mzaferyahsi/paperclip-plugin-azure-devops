-- Staging release bundle approval (design ALRAA-1780 v2). Additive and idempotent.
CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.release_bundle (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  project_id text NOT NULL,
  proposer_agent_id uuid NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  branch text NOT NULL CHECK (branch = 'refs/heads/main'),
  build_pipeline_id integer NOT NULL,
  deploy_pipeline_id integer NOT NULL,
  config_snapshot jsonb NOT NULL,
  config_hash text NOT NULL,
  args_hash text NOT NULL,
  reason text NOT NULL,
  commit_facts jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_confirmation','active','building','built','deploying','completed','failed','rejected','expired','revoked')),
  interaction_id uuid,
  approved_by_user_id text,
  approved_at timestamptz,
  expires_at timestamptz NOT NULL,
  build_attempts integer NOT NULL DEFAULT 0,
  build_id bigint,
  image_digest text CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  digest_pinned_at timestamptz,
  deploy_run_id bigint,
  lease text,
  lease_expires_at timestamptz,
  step_started_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
ALTER TABLE plugin_azure_devops_4c61b1230e.release_bundle DROP CONSTRAINT IF EXISTS release_bundle_approved_check;
ALTER TABLE plugin_azure_devops_4c61b1230e.release_bundle ADD CONSTRAINT release_bundle_approved_check
  CHECK (status NOT IN ('active','building','built','deploying','completed') OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL));
-- One open bundle per company and project. 'deploying' stays open until 138 is terminal or cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS release_bundle_one_open ON plugin_azure_devops_4c61b1230e.release_bundle (company_id, project_id)
  WHERE status IN ('awaiting_confirmation','active','building','built','deploying');
CREATE INDEX IF NOT EXISTS release_bundle_due ON plugin_azure_devops_4c61b1230e.release_bundle (company_id, status, expires_at);

-- The host refuses CREATE TRIGGER / CREATE FUNCTION in plugin migrations (plugin-database.js assertNoBannedSql), so the design's freeze trigger
-- cannot exist. Stateless invariants are CHECK constraints; the frozen columns are protected in store.ts, whose only UPDATE statements never name them.
ALTER TABLE plugin_azure_devops_4c61b1230e.release_bundle DROP CONSTRAINT IF EXISTS release_bundle_expiry_check;
ALTER TABLE plugin_azure_devops_4c61b1230e.release_bundle ADD CONSTRAINT release_bundle_expiry_check
  CHECK (approved_at IS NULL OR expires_at <= approved_at + ((config_snapshot->>'ttlMinutes')::integer * interval '1 minute'));
ALTER TABLE plugin_azure_devops_4c61b1230e.release_bundle DROP CONSTRAINT IF EXISTS release_bundle_digest_check;
ALTER TABLE plugin_azure_devops_4c61b1230e.release_bundle ADD CONSTRAINT release_bundle_digest_check
  CHECK ((image_digest IS NULL) = (digest_pinned_at IS NULL) AND (image_digest IS NULL OR build_id IS NOT NULL) AND (status NOT IN ('built','deploying','completed') OR image_digest IS NOT NULL) AND (status <> 'completed' OR deploy_run_id IS NOT NULL));
