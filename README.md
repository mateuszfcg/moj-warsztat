# Mój Warsztat

Self-hosted aplikacja do obsługi warsztatu samochodowego.

Aktualna wersja: **0.8.0**.

## Najważniejsze moduły

- zlecenia - także bez przypisanego klienta i pojazdu,
- klienci i pojazdy,
- pozycje zleceń, RBH, części, materiały i usługi,
- protokoły przyjęcia i wydania,
- faktury z kwotami netto, VAT i brutto,
- konfiguracja wyglądu dokumentów i logo,
- zadania i terminarz,
- zakupy/WZ, magazyn, katalog części i przygotowanie integracji Auto Partner,
- kasa i raporty z zakresem dat,
- raporty PDF, Excel oraz widok do druku w nowym oknie,
- aktualizacje z GHCR z backupem i automatycznym rollbackiem.


## Nowości 0.8.0

- pozycje faktur i zleceń edytowane bez osobnych okien, z rabatem na każdej pozycji,
- automatyczne zakończenie zlecenia po wystawieniu powiązanej faktury,
- terminy płatności w dniach i automatyczny termin „dzisiaj” dla gotówki,
- edytowalne stanowiska pracowników i warsztatu oraz rozbudowane role i uprawnienia,
- raporty miesięczne i dodatkowe filtry,
- osobne szablony dokumentów z importem i eksportem JSON,
- podgląd i import archiwalnych dokumentów EPP,
- ekran wersji i bezpiecznie konfigurowanej aktualizacji,
- przygotowanie integracji Auto Partner, Autodata i TecRMI.

## Nowości 0.7.0

- wizualny edytor układu dokumentów PDF z pozycjonowaniem bloków X/Y i przeciąganiem w podglądzie,
- wybór czcionki oraz rozmiaru tekstu,
- własne pola tekstowe, np. BDO, dodatkowe dane firmy i informacje prawne, z możliwością wskazania miejsca na dokumencie,
- dynamiczne znaczniki w polach własnych, m.in. numer dokumentu, klient, pojazd i rachunek bankowy,
- konfigurowalna numeracja zleceń, faktur, korekt, faktur do paragonu, protokołów i dokumentów magazynowych,
- zerowanie numeracji miesięczne, roczne lub numeracja ciągła,
- osobne numery dla nowo tworzonych protokołów.

## Tryb developerski

```bash
cp .env.example .env
docker compose up -d --build
```

Domyślnie: `http://localhost:3000`.

## Produkcja

Produkcja korzysta z `compose.prod.yml` i gotowego obrazu z GitHub Container Registry. Serwer produkcyjny nie jest miejscem edycji kodu.

Najważniejsze komendy:

```bash
sudo moj-warsztat-update
sudo moj-warsztat-update 0.8.0
sudo moj-warsztat-rollback
sudo moj-warsztat-version
sudo moj-warsztat-backup
sudo moj-warsztat-restore-local /ścieżka/do/backupu.tar.gz
```

## Dokumentacja

- `docs/INSTALACJA-WINDOWS.pdf`
- `docs/INSTALACJA-SERWERA-LINUX.pdf`
- `docs/AWARYJNE-ODTWORZENIE-SYSTEMU.pdf`
- `docs/DEVELOPMENT-WINDOWS.md`
- `docs/GITHUB-GHCR-SETUP.md`
- `docs/BACKUP.md`
- `docs/SERVER-FIRST-MIGRATION.md`

> Produkcyjny KSeF nadal wymaga osobnego, zweryfikowanego adaptera. Tryb domyślny pozostaje `mock`.


## Użytkownicy
Właściciel może w Ustawienia → Użytkownicy dodawać konta pracowników, przypisywać role, blokować dostęp i zmieniać hasła.
