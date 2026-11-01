/**
 * app/blank.js — Blank personal-app canvas
 *
 * Replace this module (or add a new one and point app.js at it).
 * Use only the collections facade — never adapters or sync:
 *   import { db } from '../core/db-api.js';
 */

/**
 * @param {HTMLElement} root
 */
export async function mount(root) {
  root.innerHTML = `
    <div class="blank-canvas" data-app="blank">
      <p class="blank-hint">edit <code>app/</code></p>
    </div>
  `;

  return {
    title: 'App',
    unmount() {
      root.innerHTML = '';
    },
  };
}
