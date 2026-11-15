# SynoUsage

DSM-App für Speicherbelegung, Verlauf und Messdetails. Das Paket ist für DSM 7.1 und die Paketarchitektur `x86_64` gebaut, einschließlich `apollolake` und Virtual DSM (`kvmx64`).

Eine kurze deutsch- und englischsprachige Beschreibung für Anwender steht unter [.github/README.md](.github/README.md).

## Vorschau und Paket bauen

Die Paket-Icons liegen neben `package/INFO`, die DSM-Größen unter `package/ui/images/` und werden beim Build unverändert verwendet. Nach einer Änderung der Icon-Zeichenfunktionen in `scripts/build.py` alle Bilder mit `UPDATE_ICONS.cmd` (alternativ `python scripts/build.py --icons`) neu erzeugen und die geänderten PNG-Dateien einchecken.



`BUILD.cmd` erzeugt in `dist` die eigenständige Browser-Vorschau `SynoUsage-Vorschau.html`, das SPK und seine SHA-256-Datei. Der Build benötigt Go 1.24 oder neuer und Python 3.10 oder neuer. Er verwendet vorhandene Werkzeuge aus dem PATH oder die portablen Werkzeuge aus dem benachbarten SynoWake-Verzeichnis. Mit `-Go` und `-Python` lassen sich eigene Programmpfade angeben.

```powershell
.\BUILD.cmd
# Mit eigenen Programmpfaden
.\BUILD.cmd -Go 'C:\Go\bin\go.exe' -Python 'C:\Python313\python.exe'
```

Die HTML-Datei lässt sich direkt im Browser öffnen. Sie zeigt Beispieldaten für zwei Volumes und simuliert die Registrierung und eine Erfassung. In DSM bleiben die Beispieldaten gekennzeichnet, bis eine erste Messung erfolgreich gespeichert wurde.

## In DSM verwenden

1. Das unsignierte SPK im Paket-Zentrum manuell installieren und SynoUsage aus dem DSM-Hauptmenü mit einem lokalen Administratorkonto öffnen.
2. Über das Zahnrad in der Titelleiste die Erfassungsaufgabe registrieren. Wenn DSM eine Passwortbestätigung verlangt, öffnet SynoUsage den DSM-Passwortdialog. Der voreingestellte Zeitplan ist Montag um 03:00 Uhr und zunächst deaktiviert. Im DSM-Aufgabenplaner lässt er sich aktivieren und auf eine wöchentliche oder monatliche Ausführung einstellen.
3. Mit **Daten aktualisieren** einen Lauf anstoßen. Unter **Aktuell** erscheinen die Messwerte laufend. Die Statusschaltfläche in der Titelleiste öffnet die Laufmeldungen und bietet **Erfassung abbrechen** an. **Erfassung neu starten** beendet den laufenden Scan, speichert den Zwischenstand und startet danach einen neuen Lauf. Der Aufgabenplaner führt die Erfassung auch nach dem Schließen des Fensters weiter.

Das Zahnrad bietet **Aufgabe aktualisieren** für Aufgaben an, die noch das frühere Erfassungsskript verwenden. Die einmalige Umstellung übernimmt Aktivierung und Zeitplan. Danach ruft die Aufgabe den festen Starter unter `/var/packages/h5uSynoUsage/scripts/start-stop-status` auf. Paketupdates liefern den Starter mit der aktuellen Collector-Prüfsumme. Bei einer Namenskollision oder einer geänderten Befehlsfolge verweist SynoUsage auf den Aufgabenplaner. Ist die DSM-Schnittstelle zur Registrierung auf einer Firmware nicht verfügbar, zeigt das Zahnrad den Befehl für die manuelle Registrierung. Die Root-Aufgabe prüft Eigentümer und Schreibrechte des Starters und seines Pfads. Der Starter prüft vor der Ausführung die SHA-256-Summe einer privaten Kopie des Collectors.

## Messwerte

Nach 15 Minuten pro Datenpfad setzt die Erfassung den ersten Durchgang fort. Am Ende erhalten zurückgestellte Pfade bis zu 24 Stunden pro Wiederholung. Bei einem Abbruch speichert SynoUsage die bisherigen Werte als Teilergebnis. Der Verlauf verwendet abgeschlossene Messstände.

- **Aktuell** zeigt die Kapazität aus dem Dateisystem. Für das Diagramm werden die 20 größten auswertbaren Einzelposten zuerst nach Größe gewählt und dann gruppiert. Bei potenziell überlappenden Btrfs-Ordnerwerten zeigt das Diagramm einen Größenvergleich. **Nicht erfasst** zeigt die positive Differenz zwischen der Volume-Belegung und allen gemessenen Posten.
- **Details** trennt belegte Dateiblöcke von logischen Größen. ABBs virtuelle FUSE-Ansichten und andere untergeordnete Mounts bleiben beim Ordnerscan außen vor. Erkannte VMM-Datenträger werden nach Ablagepfad getrennt vom übrigen iSCSI-/SAN-Speicher gemessen. Bei erreichbarem lokalen Docker-Dienst erscheinen Images mit der von Docker gemeldeten Größe und dem Anteil gemeinsam genutzter Schichten. Docker und VMM sind optional.
- **Snapshots nach Quell-Volume** zeigt die Datenblöcke, die ausschließlich erkannte Snapshots halten. Dazu gehören DSM-Snapshots von Freigaben und VM-Datenträgern sowie schreibgeschützte Btrfs-Snapshots von App- und Docker-Subvolumes. Aktive Docker- und Containerd-Layer zählen zu den Live-Referenzen. SynoUsage liest Btrfs-Metadaten und zählt gemeinsam gehaltene Datenblöcke einmal. Die Details zeigen die exklusiv und insgesamt referenzierten Datenblöcke je Snapshot. Falls die Blockmessung fehlschlägt, kann die Summe der exklusiven Einzelwerte aus Btrfs-Quotas eine Untergrenze liefern. Dateisystem-Metadaten bleiben in der übrigen Volume-Belegung.
- **Verlauf** verwendet abgeschlossene Erfassungen. Die Statusdatei und die letzten Laufmeldungen sind auch bei einem laufenden Scan abrufbar. Die Historie liegt als atomar geschriebene JSON-Dateien unter `/var/lib/h5uSynoUsage` und ist auf 120 Messstände und 24 MiB begrenzt. Ansichtsoptionen speichert der Browser.
- **Aufgaben** zeigt oben die im Browser hinterlegten wöchentlichen Arbeitszeiten. Darunter stehen gespeicherte DSM-Ausführungsergebnisse und SynoUsage-Erfassungen mit Dauer und Überschneidungen ab fünf Minuten. Für diese und nächste Woche kommen die nächsten DSM-Termine und die Zeitpläne von Antivirus Essential hinzu, soweit das NAS die Daten liefert. Die Antivirus-Historie liest deutsch- und englischsprachige Start- und Endmeldungen. Bei der Datenbereinigung zeigt der Speicher-Manager auch den letzten Abschluss je Pool. Für einen geplanten Start und einen Abschluss ohne Startzeit ist die Laufdauer unbekannt.
- **System & Speicher** zeigt erkannte Hardware, die Belegung des Root-Dateisystems, Laufwerke und Partitionen sowie deren RAID-, LVM- und Device-Mapper-Beziehungen. Die Übersicht gruppiert Arrays anhand erkannter LVM-Volumengruppen; System- und Swap-Spiegel verbinden dabei keine sonst getrennten Gruppen. Ungeklärte Volume- und Cache-Zuordnungen bleiben offen. Je Volume erscheinen die drei größten erkannten Freigaben und App-Posten. Die Angaben werden bei der Erfassung lesend aus Linux-Systeminformationen und, falls verfügbar, `pvs`, `lvs` und `synopartition --list` ermittelt und separat als letzter Stand gespeichert. Die Synology-Tabelle enthält mögliche Vorlagen und belegt nicht, welches Layout aktiv ist. Laufwerksplätze, Cache-Funktion und RAM-Riegel werden nicht geraten; fehlende Informationen bleiben offen. Nicht partitionierter Platz ist nicht zwangsläufig für einen Speicherpool verfügbar.

Der Prototyp verwendet die native DSM-Sitzung für den Aufgabenplaner und zeigt den Erfassungsstatus im App-Fenster. Installation und Erfassung wurden auf einer DS918+ mit DSM 7.1.1 und 7.2.2 erprobt; auf einem DSM-7.2.2-System war die manuelle Registrierung der Aufgabe erforderlich. Weitere Tests, insbesondere mit Virtual DSM und neueren DSM-Versionen, stehen aus.
