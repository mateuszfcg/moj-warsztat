# Changelog

## 0.5.2

- Naprawiono błąd startu SQLite `Cannot add a column with non-constant default` podczas migracji tabeli użytkowników.
- Świeża baza i aktualizacja starszej bazy uruchamiają się poprawnie.
- Dane istniejących użytkowników są zachowywane, a pole `updated_at` jest uzupełniane bezpiecznie po migracji.
- Dodano brakujący widok modułu Przechowalnia, wykryty podczas pełnego uruchomienia testów.

## 0.5.1

- Dodano zarządzanie użytkownikami w Ustawieniach.
- Dodano konta pracowników i role: Właściciel, Kierownik, Doradca serwisowy, Mechanik, Księgowość.
- Dodano blokowanie i odblokowywanie kont oraz resetowanie haseł.
- Ochrona ostatniego aktywnego właściciela przed przypadkowym zablokowaniem lub zmianą roli.
- Nieaktywne konta nie mogą się logować i nie są proponowane przy przypisywaniu zadań.

## 0.5.0

- Naprawiono błąd CSRF podczas wgrywania logo w formularzu `multipart/form-data`.
- Naprawiono zapisywanie kolorów i podglądu konfiguracji wyglądu dokumentów.
- Dodano możliwość utworzenia zlecenia bez klienta i bez pojazdu.
- Dodano migrację istniejącej bazy danych, która bezpiecznie dopuszcza puste powiązania klienta i pojazdu w zleceniu.
- Fakturę można wystawić po późniejszym przypisaniu klienta do zlecenia.
- Raporty obsługują zakres dat `od-do`.
- Dodano eksport raportów do PDF i XLSX oraz widok raportu w nowym oknie do druku.
- Dokumenty PDF można otwierać w nowym oknie lub pobierać.
- Przebudowano generator faktur: kompaktowy układ, poprawne łamanie stron oraz bezpieczna stopka bez tworzenia pustych stron.
- Protokoły i faktury pokazują kwoty netto, VAT i brutto.
- Dodano polskie etykiety statusów zleceń, faktur, KSeF, metod płatności i wpisów dziennika zmian.
- Dodano test zapisu konfiguracji dokumentów, uploadu logo z CSRF, zlecenia anonimowego oraz raportów PDF/XLSX.
- Dodano osobny workflow testowy dla zmian na `main`; publikacja obrazu produkcyjnego odbywa się wyłącznie po tagu `vX.Y.Z`.
- Zaktualizowano akcje GitHub używane do pobierania kodu i konfiguracji Node.js.
- Dodano instrukcje PDF dla Windows, serwera Linux i awaryjnego odtworzenia systemu.

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
