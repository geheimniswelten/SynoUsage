@echo off
rem Projektbezogene Einstellungen fuer RELEASE.cmd
set "REPO=geheimniswelten/SynoUsage"
set "REMOTE=origin"
set "TITLE_TEMPLATE=SynoUsage {VERSION}"
set "NOTES_DEFAULT=Fehlerkorrekturen und Verbesserungen."
set "ASSET_MASK=dist\h5uSynoUsage-{VERSION}-*.spk*"
set "VERSION_FILE=package\INFO"
set "VERSION_FORMAT=info"
set "VERSION_TRIM_BUILD=0"
set "TAG_PREFIX=v"
