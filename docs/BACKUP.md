# Mój Warsztat — backup

## Co jest chronione

- baza SQLite,
- zdjęcia i załączniki,
- wygenerowane PDF-y,
- plik `.env`,
- manifest z obrazem Docker używanym w chwili wykonania kopii.

Baza działa w trybie WAL, dlatego skrypt nie kopiuje jej „na żywo” zwykłym `cp`. Tworzy spójny snapshot SQLite poleceniem `VACUUM INTO`, a następnie pakuje go razem z pozostałymi danymi.

## Backup lokalny

Ręcznie:

```bash
sudo moj-warsztat-backup
```

Domyślny katalog:

`/var/backups/moj-warsztat`

Timer systemd wykonuje backup co 6 godzin. Domyślnie przechowywanych jest 30 najnowszych lokalnych archiwów.

Status timera:

```bash
systemctl list-timers moj-warsztat-backup.timer
```

Log ostatniego wykonania:

```bash
journalctl -u moj-warsztat-backup.service -n 100 --no-pager
```

## Backup poza warsztatem

Skrypt opcjonalnie korzysta z restic. Ustaw `RESTIC_REPOSITORY` oraz dane dostępu w `/etc/moj-warsztat/backup.env`, a hasło repozytorium w `/etc/moj-warsztat/restic-password` z prawami `600`.

Domyślna retencja restic:

- 7 dziennych,
- 4 tygodniowe,
- 12 miesięcznych.

Przy każdym backupie aktualizowana jest polityka retencji. Raz w tygodniu timer wykonuje `restic prune`, a następnie `restic check`, aby usunąć nieużywane dane i sprawdzić integralność repozytorium.

## Zasada 3-2-1

Dla produkcji zalecane są trzy kopie danych na co najmniej dwóch rodzajach nośników, z co najmniej jedną kopią poza warsztatem. Lokalny dysk USB jest dobry do szybkiego odtworzenia, ale nie zastępuje kopii zdalnej.

## Test odtworzenia

Raz w miesiącu wykonaj próbne odtworzenie do osobnego katalogu lub osobnej maszyny. Backup bez testu odtworzenia nie daje pewności, że procedura awaryjna rzeczywiście zadziała.

## Odtworzenie lokalnego backupu

Odtworzenie danych z wybranego archiwum:

```bash
sudo moj-warsztat-restore-local /var/backups/moj-warsztat/moj-warsztat-RRRRMMDD-HHMMSS.tar.gz
```

Przed odtworzeniem skrypt automatycznie wykonuje dodatkowy backup bezpieczeństwa. Odtwarzane są dane aplikacji; bieżący plik `.env` nie jest nadpisywany.
