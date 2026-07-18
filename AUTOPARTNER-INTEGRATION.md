# Integracja Auto Partner / AP CAT

## Co jest już gotowe

- osobny dostawca Auto Partner w bazie,
- ekran Katalog części z zakładkami Sprzedaż i WZ,
- wyszukiwanie po kodzie, producencie i nazwie,
- przycisk dodania pozycji do magazynu,
- lista otwartych zleceń i dodawanie części do wybranego zlecenia,
- obsługa dokumentów WZ wprowadzanych do aplikacji,
- model danych przygotowany na kod AP, kod producenta, ceny, VAT, stan i jednostkę,
- ekran ustawień integracji.

## Czego brakuje do połączenia produkcyjnego

Od opiekuna Auto Partner potrzebna jest oficjalna informacja dotycząca:

- dostępnego API, webservice lub innego kanału B2B,
- sposobu autoryzacji,
- środowiska testowego,
- pobierania indywidualnych cen i stanów,
- tworzenia koszyka lub zamówienia,
- pobierania WZ i faktur,
- identyfikatorów części i mapowania danych.

## Wiadomość do opiekuna handlowego

> Dzień dobry, korzystam z AP CAT i tworzę własny program warsztatowy do użytku wewnętrznego. Czy Auto Partner udostępnia dla klientów interfejs API, webservice, TecCom, Integra, Nextis lub inny mechanizm integracyjny do pobierania katalogu, cen indywidualnych, stanów, składania zamówień oraz pobierania WZ i faktur? Proszę o dokumentację techniczną, dane środowiska testowego i informacje o warunkach dostępu.

Nie umieszczaj loginu ani hasła AP CAT w pliku `.env`, dopóki Auto Partner nie wskaże oficjalnego sposobu integracji.
