-- Vorschaukarten zu Links in Kommentaren (Open Graph)
--
-- Was Teams und WhatsApp tun: wer einen Link schreibt, bekommt darunter eine
-- Karte mit Titel, Beschreibung und Bild der verlinkten Seite.
--
-- EIGENE TABELLE, nicht Spalten an `kommentare`: derselbe Link wird im
-- Freundeskreis mehrfach gepostet, und dann soll er einmal geholt werden und
-- nicht dreimal. `url_hash` ist der Schluessel dafuer, nicht `url` selbst --
-- SQLite indiziert einen kurzen Hex-String schneller als eine 2 kB lange
-- Adresse, und UNIQUE auf TEXT unbegrenzter Laenge ist eine Falle.
--
-- Fehlgeschlagene Versuche bleiben ALS ZEILE stehen (`fehler` gesetzt, `titel`
-- NULL). Sonst versucht es der Worker bei jedem neuen Kommentar mit demselben
-- toten Link wieder -- und ein Link ist meist tot, weil er tot ist, nicht weil
-- gerade etwas klemmte.

CREATE TABLE vorschauen (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,

  -- SHA-256 der normalisierten Adresse, hex. Normalisiert heisst: das, was
  -- `darfGeholtWerden()` im Worker zurueckgibt -- `new URL()` schreibt Schema
  -- und Host klein und laesst den Standardport weg, das Gatter raeumt das
  -- Fragment ab. Query bleibt DRIN: bei YouTube ist ?v=... die halbe Adresse.
  -- Gehasht wird also nie der rohe Text aus dem Kommentar, sondern immer die
  -- Rueckgabe des Gatters; sonst laufen Tabelle und Code auseinander.
  url_hash  TEXT NOT NULL UNIQUE,
  url       TEXT NOT NULL,

  titel     TEXT,
  text      TEXT,          -- og:description, auf 300 Zeichen gekuerzt
  host      TEXT,          -- was unter der Karte steht: "youtube.com"

  -- Das Vorschaubild liegt in R2 wie jedes andere, mit demselben
  -- Schluesselmuster (UUID + Endung). NICHT die fremde Adresse: die waere ein
  -- IP-Leck je Leser, und die Karte verrottete, sobald die Gegenseite ihr Bild
  -- umbenennt.
  bild_key  TEXT,

  -- Gesetzt, wenn es nicht geklappt hat. Dann zeigt die Seite nichts an -- die
  -- Zeile existiert nur, damit nicht dauernd neu versucht wird.
  fehler    TEXT,

  geholt    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ein Kommentar hat hoechstens EINE Vorschau: die des ERSTEN Links im Text.
-- Teams und WhatsApp machen es genauso, und drei Karten unter einem Zweizeiler
-- waeren keine Hilfe mehr.
--
-- Kein Index darauf: gelesen wird immer von der Karte zur Vorschau (ueber den
-- Primaerschluessel), nie umgekehrt.
ALTER TABLE kommentare ADD COLUMN vorschau_id INTEGER REFERENCES vorschauen(id);
