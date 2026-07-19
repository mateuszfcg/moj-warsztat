# Aktualizacja Mój Warsztat do 0.8.0

Wersja 0.8.0 jest zgodna z danymi wersji 0.7.0. Migracje SQLite są wykonywane automatycznie podczas startu aplikacji. Nie usuwaj katalogu `storage` ani produkcyjnego pliku `.env`.

## Zalecana procedura

1. Wykonaj backup: `sudo moj-warsztat-backup`.
2. Opublikuj obraz `ghcr.io/mateuszfcg/moj-warsztat:0.8.0` przez tag Git `v0.8.0`.
3. Połącz się z serwerem przez Tailscale/SSH.
4. Uruchom: `sudo moj-warsztat-update 0.8.0`.
5. Sprawdź: `sudo moj-warsztat-version` oraz `curl -f http://127.0.0.1:3000/health`.

W razie problemów użyj `sudo moj-warsztat-rollback`.

## Nowe migracje

Aplikacja dodaje m.in. rabaty pozycji, terminy płatności, stanowiska pracowników, uprawnienia, szablony dokumentów oraz tabele archiwalnego importu danych. Istniejące rekordy pozostają zachowane.
