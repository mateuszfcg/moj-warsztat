# Mój Warsztat

Self-hosted aplikacja do obsługi warsztatu samochodowego.

Aktualna wersja: **0.4.0**.

## Tryb developerski

```bash
cp .env.example .env
docker compose up -d --build
```

Domyślnie: `http://localhost:3000`.

## Produkcja

Produkcja korzysta z `compose.prod.yml` i gotowego obrazu z GitHub Container Registry. Dzięki temu serwer nie kompiluje aplikacji i nie jest miejscem edycji kodu.

Najważniejsze komendy po skonfigurowaniu serwera:

```bash
sudo moj-warsztat-update
sudo moj-warsztat-rollback
sudo moj-warsztat-version
sudo moj-warsztat-backup
sudo moj-warsztat-restore-local /ścieżka/do/backupu.tar.gz
```

Dokumentacja:

- `docs/DEVELOPMENT-WINDOWS.md`
- `docs/GITHUB-GHCR-SETUP.md`
- `docs/BACKUP.md`
- `docs/SERVER-FIRST-MIGRATION.md`

> KSeF produkcyjny nadal wymaga osobnego, zweryfikowanego adaptera. Tryb domyślny pozostaje `mock`.
