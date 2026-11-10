# SynoUsage

DSM-App für Speicherbelegung, Verlauf und Messdetails. Die erste Paketversion ist für die DS918+ mit DSM 7.1 und die Paketarchitektur `apollolake` gebaut.

## Vorschau und Paket bauen

`BUILD.cmd` erzeugt in `dist` die eigenständige Browser-Vorschau `SynoUsage-Vorschau.html`, das SPK und seine SHA-256-Datei. Der Build benötigt Go 1.24 oder neuer und Python 3.10 oder neuer. Er verwendet vorhandene Werkzeuge aus dem PATH oder die portablen Werkzeuge aus dem benachbarten SynoWake-Verzeichnis. Mit `-Go` und `-Python` lassen sich eigene Programmpfade angeben.

```powershell
.\BUILD.cmd
# Mit eigenen Programmpfaden
.\BUILD.cmd -Go 'C:\Go\bin\go.exe' -Python 'C:\Python313\python.exe'
```

Die HTML-Datei lässt sich direkt im Browser öffnen. Sie zeigt Beispieldaten für zwei Volumes und simuliert die Registrierung und eine Erfassung. In DSM bleiben die Beispieldaten gekennzeichnet, bis eine erste Messung erfolgreich gespeichert wurde.

## In DSM verwenden

1. Das unsignierte SPK im Paket-Zentrum manuell installieren und SynoUsage aus dem DSM-Hauptmenü mit einem lokalen Administratorkonto öffnen.
2. Über das Zahnrad in der Titelleiste die Erfassungsaufgabe registrieren. Der voreingestellte Zeitplan ist Montag um 03:00 Uhr und zunächst deaktiviert. Im DSM-Aufgabenplaner lässt er sich aktivieren und auf eine wöchentliche oder monatliche Ausführung einstellen.
3. Mit **Daten aktualisieren** einen Lauf anstoßen. Die Statusschaltfläche in der Titelleiste öffnet die letzten Laufmeldungen. Die Erfassung läuft im Aufgabenplaner weiter, wenn das Fenster geschlossen wird oder man sich abmeldet.

Das Zahnrad bietet **Aufgabe aktualisieren** an, wenn die Prüfsumme des Erfassungsskripts aus einer älteren Paketversion stammt. Die vorhandene Aktivierung und der Zeitplan werden übernommen. Bei einer Namenskollision oder einer geänderten Befehlsfolge verweist SynoUsage auf den Aufgabenplaner. Ist die DSM-Schnittstelle zur Registrierung auf einer Firmware nicht verfügbar, zeigt das Zahnrad den Befehl für die manuelle Registrierung. Das Root-Skript prüft die SHA-256-Summe einer privaten Kopie des Collectors vor jedem Start.

## Messwerte

- **Aktuell** zeigt die Kapazität aus dem Dateisystem. Für das Diagramm werden die 20 größten auswertbaren Einzelposten zuerst nach Größe gewählt und dann gruppiert. Bei potenziell überlappenden Btrfs-Ordnerwerten zeigt das Diagramm einen Größenvergleich. Die tatsächliche Volume-Belegung bleibt separat sichtbar.
- **Details** trennt belegte Dateiblöcke von logischen Größen. ABBs virtuelle FUSE-Ansichten und andere untergeordnete Mounts bleiben beim Ordnerscan außen vor. Erkannte VMM-Datenträger werden nach Ablagepfad getrennt vom übrigen iSCSI-/SAN-Speicher gemessen. Bei erreichbarem lokalen Docker-Dienst erscheinen Images mit der von Docker gemeldeten Größe und dem Anteil gemeinsam genutzter Schichten. Docker und VMM sind optional.
- **Snapshots** werden soweit möglich ihrer Freigabe, App oder VM-Platte zugeordnet. Pro Snapshot erscheinen die exklusiven und referenzierten Btrfs-Qgroup-Bytes, sofern das Dateisystem sie liefert. Die Summe exklusiver Einzelwerte ist eine Untergrenze, da mehrere Snapshots Blöcke untereinander teilen können.
- **Verlauf** verwendet abgeschlossene Erfassungen. Die Statusdatei und die letzten Laufmeldungen sind auch bei einem laufenden Scan abrufbar. Die Historie liegt als atomar geschriebene JSON-Dateien unter `/var/lib/h5uSynoUsage` und ist auf 120 Messstände und 24 MiB begrenzt. Ansichtsoptionen speichert der Browser.

Der Prototyp verwendet die native DSM-Sitzung für den Aufgabenplaner und zeigt den Erfassungsstatus im App-Fenster. Der Paketaufbau und die Abläufe sind lokal geprüft. Registrierung und erste Messung auf der DS918+ sind noch zu prüfen.
