-- SKU catalog. Description, cost, material and plant come from the pricing
-- spreadsheet (scripts/build_import_sql.py). Notes and photos are added by
-- admins in the lookup page and are never touched by a re-import.
CREATE TABLE IF NOT EXISTS skus (
  sku           TEXT PRIMARY KEY,
  material      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  unit_cost     REAL,
  plant         TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  photo_key     TEXT,
  updated       TEXT NOT NULL DEFAULT ''
);

-- Lets a lookup typed with hyphens (e.g. M1131758-00200) find its SKU.
CREATE INDEX IF NOT EXISTS skus_material ON skus(material);

-- Word search over SKU, description and notes for the Browse panel.
CREATE VIRTUAL TABLE IF NOT EXISTS skus_fts USING fts5(
  sku, description, notes,
  content='skus', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS skus_ai AFTER INSERT ON skus BEGIN
  INSERT INTO skus_fts(rowid, sku, description, notes)
  VALUES (new.rowid, new.sku, new.description, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS skus_ad AFTER DELETE ON skus BEGIN
  INSERT INTO skus_fts(skus_fts, rowid, sku, description, notes)
  VALUES ('delete', old.rowid, old.sku, old.description, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS skus_au AFTER UPDATE OF sku, description, notes ON skus BEGIN
  INSERT INTO skus_fts(skus_fts, rowid, sku, description, notes)
  VALUES ('delete', old.rowid, old.sku, old.description, old.notes);
  INSERT INTO skus_fts(rowid, sku, description, notes)
  VALUES (new.rowid, new.sku, new.description, new.notes);
END;
