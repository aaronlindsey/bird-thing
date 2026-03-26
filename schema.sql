CREATE TABLE IF NOT EXISTS detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  common_name TEXT NOT NULL,
  scientific_name TEXT NOT NULL,
  confidence REAL NOT NULL,
  detected_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  is_new_species INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_detections_detected_at ON detections(detected_at);
CREATE INDEX IF NOT EXISTS idx_detections_species ON detections(common_name, detected_at);
