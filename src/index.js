/**
 * grass-field — interactive WebGL grass with cursor-bloom flowers.
 *
 *   import { mount, dispose } from 'https://cdn.example.com/grass-field/grass-field.js';
 *   const field = mount(document.querySelector('#grass'), { instanceCount: 50000 });
 *   ...
 *   dispose(field);   // or field.dispose()
 *
 * `mount()` is the only entry point; nothing is attached to `window`.
 */
import { GrassField } from './GrassField.js';
import { defaultConfig } from './config.js';

const instances = new WeakMap();

/**
 * Mount a grass field into `container` (any block element; the canvas fills it).
 * @param {HTMLElement|string} container element or CSS selector
 * @param {object} [options] partial config, deep-merged over `defaultConfig`
 * @returns {GrassField|null} the instance (null when the container can't be found)
 */
export function mount(container, options = {}) {
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) { console.warn('[grass-field] container not found:', container); return null; }
  const existing = instances.get(el);
  if (existing && !existing.disposed) existing.dispose();
  const field = new GrassField(el, options);
  instances.set(el, field);
  return field;
}

/**
 * Tear down a field. Accepts the instance returned by `mount()` or the container element.
 */
export function dispose(target) {
  const field = target instanceof GrassField ? target : instances.get(typeof target === 'string' ? document.querySelector(target) : target);
  if (field) { field.dispose(); instances.delete(field.container); }
}

export { defaultConfig, GrassField };
