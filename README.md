# Mój Warsztat

Self-hosted aplikacja do obsługi warsztatu samochodowego.

Aktualna wersja: **0.5.0**.

## Najważniejsze moduły

- zlecenia - także bez przypisanego klienta i pojazdu,
- klienci i pojazdy,
- pozycje zleceń, RBH, części, materiały i usługi,
- protokoły przyjęcia i wydania,
- faktury z kwotami netto, VAT i brutto,
- konfiguracja wyglądu dokumentów i logo,
- zadania i terminarz,
- zakupy/WZ, magazyn, katalog części i przygotowanie integracji Auto Partner,
- kasa i raporty z zakresem dat,
- raporty PDF, Excel oraz widok do druku w nowym oknie,
- aktualizacje z GHCR z backupem i automatycznym rollbackiem.

## Tryb developerski

```bash
cp .env.example .env
docker compose up -d --build
```

Domyślnie: `http://localhost:3000`.

## Produkcja

Produkcja korzysta z `compose.prod.yml` i gotowego obrazu z GitHub Container Registry. Serwer produkcyjny nie jest miejscem edycji kodu.

Najważniejsze komendy:

```bash
sudo moj-warsztat-update
sudo moj-warsztat-update 0.5.0
sudo moj-warsztat-rollback
sudo moj-warsztat-version
sudo moj-warsztat-backup
sudo moj-warsztat-restore-local /ścieżka/do/backupu.tar.gz
```

## Dokumentacja

- `docs/INSTALACJA-WINDOWS.pdf`
- `docs/INSTALACJA-SERWERA-LINUX.pdf`
- `docs/AWARYJNE-ODTWORZENIE-SYSTEMU.pdf`
- `docs/DEVELOPMENT-WINDOWS.md`
- `docs/GITHUB-GHCR-SETUP.md`
- `docs/BACKUP.md`
- `docs/SERVER-FIRST-MIGRATION.md`

> Produkcyjny KSeF nadal wymaga osobnego, zweryfikowanego adaptera. Tryb domyślny pozostaje `mock`.
