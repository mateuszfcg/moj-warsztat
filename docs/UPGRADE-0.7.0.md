# Aktualizacja Mój Warsztat do 0.7.0

Wersja 0.7.0 jest aktualizacją zgodną z bazą danych 0.6.0. Przy pierwszym uruchomieniu aplikacja automatycznie dodaje tabelę liczników numeracji oraz pole numeru protokołu.

## Przed aktualizacją

1. Wykonaj backup: `sudo moj-warsztat-backup`.
2. Opublikuj obraz `ghcr.io/mateuszfcg/moj-warsztat:0.7.0` przez tag Git `v0.7.0`.
3. Na serwerze uruchom: `sudo moj-warsztat-update 0.7.0`.
4. Sprawdź: `sudo moj-warsztat-version` oraz `curl http://127.0.0.1:3000/health`.

## Po aktualizacji

Wejdź w **Ustawienia → Edytor dokumentów** i ustaw układ PDF. Następnie przejdź do **Ustawienia → Numeracja dokumentów** i sprawdź wzorce numerów przed wystawieniem pierwszego nowego dokumentu.

Historyczne protokoły nie są automatycznie renumerowane. Nowe protokoły otrzymują numery zgodne z ustawionym wzorcem.
