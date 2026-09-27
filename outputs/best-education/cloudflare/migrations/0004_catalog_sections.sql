-- A two-level, editor-managed catalogue. The stable IDs below make it safe to
-- connect the original Class 10/11/12 category pages without inventing content.
CREATE TABLE IF NOT EXISTS catalog_sections (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 0,
  show_on_home INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_sections_parent_sort
  ON catalog_sections(parent_id, sort_order, title);
CREATE INDEX IF NOT EXISTS idx_catalog_sections_public
  ON catalog_sections(is_published, parent_id, sort_order);

ALTER TABLE cards ADD COLUMN section_id TEXT;
ALTER TABLE cards ADD COLUMN resource_label TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN is_published INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_cards_catalog_public
  ON cards(section_id, is_published, sort_order, updated_at);

-- Stable top-level sections. JEE and NEET deliberately have no invented child
-- categories or materials; empty collections truthfully show that material is
-- being prepared until the editor publishes a tile and study card.
INSERT OR IGNORE INTO catalog_sections
  (id,parent_id,title,slug,description,icon,sort_order,is_published,show_on_home,created_at,updated_at)
VALUES
  ('class-10',NULL,'Class 10','class-10','Study materials for Class 10.','',10,1,1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-11',NULL,'Class 11','class-11','Study materials for Class 11.','',20,1,1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-12',NULL,'Class 12','class-12','Study materials for Class 12.','',30,1,1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('jee',NULL,'JEE','jee','Study materials for JEE preparation.','',40,1,1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('neet',NULL,'NEET','neet','Study materials for NEET preparation.','',50,1,1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');

INSERT OR IGNORE INTO catalog_sections
  (id,parent_id,title,slug,description,icon,sort_order,is_published,show_on_home,created_at,updated_at)
VALUES
  ('class-10-sample','class-10','Sample Papers','class-10-sample-papers','', '',10,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-10-pyq','class-10','Previous Year Questions','class-10-previous-year-questions','', '',20,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-10-mcq','class-10','MCQs','class-10-mcqs','', '',30,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-10-important','class-10','Important Questions','class-10-important-questions','', '',40,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-11-sample','class-11','Sample Papers','class-11-sample-papers','', '',10,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-11-pyq','class-11','Previous Year Questions','class-11-previous-year-questions','', '',20,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-11-mcq','class-11','MCQs','class-11-mcqs','', '',30,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-11-important','class-11','Important Questions','class-11-important-questions','', '',40,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-12-sample','class-12','Sample Papers','class-12-sample-papers','', '',10,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-12-pyq','class-12','Previous Year Questions','class-12-previous-year-questions','', '',20,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-12-mcq','class-12','MCQs','class-12-mcqs','', '',30,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z'),
  ('class-12-important','class-12','Important Questions','class-12-important-questions','', '',40,1,0,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');

-- Existing cards stay compatible with the original category pages, while also
-- appearing in the new catalogue tree.
UPDATE cards
SET section_id = 'class-' || class_name || '-' || type
WHERE section_id IS NULL
  AND class_name IN ('10','11','12')
  AND type IN ('sample','pyq','mcq','important');
