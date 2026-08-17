-- ===========================================================================
-- Schema 36: Zahlwege — PayPal, Überweisung (EPC-QR), Wero, Bar.
--
-- Etappe 5 des Gruppen-Umbaus (siehe ideas/plan-gruppen.md §4.1, §5.3, §6).
-- Reine CREATE-Schritte wie schon 0034/0035 - kein Backfill, jede Gruppe
-- startet ohne Zahlwege.
--
-- WARUM KEINE BIC-SPALTE, UND WAS DAS FUER DEN EPC-QR ERZWINGT (Opus-
-- Konsultation vor der Festlegung, 2026-08-11). Der Girocode (EPC069-12)
-- kennt zwei Versionen: '001' verlangt die BIC als Pflichtfeld, '002' laesst
-- sie leer. Ohne BIC-Spalte in diesem Schema ist Version '001' gar nicht
-- erzeugbar - der Worker baut darum IMMER Version '002' (worker/src/epc.js).
-- Das ist eine Folge dieses Schemas, kein unabhaengiger Encoder-Entscheid,
-- und gehoert deshalb hier UND im Encoder-Kopf dokumentiert.
--
-- WARUM `wert` EIN FREITEXTFELD FUER VIER VERSCHIEDENE DINGE IST. paypal.me-
-- Link, IBAN oder Wero-Kennung oder ein Freitext fuer 'bar' - eine Spalte je
-- Art waere hier Spalten fuer Werte, die es nur einmal je Zeile gibt (jede
-- Zeile hat GENAU eine `art`). `inhaber` bleibt daneben eine eigene Spalte,
-- weil er NUR bei 'bank' gebraucht wird und sonst NULL bleibt - kein
-- Freitext-Praefix-Parsing im Worker noetig.
-- ===========================================================================

CREATE TABLE zahlweg (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gruppe_id   INTEGER NOT NULL REFERENCES gruppen(id) ON DELETE CASCADE,
  art         TEXT NOT NULL CHECK (art IN ('paypal','bank','wero','bar')),
  wert        TEXT NOT NULL,   -- paypal.me-Link | IBAN | Kennung | Freitext
  -- Nur bei 'bank': Kontoinhaber. Der EPC-QR vertraegt hoechstens 70 Zeichen,
  -- der Encoder (worker/src/epc.js) schneidet darauf ab.
  inhaber     TEXT,
  reihenfolge INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX zahlweg_gruppe ON zahlweg(gruppe_id, reihenfolge);
