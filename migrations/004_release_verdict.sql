CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.release_verdict (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  release_issue_id uuid NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  build_id bigint NOT NULL CHECK (build_id > 0),
  fn text NOT NULL CHECK (fn IN ('techlead', 'qa', 'security')),
  agent_id uuid NOT NULL,
  vote integer NOT NULL CHECK (vote IN (10, 5, 0, -5, -10)),
  summary_redacted text NOT NULL,
  run_id uuid,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS release_verdict_tuple ON plugin_azure_devops_4c61b1230e.release_verdict (company_id, source_commit, image_digest, build_id);
