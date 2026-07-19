# Aktualizacja do 0.6.0

1. Wykonaj backup produkcji.
2. Opublikuj tag `v0.6.0` i poczekaj na gotowy obraz GHCR.
3. Na serwerze uruchom `sudo moj-warsztat-update 0.6.0`.
4. Sprawdź `sudo moj-warsztat-version` i `curl -fsS http://127.0.0.1:3000/health`.

Migracje SQLite są wykonywane automatycznie przy starcie i zachowują istniejące dane.

Nowe opcjonalne ustawienia SMS w `.env`:

```env
SMS_WEBHOOK_URL=
SMS_WEBHOOK_TOKEN=
SMS_SENDER=MojWarsztat
```

KSeF w tej wersji nadal korzysta z istniejącego adaptera/trybu `mock`, jeśli produkcyjna integracja nie została skonfigurowana.
