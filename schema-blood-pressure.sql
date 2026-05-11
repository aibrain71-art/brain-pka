CREATE TABLE IF NOT EXISTS blood_pressure (id INTEGER PRIMARY KEY AUTOINCREMENT, systolic INTEGER NOT NULL, diastolic INTEGER NOT NULL, pulse INTEGER, taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, source TEXT, device TEXT, body_position TEXT, arm TEXT, mood TEXT, notes TEXT, irregular_heartbeat INTEGER DEFAULT 0, classification TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_bp_taken ON blood_pressure(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_bp_classification ON blood_pressure(classification);
