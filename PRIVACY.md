# Datenschutzerklärung – claude-obsidian-sync

Stand: November 2026

## Wer ist verantwortlich?

Dieses Obsidian-Plugin („Google Drive Vault Sync“) ist ein privates Projekt von
4ndr345geo (<https://github.com/4ndr345geo>). Es wird nur für den eigenen Gebrauch
betrieben.

## Welche Daten verarbeitet das Plugin?

- **Notizen und Anhänge deines Obsidian-Vaults.** Sie werden direkt von deinem Gerät
  in **dein eigenes Google Drive** übertragen und von dort auf deine anderen Geräte geladen.
- **Anmeldedaten für Google** (OAuth-Token). Sie werden nur lokal auf deinen Geräten
  gespeichert: im Schlüsselbund von Obsidian (ab Obsidian 1.11.4), sonst unverschlüsselt in
  den Einstellungen des Plugins im Vault-Ordner.

- **Lokale Sicherungen.** Frühere Versionen von Dateien, die die Synchronisierung
  überschreibt oder löscht, werden nur auf dem jeweiligen Gerät im Ordner
  `.obsidian/sync-history` gespeichert (standardmäßig 30 Tage) und nicht übertragen. Der Ordner
  bleibt nach dem Deinstallieren erhalten und kann von Hand gelöscht werden.

## Zugriff auf Google Drive

Das Plugin nutzt ausschließlich die Berechtigung
`https://www.googleapis.com/auth/drive.file`. Damit kann es **nur Dateien sehen und
ändern, die es selbst angelegt hat**. Auf andere Dateien in deinem Google Drive hat es
keinen Zugriff.

## Weitergabe von Daten

Es gibt **keinen Server des Entwicklers**. Daten werden nicht an den Entwickler oder an
Dritte übertragen, nicht ausgewertet, nicht verkauft und nicht für Werbung genutzt. Die
einzige Verbindung besteht zwischen deinem Gerät und Google (Google Drive API,
Google-Anmeldung). Dafür gilt die Datenschutzerklärung von Google:
<https://policies.google.com/privacy>

## Nutzung von Google-Nutzerdaten

Die Verwendung von Daten, die über Google-APIs empfangen werden, entspricht der
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
einschließlich der Anforderungen zur eingeschränkten Nutzung („Limited Use“).

## Löschen

- Plugin in Obsidian deinstallieren bzw. „Verbindung trennen“ entfernt die lokalen Anmeldedaten.
- Den Zugriff widerrufen kannst du jederzeit unter <https://myaccount.google.com/permissions>.
- Die synchronisierten Dateien liegen im Ordner „Obsidian – …“ in deinem Google Drive
  und können dort gelöscht werden.

## Kontakt

Über die Issues dieses Repositorys: <https://github.com/4ndr345geo/claude-obsidian-sync/issues>
