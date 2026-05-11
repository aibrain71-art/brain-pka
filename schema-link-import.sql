ALTER TABLE notes ADD COLUMN source_url TEXT;
ALTER TABLE notes ADD COLUMN source_type TEXT;
ALTER TABLE notes ADD COLUMN source_meta TEXT;
ALTER TABLE notes ADD COLUMN full_summary TEXT;
ALTER TABLE notes ADD COLUMN garden_type TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_source_type ON notes(source_type);
CREATE INDEX IF NOT EXISTS idx_notes_source_url ON notes(source_url);
