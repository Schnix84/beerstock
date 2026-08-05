-- ===========================================================================
-- Schema 15: Die Rundmail bekommt Bild, Knopf und Zeitsteuerung.
--
-- Bild und Knopf sind nur Text-Spalten - das HTML dazu baut der Worker, hier
-- steht bloss die Adresse. Neu ist vor allem `rundmail_geplant`: eine
-- vorgemerkte Rundmail wartet auf ihren Versandzeitpunkt und ist bis dahin
-- editierbar und verwerfbar. Der Cron dazu steht in wrangler.jsonc (der
-- zweite Eintrag) und prueft alle zehn Minuten, was faellig ist.
-- ===========================================================================

CREATE TABLE rundmail_geplant (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  betreff      TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  bild_url     TEXT,
  knopf_text   TEXT,
  knopf_link   TEXT,
  versand_am   TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'geplant'
                  CHECK (status IN ('geplant', 'versendet', 'fehlgeschlagen')),
  fehler       TEXT,               -- gesetzt bei 'fehlgeschlagen'
  empfaenger   INTEGER,            -- gesetzt bei 'versendet'
  erstellt     TEXT    NOT NULL DEFAULT (datetime('now')),
  versendet_am TEXT
);

-- Der Cron fragt genau das: alles, was noch aussteht und faellig ist.
CREATE INDEX idx_rundmail_geplant_faellig ON rundmail_geplant (status, versand_am);
