-- Add runtime columns to agents (run after schema.sql on existing DBs)
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS runtime_endpoint TEXT;
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS deployment_mode VARCHAR(20);