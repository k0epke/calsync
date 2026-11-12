// CalSync dashboard progressive enhancement (vanilla JS, no frameworks).
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // localStorage helpers: every call is wrapped because storage may be
  // unavailable (disabled, private mode, quota) - in that case sort/filter
  // state simply lasts one visit instead of throwing.
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (err) { /* keep going without persistence */ }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
  }
  function lsJson(key) {
    var raw = lsGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  // Client-side table state (rendered rows carry data-* attributes from
  // lib/render.js; the server is never reloaded for sort or filter changes).
  var SORT_STORE_KEY = 'calsync.sort.v1';
  var FILTER_STORE_KEY = 'calsync.filters.v1';
  var SORT_KEYS = { name: 1, category: 1, target: 1, interval: 1, status: 1, last_run: 1 };
  var CATEGORY_VALUES = { google: 1, caldav: 1, webcal: 1, ics: 1 };
  var STATUS_VALUES = { enabled: 1, paused: 1, errors: 1 };

  ready(function () {
    confirmDialogs();
    targetModeRadios();
    pairTableSort();
    pairTableFilters();
    tagDotPreview();
    fadeFlashes();
  });

  function confirmDialogs() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    });
  }

  // Target-calendar mode radios toggle their matching subfield.
  function targetModeRadios() {
    var radios = document.querySelectorAll('input[name="calendar_mode"]');
    if (!radios.length) return;
    var apply = function () {
      var checked = document.querySelector('input[name="calendar_mode"]:checked');
      var v = checked ? checked.value : 'select';
      ['select', 'create', 'manual'].forEach(function (mode) {
        var el = document.getElementById('sec-mode-' + mode);
        if (el) el.hidden = mode !== v;
      });
    };
    radios.forEach(function (r) { r.addEventListener('change', apply); });
    apply();
  }

  function fadeFlashes() {
    setTimeout(function () {
      document.querySelectorAll('.flash').forEach(function (el) {
        el.style.transition = 'opacity 1s ease';
        el.style.opacity = '0.35';
      });
    }, 9000);
  }

  function pairRows(table) {
    return Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  }

  function pairTableSort() {
    var table = document.querySelector('table.pairs');
    if (!table || !table.tBodies.length) return;
    var tbody = table.tBodies[0];
    var state = restoreSortState();

    function restoreSortState() {
      var saved = lsJson(SORT_STORE_KEY);
      if (saved && SORT_KEYS[saved.key] && (saved.dir === 'asc' || saved.dir === 'desc')) {
        return { key: saved.key, dir: saved.dir };
      }
      return { key: 'name', dir: 'asc' };
    }

    function sortValue(row, key) {
      var cell = row.querySelector('[data-sort-key="' + key + '"]');
      return cell ? String(cell.getAttribute('data-sort-value') || '') : '';
    }

    function compare(a, b) {
      var av = sortValue(a, state.key);
      var bv = sortValue(b, state.key);
      var cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      return state.dir === 'asc' ? cmp : -cmp;
    }

    function paint() {
      table.querySelectorAll('th.sortable').forEach(function (th) {
        var key = th.getAttribute('data-sort-key');
        var arrow = th.querySelector('.sort-arrow');
        th.classList.remove('sort-asc', 'sort-desc');
        if (arrow) arrow.textContent = '';
        if (key === state.key) {
          th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');
          if (arrow) arrow.textContent = state.dir === 'asc' ? '^' : 'v';
          th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
        } else {
          th.removeAttribute('aria-sort');
        }
      });
    }

    function apply() {
      pairRows(table).sort(compare).forEach(function (row) { tbody.appendChild(row); });
      paint();
    }

    table.querySelectorAll('th.sortable').forEach(function (th) {
      var key = th.getAttribute('data-sort-key');
      if (!key || !SORT_KEYS[key]) return;
      th.addEventListener('click', function () {
        if (state.key === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else state = { key: key, dir: 'asc' };
        lsSet(SORT_STORE_KEY, JSON.stringify(state));
        apply();
      });
    });

    apply();
  }

  function pairTableFilters() {
    var table = document.querySelector('table.pairs');
    var q = document.getElementById('filter-q');
    var cat = document.getElementById('filter-category');
    var st = document.getElementById('filter-status');
    var tgt = document.getElementById('filter-target');
    var tgs = document.getElementById('filter-tags');
    var iv = document.getElementById('filter-interval');
    var clearBtn = document.getElementById('filter-clear');
    var noMatch = document.getElementById('no-pairs-match');
    var counter = document.getElementById('filter-count');
    if (!table || !q || !cat || !st || !tgt || !tgs || !iv) return;

    // Row metadata was rendered onto the name cell (server-side), so each
    // row's searchable/filterable facts come from there.
    function infoOf(row) {
      var cell = row.querySelector('td.namecell');
      return cell || null;
    }

    function statusMatches(row, mode) {
      var cell = infoOf(row);
      if (!cell) return true;
      if (mode === 'enabled') return cell.getAttribute('data-enabled') === '1';
      if (mode === 'paused') return cell.getAttribute('data-enabled') === '0';
      if (mode === 'errors') {
        var s = String(cell.getAttribute('data-status') || '');
        return s === 'error' || s === 'partial';
      }
      return true;
    }

    function intervalValueOf(row) {
      var td = row.querySelector('td[data-sort-key="interval"]');
      return td ? String(td.getAttribute('data-sort-value') || '') : '';
    }

    function apply() {
      var qv = String(q.value || '').trim().toLowerCase();
      var cv = String(cat.value || '');
      var sv = String(st.value || '');
      var tv = String(tgt.value || '');
      var gv = String(tgs.value || '');
      var ivv = String(iv.value || '');
      var total = 0;
      var visible = 0;
      pairRows(table).forEach(function (row) {
        total += 1;
        var cell = infoOf(row);
        var show = true;
        if (show && qv && cell) {
          var name = String(cell.getAttribute('data-name') || '').toLowerCase();
          var url = String(cell.getAttribute('data-url') || '').toLowerCase();
          show = name.indexOf(qv) !== -1 || url.indexOf(qv) !== -1;
        }
        if (show && cv && cell) show = String(cell.getAttribute('data-category') || '') === cv;
        if (show && sv) show = statusMatches(row, sv);
        if (show && tv && cell) show = String(cell.getAttribute('data-target') || '') === tv;
        if (show && gv && cell) {
          var slots = String(cell.getAttribute('data-tag-slots') || '').split(',');
          show = slots.indexOf(gv) !== -1;
        }
        if (show && ivv) show = intervalValueOf(row) === ivv;
        row.style.display = show ? '' : 'none';
        if (show) visible += 1;
      });
      if (noMatch) noMatch.hidden = !(total > 0 && visible === 0);
      if (counter) counter.textContent = (qv || cv || sv || tv || gv || ivv) ? ('showing ' + visible + ' of ' + total + ' pairs') : '';
    }

    function save() {
      lsSet(FILTER_STORE_KEY, JSON.stringify({
        q: String(q.value || ''),
        category: String(cat.value || ''),
        status: String(st.value || ''),
        target: String(tgt.value || ''),
        tags: String(tgs.value || ''),
        interval: String(iv.value || ''),
      }));
    }

    function restore() {
      var saved = lsJson(FILTER_STORE_KEY);
      if (!saved) return;
      q.value = typeof saved.q === 'string' ? saved.q.slice(0, 200) : '';
      cat.value = CATEGORY_VALUES[saved.category] ? saved.category : '';
      st.value = STATUS_VALUES[saved.status] ? saved.status : '';
      tgt.value = typeof saved.target === 'string' ? saved.target : '';
      tgs.value = typeof saved.tags === 'string' ? saved.tags : '';
      iv.value = typeof saved.interval === 'string' ? saved.interval : '';
    }

    q.addEventListener('input', function () { apply(); save(); });
    [cat, st, tgt, tgs, iv].forEach(function (el) {
      el.addEventListener('change', function () { apply(); save(); });
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        q.value = '';
        cat.value = '';
        st.value = '';
        tgt.value = '';
        tgs.value = '';
        iv.value = '';
        lsDel(FILTER_STORE_KEY);
        apply();
      });
    }

    restore();
    apply();
  }

  // Tags manager nicety: the color dot previews the select's value live.
  function tagDotPreview() {
    document.querySelectorAll('.tag-slot-row').forEach(function (row) {
      var select = row.querySelector('select[name^="color_"]');
      var dot = row.querySelector('.color-dot');
      if (!select || !dot) return;
      select.addEventListener('change', function () {
        dot.style.background = String(select.value || '');
      });
    });
  }
})();
