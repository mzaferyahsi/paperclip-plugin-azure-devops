-- Paperclip user ids are not UUIDs, so the person who approved a confirmation card is stored as text.
ALTER TABLE plugin_azure_devops_4c61b1230e.action ALTER COLUMN approved_by_user_id TYPE text USING approved_by_user_id::text;
