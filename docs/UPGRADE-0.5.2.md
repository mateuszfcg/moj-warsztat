# Aktualizacja Mój Warsztat 0.5.1 → 0.5.2

Wersja 0.5.2 naprawia błąd startu SQLite `Cannot add a column with non-constant default` w migracji tabeli użytkowników.

Na Windows skopiuj pliki 0.5.2 do repozytorium, zachowując `.git`, `.env`, `storage/` i `node_modules/`, następnie:

```powershell
docker compose down
docker compose up -d --build
curl.exe http://localhost:3000/health
```

Po teście:

```powershell
git add .
git commit -m "Moj Warsztat 0.5.2 - poprawka migracji SQLite"
git push origin main
git tag -a v0.5.2 -m "Moj Warsztat 0.5.2"
git push origin v0.5.2
```

Na serwerze po zielonej publikacji GHCR:

```bash
sudo moj-warsztat-update 0.5.2
```
