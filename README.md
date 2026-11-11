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

## Sicherheit

**Wo liegen die Zugangsdaten?** Das Plugin braucht drei Werte: OAuth-Client-ID, Client-Secret und
das Refresh-Token (damit kann man dauerhaft auf den Sync-Ordner in Google Drive zugreifen).

- **Ab Obsidian 1.11.4:** Client-Secret und Refresh-Token liegen im **Schlüsselbund von Obsidian**
  (`app.secretStorage`), nicht mehr im Vault-Ordner. Sie sind damit nicht in ZIP-Backups
  des Vaults, in anderen Sync-Diensten oder in einem Git-Repository des Vaults enthalten. Beim
  ersten Start nach dem Update werden vorhandene Werte automatisch dorthin verschoben.
  Wie der Schlüsselbund die Werte auf dem Gerät ablegt, bestimmt Obsidian. Andere Community-Plugins
  im selben Vault können ihn lesen.
- **Ältere Obsidian-Versionen:** Die Werte stehen **unverschlüsselt** in
  `.obsidian/plugins/gdrive-vault-sync/data.json`. Diese Datei wird nie synchronisiert, steckt aber
  in jedem Backup des Vault-Ordners.
- In den Plugin-Einstellungen steht unter „Verbindung“, welche der beiden Varianten gerade gilt.
- **Alte Backups** des Vaults (vor Version 1.5.0) enthalten das Token weiterhin. Wenn so ein Backup
  in fremde Hände geraten sein könnte: Zugriff unter <https://myaccount.google.com/permissions>
  widerrufen und neu verbinden.

**Alle Geräte teilen sich ein Token.** Geht ein Gerät verloren, den Zugriff bei Google widerrufen
(Link oben) und alle Geräte neu verbinden. „Verbindung trennen“ löscht das Token nur auf dem
jeweiligen Gerät.

**Verbindungscode und QR-Code enthalten den vollen Zugang.** Nicht fotografieren, nicht
verschicken. Nach „Code kopieren“ wird die Zwischenablage nach 60 Sekunden geleert. Ein
`obsidian://`-Link zum Verbinden wird nur angenommen, solange das Gerät **nicht** verbunden ist,
und nie ohne Rückfrage mit Anzeige des Google-Kontos. Bestätige nur Codes, die du selbst erzeugt hast.

**Schutz vor manipulierten Dateien in Google Drive.** Dateinamen aus Drive werden geprüft, bevor
etwas geschrieben wird. Ignoriert werden Pfade, die aus dem Vault herausführen (`../`), versteckte
Ordner (Name beginnt mit einem Punkt) außer dem Einstellungsordner, andere Schreibweisen des
Einstellungsordners (`.Obsidian`, `OBSIDI~1`) und Namen mit `:` oder Steuerzeichen. Der Ordner
dieses Plugins wird nie überschrieben. Solche Dateien werden auch lokal nicht synchronisiert.

**Sicherheitsstopp bei Massenlöschung.** Würde eine Synchronisierung mindestens 20 Dateien und
mindestens die Hälfte aller Dateien löschen (z. B. weil der Drive-Ordner geleert wurde oder der
Vault nicht vollständig geladen ist), wird nichts geändert. Ein Klick auf die Statusleiste zeigt
die Zahlen und fragt nach Bestätigung.

**Verhalten bei Fehlern.** Im Zweifel bricht die Synchronisierung ab, statt zu raten:

- Ist der Ordner in Google Drive gelöscht oder im Papierkorb, wird lokal nichts gelöscht. Das
  Plugin legt einen neuen Ordner an und lädt alles wieder hoch.
- Jeder Download wird mit der Prüfsumme von Google verglichen. Unvollständige Dateien werden nicht
  in den Vault geschrieben.
- Kann eine Datei oder ein Einstellungsordner nicht gelesen werden, wird abgebrochen, damit die
  Datei nicht als „gelöscht“ gilt.
- Scheitert ein Upload mitten in einem Konflikt, bleibt die Notiz unverändert und der nächste
  Versuch beginnt von vorn. Es entstehen keine doppelten Markierungen oder Konfliktkopien.
- Ohne Internet wartet die automatische Synchronisierung still (Statusleiste: „offline“).
- Eine beschädigte Einstellungsdatei des Plugins wird gesichert und zurückgesetzt. Notizen sind
  davon nicht betroffen.
- Dateinamen und Fehlertexte von außen erscheinen im Sync-Protokoll als Code, damit darüber keine
  Links, Bilder oder HTML in die Notiz gelangen.

**Antworten von Google werden einzeln ausgewertet** (`src/http.ts`):

| Antwort | Bedeutung | Reaktion |
|---|---|---|
| keine Verbindung | offline | automatische Synchronisierung wartet still |
| 400 | Anfrage abgelehnt | nur diese Datei schlägt fehl |
| 401 | Zugriffstoken abgelaufen | einmal neues Token holen, sonst „neu verbinden“ |
| 403 `storageQuotaExceeded` | Speicher voll | keine weiteren Uploads, Downloads laufen weiter |
| 403 `rateLimitExceeded` u. ä., 429 | zu viele Anfragen | bis zu 6 Versuche, `Retry-After` wird beachtet |
| 403 `accessNotConfigured`, `domainPolicy` | API aus oder gesperrt | Abbruch mit Hinweis |
| 403 sonst | keine Berechtigung | nur diese Datei schlägt fehl |
| 404, 410 | Datei nicht mehr da | nur diese Datei, nächster Lauf prüft neu |
| 409, 412 | gleichzeitig geändert | nur diese Datei, nächster Lauf prüft neu |
| 413 | Datei zu groß | nur diese Datei schlägt fehl |
| 408, 500, 502, 503, 504 | Google gestört | bis zu 6 Versuche, dann Abbruch |
| Anmeldung `invalid_grant` | Zugang widerrufen oder abgelaufen | automatische Synchronisierung pausiert, „neu verbinden“ |
| Anmeldung `invalid_client` | Client-ID oder Secret falsch | wie oben |

Ein Fehler, der länger anhält, wird bei der automatischen Synchronisierung nur einmal gemeldet
und protokolliert, nicht alle zwei Minuten.

**„Community-Plugins synchronisieren“ überträgt Programmcode.** Wer in deinen Drive-Ordner
schreiben kann, kann damit Code auf allen Geräten ausführen. Die Option ist standardmäßig aus; nur
einschalten, wenn dein Google-Konto gut geschützt ist (2-Faktor-Anmeldung).

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
- **Einstellungen (`.obsidian`)** lassen sich optional mitsynchronisieren, siehe unten.
- Umbenennen wird als „alte Datei löschen + neue anlegen“ übertragen.
- Die Statusleiste unten zeigt den Zustand (`☁ ✓ vor 2 Min.`). Ein Klick darauf synchronisiert sofort.
- Befehl: *„Jetzt mit Google Drive synchronisieren“* (auch per Tastenkürzel belegbar).

## Einstellungen, Themes und Plugins synchronisieren

In den Plugin-Einstellungen unter **„Einstellungen (.obsidian) synchronisieren“** einschalten, auf
**jedem** Gerät. Am besten zuerst auf dem Gerät, dessen Einstellungen du behalten willst.
Synchronisieren und danach die anderen Geräte einschalten.

| Bereich | Inhalt |
|---|---|
| Allgemeine Einstellungen | Editor, Dateien & Links, Tastenkürzel, Kern-Plugins, Lesezeichen … |
| Darstellung | Themes und CSS-Snippets |
| Community-Plugins | installierte Plugins, ob sie aktiv sind, und ihre Einstellungen |

- **Nie synchronisiert:** das Fensterlayout (`workspace.json`, `workspace-mobile.json`) und der
  Ordner dieses Plugins (enthält deinen Google-Zugang und den Sync-Status des Geräts).
- **Gleichzeitige Änderungen:** Einstellungsdateien werden **pro Einstellung** zusammengeführt.
  Ändert der Laptop das Theme und das iPad die Schriftgröße, bleibt beides. Wurde *dieselbe*
  Einstellung auf zwei Geräten geändert, gewinnt die neuere. Konfliktkopien oder Markierungen gibt
  es in `.obsidian` nicht, damit die Einstellungen gültig bleiben.
- **Neu laden:** Übernommene Einstellungen wirken erst nach einem Neustart von Obsidian. Das Plugin
  zeigt dann eine Meldung, ein Tipp darauf lädt Obsidian neu.
- **Einzelne Plugins ausnehmen**, z. B. wenn ein Plugin gerätespezifische Einstellungen hat: unter
  „Ausschließen“ eine Zeile wie `.obsidian/plugins/obsidian-git/**` eintragen.
- **Abschalten** löscht nichts, weder lokal noch in Google Drive.

## Sync-Protokoll

Jedes Gerät schreibt ein Protokoll als Notiz nach **`Sync-Protokoll/<Gerätename>.md`**. Weil jedes Gerät
nur seine eigene Datei schreibt, gibt es dabei keine Konflikte. Die Protokolle werden ganz normal
synchronisiert, du kannst also z. B. am Computer nachlesen, was auf dem iPad passiert ist.

```markdown
## 05.11.2026 14:03:12 · ✓ 2,1 s
- ↑ 1 · ↓ 2 · ⚠ 1
- ⚠ Konflikt in der Notiz markiert: [[Einkauf]]
- ↓ heruntergeladen: [[Projekte/Idee]]
- ↓ heruntergeladen: `.obsidian/app.json`
- ↑ hochgeladen: [[Tagebuch/2026-11-05]]
```

- Einträge entstehen nur, wenn etwas übertragen wurde oder ein Fehler auftrat. Neueste stehen oben,
  alte werden automatisch entfernt (max. ca. 500 Zeilen).
- Zugangsdaten (Token, Secret, Verbindungscode) werden nie protokolliert.
- Befehl: **„Sync-Protokoll dieses Geräts öffnen“**. Abschalten und Ordner ändern geht in den Plugin-Einstellungen.

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
- `src/http.ts`: Auswertung der HTTP-Statuscodes (Wiederholen, Abbrechen, Meldung)
- `src/auth.ts`: Google-Anmeldung (OAuth mit PKCE) und Verbindungscode
- `src/config.ts`: welche Dateien aus `.obsidian` synchronisiert werden
- `src/paths.ts`: Prüfung von Pfaden und Namen aus Google Drive
- `src/secrets.ts`: Zugangsdaten im Schlüsselbund von Obsidian
- `src/log.ts`: Sync-Protokoll pro Gerät
- `src/main.ts`: Plugin, Einstellungen, automatische Auslöser

### Neue Version veröffentlichen

1. Version in `manifest.json` und `package.json` erhöhen (z. B. `1.2.0`) und in `versions.json` ergänzen.
2. Committen und auf `main` pushen.

GitHub Actions merkt, dass es zu dieser Version noch kein Release gibt, testet und baut das Plugin
und legt Tag und Release mit `main.js` und `manifest.json` an. BRAT installiert die neue Version
danach automatisch auf allen Geräten. Pushes ohne Versionsänderung erzeugen kein neues Release.
