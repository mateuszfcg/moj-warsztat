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

  if (new URLSearchParams(window.location.search).get('new') === '1') openModal('order-modal');
})();
