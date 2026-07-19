# Changelog

## 0.8.0

- Przebudowano dodawanie pozycji faktur i zleceń: pierwszy pusty wiersz jest dostępny od razu, kolejne pozycje dodaje się bez osobnego okna.
- Dodano rabat procentowy osobno dla każdej pozycji zlecenia i faktury; rabat jest uwzględniany w podsumowaniach i PDF.
- Dodano liczbę dni do płatności; przy płatności gotówką termin płatności jest równy dacie wystawienia.
- Po wystawieniu faktury powiązanej ze zleceniem zlecenie automatycznie otrzymuje status „Zakończone”.
- Rozbudowano protokoły o stan paliwa, przebieg, listę stanu pojazdu i możliwość usuwania protokołu.
- Rozbudowano tworzenie i edycję zleceń o niezależny wybór klienta i pojazdu oraz dodawanie nowych kartotek z poziomu formularza.
- Uporządkowano szybki pasek nawigacji i zmieniono go w kafelkowy pasek modułów.
- Rozbudowano publiczną akceptację kosztorysu i dodano oddzielny szablon ustawień dla widoku akceptacji.
- Rozbudowano graficzny edytor dokumentów o osobne konfiguracje typów dokumentów oraz import i eksport szablonów JSON.
- Dodano edycję stanowisk pracowników i stanowisk warsztatowych.
- Rozbudowano użytkowników o stanowiska, szczegółowe uprawnienia, prowizję i koszt miesięczny oraz dodano odzyskiwanie hasła przez jednorazowy link e-mail.
- Rozbudowano raporty o filtrowanie po kliencie, pojeździe i usłudze/części, miesięczne przychody i rozchody oraz szacunkowe rozliczenie pracowników.
- Dodano podgląd i bezpieczny import archiwum EPP do oddzielnych tabel historii migracji; opcjonalnie można utworzyć brakujące kartoteki kontrahentów.
- Dodano ekran wersji i aktualizacji. Aktualizacja z panelu działa wyłącznie po jawnej konfiguracji bezpiecznego polecenia po stronie serwera.
- Rozszerzono ustawienia integracji o przygotowanie adapterów Auto Partner, Autodata i TecRMI. Produkcyjne połączenia wymagają danych dostępowych i dokumentacji dostawców.
- Ustawienia prowadzą teraz do ekranów konfiguracji, a nie bezpośrednio do modułów operacyjnych.
- Dodano i zaktualizowano testy regresji; zestaw wersji 0.8.0 obejmuje 15 testów przepływów aplikacji.

## 0.7.0

- Dodano rozbudowany edytor dokumentów PDF z wizualnym podglądem strony A4.
- Bloki logo, tytułu, sprzedawcy, nabywcy, danych dokumentu i rachunku bankowego można pozycjonować współrzędnymi X/Y; w podglądzie można je również przeciągać myszą.
- Dodano konfigurację szerokości i wysokości głównych bloków oraz położenia początku tabeli pozycji.
- Dodano wybór rodziny czcionek: DejaVu Sans, Helvetica, Times i Courier.
- Dodano do 10 własnych pól tekstowych z niezależnym położeniem, szerokością, rozmiarem, stylem i wyborem typu dokumentu.
- Własne pola obsługują znaczniki dynamiczne, m.in. dane firmy, klienta, pojazdu, numer dokumentu i rachunek bankowy.
- Generator faktur i protokołów korzysta z zapisanego układu dokumentów.
- Dodano konfigurowalną numerację z osobnymi wzorcami dla zleceń, faktur, korekt, faktur do paragonu, protokołów oraz dokumentów WZ/PZ.
- Numeracja obsługuje tokeny {PREFIX}, {YYYY}, {YY}, {MM}, {DD}, {N}, {NN}, {NNN}, {NNNN} oraz zerowanie miesięczne, roczne lub brak zerowania.
- Nowo tworzone protokoły otrzymują własne numery dokumentów; historyczne protokoły pozostają bez automatycznej zmiany numeru.
- Dodano osobny ekran Ustawienia → Numeracja dokumentów.
- Rozszerzono testy regresji do 13 przypadków, w tym zapis zaawansowanego układu, render PDF i konfigurowalną numerację.

## 0.6.0

- Faktury można tworzyć bez zlecenia.
- Faktura utworzona ze zlecenia powstaje jako szkic i przed wystawieniem można edytować numer, klienta, daty, płatność, rabat oraz wszystkie pozycje.
- Dodano faktury do paragonu z ręcznym numerem paragonu oraz tworzenie korekt.
- Dodano rabat procentowy do zleceń, kosztorysów, faktur i podsumowań protokołów.
- Uproszczono obsługę KSeF do jednego przycisku „Wyślij do KSeF”; status pozostaje widoczny na liście sprzedaży.
- Dodano wysyłkę e-mail i opcjonalne powiadomienia SMS przez konfigurowalny webhook.
- Dodano edycję protokołów; edycja zwiększa numer wersji i cofa wcześniejszy podpis.
- Dodano protokół dodatkowych kosztów tworzony w trakcie naprawy.
- Na protokołach rozdzielono usługi/robociznę od części/materiałów.
- Dodano listę stanu pojazdu i usunięto pole „Podpisujący” z formularzy.
- Dodano podstawowe zapisy ochronne warsztatu do protokołów.
- Dodano przyciski drukowania/PDF dla zleceń, wycen, faktur i protokołów.
- Klient i pojazd w zleceniu są wybierane niezależnie; podczas edycji można utworzyć nowego klienta i pojazd.
- Podczas dodawania pojazdu można utworzyć nowego klienta.
- Dodano wykrywanie możliwych duplikatów klientów oraz pojazdów po VIN i numerze rejestracyjnym.
- Dodano poziomy pasek szybkiej nawigacji: Pulpit, Zlecenia, Pojazdy, Klienci, Sprzedaż.
- Dodano wyszukiwalne listy wyboru oraz samouczącą bazę podpowiedzi nazw usług, części i materiałów.
- Poprawiono publiczny widok akceptacji kosztorysu, który pokazuje pełne dane kosztorysu i rabat.
- Dodano 11 testów przepływów i regresji; wszystkie przechodzą w środowisku testowym.

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
