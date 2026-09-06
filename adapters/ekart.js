/* Ekart adapter — v0.4.0
   Selectors verified against the live DOM (app.elite.ekartlogistics.in).
   Suffix matching is used because the "forward-ship_" prefix is the antd
   form name and differs on other shipment forms. */
/** biome-ignore-all lint/complexity/useArrowFunction: ignore */
(function () {

  const SEL = {
    awb_no:              { sel: '[id="order_number"], [id$="_order_number"]',  label: 'Order Number' },
    client_name:         { sel: '[id="customer_name"], [id$="_customer_name"]', label: 'Customer Name' },
    destination_pincode: { sel: '[id="pincode"], [id$="_pincode"]',       label: 'Pincode' },
    actual_wt:           { sel: '[id="parcelWeight"], [id$="_parcelWeight"]',  label: 'Weight' },
    product_value:       { sel: '[id="total_amount"], [id$="_total_amount"]',  label: 'Total Parcel Amount' },
    payment_type:        { sel: '[id="payment_type"], [id$="_payment_type"]',  label: 'Payment Type' },
    cod_charge:          { sel: '[id="cod_amount"], [id$="_cod_amount"]',    label: 'COD Amount' },
    _length:             { sel: '[id$="_package_0_length"]', label: 'Length' },
    _width:              { sel: '[id$="_package_0_width"]',  label: 'Width' },
    _height:             { sel: '[id$="_package_0_height"]', label: 'Height' }
  };

  // Service Type is a radio group ("How do you want to ship your order ?"),
  // not an input, so it is read separately — see HS.radio.
  const RADIO = {
    service_type: {
      sel: '[id="shipment_mode"], [id$="_shipment_mode"]',
      label: 'How do you want to ship your order ?',
      options: ['Express', 'Surface']
    }
  };

  // Only these keys are written back to the sheet. Everything else on the
  // Ekart form (Package Type, Travel Mode) does not exist, so it stays blank
  // and manually editable.
  const CAPTURED = [
    'awb_no', 'client_name', 'destination_pincode', 'service_type',
    'actual_wt', 'product_value', 'payment_type', 'cod_charge', 'volumetric_wt'
  ];

  // Evidence that the user has actually started booking. service_type comes
  // from a radio group that ships with a default selection and volumetric_wt
  // falls back to 0, so neither counts — a freshly loaded page would arm on
  // them alone and create an empty row.
  const ARM_KEYS = CAPTURED.filter(k => k !== 'service_type' && k !== 'volumetric_wt');


  function read() {
    const raw = HS.readAll(SEL);
    const payment = HS.paymentMode(raw.payment_type);  // COD / TOPAY / PREPAID

    return {
      courier:             'EKART',
      awb_no:              raw.awb_no,
      client_name:         raw.client_name,
      destination_pincode: raw.destination_pincode,
      service_type:        HS.radio(RADIO.service_type),  // Express / Surface
      actual_wt:           HS.num(raw.actual_wt),      // grams
      product_value:       HS.num(raw.product_value),
      payment_type:        payment,
      cod_charge:          payment === 'COD' ? HS.num(raw.cod_charge) : '',
      volumetric_wt:       HS.volumetric(raw._length, raw._width, raw._height)
    };
  }

  const ANCHOR = { sel: '[id="order_number"], [id$="_order_number"]', label: 'Order Number' };
  let armed = false;          // becomes true once the user has typed anything

  const filled = o => ARM_KEYS.some(k => o[k] !== '' && o[k] !== null && o[k] !== undefined);
  const sig = o => JSON.stringify(CAPTURED.map(k => o[k]));

  let submitted = false, finalized = false, lastSig = '', lastCapturedAwb = '';

  async function push() {
    if (finalized) return;

    // Form not mounted (navigating away, SPA re-render). Reading now would
    // produce false blanks, so report nothing at all.
    if (!HS.formReady(ANCHOR)) return;

    const o = read();

    // After a successful capture, stay quiet while the same AWB is still on
    // the form so we don't recreate a live row next to the saved one.
    if (lastCapturedAwb) {
      if (o.awb_no && o.awb_no !== lastCapturedAwb) lastCapturedAwb = '';
      else if (!o.awb_no || o.awb_no === lastCapturedAwb) return;
    }

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
    await HS.capture(o, false, CAPTURED, 'EKART', true);
  }

  async function finalize() {
    if (!submitted || finalized) return;
    const o = read();
    if (!o.awb_no) return;
    finalized = true;
    lastCapturedAwb = o.awb_no;
    await HS.capture(o, true, CAPTURED, 'EKART', true);
  }

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
    if (mode === 'RESET') { submitted = false; finalized = false; lastSig = ''; lastCapturedAwb = ''; armed = false; }
  });

  // Page load or refresh: the courier form is empty, so drop the stale draft.
  HS.clearSession('EKART');

  HS.trackFocus(SEL, 'EKART');
  HS.observeForm(push);
  HS.observeButtons(['create shipment'], doSubmit);
})();
