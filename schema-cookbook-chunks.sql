CREATE TABLE IF NOT EXISTS cookbook_chunks (cookbook_id INTEGER NOT NULL, idx INTEGER NOT NULL, data_b64 TEXT NOT NULL, PRIMARY KEY (cookbook_id, idx));
CREATE INDEX IF NOT EXISTS idx_chunks_cookbook ON cookbook_chunks(cookbook_id, idx);
