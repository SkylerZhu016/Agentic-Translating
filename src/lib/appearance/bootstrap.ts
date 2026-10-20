import { APPEARANCE_STORAGE_KEY, APPEARANCE_THEMES } from './core'

/*
 * Runs synchronously in <head>, before any application content is painted.
 * This source is deliberately self-contained, with no function.toString() or
 * references to bundler-renamed functions. Constants come from the same theme
 * table as the client. A VM parity regression covers the small color algorithm.
 */
export const APPEARANCE_BOOTSTRAP_SOURCE = `(() => {
  var themes = ${JSON.stringify(APPEARANCE_THEMES)};
  var key = ${JSON.stringify(APPEARANCE_STORAGE_KEY)};
  var value = null;
  try { value = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
  var valid = value && typeof value === 'object' && value.version === 1;
  var theme = themes.find(function (item) { return valid && item.id === value.themeId; }) || themes[0];
  function normalize(input) {
    if (typeof input !== 'string' || input.length > 32) return null;
    var color = input.trim();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return null;
    if (color.length === 4) color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
    return color.toUpperCase();
  }
  function rgb(color) {
    return [1, 3, 5].map(function (offset) { return parseInt(color.slice(offset, offset + 2), 16); });
  }
  function luminance(color) {
    var channels = rgb(color).map(function (channel) {
      var n = channel / 255;
      return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  var colors = theme.colors;
  var custom = valid && value.accents && typeof value.accents === 'object' && !Array.isArray(value.accents)
    ? normalize(value.accents[theme.id]) : null;
  var accent = custom || colors.accent;
  var surfaces = ['#FFFFFF', colors.paper, colors.surface, colors.panel];
  function readable(candidate, minimum) {
    return surfaces.every(function (surface) { return contrast(candidate, surface) >= minimum; });
  }
  if (!readable(accent, 4.5)) {
    var channels = rgb(accent);
    function darken(factor) {
      return ('#' + channels.map(function (channel) {
        return Math.floor(channel * factor).toString(16).padStart(2, '0');
      }).join('')).toUpperCase();
    }
    var low = 0, high = 1;
    for (var i = 0; i < 24; i += 1) {
      var middle = (low + high) / 2;
      if (readable(darken(middle), 4.55)) low = middle;
      else high = middle;
    }
    accent = darken(low);
  }
  var variables = {
    '--color-paper': colors.paper,
    '--color-paper-raise': colors.surface,
    '--color-paper-sink': colors.panel,
    '--color-ink': colors.ink,
    '--color-ink-2': colors.ink2,
    '--color-ink-3': colors.ink3,
    '--color-ink-4': colors.ink4,
    '--color-line': colors.line,
    '--color-line-2': colors.lineStrong,
    '--color-pine': accent,
    '--color-moss': accent
  };
  var root = document.documentElement;
  Object.keys(variables).forEach(function (name) { root.style.setProperty(name, variables[name]); });
  root.dataset.appearance = theme.id;
})();`
