# Aktualizacja Mój Warsztat 0.5.0 → 0.5.1

Wersja 0.5.1 dodaje zarządzanie użytkownikami w `Ustawienia → Użytkownicy i uprawnienia`.

## Test na komputerze developerskim Windows

Po skopiowaniu plików 0.5.1 do lokalnego repozytorium, z zachowaniem `.git`, `.env` i `storage/`:

```powershell
docker compose down
docker compose up -d --build
curl.exe http://localhost:3000/health
```

Endpoint powinien zwrócić wersję `0.5.1`.

## Publikacja

```powershell
git add .
git commit -m "Moj Warsztat 0.5.1 - obsluga uzytkownikow"
git push origin main
```

Po zielonym workflow `Testy kodu`:

```powershell
git tag -a v0.5.1 -m "Moj Warsztat 0.5.1"
git push origin v0.5.1
```

Po zielonym workflow `Publikacja obrazu Docker` aktualizacja serwera:

```bash
sudo moj-warsztat-update 0.5.1
```

## Migracja bazy

Migracja wykonuje się automatycznie przy starcie. Istniejące konto administratora pozostaje aktywne i otrzymuje rolę właściciela. Nie są wymagane ręczne zmiany w bazie.
