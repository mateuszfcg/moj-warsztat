# Aktualizacja Mój Warsztat do 0.5.0

## Komputer developerski Windows

1. Zrób kopię lokalnego `.env` i katalogu `storage`.
2. Wgraj pliki wersji 0.5.0 do katalogu repozytorium, nie nadpisując `.env`, `storage` ani `.git`.
3. Uruchom lokalne testy:

```powershell
docker compose up -d --build
curl.exe http://localhost:3000/health
```

4. Zapisz zmiany w Git:

```powershell
git add .
git commit -m "Mój Warsztat 0.5.0"
git push origin main
```

5. Poczekaj na zielony workflow `Testy kodu`.
6. Opublikuj wydanie:

```powershell
git tag -a v0.5.0 -m "Mój Warsztat 0.5.0"
git push origin v0.5.0
```

7. Poczekaj na zielony workflow `Publikacja obrazu Docker`.

## Serwer warsztatowy

Po opublikowaniu obrazu:

```bash
sudo moj-warsztat-update 0.5.0
sudo moj-warsztat-version
```

Aktualizacja wykonuje backup przed wdrożeniem, a w razie błędu testu `/health` próbuje automatycznego rollbacku.
