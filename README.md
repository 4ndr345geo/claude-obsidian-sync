# Google Drive Vault Sync (Obsidian-Plugin)

Synchronisiert deinen Obsidian-Vault über **dein eigenes Google Drive** auf allen Geräten:
Windows, macOS, Linux, Android, iPhone und iPad.

## So werden Konflikte vermieden: 3-Wege-Merge

Für jede Notiz merkt sich das Plugin die Version der letzten Synchronisierung (die *Basis*).
Wurde eine Notiz auf zwei Geräten geändert, vergleicht es **beide neuen Versionen mit der Basis**
und weiß so genau, was auf welchem Gerät geändert wurde.

| Situation | Was passiert |
|---|---|
| Notiz auf einem Gerät geändert | wird automatisch auf die anderen übertragen |
| **Unkritisch:** verschiedene Stellen derselben Notiz geändert (z. B. Laptop oben, Handy unten) | wird **automatisch zusammengeführt** |
| **Unkritisch:** auf beiden Geräten dieselbe Änderung | wird einfach übernommen |
| **Kritisch:** dieselbe Stelle auf beiden Geräten unterschiedlich geändert | **beide Versionen werden in der Notiz markiert**, siehe unten |
| Bild, PDF o. Ä. auf zwei Geräten geändert | neuere Version behält den Namen, ältere wird als `bild (Konflikt Handy 2026-11-03 14-05).png` gespeichert |
| Auf Gerät A gelöscht, auf Gerät B bearbeitet | bearbeitete Version bleibt erhalten |
| Datei gelöscht | landet im Papierkorb (Obsidian bzw. Google Drive, 30 Tage wiederherstellbar) |

### Wie kritische Stellen markiert werden

Alles Unkritische ist schon zusammengeführt. Nur die kritische Stelle erscheint als Warn-Kasten,
die neuere Version steht oben:

```markdown
# Einkauf am Markt          ← Änderung vom Handy übernommen

- Milch
- Brot
- Käse                      ← Änderung vom Laptop übernommen

> [!warning] Sync-Konflikt
> Diese Stelle wurde auf zwei Geräten unterschiedlich geändert. Behalte die richtige Version und lösche diesen Kasten.
>
> **Laptop · 03.11.2026 14:07**
>
> Termin: Dienstag
>
> **Handy · 03.11.2026 13:50**
>
> Termin: Mittwoch
```

Du behältst die richtige Zeile und löschst den Kasten. Fertig.

- **In Codeblöcken** wird statt des Kastens die Markierung `<<<<<<< … ======= … >>>>>>>` verwendet,
  weil ein Kasten dort nicht angezeigt würde.
- **In den Eigenschaften (Frontmatter)** wird die neuere Version übernommen, damit die
  Eigenschaften gültig bleiben. Der Kasten mit der anderen Version erscheint direkt darunter.
- Zwei Änderungen in **direkt benachbarten Zeilen** gelten als eine Stelle (wie bei Git), weil es
  dort oft um denselben Zusammenhang geht.
- Der Befehl **„Notizen mit Sync-Konflikten anzeigen“** listet alle Notizen, in denen noch ein
  Kasten steht.

Änderungen werden anhand von Prüfsummen (MD5) erkannt, nicht anhand der Uhrzeit. Falsch gehende
Geräteuhren können also nichts kaputt machen.

Synchronisiert wird beim Start, 10 Sekunden nach dem Bearbeiten, alle 2 Minuten und beim
Zurückkehren in die App (Handy). So sind die Geräte fast immer auf dem gleichen Stand.

**Datenschutz:** Das Plugin nutzt die Berechtigung `drive.file`. Es sieht **nur die Dateien, die
es selbst angelegt hat**, nicht den Rest deines Google Drive. Es gibt keinen fremden Server
dazwischen: Die Daten gehen direkt von deinem Gerät zu Google.

---

## Einrichtung (einmalig, ca. 10 Minuten)

### 1. Eigenen Google-Zugang anlegen

1. Öffne <https://console.cloud.google.com/> und lege ein **neues Projekt** an (z. B. „Obsidian Sync“).
2. **APIs & Dienste → Bibliothek** → „Google Drive API“ suchen → **Aktivieren**.
3. **Google Auth Platform / OAuth-Zustimmungsbildschirm** → Erste Schritte:
   - App-Name: z. B. „Obsidian Sync“, deine E-Mail eintragen
   - Zielgruppe: **Extern**
   - Unter **Datenzugriff** den Bereich `.../auth/drive.file` hinzufügen
4. Unter **Zielgruppe** auf **„App veröffentlichen“** klicken (Status „In Produktion“).
   > Wichtig: Im Status „Test“ läuft die Anmeldung nach 7 Tagen ab. Für `drive.file` ist keine
   > Prüfung durch Google nötig. Bei der Anmeldung erscheint evtl. „Google hat diese App nicht
   > überprüft“: Über **Erweitert → Weiter zu Obsidian Sync** geht es weiter. Es ist ja deine eigene App.
5. **Clients → Client erstellen** → Anwendungstyp **Desktop-App** → Erstellen.
   **Client-ID** und **Clientschlüssel** kopieren.

### 2. Plugin installieren

**Variante A, mit BRAT (empfohlen, funktioniert auch auf dem Handy):**
Dieses Repository auf GitHub stellen und ein Release mit `main.js` und `manifest.json` anlegen.
Dann in Obsidian das Community-Plugin **BRAT** installieren → „Add beta plugin“ → Repo-URL eingeben.

**Variante B, manuell:** Den Ordner `<dein Vault>/.obsidian/plugins/gdrive-vault-sync/` anlegen
und `main.js` und `manifest.json` hineinkopieren. Danach Obsidian neu laden und das Plugin unter
*Einstellungen → Community-Plugins* aktivieren.

### 3. Verbinden

**Am Computer:** Einstellungen → *Google Drive Vault Sync* → Client-ID und Secret eintragen →
**Verbinden**. Der Browser öffnet sich, du meldest dich bei Google an, fertig.

**Auf Handy/Tablet, per QR-Code (empfohlen):** Auf dem Tablet/Handy Obsidian mit dem Vault öffnen
(Plugin installiert und aktiviert). Am Computer auf **„QR-Code anzeigen“** klicken. Mit der
**Kamera-App** des Tablets/Handys scannen und auf **„In Obsidian öffnen“** tippen. Obsidian zeigt, mit
welchem Google-Konto verbunden wird, und fragt nach Bestätigung. Zwischenablage oder Tippen sind nicht nötig.

**Alternativ per Code:** Am Computer auf **„Code kopieren“** klicken und auf dem Gerät unter
**„Verbindungscode einfügen“** übernehmen. Wenn das Einfügen am iPad/iPhone blockiert ist:
iOS-Einstellungen → Obsidian → „Aus anderen Apps einfügen“ → „Erlauben“.

### 4. Erste Synchronisierung, so geht nichts schief

1. **Backup:** Den Vault-Ordner vorher einmal als ZIP sichern.
2. Zuerst auf dem Gerät mit dem vollständigen Vault synchronisieren und warten, bis „✓“ erscheint.
3. Auf den anderen Geräten am besten mit einem **leeren Vault** beginnen und dann synchronisieren.
4. Den Vault **nicht zusätzlich** im Google-Drive-Desktop-Ordner, in iCloud, OneDrive usw.
   speichern. Doppelte Synchronisierung erzeugt Konflikte.

---

## Gut zu wissen

- In Google Drive liegen alle Dateien in einem Ordner (Standard: `Obsidian – <Vault-Name>`).
  Der Dateiname entspricht dem Pfad im Vault, z. B. `Projekte/Idee.md`.
- Der Ordner `.obsidian` (Einstellungen, Themes, Plugins) wird **nicht** synchronisiert. So kann
  jedes Gerät eigene Einstellungen haben, und es gibt keine Konflikte mit `workspace.json`.
- Umbenennen wird als „alte Datei löschen + neue anlegen“ übertragen.
- Die Statusleiste unten zeigt den Zustand (`☁ ✓ vor 2 Min.`). Ein Klick darauf synchronisiert sofort.
- Befehl: *„Jetzt mit Google Drive synchronisieren“* (auch per Tastenkürzel belegbar).

## Entwicklung

```bash
npm install
npm test        # Simulation mit zwei Geräten und einem Fake-Drive
npm run build   # erzeugt main.js
```

Aufbau:
- `src/plan.ts`: entscheidet pro Datei, was zu tun ist (3-Wege-Vergleich, reine Logik)
- `src/merge.ts`: 3-Wege-Merge mit Markdown-gerechter Markierung kritischer Stellen
- `src/sync.ts`: führt den Plan aus
- `src/drive.ts`: Google Drive API (v3)
- `src/auth.ts`: Google-Anmeldung (OAuth mit PKCE) und Verbindungscode
- `src/main.ts`: Plugin, Einstellungen, automatische Auslöser

### Neue Version veröffentlichen

1. Version in `manifest.json` und `package.json` erhöhen (z. B. `1.2.0`) und in `versions.json` ergänzen.
2. Committen und auf `main` pushen.

GitHub Actions merkt, dass es zu dieser Version noch kein Release gibt, testet und baut das Plugin
und legt Tag und Release mit `main.js` und `manifest.json` an. BRAT installiert die neue Version
danach automatisch auf allen Geräten. Pushes ohne Versionsänderung erzeugen kein neues Release.
