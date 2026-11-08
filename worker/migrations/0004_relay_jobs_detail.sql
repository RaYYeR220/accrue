ALTER TABLE relay_jobs ADD COLUMN detail TEXT;
CREATE INDEX relay_jobs_owner_created ON relay_jobs (owner, created_at);
