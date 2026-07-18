# Pierwsze przejście z wersji budowanej lokalnie do aktualizacji z GHCR

Ta operacja jest jednorazowa. Przed rozpoczęciem aplikacja powinna działać i mieć aktualny backup.

1. Na serwerze utwórz `/opt/moj-warsztat` i przenieś tam produkcyjny `.env`, `storage/` oraz `compose.prod.yml`.
2. Skopiuj katalog `deployment/server/` i uruchom:

```bash
sudo bash deployment/server/install-management.sh
```

3. Uzupełnij `/etc/moj-warsztat/deploy.env` i `/etc/moj-warsztat/backup.env`.
4. Zaloguj Docker do prywatnego GHCR.
5. Wykonaj pierwszy ręczny backup:

```bash
sudo moj-warsztat-backup
```

6. Uruchom wersję z rejestru:

```bash
sudo moj-warsztat-update 0.5.0
```

Od tego momentu kolejne wydania można wdrażać przez `sudo moj-warsztat-update`.
