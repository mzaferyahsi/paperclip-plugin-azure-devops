-- Merge approval inside the organisation: who voted what on which exact commit, staging gate results, and approval columns on actions.
CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.verdict (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  org text NOT NULL,
  project_id text NOT NULL,
  repo_id text NOT NULL,
  pr_id integer NOT NULL,
  commit_id text NOT NULL,
  iteration integer NOT NULL,
  agent_id uuid NOT NULL,
  verdict_function text NOT NULL,
  vote integer NOT NULL,
  run_id uuid,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS verdict_pr_commit ON plugin_azure_devops_4c61b1230e.verdict (company_id, project_id, repo_id, pr_id, commit_id);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.gate (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  org text NOT NULL,
  project_id text NOT NULL,
  repo_id text NOT NULL,
  pr_id integer NOT NULL,
  commit_id text NOT NULL,
  iteration integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('staging')),
  state text NOT NULL CHECK (state IN ('succeeded', 'failed')),
  agent_id uuid,
  run_id uuid,
  evidence_url text,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_pr_commit ON plugin_azure_devops_4c61b1230e.gate (company_id, project_id, repo_id, pr_id, commit_id);

ALTER TABLE plugin_azure_devops_4c61b1230e.action
  ADD COLUMN IF NOT EXISTS gate_mode text NOT NULL DEFAULT 'board',
  ADD COLUMN IF NOT EXISTS approval_issue_id uuid,
  ADD COLUMN IF NOT EXISTS approval_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by_agent_id uuid,
  ADD COLUMN IF NOT EXISTS approved_commit text,
  ADD COLUMN IF NOT EXISTS precondition_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by_agent_id uuid,
  ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE plugin_azure_devops_4c61b1230e.action DROP CONSTRAINT IF EXISTS action_status_check;
ALTER TABLE plugin_azure_devops_4c61b1230e.action ADD CONSTRAINT action_status_check
  CHECK (status IN ('proposed', 'awaiting_confirmation', 'awaiting_approval', 'escalated', 'approved', 'applied', 'failed', 'rejected', 'expired'));
CREATE INDEX IF NOT EXISTS action_pending ON plugin_azure_devops_4c61b1230e.action (company_id, status, approval_deadline_at);
