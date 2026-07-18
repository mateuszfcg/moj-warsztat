# GitHub + GHCR — konfiguracja jednokomendowych aktualizacji

## 1. Prywatne repozytorium

Utwórz prywatne repozytorium `moj-warsztat` i wypchnij do niego kod. Pliki `.env` i `storage/` są ignorowane i nie mogą trafić do repozytorium.

## 2. Publikowanie obrazu

Workflow `.github/workflows/publish.yml` uruchamia testy, a po utworzeniu taga `vX.Y.Z` buduje obraz:

`ghcr.io/TWOJ_LOGIN/moj-warsztat:X.Y.Z`

oraz aktualizuje tag `stable`.

## 3. Dostęp serwera do prywatnego GHCR

Na GitHub utwórz Personal Access Token (classic) z minimalnym zakresem `read:packages`. Na serwerze wykonaj jednorazowo:

```bash
export CR_PAT='TU_WKLEJ_TOKEN'
echo "$CR_PAT" | docker login ghcr.io -u TWOJ_LOGIN --password-stdin
unset CR_PAT
```

Token nie powinien być wpisywany do repozytorium ani do `.env` aplikacji.

## 4. Konfiguracja serwera

Ustaw w `/etc/moj-warsztat/deploy.env`:

```env
APP_DIR=/opt/moj-warsztat
IMAGE_REPO=ghcr.io/TWOJ_LOGIN/moj-warsztat
IMAGE_TAG=stable
HEALTH_URL=http://127.0.0.1:3000/health
```

W `/opt/moj-warsztat/.env` dodaj:

```env
MOJ_WARSZTAT_IMAGE=ghcr.io/TWOJ_LOGIN/moj-warsztat:stable
MOJ_WARSZTAT_DATA_DIR=/opt/moj-warsztat/storage
MOJ_WARSZTAT_HOST_PORT=3000
```

## 5. Aktualizacja

```bash
sudo moj-warsztat-update
```

Można też wskazać konkretną wersję:

```bash
sudo moj-warsztat-update 0.5.0
```

Przed zmianą wykonywany jest backup. Po uruchomieniu nowego kontenera wykonywany jest test `/health`. Gdy test nie przejdzie, skrypt automatycznie wraca do poprzedniego lokalnego obrazu.

Ręczny rollback:

```bash
sudo moj-warsztat-rollback
```

Status:

```bash
sudo moj-warsztat-version
```
