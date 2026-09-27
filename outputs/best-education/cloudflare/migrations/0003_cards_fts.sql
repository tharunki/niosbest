CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  title,
  subject,
  description,
  type,
  class_name,
  content='cards',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS cards_fts_after_insert AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid,title,subject,description,type,class_name)
  VALUES (new.rowid,new.title,new.subject,new.description,new.type,new.class_name);
END;

CREATE TRIGGER IF NOT EXISTS cards_fts_after_delete AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts,rowid,title,subject,description,type,class_name)
  VALUES ('delete',old.rowid,old.title,old.subject,old.description,old.type,old.class_name);
END;

CREATE TRIGGER IF NOT EXISTS cards_fts_after_update AFTER UPDATE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts,rowid,title,subject,description,type,class_name)
  VALUES ('delete',old.rowid,old.title,old.subject,old.description,old.type,old.class_name);
  INSERT INTO cards_fts(rowid,title,subject,description,type,class_name)
  VALUES (new.rowid,new.title,new.subject,new.description,new.type,new.class_name);
END;

INSERT INTO cards_fts(cards_fts) VALUES ('rebuild');
