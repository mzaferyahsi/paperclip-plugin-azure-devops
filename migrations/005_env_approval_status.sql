-- Deploy approval decisions are written to the action ledger as 'applying' BEFORE the Azure DevOps call (design ALRAA-1280, control 8).
ALTER TABLE plugin_azure_devops_4c61b1230e.action DROP CONSTRAINT IF EXISTS action_status_check;
ALTER TABLE plugin_azure_devops_4c61b1230e.action ADD CONSTRAINT action_status_check
  CHECK (status IN ('proposed', 'awaiting_confirmation', 'awaiting_approval', 'escalated', 'approved', 'applying', 'applied', 'failed', 'rejected', 'expired'));
