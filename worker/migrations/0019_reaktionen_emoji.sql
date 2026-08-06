-- Reaktionen: das Emoji IST der Schlüssel
--
-- Bisher standen vier Namen im CHECK der Tabelle ('daumen_hoch' … 'bier'), und
-- welches Zeichen dazugehört, wusste allein die Seite. Der Emoji-Wähler nach
-- Art von Teams macht die Menge offen — jede weitere Reaktion wäre sonst eine
-- Migration, und ein CHECK mit fünfzig Namen ist keine Regel mehr, sondern eine
-- Liste am falschen Ort. Sie steht jetzt im Worker (REAKTIONEN), wo sie sich
-- ohne Schemaschritt erweitern lässt, und die Spalte trägt das Zeichen selbst.
--
-- SQLite kann kein DROP CONSTRAINT: die Tabelle wird neu gebaut. Die vier alten
-- Namen werden dabei auf ihr Zeichen umgeschrieben, auch 'daumen_runter' —
-- 👎 gehört nicht mehr zu den vier schnellen, steht aber weiter im Wähler, damit
-- ein alter Daumen sichtbar bleibt und sich zurücknehmen lässt. Die Abbildung
-- ist eindeutig, der Primärschlüssel kann dabei nicht kollidieren.
--
-- ❤️ ist U+2764 U+FE0F (mit Variantenselektor) — genau so, wie es im Worker und
-- auf der Seite steht. Ohne den Selektor wäre es eine andere Zeichenkette und
-- damit eine andere Zeile.

CREATE TABLE reaktionen_neu (
  kommentar_id INTEGER NOT NULL REFERENCES kommentare(id) ON DELETE CASCADE,
  autor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  art          TEXT    NOT NULL,
  erstellt     TEXT NOT NULL DEFAULT (datetime('now')),

  -- Unverändert die eigentliche Regel: derselbe Druck auf dieselbe Reaktion
  -- nimmt sie zurück, ein zweiter Daumen desselben Autors entsteht nie.
  PRIMARY KEY (kommentar_id, autor_id, art)
);

INSERT INTO reaktionen_neu (kommentar_id, autor_id, art, erstellt)
SELECT kommentar_id, autor_id,
       CASE art
         WHEN 'daumen_hoch'   THEN '👍'
         WHEN 'daumen_runter' THEN '👎'
         WHEN 'herz'          THEN '❤️'
         WHEN 'bier'          THEN '🍺'
         ELSE art
       END,
       erstellt
FROM reaktionen;

DROP TABLE reaktionen;
ALTER TABLE reaktionen_neu RENAME TO reaktionen;
