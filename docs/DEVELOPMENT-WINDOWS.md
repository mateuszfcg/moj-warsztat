# Mój Warsztat — środowisko developerskie Windows

## Założenie

Kod i testy są wykonywane na komputerze z Windows. Serwer warsztatowy nie służy do edycji kodu. Produkcja pobiera wyłącznie gotowy obraz Docker z GitHub Container Registry.

## Narzędzia

Zainstaluj:

1. Git for Windows.
2. Visual Studio Code.
3. Docker Desktop z backendem WSL 2.
4. Opcjonalnie GitHub CLI (`gh`).

Po instalacji sprawdź w PowerShell:

```powershell
git --version
docker version
docker compose version
```

## Pierwsze uruchomienie projektu

```powershell
cd C:\Projekty
git clone https://github.com/TWOJ_LOGIN/moj-warsztat.git
cd moj-warsztat
Copy-Item .env.example .env
notepad .env
docker compose up -d --build
```

Aplikacja developerska: `http://localhost:3000`.

## Codzienna praca

```powershell
git pull
docker compose up -d --build
npm test
```

Po zmianach:

```powershell
git add .
git commit -m "Opis zmiany"
git push
```

## Publikacja wersji

Zmień numer w `package.json`, uruchom testy i utwórz tag:

```powershell
npm test
git add .
git commit -m "Mój Warsztat 0.5.0"
git tag -a v0.5.0 -m "Mój Warsztat 0.5.0"
git push origin main
git push origin v0.5.0
```

GitHub Actions zbuduje obraz i opublikuje tagi `0.5.0`, `0.5` i `stable` w GHCR.
