// CalSync dashboard progressive enhancement (vanilla JS, no frameworks).
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    // Confirmation dialogs on destructive forms.
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    });

    // Target-calendar mode radios toggle their matching subfield.
    var radios = document.querySelectorAll('input[name="calendar_mode"]');
    if (radios.length) {
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

    // Auto-fade flash messages.
    setTimeout(function () {
      document.querySelectorAll('.flash').forEach(function (el) {
        el.style.transition = 'opacity 1s ease';
        el.style.opacity = '0.35';
      });
    }, 9000);
  });
})();
