-- Azure DevOps plugin schema. Fully qualified names only; additive, idempotent (IF NOT EXISTS). Never edit a shipped file.
-- Every row is company scoped and every query filters by company_id. tests/namespace.test.ts checks this file names the derived schema.
CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.connection_state (
  company_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('author', 'reviewer')),
  identity_id text,
  display_name text,
  auth_kind text,
  last_ok_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  PRIMARY KEY (company_id, role)
);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.pull_request (
  company_id uuid NOT NULL,
  org text NOT NULL,
  project_id text NOT NULL,
  repo_id text NOT NULL,
  pr_id integer NOT NULL,
  repo_name text,
  project_name text,
  url text,
  title text,
  status text NOT NULL,
  merge_status text,
  is_draft boolean NOT NULL DEFAULT false,
  source_ref text,
  target_ref text,
  created_by_id text,
  last_merge_source_commit text,
  last_merge_commit text,
  iteration_count integer NOT NULL DEFAULT 0,
  reviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  builds jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status jsonb,
  review_requested_at timestamptz,
  etag text,
  fetched_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  next_reconcile_at timestamptz,
  PRIMARY KEY (company_id, org, project_id, repo_id, pr_id)
);
CREATE INDEX IF NOT EXISTS pull_request_due ON plugin_azure_devops_4c61b1230e.pull_request (company_id, terminal, next_reconcile_at);
CREATE INDEX IF NOT EXISTS pull_request_branch ON plugin_azure_devops_4c61b1230e.pull_request (company_id, source_ref);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.work_item (
  company_id uuid NOT NULL,
  org text NOT NULL,
  project_id text NOT NULL,
  wi_id integer NOT NULL,
  url text,
  wi_type text,
  title text,
  state text,
  state_category text,
  assigned_to text,
  rev integer,
  fetched_at timestamptz NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  next_reconcile_at timestamptz,
  PRIMARY KEY (company_id, org, project_id, wi_id)
);
CREATE INDEX IF NOT EXISTS work_item_due ON plugin_azure_devops_4c61b1230e.work_item (company_id, terminal, next_reconcile_at);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.build (
  company_id uuid NOT NULL,
  org text NOT NULL,
  project_id text NOT NULL,
  build_id integer NOT NULL,
  pipeline_id integer,
  web_url text,
  status text,
  result text,
  source_branch text,
  source_version text,
  reason text,
  finished_at timestamptz,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, org, project_id, build_id)
);
CREATE INDEX IF NOT EXISTS build_branch ON plugin_azure_devops_4c61b1230e.build (company_id, source_branch);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.link (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pull_request', 'work_item', 'build')),
  org text NOT NULL,
  project_id text NOT NULL,
  repo_id text NOT NULL DEFAULT '',
  external_id text NOT NULL,
  source text NOT NULL,
  confidence text NOT NULL DEFAULT 'exact',
  author_agent_id uuid,
  created_by_run_id uuid,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS link_unique ON plugin_azure_devops_4c61b1230e.link (company_id, issue_id, kind, org, project_id, repo_id, external_id);
CREATE INDEX IF NOT EXISTS link_issue ON plugin_azure_devops_4c61b1230e.link (company_id, issue_id);
CREATE INDEX IF NOT EXISTS link_object ON plugin_azure_devops_4c61b1230e.link (company_id, kind, external_id);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.webhook_inbox (
  id uuid PRIMARY KEY,
  company_id uuid,
  event_id text NOT NULL,
  subscription_id text,
  event_type text NOT NULL,
  resource_kind text,
  resource_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  project_id text,
  received_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'skipped', 'failed', 'rejected')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_inbox_event ON plugin_azure_devops_4c61b1230e.webhook_inbox (event_id);
CREATE INDEX IF NOT EXISTS webhook_inbox_queue ON plugin_azure_devops_4c61b1230e.webhook_inbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_inbox_received ON plugin_azure_devops_4c61b1230e.webhook_inbox (received_at);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.subscription (
  company_id uuid NOT NULL,
  subscription_id text NOT NULL,
  event_type text NOT NULL,
  project_id text,
  status text,
  created_at timestamptz NOT NULL,
  last_verified_at timestamptz,
  last_notification_result text,
  PRIMARY KEY (company_id, subscription_id)
);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.action (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  issue_id uuid,
  agent_id uuid NOT NULL,
  run_id uuid,
  tool text NOT NULL,
  args_hash text NOT NULL,
  args_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_class text NOT NULL CHECK (risk_class IN ('W', 'G')),
  status text NOT NULL CHECK (status IN ('proposed', 'awaiting_confirmation', 'approved', 'applied', 'failed', 'rejected', 'expired')),
  interaction_id uuid,
  approved_by_user_id uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  result jsonb,
  idempotency_key text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS action_idem ON plugin_azure_devops_4c61b1230e.action (company_id, idempotency_key);
CREATE INDEX IF NOT EXISTS action_issue ON plugin_azure_devops_4c61b1230e.action (company_id, issue_id, status);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.rate_budget (
  company_id uuid NOT NULL,
  role text NOT NULL,
  window_start timestamptz NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  remaining_hint integer,
  parked_until timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, role)
);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.reconcile_cursor (
  company_id uuid NOT NULL,
  scope text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, scope)
);

CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.audit (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  at timestamptz NOT NULL,
  actor_agent_id uuid,
  run_id uuid,
  issue_id uuid,
  action text NOT NULL,
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_company_at ON plugin_azure_devops_4c61b1230e.audit (company_id, at DESC);

-- One row per side effect already performed (comment, wakeup, status change). Replays and the reconciler share keys, so effects happen once.
CREATE TABLE IF NOT EXISTS plugin_azure_devops_4c61b1230e.effect (
  company_id uuid NOT NULL,
  effect_key text NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (company_id, effect_key)
);
