(() => {
  const basePath = document.documentElement.dataset.basePath || '';
  const one = (selector, root = document) => root.querySelector(selector);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const first = modal.querySelector('input:not([type="hidden"]),select,textarea,button');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
  }
  all('[data-open-modal]').forEach(button => button.addEventListener('click', () => openModal(button.dataset.openModal)));
  all('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal'))));
  all('.modal').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) closeModal(modal); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(document.querySelector('.modal:not([hidden])')); });

  const drawer = one('[data-module-drawer]');
  const backdrop = one('[data-drawer-backdrop]');
  const setDrawer = (open) => {
    if (!drawer) return;
    drawer.classList.toggle('open', open);
    backdrop.hidden = !open;
    document.body.classList.toggle('drawer-open', open);
  };
  one('[data-toggle-drawer]')?.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
  one('[data-close-drawer]')?.addEventListener('click', () => setDrawer(false));
  backdrop?.addEventListener('click', () => setDrawer(false));

  const userMenu = one('[data-user-menu]');
  one('[data-toggle-user]')?.addEventListener('click', event => {
    event.stopPropagation();
    userMenu.hidden = !userMenu.hidden;
  });
  document.addEventListener('click', event => {
    if (userMenu && !userMenu.hidden && !userMenu.contains(event.target)) userMenu.hidden = true;
  });

  const decodeButton = one('#decode-vin');
  if (decodeButton) decodeButton.addEventListener('click', async () => {
    const form = decodeButton.closest('form') || document;
    const vinInput = one('[name="vehicle_vin"],#vin', form);
    const result = one('#vin-result', form) || one('#vin-result');
    const vin = vinInput?.value.trim();
    if (!result) return;
    result.classList.remove('hidden');
    result.textContent = 'Rozpoznawanie VIN…';
    try {
      const csrf = one('input[name="_csrf"]', form)?.value || one('input[name="_csrf"]')?.value;
      const response = await fetch(`${basePath}/api/vin/decode`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ vin })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Nie udało się rozpoznać VIN.');
      const data = payload.data;
      for (const key of ['make','model','year','engine','fuel']) {
        const input = one(`[name="vehicle_${key}"]`, form) || one(`#${key}`, form);
        if (input && data[key] && !input.value) input.value = data[key];
      }
      result.textContent = [data.make, data.model, data.year, data.body, data.errorText].filter(Boolean).join(' · ') || 'Dekoder nie zwrócił szczegółów.';
    } catch (error) { result.textContent = error.message; }
  });

  all('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const source = one(button.dataset.copy);
    await navigator.clipboard.writeText(source?.value || source?.textContent || '');
    const old = button.textContent; button.textContent = 'Skopiowano'; setTimeout(() => button.textContent = old, 1200);
  }));

  all('[data-choice-group]').forEach(group => {
    const sync = () => {
      const selected = one('input[type="radio"]:checked', group)?.value;
      all('[data-choice-panel]', group).forEach(panel => panel.hidden = !panel.dataset.choicePanel.split(',').includes(selected));
    };
    all('input[type="radio"]', group).forEach(input => input.addEventListener('change', sync));
    sync();
  });

  const itemType = one('#item-type');
  const laborFields = one('[data-labor-fields]');
  const regularFields = one('[data-regular-fields]');
  const itemPrice = one('#item-price');
  const itemCost = one('#item-cost');
  function syncItemType() {
    if (!itemType) return;
    const labor = itemType.value === 'labor';
    if (laborFields) laborFields.hidden = !labor;
    if (regularFields) regularFields.hidden = labor;
    if (labor && itemPrice && !itemPrice.value) itemPrice.value = itemPrice.dataset.laborRate || '';
    if (labor && itemCost && !itemCost.value) itemCost.value = itemCost.dataset.laborCost || '';
  }
  itemType?.addEventListener('change', syncItemType);
  syncItemType();

  all('[data-price-mode]').forEach(button => button.addEventListener('click', () => {
    const mode = button.dataset.priceMode;
    const url = new URL(window.location.href);
    url.searchParams.set('price', mode);
    window.location.href = url.toString();
  }));

  all('[data-color-input]').forEach(input => input.addEventListener('input', () => {
    document.documentElement.style.setProperty(input.dataset.colorInput, input.value);
    one('.preview-document')?.style.setProperty(input.dataset.colorInput, input.value);
    const row = input.closest('.color-row');
    const textInput = row?.querySelector('input[type="text"],input:not([type])');
    if (textInput) textInput.value = input.value;
  }));

  // Gdy użytkownik wpisze kod HEX ręcznie, aktualizujemy próbnik koloru i podgląd.
  all('.color-row input[type="text"],.color-row input:not([type])').forEach(input => input.addEventListener('input', () => {
    if (!/^#[0-9a-f]{6}$/i.test(input.value)) return;
    const picker = input.closest('.color-row')?.querySelector('input[type="color"]');
    if (picker) {
      picker.value = input.value;
      if (picker.dataset.colorInput) { document.documentElement.style.setProperty(picker.dataset.colorInput, input.value); one('.preview-document')?.style.setProperty(picker.dataset.colorInput, input.value); }
    }
  }));



  all('[data-open-transfer],[data-open-adjust]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.openTransfer || button.dataset.openAdjust;
    const panel = document.getElementById(id);
    if (panel) panel.hidden = !panel.hidden;
  }));

  all('[data-slot-time]').forEach(slot => slot.addEventListener('click', () => {
    const start = slot.dataset.slotTime;
    const endDate = new Date(start);
    endDate.setHours(endDate.getHours() + 1);
    const localIso = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
    const startInput = one('#event-start'); const endInput = one('#event-end'); const resource = one('#event-resource');
    if (startInput) startInput.value = start;
    if (endInput) endInput.value = localIso(endDate);
    if (resource) resource.value = slot.dataset.resourceId;
    openModal('event-modal');
  }));

  all('[data-event-order]').forEach(button => button.addEventListener('click', () => {
    const order = one('#event-order'); const title = one('#event-title');
    if (order) order.value = button.dataset.eventOrder;
    if (title) title.value = button.dataset.eventTitle;
    openModal('event-modal');
  }));

  const storageClient = one('#storage-client');
  const storageVehicle = one('#storage-vehicle');
  const syncStorageVehicles = () => {
    if (!storageClient || !storageVehicle) return;
    const clientId = storageClient.value;
    all('option[data-client-id]', storageVehicle).forEach(option => { option.hidden = Boolean(clientId) && option.dataset.clientId !== clientId; });
    if (storageVehicle.selectedOptions[0]?.hidden) storageVehicle.value = '';
  };
  storageClient?.addEventListener('change', syncStorageVehicles);
  syncStorageVehicles();

  // Wyszukiwalne listy: wpisanie kilku liter filtruje widoczne opcje bez dodatkowej biblioteki.
  all('select[data-searchable-select]').forEach(select => {
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'select-search'; search.placeholder = 'Wpisz, aby wyszukać…'; search.autocomplete = 'off';
    select.parentNode.insertBefore(search, select);
    const options = [...select.options].map(option => ({ option, text: option.textContent.toLocaleLowerCase('pl') }));
    const filter = () => {
      const q = search.value.trim().toLocaleLowerCase('pl'); let matches = 0;
      options.forEach(({ option, text }, index) => { const visible = index === 0 || !q || text.includes(q); option.hidden = !visible; if (visible) matches += 1; });
      select.size = q ? Math.min(7, Math.max(2, matches)) : 1;
      select.classList.toggle('searchable-select-open', Boolean(q));
    };
    search.addEventListener('input', filter);
    select.addEventListener('change', () => { if (select.value) search.value = select.selectedOptions[0]?.textContent || ''; select.size = 1; select.classList.remove('searchable-select-open'); });
    search.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { select.focus(); if (select.options.length > 1) select.selectedIndex = Math.max(1, select.selectedIndex); } });
  });

  // Pola klienta/pojazdu mogą od razu otworzyć formularz dodawania nowej kartoteki.
  all('select[data-create-panel]').forEach(select => {
    const panel = one(select.dataset.createPanel);
    const sync = () => { if (panel) panel.hidden = select.value !== '__new__'; };
    select.addEventListener('change', sync); sync();
  });

  // Zmiana typu pozycji przełącza oddzielną bazę podpowiedzi usług/części/materiałów.
  const itemDescription = one('#item-description');
  const syncSuggestionList = () => {
    if (!itemType || !itemDescription) return;
    itemDescription.setAttribute('list', itemType.value === 'part' ? 'part-suggestions' : itemType.value === 'material' ? 'material-suggestions' : 'service-suggestions');
  };
  itemType?.addEventListener('change', syncSuggestionList); syncSuggestionList();

  // Edycja pozycji faktury przed jej ostatecznym wystawieniem.
  const invoiceTable = one('#invoice-items-table tbody');
  const invoiceTemplate = one('#invoice-row-template');
  one('[data-add-invoice-row]')?.addEventListener('click', () => {
    if (!invoiceTable || !invoiceTemplate) return;
    invoiceTable.appendChild(invoiceTemplate.content.cloneNode(true));
    one('[data-empty-items]')?.remove();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-row]');
    if (button) button.closest('tr')?.remove();
  });


  // v0.8.0 — termin płatności i dynamiczne wiersze pozycji.
  const invoiceForm = one('[data-invoice-form]');
  if (invoiceForm) {
    const issue = one('[data-invoice-issue-date]', invoiceForm);
    const days = one('[data-payment-days]', invoiceForm);
    const due = one('[data-invoice-due-date]', invoiceForm);
    const method = one('[data-payment-method]', invoiceForm);
    const syncDueDate = () => {
      if (!issue || !due || !method) return;
      const base = issue.value ? new Date(`${issue.value}T12:00:00`) : new Date();
      const count = Math.max(0, Number(days?.value || 0));
      if (method.value !== 'cash') base.setDate(base.getDate() + count);
      const y=base.getFullYear(), m=String(base.getMonth()+1).padStart(2,'0'), d=String(base.getDate()).padStart(2,'0');
      due.value = `${y}-${m}-${d}`;
      if (method.value === 'cash' && days) days.value = 0;
    };
    issue?.addEventListener('change', syncDueDate); days?.addEventListener('input', syncDueDate); method?.addEventListener('change', syncDueDate);
  }

  all('[data-add-line-row]').forEach(button => button.addEventListener('click', () => {
    const target = one(button.dataset.addLineRow);
    const template = one(button.dataset.lineTemplate);
    if (target && template) target.appendChild(template.content.cloneNode(true));
  }));

  // v0.7.0 — prosty wizualny edytor położenia bloków dokumentu PDF.
  const designer = one('[data-document-designer] .designer-page');
  if (designer) {
    const coordinateInputs = Object.fromEntries(all('[data-designer-coordinate]').map(input => [input.dataset.designerCoordinate, input]));
    const syncBlockFromInputs = (key) => {
      const block = one(`[data-designer-block="${key}"]`, designer);
      if (!block) return;
      const x = coordinateInputs[`${key}-x`]; const y = coordinateInputs[`${key}-y`];
      const width = coordinateInputs[`${key}-width`]; const height = coordinateInputs[`${key}-height`];
      if (x) block.style.left = `${Number(x.value || 0)}px`;
      if (y) block.style.top = `${Number(y.value || 0)}px`;
      if (width) block.style.width = `${Number(width.value || 0)}px`;
      if (height) block.style.height = `${Number(height.value || 0)}px`;
    };
    all('[data-designer-coordinate]').forEach(input => input.addEventListener('input', () => syncBlockFromInputs(input.dataset.designerCoordinate.split('-')[0])));

    all('[data-designer-block]', designer).forEach(block => {
      block.addEventListener('pointerdown', event => {
        const key = block.dataset.designerBlock;
        const xInput = coordinateInputs[`${key}-x`]; const yInput = coordinateInputs[`${key}-y`];
        if (!xInput && !yInput) return;
        event.preventDefault(); block.setPointerCapture(event.pointerId); block.classList.add('dragging');
        const pageRect = designer.getBoundingClientRect();
        const scaleX = 595 / pageRect.width; const scaleY = 842 / pageRect.height;
        const startX = event.clientX; const startY = event.clientY;
        const initialX = Number(xInput?.value || parseFloat(block.style.left) || 0);
        const initialY = Number(yInput?.value || parseFloat(block.style.top) || 0);
        const move = moveEvent => {
          if (xInput) { const value = Math.max(0, Math.min(560, Math.round(initialX + (moveEvent.clientX - startX) * scaleX))); xInput.value = value; block.style.left = `${value}px`; }
          if (yInput) { const value = Math.max(40, Math.min(760, Math.round(initialY + (moveEvent.clientY - startY) * scaleY))); yInput.value = value; block.style.top = `${value}px`; }
        };
        const up = () => { block.classList.remove('dragging'); block.removeEventListener('pointermove', move); block.removeEventListener('pointerup', up); block.removeEventListener('pointercancel', up); };
        block.addEventListener('pointermove', move); block.addEventListener('pointerup', up); block.addEventListener('pointercancel', up);
      });
    });
  }

  if (new URLSearchParams(window.location.search).get('new') === '1') openModal('order-modal');
})();
