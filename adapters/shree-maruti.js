/* Shree Maruti adapter — v0.4.0
   Selectors verified against the live DOM (bookings.innofulfill.com).
   Also an antd app; IDs here are plain and unprefixed.
   clientName / shipmentType / service / travelBy are antd selects — their
   value lives in .ant-select-selection-item, not in the input. */
(function () {

  const SEL = {
    awb_no:              { sel: '#documentNumber',   label: 'Document Number' },
    client_name:         { sel: '#clientName',       label: 'Client' },
    destination_pincode: { sel: '#deliveryPincode',  label: 'Delivery PIN code' },
    service_type:        { sel: '#service',          label: 'Service' },
    package_type:        { sel: '#shipmentType',     label: 'Type' },
    travel_mode:         { sel: '#travelBy',         label: 'Travel by' },
    actual_wt:           { sel: '#weight',           label: 'Weight(Gms)' },
    product_value:       { sel: '#value',            label: 'Value (INR)' }
  };

  // Payment Type / COD Amount do not exist on this form, so they stay blank
  // and manually editable. Same for volumetric (no L/W/H fields here).
  const CAPTURED = [
    'awb_no', 'client_name', 'destination_pincode',
    'service_type', 'package_type', 'travel_mode',
    'actual_wt', 'product_value', 'volumetric_wt'
  ];

  function read() {
    const raw = HS.readAll(SEL);
    return {
      courier:             'SHREE MARUTI',
      awb_no:              raw.awb_no,
      client_name:         raw.client_name,
      destination_pincode: raw.destination_pincode,
      service_type:        raw.service_type,
      package_type:        raw.package_type,
      travel_mode:         raw.travel_mode,
      actual_wt:           HS.num(raw.actual_wt),   // grams
      product_value:       HS.num(raw.product_value),
      payment_type:        '',
      cod_charge:          '',
      volumetric_wt:       0   // no L/W/H fields on this form
    };
  }

  const ANCHOR = { sel: '#documentNumber', label: 'Document Number' };
  let armed = false;          // becomes true once the user has typed anything

  const filled = o => CAPTURED.some(k => o[k] !== '' && o[k] !== null && o[k] !== undefined);
  const sig = o => JSON.stringify(CAPTURED.map(k => o[k]));

  let submitted = false, finalized = false, lastSig = '';

  async function push() {
    if (finalized) return;

    // Form not mounted (navigating away, SPA re-render). Reading now would
    // produce false blanks, so report nothing at all.
    if (!HS.formReady(ANCHOR)) return;

    const o = read();

    // Before the first real input, stay quiet so a freshly loaded page
    // doesn't create an empty row.
    if (!armed) {
      if (!filled(o)) return;
      armed = true;
    }

    const s = sig(o);
    if (s === lastSig) return;
    lastSig = s;

    // authoritative: the form is mounted, so this is the truth including
    // deliberately cleared fields.
    await HS.capture(o, false, CAPTURED, 'SHREE MARUTI', true);
  }

  async function finalize() {
    if (!submitted || finalized) return;
    const o = read();
    if (!o.awb_no) return;
    finalized = true;
    await HS.capture(o, true, CAPTURED, 'SHREE MARUTI', true);
  }

  // one submit path, shared by the real button and the test button
  async function doSubmit() {
    submitted = true;
    await push();
    let n = 0;
    const t = setInterval(async () => {
      n++; await finalize();
      if (finalized || n > 100) clearInterval(t);
    }, 200);
  }

  HS.onControl(mode => {
    if (mode === 'RESET') { submitted = false; finalized = false; lastSig = ''; armed = false; return; }
    if (mode === 'TEST_SUBMIT') {
      const o = read();
      if (!o.awb_no) return { ok: false, reason: 'no awb on the form yet' };
      doSubmit();
      return { ok: true };
    }
  });

  // Page load or refresh: the courier form is empty, so drop the stale draft.
  HS.clearSession('SHREE MARUTI');

  HS.trackFocus(SEL, 'SHREE MARUTI');
  HS.observeForm(push);
  HS.observeButtons(['confirm booking'], doSubmit);
})();
