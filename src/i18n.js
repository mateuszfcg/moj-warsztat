const dictionaries = {
  order: {
    draft: 'Nowe zlecenie', estimate: 'Wycena', approved: 'Zaakceptowane', accepted: 'Zaakceptowane',
    in_progress: 'W trakcie naprawy', ready: 'Gotowy do odbioru', completed: 'Zakończone', cancelled: 'Anulowane'
  },
  invoice: { draft: 'Szkic', issued: 'Wystawiona', sent: 'Wysłana', paid: 'Opłacona', cancelled: 'Anulowana' },
  ksef: {
    not_sent: 'Niewysłana', queued: 'W kolejce', processing: 'Przetwarzanie', sent: 'Wysłana', accepted: 'Przyjęta',
    rejected: 'Odrzucona', error: 'Błąd', blocked: 'Zablokowana', accepted_mock: 'Przyjęta (test)', not_configured: 'Nieskonfigurowana', disabled: 'Wyłączony', mock: 'Tryb testowy', test: 'Test', demo: 'Demo', production: 'Produkcja'
  },
  payment: { transfer: 'Przelew', cash: 'Gotówka', card: 'Karta', other: 'Inna' },
  task: { todo: 'Do zrobienia', in_progress: 'W trakcie', done: 'Zakończone' },
  priority: { urgent: 'Pilne', high: 'Wysoki', normal: 'Normalny', low: 'Niski' },
  stock: { receipt: 'Przyjęcie', issue: 'Wydanie', adjustment: 'Korekta', opening: 'Stan początkowy' },
  purchaseType: { wz: 'WZ', invoice: 'Faktura zakupu', receipt: 'Paragon' },
  action: {
    login: 'Logowanie', logout: 'Wylogowanie', create: 'Utworzenie', update: 'Aktualizacja', upload: 'Wgranie pliku',
    email: 'Wysłanie e-mailem', process: 'Przetworzenie', queue_ksef: 'Dodanie do kolejki KSeF', update_status: 'Zmiana statusu',
    update_price_mode: 'Zmiana sposobu prezentacji cen', public_accept: 'Akceptacja klienta', stock_receipt: 'Przyjęcie do magazynu',
    add_supplier_item_to_order: 'Dodanie części do zlecenia', release: 'Wydanie'
  },
  entity: {
    user: 'Użytkownik', client: 'Klient', vehicle: 'Pojazd', work_order: 'Zlecenie', work_order_item: 'Pozycja zlecenia',
    invoice: 'Faktura', protocol: 'Protokół', settings: 'Ustawienia', settings_logo: 'Logo dokumentów', task: 'Zadanie',
    calendar_event: 'Wydarzenie terminarza', inventory_product: 'Towar magazynowy', purchase_document: 'Dokument zakupu',
    purchase_document_item: 'Pozycja dokumentu zakupu', storage_item: 'Pozycja przechowalni', cash_transaction: 'Operacja kasowa',
    ksef_jobs: 'Kolejka KSeF'
  }
};

function label(group, value) {
  if (value == null || value === '') return '—';
  return dictionaries[group]?.[String(value)] || String(value);
}

module.exports = { label };
