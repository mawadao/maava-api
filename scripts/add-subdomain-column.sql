-- Add subdomain column to agents table
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS subdomain VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_agents_subdomain ON agents(subdomain) WHERE subdomain IS NOT NULL;
