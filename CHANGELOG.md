# Changelog

## 0.4.0

- Zmiana nazwy produktu na **Mój Warsztat**.
- Dodanie numeru wersji do endpointu `/health`.
- Dodanie produkcyjnego `compose.prod.yml` korzystającego z gotowych obrazów Docker.
- Dodanie workflow GitHub Actions publikującego obrazy do GitHub Container Registry.
- Dodanie jednokomendowej aktualizacji `moj-warsztat-update`.
- Backup wykonywany automatycznie przed aktualizacją.
- Automatyczny rollback po nieudanym teście `/health`.
- Dodanie `moj-warsztat-rollback` i `moj-warsztat-version`.
- Dodanie spójnych snapshotów SQLite do backupu.
- Dodanie bezpiecznego odtwarzania lokalnego backupu z dodatkową kopią przed restore.
- Dodanie lokalnych backupów rotowanych oraz opcjonalnego zaszyfrowanego backupu restic.
- Dodanie timerów systemd: backup co 6 godzin i cotygodniowy `restic check`.
- Dodanie instrukcji pracy developerskiej na Windows.

## 0.3.0

- Moduły warsztatu, zadań, terminarza, zakupów/WZ, sprzedaży, kasy, katalogu, magazynu, raportów i przechowalni.
- Przygotowanie integracji Auto Partner.
