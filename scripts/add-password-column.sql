-- Add password_hash column to agents table
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_agents_password_hash ON agents(password_hash) WHERE password_hash IS NOT NULL;
