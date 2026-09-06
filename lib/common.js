/* Hisaabsathi Capture library — v0.4.0
   Deterministic, ID-based reading. No fuzzy label matching.
   Both Ekart and Shree Maruti are Ant Design (React) apps, so the same
   reader works for both: plain inputs expose a live .value, antd selects
   keep their displayed value in .ant-select-selection-item[title]. */
(function () {
  const H = {

    /* ---------- reading ---------- */

    // The visible value of an antd control.
    // Order matters: a select's <input> is always empty, so the select
    // branch has to win before we ever look at .value.
    value(el) {
      if (!el) return '';

      // antd select (rc-select): value lives in the selection-item span
      const wrap = el.closest && el.closest('.ant-select');
      if (wrap) {
        const item = wrap.querySelector('.ant-select-selection-item');
        if (item) return (item.getAttribute('title') || item.textContent || '').trim();
        // No selection-item. Two cases share this markup:
        //   AutoComplete — free text lives in the input itself
        //   Select with nothing chosen — input is readonly and empty
        // Reading .value covers the first and returns '' for the second.
        return ('value' in el) ? String(el.value ?? '').trim() : '';
      }

      // native select (neither portal uses these today, but harmless)
      if (typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement) {
        return String(el.options[el.selectedIndex]?.text ?? '').trim();
      }

      // plain input / textarea — .value is the live React value.
      // getAttribute('value') would return the *initial* value; never use it.
      if ('value' in el) return String(el.value ?? '').trim();

      return String(el.textContent ?? '').trim();
    },

    // Resolve a field spec to an element.
    // spec is either a CSS selector, or {sel, label} where label is the exact
    // text of the field's <label>. Two failure modes are handled here:
    //   - several elements match the selector (hidden duplicates, other form
    //     sections): prefer a visible one that actually holds a value
    //   - the id changed: fall back to label[for], which is deterministic
    resolve(spec) {
      const sel = typeof spec === 'string' ? spec : spec && spec.sel;
      const label = typeof spec === 'object' && spec ? spec.label : '';

      let list = [];
      try { list = sel ? [...document.querySelectorAll(sel)] : []; } catch { list = []; }

      if (list.length > 1) {
        const visible = list.filter(e => e.offsetParent !== null || e.getClientRects().length);
        const pool = visible.length ? visible : list;
        const valued = pool.filter(e => 'value' in e);
        const cands = valued.length ? valued : pool;
        return cands.find(e => this.value(e) !== '') || cands[0];
      }
      if (list.length === 1) return list[0];

      if (label) {
        const want = this.normalize(label);
        for (const l of document.querySelectorAll('label')) {
          const t = this.normalize(l.getAttribute('title') || l.textContent);
          if (t !== want) continue;

          const id = l.getAttribute('for');
          const el = id && document.getElementById(id);
          if (el) return el;

          // label[for] points at an element that no longer exists (Ekart
          // renames inputs but leaves the label stale). Fall back to the
          // control inside this label's own antd form-item. Scoped to that
          // one field, so it can't drift onto a neighbouring column.
          const item = l.closest('.ant-form-item');
          if (!item) continue;
          const controls = [...item.querySelectorAll('input,textarea,select')]
            .filter(c => !/dummyinput/i.test(c.className || ''));
          if (!controls.length) continue;
          const visible = controls.filter(c => c.offsetParent !== null || c.getClientRects().length);
          const pool = visible.length ? visible : controls;
          return pool.find(c => this.value(c) !== '') || pool[0];
        }
      }
      return null;
    },

    read(spec) {
      return this.value(this.resolve(spec));
    },

    // The visible text of one radio option. antd wraps the input in a
    // <label class="ant-radio-wrapper"> whose only text is the option label,
    // so textContent is exact; native markup needs label[for].
    radioText(input) {
      if (!input) return '';
      const wrap = input.closest('.ant-radio-wrapper') || input.closest('label');
      const t = wrap && wrap.textContent.replace(/\s+/g, ' ').trim();
      if (t) return t;
      if (input.id) {
        const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l) return l.textContent.replace(/\s+/g, ' ').trim();
      }
      return String(input.value ?? '').trim();
    },

    // Read the checked option of a radio group. Radios carry no id we can
    // rely on, so spec is tried in order:
    //   sel     — CSS selector for the group container (or one of its radios)
    //   label   — exact text of the group's label, punctuation ignored
    //   options — the option texts we expect; matches the one that is checked
    // The options pass is what keeps this working when the portal renames
    // its form item, and it can only ever return a value we already know.
    radio(spec) {
      const sel = typeof spec === 'string' ? spec : spec && spec.sel;
      const label = (typeof spec === 'object' && spec && spec.label) || '';
      const slim = s => this.normalize(s).replace(/[^a-z0-9]+/g, ' ').trim();
      const options = (typeof spec === 'object' && spec && Array.isArray(spec.options))
        ? spec.options.map(slim) : [];

      const pick = scope => {
        const on = scope && scope.querySelector('input[type="radio"]:checked');
        return on ? this.radioText(on) : '';
      };

      if (sel) {
        let list = [];
        try { list = [...document.querySelectorAll(sel)]; } catch { list = []; }
        for (const el of list) {
          const scope = el.matches('input[type="radio"]')
            ? (el.closest('.ant-radio-group') || el.parentElement)
            : el;
          const v = pick(scope);
          if (v) return v;
        }
      }

      if (label) {
        const want = slim(label);
        for (const l of document.querySelectorAll('label,legend,.ant-form-item-label')) {
          if (slim(l.getAttribute('title') || l.textContent) !== want) continue;
          const v = pick(l.closest('.ant-form-item') || l.parentElement);
          if (v) return v;
        }
      }

      if (options.length) {
        for (const input of document.querySelectorAll('input[type="radio"]:checked')) {
          const t = this.radioText(input);
          if (options.includes(slim(t))) return t;
        }
      }
      return '';
    },

    // Read a whole map of {key: selector} in one pass.
    readAll(map) {
      const out = {};
      for (const k in map) out[k] = this.read(map[k]);
      return out;
    },

    num(v) {
      const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : '';
    },

    // The sheet accepts only COD / TOPAY / PREPAID, but the portals phrase it
    // however they like ("Cash/Card on Delivery", "Pre-paid", "To Pay").
    // Order matters: "to pay" contains "pay", so TOPAY is tested first.
    paymentMode(text) {
      const t = this.normalize(text).replace(/\./g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) return '';

      if (/\b(to ?pay|topay|freight collect|receiver pays?)\b/.test(t)) return 'TOPAY';
      if (/\b(cod|cash|card on delivery|collect on delivery|pay on delivery|delivery payment)\b/.test(t)) return 'COD';
      if (/\b(prepaid|pre paid|prepay|pre pay|prepared|paid|online|advance)\b/.test(t)) return 'PREPAID';

      // Unrecognised wording: pass it through in caps rather than silently
      // dropping it, so a wrong value is visible in the sheet.
      return t.toUpperCase();
    },

    // Volumetric weight = L x W x H, only when all three are present.
    // Any missing or non-numeric dimension gives 0.
    volumetric(l, w, h) {
      const a = this.num(l), b = this.num(w), c = this.num(h);
      if (a === '' || b === '' || c === '') return 0;
      if (!(a > 0 && b > 0 && c > 0)) return 0;
      return a * b * c;
    },

    normalize(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); },

    /* ---------- watching ---------- */

    observeForm(callback) {
      let timer = 0;
      const fire = () => { clearTimeout(timer); timer = setTimeout(callback, 120); };
      ['input', 'change', 'blur', 'keyup', 'click'].forEach(e => {
        document.addEventListener(e, fire, true);
      });
      // antd writes the chosen option by swapping the placeholder span for
      // .ant-select-selection-item, so childList/class changes matter here.
      new MutationObserver(fire).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['value', 'title', 'class', 'aria-activedescendant']
      });
      fire();
      setInterval(fire, 500);
    },

    observeButtons(words, callback) {
      const want = words.map(w => this.normalize(w));
      const bind = () => {
        document.querySelectorAll('button,input[type="submit"],[role="button"]').forEach(btn => {
          const t = this.normalize(btn.innerText || btn.value || btn.getAttribute('aria-label'));
          if (!t || !want.some(w => t === w || t.includes(w))) return;
          if (btn.dataset.hsBound) return;
          btn.dataset.hsBound = '1';
          btn.addEventListener('click', () => callback(btn), true);
        });
      };
      bind();
      new MutationObserver(bind).observe(document.documentElement, { childList: true, subtree: true });
    },

    /* ---------- messaging ---------- */

    async enabled() {
      try { return (await chrome.storage.local.get({ enabled: true })).enabled !== false; }
      catch { return true; }
    },

    async send(type, payload = {}) {
      try { return await chrome.runtime.sendMessage({ type, ...payload }); }
      catch { return null; }
    },

    onControl(callback) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'HS_PING') { sendResponse({ ok: true, href: location.href }); return true; }
        if (msg?.type === 'RESET_ORDER_SESSION') {
          Promise.resolve(callback('RESET')).then(() => sendResponse({ ok: true }));
          return true;
        }
        return false;
      });
    },

    // True only while the booking form is actually mounted. When this is
    // false the page is navigating/unmounting and any read would be a false
    // blank, so the adapter stays silent instead of reporting empty values.
    formReady(anchor) {
      return !!this.resolve(anchor);
    },

    // Report which sheet column the user is currently typing into, so the
    // side panel can highlight and scroll to the matching cell.
    trackFocus(selMap, sessionSuffix) {
      const keyFor = el => {
        if (!el) return '';
        for (const k in selMap) {
          const n = this.resolve(selMap[k]);
          if (n && (n === el || n.contains(el))) return k;
        }
        return '';
      };
      let last = null;
      const update = () => {
        const k = keyFor(document.activeElement);
        if (k === last) return;
        last = k;
        this.send('FIELD_FOCUS', { field: k, session_suffix: sessionSuffix });
      };
      document.addEventListener('focusin', update, true);
      document.addEventListener('click', update, true);
      // dropdowns move focus around before settling, so debounce the blur
      document.addEventListener('focusout', () => setTimeout(update, 150), true);
    },

    // A page load (including a refresh) wipes the courier form, so the
    // matching draft is dropped too. Runs once per content-script injection.
    async clearSession(sessionSuffix) {
      await this.send('CLEAR_SESSION_DRAFT', { session_suffix: sessionSuffix });
    },

    // sessionKey is stable for the life of a tab on a given courier, so
    // switching browser tabs and coming back lands on the same draft.
    //
    // authoritative=true means "the form is mounted and this is exactly what
    // it says right now" — blanks included, so clearing a field clears the
    // cell. Only ever sent while formReady() holds.
    async capture(order, complete, capturedFields, sessionSuffix, authoritative) {
      if (!(await this.enabled())) return;
      await this.send(complete ? 'ORDER_CAPTURED' : 'DRAFT_UPDATED', {
        order,
        captured_fields: capturedFields,
        session_suffix: sessionSuffix || order.courier || '',
        authoritative: !!authoritative
      });
    }
  };

  self.HS = H;
})();
